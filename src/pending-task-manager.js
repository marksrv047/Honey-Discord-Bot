import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = new Logger('PendingTaskManager');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const DEFAULT_STORAGE_PATH = path.join(DATA_DIR, 'pending-tasks.json');

/**
 * Lifecycle states for pending administrative tasks.
 */
export const PendingTaskStatus = {
  WAITING_FOR_INPUT: 'waiting_for_input',
  READY: 'ready',
  EXECUTING: 'executing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired'
};

/**
 * Manages incomplete and pending administrative tasks requiring user follow-up or clarification.
 * Guarantees atomic persistence, concurrency locks, TTL expiration, and cross-guild isolation.
 */
export class PendingTaskManager {
  constructor(options = {}) {
    this.storagePath = options.storagePath || DEFAULT_STORAGE_PATH;
    this.maxTasksPerUserGuild = options.maxTasksPerUserGuild || 3;
    this.defaultTtlMs = options.defaultTtlMs || 15 * 60 * 1000; // 15 minutes
    this.tasks = new Map(); // taskId -> taskObject
    this.locks = new Set(); // taskId set for in-flight execution locks
    this.loaded = false;
    this._cleanupTimer = null;
    this.stats = {
      createdCount: 0,
      completedCount: 0,
      cancelledCount: 0,
      expiredCount: 0,
      failedCount: 0,
      concurrentLockBlocks: 0
    };
  }

