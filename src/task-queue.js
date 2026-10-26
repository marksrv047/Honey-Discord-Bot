import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Logger } from './logger.js';
import { ModLogService } from './mod-log.js';
import { classifyDiscordError } from './recovery.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = new Logger('TaskQueue');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const QUEUE_FILE = path.join(DATA_DIR, 'task-queue.json');

/**
 * Task Queue Lifecycle States
 */
export const TaskQueueState = {
  QUEUED: 'queued',
  PLANNING: 'planning',
  VALIDATING: 'validating',
  AWAITING_CONFIRMATION: 'awaiting_confirmation',
  RUNNING: 'running',
  WAITING: 'waiting',
  PARTIALLY_COMPLETED: 'partially_completed',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  INTERRUPTED: 'interrupted',
  RECOVERY_REQUIRED: 'recovery_required'
};

/**
 * Per-Action Execution Status
 */
export const TaskActionStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  UNCERTAIN: 'uncertain'
};

/**
 * Valid state transitions mapping
 */
const VALID_TRANSITIONS = {
  [TaskQueueState.QUEUED]: [
    TaskQueueState.PLANNING,
    TaskQueueState.VALIDATING,
    TaskQueueState.RUNNING,
    TaskQueueState.CANCELLED,
    TaskQueueState.FAILED
  ],
  [TaskQueueState.PLANNING]: [
    TaskQueueState.VALIDATING,
    TaskQueueState.CANCELLED,
    TaskQueueState.FAILED
  ],
  [TaskQueueState.VALIDATING]: [
    TaskQueueState.AWAITING_CONFIRMATION,
    TaskQueueState.RUNNING,
    TaskQueueState.CANCELLED,
    TaskQueueState.FAILED
  ],
  [TaskQueueState.AWAITING_CONFIRMATION]: [
    TaskQueueState.RUNNING,
    TaskQueueState.CANCELLED,
    TaskQueueState.FAILED
  ],
  [TaskQueueState.RUNNING]: [
    TaskQueueState.WAITING,
    TaskQueueState.PARTIALLY_COMPLETED,
    TaskQueueState.COMPLETED,
    TaskQueueState.FAILED,
    TaskQueueState.INTERRUPTED,
    TaskQueueState.RECOVERY_REQUIRED,
    TaskQueueState.CANCELLED
  ],
  [TaskQueueState.WAITING]: [
    TaskQueueState.RUNNING,
    TaskQueueState.FAILED,
    TaskQueueState.CANCELLED,
    TaskQueueState.INTERRUPTED
  ],
  [TaskQueueState.PARTIALLY_COMPLETED]: [
    TaskQueueState.RUNNING,
    TaskQueueState.RECOVERY_REQUIRED,
    TaskQueueState.INTERRUPTED
  ],
  [TaskQueueState.INTERRUPTED]: [
    TaskQueueState.VALIDATING,
    TaskQueueState.RUNNING,
    TaskQueueState.RECOVERY_REQUIRED,
    TaskQueueState.FAILED,
    TaskQueueState.CANCELLED
  ],
  [TaskQueueState.RECOVERY_REQUIRED]: [
    TaskQueueState.RUNNING,
    TaskQueueState.COMPLETED,
    TaskQueueState.PARTIALLY_COMPLETED,
    TaskQueueState.FAILED,
    TaskQueueState.CANCELLED
  ],
  [TaskQueueState.COMPLETED]: [],
  [TaskQueueState.FAILED]: [],
  [TaskQueueState.CANCELLED]: []
};

export class InvalidStateTransitionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidStateTransitionError';
  }
}

export class QueueOverloadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QueueOverloadError';
  }
}

/**
 * Robust, restart-resilient, dependency-aware task queue.
 */
export class TaskQueue {
  static _tasks = new Map(); // taskId -> TaskRecord
  static _guildLocks = new Map(); // guildId -> Promise lock
  static _loaded = false;
  static _maxTasksPerGuild = 10;
  static _maxGlobalTasks = 100;
  static _storagePath = QUEUE_FILE;

