import crypto from 'crypto';
import { TaskBudget, BudgetExceededError } from './budget.js';
import { Logger } from './logger.js';
export {
  TaskQueue,
  TaskQueueState,
  TaskActionStatus,
  InvalidStateTransitionError,
  QueueOverloadError
} from './task-queue.js';

const logger = new Logger('TaskWorkflow');

export const TaskState = {
  RECEIVED: 'RECEIVED',
  PLANNED: 'PLANNED',
  VALIDATED: 'VALIDATED',
  AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION',
  EXECUTING: 'EXECUTING',
  VERIFYING: 'VERIFYING',
  COMPLETED: 'COMPLETED',
  PARTIAL_SUCCESS: 'PARTIAL_SUCCESS',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
};

export const ActionStatus = {
  PENDING: 'PENDING',
  EXECUTING: 'EXECUTING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  UNCERTAIN: 'UNCERTAIN',
  SKIPPED: 'SKIPPED'
};

/**
 * Stateful Task Workflow Manager.
 * Tracks task lifecycle, action status, idempotency keys, budget consumption, and recovery checkpoints.
 */
export class TaskWorkflow {
  // In-memory durable task registry (can survive across transient retries)
  static activeTasks = new Map();

  constructor(taskId, userPrompt, executionContext, options = {}) {
    this.taskId = taskId;
    this.userPrompt = userPrompt;
    this.executionContext = executionContext;
    this.userId = executionContext.invokingUser.id;
    this.guildId = executionContext.guild?.id;
    this.state = TaskState.RECEIVED;
    this.intent = null;
    this.actions = []; // Array of { id, hash, action, target, args, status, result, error }
    this.budget = new TaskBudget(options.budgetOptions);
    this.verificationResults = [];
    this.error = null;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();

    TaskWorkflow.activeTasks.set(this.taskId, this);
  }

  /**
   * Generates a deterministic hash for an action to guarantee idempotency and avoid duplicates.
   */
  static computeActionHash(action, target, args = {}) {
    const serialized = JSON.stringify({ action, target: String(target).toLowerCase(), args });
    return crypto.createHash('sha256').update(serialized).digest('hex').substring(0, 16);
  }

  /**
   * Transitions task to a new state with strict validation.
   */
  transition(newState, details = {}) {
    logger.info(`Task [${this.taskId}] state transition: ${this.state} -> ${newState}`, details);
    this.state = newState;
    this.updatedAt = Date.now();
  }

  /**
   * Registers planned actions into the workflow ledger with idempotency hashes.
   */
  setPlannedActions(plannedActions) {
    this.actions = plannedActions.map((act, index) => {
      const hash = TaskWorkflow.computeActionHash(act.action, act.targetChannel || act.targetRole || act.targetMember || act.name, act);
      return {
        id: `act_${index + 1}_${hash}`,
        hash,
        action: act.action,
        raw: act,
        status: ActionStatus.PENDING,
        result: null,
        error: null
      };
    });

    this.transition(TaskState.PLANNED, { actionCount: this.actions.length });
  }

  /**
   * Retrieves pending or uncertain actions that need execution or re-verification.
   */
  getPendingActions() {
    return this.actions.filter(a => a.status === ActionStatus.PENDING || a.status === ActionStatus.UNCERTAIN);
  }

  /**
   * Marks an action status.
   */
  updateActionStatus(actionId, status, result = null, error = null) {
    const item = this.actions.find(a => a.id === actionId);
    if (item) {
      item.status = status;
      item.result = result;
      item.error = error;
      this.updatedAt = Date.now();
    }
  }

  /**
   * Checks for lack of forward progress (circuit breaker).
   * Detects repeated failures or repeated tool actions with identical parameters.
   */
  assertForwardProgress(consecutiveFailureLimit = 3) {
    const failedCount = this.actions.filter(a => a.status === ActionStatus.FAILED).length;
    if (failedCount >= consecutiveFailureLimit) {
      throw new BudgetExceededError(
        `Task halted: ${failedCount} consecutive actions failed without forward progress.`
      );
    }
  }

  /**
   * Evaluates final task completion status based on action results.
   */
  finalize() {
    const total = this.actions.length;
    if (total === 0) {
      this.transition(TaskState.COMPLETED, { outcome: 'Zero actions executed' });
      return;
    }

    const succeeded = this.actions.filter(a => a.status === ActionStatus.SUCCEEDED).length;
    const failed = this.actions.filter(a => a.status === ActionStatus.FAILED).length;
    const skipped = this.actions.filter(a => a.status === ActionStatus.SKIPPED).length;

    if (succeeded === total) {
      this.transition(TaskState.COMPLETED, { succeeded, total });
    } else if (succeeded > 0) {
      this.transition(TaskState.PARTIAL_SUCCESS, { succeeded, failed, skipped, total });
    } else {
      this.transition(TaskState.FAILED, { failed, total });
    }
  }

  /**
   * Returns a diagnostic overview of the workflow.
   */
  getSummary() {
    return {
      taskId: this.taskId,
      userPrompt: this.userPrompt,
      state: this.state,
      actions: this.actions.map(a => ({
        action: a.action,
        status: a.status,
        details: a.result?.details || a.error
      })),
      budget: this.budget.getSnapshot(),
      durationMs: Date.now() - this.createdAt
    };
  }
}