  _ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      } catch (err) {
        logger.error('Failed to create data directory', { error: err.message });
      }
    }
  }

  /**
   * Loads pending tasks from disk storage.
   */
  loadAllTasks() {
    if (this.loaded) return this.tasks;
    this._ensureDataDir();

    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            this.tasks.clear();
            const now = Date.now();
            for (const [id, task] of Object.entries(parsed)) {
              // Apply TTL on load: if expired, mark EXPIRED
              if (task.status === PendingTaskStatus.WAITING_FOR_INPUT && task.expiresAt && task.expiresAt <= now) {
                task.status = PendingTaskStatus.EXPIRED;
                this.stats.expiredCount++;
              }
              this.tasks.set(id, task);
            }
          }
        } catch (parseErr) {
          logger.error('Corrupted pending-tasks.json detected. Safely resetting file.', { error: parseErr.message });
          // Safe fallback for corrupted state: keep backup and reset
          try {
            const backupPath = `${this.storagePath}.corrupt.${Date.now()}`;
            fs.writeFileSync(backupPath, raw, 'utf8');
          } catch {}
          this.tasks.clear();
        }
      }
      this.loaded = true;
      logger.info('Loaded pending tasks from storage', { count: this.tasks.size });
    } catch (err) {
      logger.error('Failed to read pending tasks storage', { error: err.message });
      this.tasks.clear();
      this.loaded = true;
    }

    return this.tasks;
  }

  /**
   * Persists pending tasks atomically to disk.
   */
  persistAllTasks() {
    this._ensureDataDir();
    const tempFile = `${this.storagePath}.tmp.${Date.now()}_${Math.random().toString(36).substring(7)}`;

    const serializable = {};
    for (const [id, task] of this.tasks.entries()) {
      // Do not store transient locks or circular references
      const { isExecuting, ...cleanTask } = task;
      serializable[id] = cleanTask;
    }

    try {
      fs.writeFileSync(tempFile, JSON.stringify(serializable, null, 2), 'utf8');
      try {
        fs.renameSync(tempFile, this.storagePath);
      } catch {
        fs.copyFileSync(tempFile, this.storagePath);
        fs.unlinkSync(tempFile);
      }
    } catch (err) {
      logger.error('Failed to persist pending tasks', { error: err.message });
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch {}
    }
  }

  /**
   * Generates a unique task identifier.
   */
  generateTaskId() {
    return `ptask_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  /**
   * Creates a new structured pending task.
   */
  createTask({
    guildId,
    userId,
    channelId = null,
    action,
    targetName = null,
    collectedParams = {},
    missingParams = [],
    clarificationQuestion = null,
    constraints = {},
    ttlMs = null
  }) {
    this.loadAllTasks();

    if (!guildId || !userId || !action) {
      throw new Error('guildId, userId, and action are required to create a pending task.');
    }

    // Check user/guild pending task limits
    const existing = this.getTasksForUser(guildId, userId, [PendingTaskStatus.WAITING_FOR_INPUT]);
    if (existing.length >= this.maxTasksPerUserGuild) {
      // Expire the oldest pending task to maintain bounded resource usage
      const oldest = existing.sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) {
        this.expireTask(oldest.taskId, 'Replaced by newer task limit');
      }
    }

    const now = Date.now();
    const expiry = now + (ttlMs || this.defaultTtlMs);
    const taskId = this.generateTaskId();

    const task = {
      taskId,
      guildId,
      userId,
      channelId,
      action,
      targetName: targetName || collectedParams.name || collectedParams.target || null,
      collectedParams: { ...collectedParams },
      missingParams: [...missingParams],
      clarificationQuestion,
      status: PendingTaskStatus.WAITING_FOR_INPUT,
      createdAt: now,
      lastActivityAt: now,
      expiresAt: expiry,
      constraints: {
        requiredUserPermissions: constraints.requiredUserPermissions || [],
        requiredBotPermissions: constraints.requiredBotPermissions || [],
        isHighImpact: Boolean(constraints.isHighImpact),
        originalPrompt: constraints.originalPrompt || null,
        ...constraints
      },
      idempotencyKey: crypto.createHash('sha256').update(`${guildId}:${userId}:${action}:${now}`).digest('hex').substring(0, 16)
    };

    this.tasks.set(taskId, task);
    this.stats.createdCount++;
    this.persistAllTasks();

    logger.info('Created pending task', { taskId, action, user: userId, guild: guildId, missingParams });
    return task;
  }

  /**
   * Retrieves an active pending task for a user in a guild.
   * Scoped to channel if channelId is provided and channel-specific tasks exist.
   */
  getPendingTask(guildId, userId, channelId = null) {
    this.loadAllTasks();
    const now = Date.now();

    const candidates = [];
    for (const task of this.tasks.values()) {
      if (task.guildId !== guildId || task.userId !== userId) continue;
      if (task.status !== PendingTaskStatus.WAITING_FOR_INPUT) continue;

      if (task.expiresAt && task.expiresAt <= now) {
        task.status = PendingTaskStatus.EXPIRED;
        this.stats.expiredCount++;
        continue;
      }

      candidates.push(task);
    }

    if (candidates.length === 0) return null;

    // Prefer exact channel match if available
    if (channelId) {
      const channelMatch = candidates.find(t => t.channelId === channelId);
      if (channelMatch) return channelMatch;
    }

    // Return most recently active candidate
    candidates.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return candidates[0];
  }

  /**
   * Returns all active pending tasks for a user in a guild.
   */
  getTasksForUser(guildId, userId, statuses = [PendingTaskStatus.WAITING_FOR_INPUT]) {
    this.loadAllTasks();
    const now = Date.now();
    const results = [];

    for (const task of this.tasks.values()) {
      if (task.guildId !== guildId || task.userId !== userId) continue;

      if (task.status === PendingTaskStatus.WAITING_FOR_INPUT && task.expiresAt && task.expiresAt <= now) {
        task.status = PendingTaskStatus.EXPIRED;
        this.stats.expiredCount++;
      }

      if (statuses.includes(task.status)) {
        results.push(task);
      }
    }

    return results;
  }

  /**
   * Returns a task by ID regardless of status.
   */
  getTaskById(taskId) {
    this.loadAllTasks();
    return this.tasks.get(taskId) || null;
  }

  /**
   * Updates task parameters, missing parameters, or metadata.
   */
  updateTask(taskId, updates = {}) {
    this.loadAllTasks();
    const task = this.tasks.get(taskId);
    if (!task) return null;

    if (updates.collectedParams) {
      task.collectedParams = { ...task.collectedParams, ...updates.collectedParams };
    }
    if (updates.missingParams) {
      task.missingParams = [...updates.missingParams];
    }
    if (updates.clarificationQuestion !== undefined) {
      task.clarificationQuestion = updates.clarificationQuestion;
    }
    if (updates.status) {
      task.status = updates.status;
    }
    if (updates.targetName) {
      task.targetName = updates.targetName;
    }

    task.lastActivityAt = Date.now();
    if (updates.extendTtl) {
      task.expiresAt = Date.now() + (updates.ttlMs || this.defaultTtlMs);
    }

    this.persistAllTasks();
    return task;
  }

  /**
   * Acquires an execution lock for a task. Returns false if already locked.
   */
  acquireLock(taskId) {
    if (this.locks.has(taskId)) {
      this.stats.concurrentLockBlocks++;
      return false;
    }
    this.locks.add(taskId);
    const task = this.tasks.get(taskId);
    if (task) task.isExecuting = true;
    return true;
  }

  /**
   * Releases an execution lock for a task.
   */
  releaseLock(taskId) {
    this.locks.delete(taskId);
    const task = this.tasks.get(taskId);
    if (task) task.isExecuting = false;
  }

  /**
   * Marks a task as COMPLETED.
   */
  completeTask(taskId, result = null) {
    this.loadAllTasks();
    const task = this.tasks.get(taskId);
    if (!task) return null;

    task.status = PendingTaskStatus.COMPLETED;
    task.lastActivityAt = Date.now();
    task.result = result;
    this.releaseLock(taskId);
    this.stats.completedCount++;
    this.persistAllTasks();
    logger.info('Completed pending task', { taskId, action: task.action });
    return task;
  }

  /**
   * Marks a task as CANCELLED.
   */
  cancelTask(taskId, reason = 'User cancelled') {
    this.loadAllTasks();
    const task = this.tasks.get(taskId);
    if (!task) return null;

    task.status = PendingTaskStatus.CANCELLED;
    task.cancelReason = reason;
    task.lastActivityAt = Date.now();
    this.releaseLock(taskId);
    this.stats.cancelledCount++;
    this.persistAllTasks();
    logger.info('Cancelled pending task', { taskId, reason });
    return task;
  }

  /**
   * Marks a task as EXPIRED.
   */
  expireTask(taskId, reason = 'TTL expired') {
    this.loadAllTasks();
    const task = this.tasks.get(taskId);
    if (!task) return null;

    task.status = PendingTaskStatus.EXPIRED;
    task.expireReason = reason;
    task.lastActivityAt = Date.now();
    this.releaseLock(taskId);
    this.stats.expiredCount++;
    this.persistAllTasks();
    return task;
  }

  /**
   * Marks a task as FAILED.
   */
  failTask(taskId, error = 'Execution error') {
    this.loadAllTasks();
    const task = this.tasks.get(taskId);
    if (!task) return null;

    task.status = PendingTaskStatus.FAILED;
    task.error = typeof error === 'string' ? error : error.message;
    task.lastActivityAt = Date.now();
    this.releaseLock(taskId);
    this.stats.failedCount++;
    this.persistAllTasks();
    return task;
  }

  /**
   * Sweeps expired tasks and cleans up old completed/cancelled records.
   */
  cleanupExpired(maxRetentionMs = 24 * 60 * 60 * 1000) {
    this.loadAllTasks();
    const now = Date.now();
    let changed = false;

    for (const [id, task] of this.tasks.entries()) {
      // Mark active expired tasks
      if (task.status === PendingTaskStatus.WAITING_FOR_INPUT && task.expiresAt && task.expiresAt <= now) {
        task.status = PendingTaskStatus.EXPIRED;
        this.stats.expiredCount++;
        changed = true;
      }

      // Purge terminal tasks older than retention limit
      const isTerminal = [
        PendingTaskStatus.COMPLETED,
        PendingTaskStatus.CANCELLED,
        PendingTaskStatus.EXPIRED,
        PendingTaskStatus.FAILED
      ].includes(task.status);

      if (isTerminal && (now - task.lastActivityAt) > maxRetentionMs) {
        this.tasks.delete(id);
        changed = true;
      }
    }

    if (changed) {
      this.persistAllTasks();
    }
  }

  /**
   * Starts periodic cleanup scheduler.
   */
  startScheduler(intervalMs = 5 * 60 * 1000) {
    if (this._cleanupTimer) return;
    this._cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, intervalMs);
    this._cleanupTimer.unref?.();
  }

  stopScheduler() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  /**
   * Resets internal in-memory and disk state (used for testing).
   */
  reset() {
    this.tasks.clear();
    this.locks.clear();
    this.loaded = true;
    this.stats = {
      createdCount: 0,
      completedCount: 0,
      cancelledCount: 0,
      expiredCount: 0,
      failedCount: 0,
      concurrentLockBlocks: 0
    };
    try {
      if (fs.existsSync(this.storagePath)) {
        fs.unlinkSync(this.storagePath);
      }
    } catch {}
  }

  /**
   * Returns statistics and diagnostics.
   */
  getStats() {
    this.loadAllTasks();
    let waitingCount = 0;
    let executingCount = 0;
    let completedCount = 0;
    let expiredCount = 0;

    for (const task of this.tasks.values()) {
      if (task.status === PendingTaskStatus.WAITING_FOR_INPUT) waitingCount++;
      else if (task.status === PendingTaskStatus.EXECUTING) executingCount++;
      else if (task.status === PendingTaskStatus.COMPLETED) completedCount++;
      else if (task.status === PendingTaskStatus.EXPIRED) expiredCount++;
    }

    let approxBytes = 0;
    try {
      if (fs.existsSync(this.storagePath)) {
        approxBytes = fs.statSync(this.storagePath).size;
      }
    } catch {}

    return {
      totalTasks: this.tasks.size,
      activeWaiting: waitingCount,
      executing: executingCount,
      completed: completedCount,
      expired: expiredCount,
      approximateSizeBytes: approxBytes,
      historicalStats: { ...this.stats },
      storagePath: this.storagePath
    };
  }
}

export const defaultPendingTaskManager = new PendingTaskManager();