  static get storagePath() {
    return this._storagePath;
  }

  static set storagePath(p) {
    this._storagePath = p;
    this._loaded = false;
  }

  static _ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  /**
   * Generates a deterministic idempotency hash for an action.
   */
  static computeActionHash(action, target, args = {}) {
    const cleanArgs = { ...args };
    delete cleanArgs.dependsOn;
    delete cleanArgs.id;
    const serialized = JSON.stringify({
      action,
      target: String(target || '').toLowerCase().trim(),
      args: cleanArgs
    });
    return crypto.createHash('sha256').update(serialized).digest('hex').substring(0, 16);
  }

  /**
   * Loads task records from persistent disk storage.
   */
  static loadAllTasks() {
    if (this._loaded) return this._tasks;
    this._ensureDataDir();

    const filePath = this._storagePath;
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this._tasks.clear();
          for (const [id, task] of Object.entries(parsed)) {
            this._tasks.set(id, task);
          }
        }
      }
      this._loaded = true;
      logger.info('Loaded task queue records from persistent storage.', { count: this._tasks.size });
    } catch (err) {
      logger.error('Failed to load task queue from disk', { error: err.message });
      this._tasks.clear();
      this._loaded = true;
    }
    return this._tasks;
  }

  /**
   * Persists all tasks atomically to disk storage.
   */
  static persistAllTasks() {
    this._ensureDataDir();
    const filePath = this._storagePath;
    const tempFile = `${filePath}.tmp.${Date.now()}_${Math.random().toString(36).substring(7)}`;

    const serializable = {};
    for (const [id, task] of this._tasks.entries()) {
      serializable[id] = task;
    }

    try {
      fs.writeFileSync(tempFile, JSON.stringify(serializable, null, 2), 'utf8');
      try {
        fs.renameSync(tempFile, filePath);
      } catch {
        fs.copyFileSync(tempFile, filePath);
        fs.unlinkSync(tempFile);
      }
    } catch (err) {
      logger.error('Failed to persist task queue to disk', { error: err.message });
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch {}
    }
  }

  /**
   * Retrieves a task by ID.
   */
  static getTask(taskId) {
    this.loadAllTasks();
    return this._tasks.get(taskId) || null;
  }

  /**
   * Returns active/pending tasks for a specific guild.
   */
  static getGuildActiveTasks(guildId) {
    this.loadAllTasks();
    const activeStates = new Set([
      TaskQueueState.QUEUED,
      TaskQueueState.PLANNING,
      TaskQueueState.VALIDATING,
      TaskQueueState.AWAITING_CONFIRMATION,
      TaskQueueState.RUNNING,
      TaskQueueState.WAITING
    ]);
    return Array.from(this._tasks.values()).filter(
      t => t.guildId === guildId && activeStates.has(t.status)
    );
  }

  /**
   * Submits a new task to the queue with backpressure protection.
   */
  static createTask({
    taskId = `task_${Date.now()}_${Math.random().toString(36).substring(7)}`,
    guildId,
    userId,
    interactionId = null,
    userPrompt,
    plan = null,
    actions = [],
    isHighImpact = false,
    timeoutMs = 60000,
    correlationId = null
  }) {
    this.loadAllTasks();

    if (!guildId) {
      throw new Error('Valid guildId is required to submit a task');
    }

    // Backpressure check: per-guild and global capacity limits
    const activeInGuild = this.getGuildActiveTasks(guildId);
    if (activeInGuild.length >= this._maxTasksPerGuild) {
      throw new QueueOverloadError(
        `Server task queue full: ${activeInGuild.length} tasks currently processing in this server. Please wait for previous tasks to complete.`
      );
    }

    const totalActive = Array.from(this._tasks.values()).filter(t =>
      t.status === TaskQueueState.RUNNING || t.status === TaskQueueState.QUEUED
    ).length;
    if (totalActive >= this._maxGlobalTasks) {
      throw new QueueOverloadError(
        'Honey Bot global task queue is at capacity. Please try again in a few moments.'
      );
    }

    const now = Date.now();
    const formattedActions = actions.map((act, index) => {
      const target = act.targetChannel || act.targetRole || act.targetMember || act.name || act.target || 'current';
      const hash = this.computeActionHash(act.action, target, act);
      return {
        id: act.id || `step_${index + 1}`,
        action: act.action,
        title: act.title || act.action,
        args: { ...act },
        target,
        dependsOn: Array.isArray(act.dependsOn) ? [...act.dependsOn] : [],
        status: TaskActionStatus.PENDING,
        result: null,
        error: null,
        attempts: 0,
        idempotencyKey: hash,
        startedAt: null,
        completedAt: null
      };
    });

    const task = {
      taskId,
      guildId,
      userId,
      interactionId,
      userPrompt: String(userPrompt || '').slice(0, 1000), // Privacy-conscious bounded length
      status: TaskQueueState.QUEUED,
      plan: plan || { thoughtProcess: 'Sequential execution plan', actions },
      actions: formattedActions,
      currentActionIndex: 0,
      isHighImpact: Boolean(isHighImpact),
      timeoutMs,
      retryCount: 0,
      maxRetries: 3,
      correlationId: correlationId || taskId,
      resultSummary: null,
      recoverableState: [],
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null
    };

    this._tasks.set(taskId, task);
    this.persistAllTasks();
    logger.info(`Task [${taskId}] queued for guild ${guildId}`, {
      actionCount: formattedActions.length,
      userId
    });

    return task;
  }

  /**
   * Transitions a task to a new state with strict validation.
   */
  static transition(taskId, newStatus, details = {}) {
    this.loadAllTasks();
    const task = this._tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    const currentStatus = task.status;
    if (currentStatus === newStatus) {
      task.updatedAt = Date.now();
      return task;
    }

    const allowed = VALID_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(newStatus)) {
      throw new InvalidStateTransitionError(
        `Invalid task state transition: Cannot transition task ${taskId} from "${currentStatus}" to "${newStatus}".`
      );
    }

    task.status = newStatus;
    task.updatedAt = Date.now();

    if (newStatus === TaskQueueState.RUNNING && !task.startedAt) {
      task.startedAt = Date.now();
    }
    if (
      newStatus === TaskQueueState.COMPLETED ||
      newStatus === TaskQueueState.FAILED ||
      newStatus === TaskQueueState.PARTIALLY_COMPLETED ||
      newStatus === TaskQueueState.CANCELLED
    ) {
      task.completedAt = Date.now();
    }

    if (details.resultSummary) task.resultSummary = details.resultSummary;
    if (details.error) task.error = details.error;

    this.persistAllTasks();
    logger.info(`Task [${taskId}] transitioned: ${currentStatus} -> ${newStatus}`, details);
    return task;
  }

  /**
   * Cancels a queued or waiting task.
   */
  static cancelTask(taskId, reason = 'Cancelled by user or administrator') {
    return this.transition(taskId, TaskQueueState.CANCELLED, { resultSummary: reason });
  }

  /**
   * Executes a task sequentially respecting dependency order and per-guild mutual exclusion.
   */
  static async executeTask(taskId, { guild, member, executor, verifier, onProgress = null }) {
    this.loadAllTasks();
    const task = this._tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Per-guild serialization lock: only one mutating task executes at a time per guild
    const guildId = task.guildId;
    const currentLock = this._guildLocks.get(guildId) || Promise.resolve();

    let releaseLock;
    const newLock = new Promise(resolve => {
      releaseLock = resolve;
    });
    this._guildLocks.set(guildId, newLock);

    await currentLock.catch(() => {});

    try {
      return await this._runTaskPipeline(task, { guild, member, executor, verifier, onProgress });
    } finally {
      releaseLock();
      if (this._guildLocks.get(guildId) === newLock) {
        this._guildLocks.delete(guildId);
      }
    }
  }

  /**
   * Internal pipeline executing the ordered task actions.
   */
  static async _runTaskPipeline(task, { guild, member, executor, verifier, onProgress }) {
    this.transition(task.taskId, TaskQueueState.RUNNING, {
      actionCount: task.actions.length
    });

    const executionContext = {
      guild,
      invokingMember: member,
      invokingUser: member?.user || member,
      executionId: task.correlationId || task.taskId
    };

    const totalSteps = task.actions.length;
    let anyFailure = false;
    let anySuccess = false;

    // Report initial progress
    if (typeof onProgress === 'function') {
      try {
        await onProgress({
          taskId: task.taskId,
          status: 'running',
          currentStep: 1,
          totalSteps,
          task
        });
      } catch (e) {
        logger.warn('Progress update error (non-fatal)', { error: e.message });
      }
    }

    for (let i = 0; i < task.actions.length; i++) {
      task.currentActionIndex = i;
      const actionItem = task.actions[i];

      // 1. Check dependencies: Every prerequisite step in dependsOn must be SUCCEEDED
      const unfulfilledPrereq = actionItem.dependsOn.find(depId => {
        const depAct = task.actions.find(a => a.id === depId);
        return !depAct || depAct.status !== TaskActionStatus.SUCCEEDED;
      });

      if (unfulfilledPrereq) {
        const depAct = task.actions.find(a => a.id === unfulfilledPrereq);
        const reason = `Skipped because prerequisite step "${depAct?.title || unfulfilledPrereq}" failed or was skipped.`;
        actionItem.status = TaskActionStatus.SKIPPED;
        actionItem.error = reason;
        actionItem.completedAt = Date.now();
        this.persistAllTasks();
        logger.warn(`Action [${actionItem.id}] (${actionItem.action}) skipped`, { reason });
        continue;
      }

      // 2. Mark action running
      actionItem.status = TaskActionStatus.RUNNING;
      actionItem.startedAt = Date.now();
      actionItem.attempts++;
      this.persistAllTasks();

      // Report step progress
      if (typeof onProgress === 'function') {
        try {
          await onProgress({
            taskId: task.taskId,
            status: 'running',
            currentStep: i + 1,
            totalSteps,
            currentAction: actionItem,
            task
          });
        } catch {}
      }

      // 3. Execute with bounded retries for transient errors
      let outcome = { success: false, details: '' };
      let executeErr = null;
      const maxRetries = 2;
      let attempt = 0;

      while (attempt <= maxRetries) {
        attempt++;
        try {
          // Check Discord idempotency before calling mutation
          const alreadyDone = await this._checkPreExistingOutcome(guild, actionItem);
          if (alreadyDone) {
            outcome = alreadyDone;
            executeErr = null;
            break;
          }

          if (executor && typeof executor.executeSingleAction === 'function') {
            outcome = await executor.executeSingleAction(
              guild,
              actionItem.args,
              task.correlationId,
              member
            );
          } else {
            outcome = { success: true, details: `Simulated execution of ${actionItem.action}` };
          }

          if (outcome?.success) {
            executeErr = null;
            break;
          } else {
            executeErr = new Error(outcome?.error || outcome?.details || 'Action failed');
          }
        } catch (err) {
          executeErr = err;
          const classified = classifyDiscordError(err);
          if (classified.retryable && attempt <= maxRetries) {
            const delay = attempt * 500;
            logger.warn(`Transient action error, retrying in ${delay}ms`, { action: actionItem.action, attempt });
            await new Promise(r => setTimeout(r, delay));
          } else {
            break;
          }
        }
      }

      // 4. Verification phase
      if (!executeErr && outcome?.success) {
        actionItem.status = TaskActionStatus.SUCCEEDED;
        actionItem.result = outcome;
        actionItem.completedAt = Date.now();
        anySuccess = true;

        if (outcome.resource) {
          task.recoverableState.push(outcome.resource);
        }
      } else {
        const errorMsg = executeErr?.message || outcome?.error || 'Action failed';
        actionItem.status = TaskActionStatus.FAILED;
        actionItem.error = errorMsg;
        actionItem.completedAt = Date.now();
        anyFailure = true;
      }

      this.persistAllTasks();

      // Log action execution event to ModLog
      if (guild) {
        ModLogService.logAction(guild, {
          action: actionItem.action,
          actor: member?.user || member,
          target: actionItem.target,
          reason: task.userPrompt,
          outcome: actionItem.status === TaskActionStatus.SUCCEEDED ? 'succeeded' : 'failed',
          failureReason: actionItem.error,
          executionId: task.correlationId,
          source: '/go'
        }).catch(() => {});
      }
    }

    // 5. Finalize overall task state
    if (!anyFailure && anySuccess) {
      this.transition(task.taskId, TaskQueueState.COMPLETED, {
        resultSummary: `Completed all ${totalSteps} actions successfully.`
      });
    } else if (anySuccess && anyFailure) {
      this.transition(task.taskId, TaskQueueState.PARTIALLY_COMPLETED, {
        resultSummary: `Partially completed: some actions succeeded while others failed or were skipped.`
      });
    } else {
      this.transition(task.taskId, TaskQueueState.FAILED, {
        resultSummary: `Task failed: actions could not be completed.`
      });
    }

    // Final progress callback
    if (typeof onProgress === 'function') {
      try {
        await onProgress({
          taskId: task.taskId,
          status: task.status,
          currentStep: totalSteps,
          totalSteps,
          task
        });
      } catch {}
    }

    return task;
  }

  /**
   * Idempotency check: Inspects actual Discord guild state to see if mutation already succeeded.
   */
  static async _checkPreExistingOutcome(guild, actionItem) {
    if (!guild) return null;
    const { action, args } = actionItem;
    const rolesList = guild.roles?.cache ? (guild.roles.cache.values ? Array.from(guild.roles.cache.values()) : (Array.isArray(guild.roles.cache) ? guild.roles.cache : [])) : [];
    const channelsList = guild.channels?.cache ? (guild.channels.cache.values ? Array.from(guild.channels.cache.values()) : (Array.isArray(guild.channels.cache) ? guild.channels.cache : [])) : [];

    // Check Role Creation
    const targetRoleName = args?.name || args?.roleName || args?.role || args?.targetRole;
    if (action === 'create_role' && targetRoleName) {
      const existing = rolesList.find(
        r => r.name?.toLowerCase() === String(targetRoleName).toLowerCase()
      );
      if (existing) {
        return {
          success: true,
          details: `Role "${existing.name}" already exists (idempotent reuse)`,
          roleId: existing.id
        };
      }
    }

    // Check Channel Creation
    const targetChannelName = args?.name || args?.channelName || args?.channel || args?.categoryName || args?.category;
    if ((action === 'create_channel' || action === 'create_category') && targetChannelName) {
      const existing = channelsList.find(
        c => c.name?.toLowerCase() === String(targetChannelName).toLowerCase()
      );
      if (existing) {
        return {
          success: true,
          details: `Channel "${existing.name}" already exists (idempotent reuse)`,
          channelId: existing.id
        };
      }
    }

    // Check Slowmode setting
    if (action === 'set_channel_slowmode' && args.seconds !== undefined) {
      const targetCh = args.targetChannel ? channelsList.find(
        c => c.name.toLowerCase() === String(args.targetChannel).replace(/^#/, '').toLowerCase() || c.id === args.targetChannel
      ) : null;
      if (targetCh && targetCh.rateLimitPerUser === args.seconds) {
        return {
          success: true,
          details: `Slowmode for #${targetCh.name} is already set to ${args.seconds}s.`
        };
      }
    }

    return null;
  }

  /**
   * Startup reconciliation: Inspects unfinished tasks from persistent storage and reconciles against actual Discord state.
   */
  static async reconcileOnStartup(client) {
    this.loadAllTasks();
    const activeStates = new Set([
      TaskQueueState.RUNNING,
      TaskQueueState.PLANNING,
      TaskQueueState.VALIDATING,
      TaskQueueState.WAITING,
      TaskQueueState.INTERRUPTED
    ]);

    const unfinished = Array.from(this._tasks.values()).filter(t => activeStates.has(t.status));
    logger.info(`Reconciling ${unfinished.length} unfinished tasks on startup`);

    for (const task of unfinished) {
      const guild = client?.guilds?.cache?.get(task.guildId) || null;
      let reconciledAny = false;

      for (const actionItem of task.actions) {
        if (actionItem.status === TaskActionStatus.RUNNING || actionItem.status === TaskActionStatus.PENDING) {
          if (guild) {
            const preExisting = await this._checkPreExistingOutcome(guild, actionItem);
            if (preExisting) {
              actionItem.status = TaskActionStatus.SUCCEEDED;
              actionItem.result = preExisting;
              actionItem.completedAt = Date.now();
              reconciledAny = true;
              continue;
            }
          }

          // Destructive or non-verifiable mutations cannot be safely resumed without confirmation
          if (['ban_member', 'kick_member', 'purge_messages', 'delete_channel', 'delete_role'].includes(actionItem.action)) {
            actionItem.status = TaskActionStatus.UNCERTAIN;
            actionItem.error = 'Interrupted during shutdown/restart; cannot reliably verify outcome';
          }
        }
      }

      const allDone = task.actions.every(a => a.status === TaskActionStatus.SUCCEEDED);
      const anyUncertain = task.actions.some(a => a.status === TaskActionStatus.UNCERTAIN);
      const anyFailed = task.actions.some(a => a.status === TaskActionStatus.FAILED);

      if (allDone) {
        task.status = TaskQueueState.COMPLETED;
        task.resultSummary = 'Reconciled all actions successfully after restart.';
      } else if (anyUncertain) {
        task.status = TaskQueueState.RECOVERY_REQUIRED;
        task.resultSummary = 'Task contains unverified actions requiring review before proceeding.';
      } else if (reconciledAny || anyFailed) {
        task.status = TaskQueueState.PARTIALLY_COMPLETED;
        task.resultSummary = 'Reconciled partial execution state after restart.';
      } else {
        task.status = TaskQueueState.INTERRUPTED;
        task.resultSummary = 'Task was interrupted by system shutdown/restart.';
      }

      task.updatedAt = Date.now();
    }

    this.persistAllTasks();
    return unfinished;
  }

  /**
   * Graceful shutdown handler: marks in-flight tasks as INTERRUPTED and persists state.
   */
  static shutdown() {
    this.loadAllTasks();
    let interruptedCount = 0;
    for (const task of this._tasks.values()) {
      if (task.status === TaskQueueState.RUNNING || task.status === TaskQueueState.QUEUED) {
        task.status = TaskQueueState.INTERRUPTED;
        task.resultSummary = 'Task safely interrupted by process shutdown.';
        task.updatedAt = Date.now();
        interruptedCount++;
      }
    }
    this.persistAllTasks();
    logger.info(`TaskQueue shutdown complete. Interrupted ${interruptedCount} active tasks.`);
  }

  /**
   * Resets all in-memory and disk tasks (used for isolated test suites).
   */
  static clear() {
    this._tasks.clear();
    this._guildLocks.clear();
    this._loaded = true;
    if (fs.existsSync(this._storagePath)) {
      try {
        fs.unlinkSync(this._storagePath);
      } catch {}
    }
  }
}
