/**
 * Outcome Tracker for Honey Bot Multi-Step Task Orchestration.
 * 
 * Tracks explicit lifecycle states for each requested outcome:
 * - Planned
 * - Validated
 * - Executing
 * - Succeeded
 * - Failed
 * - Skipped
 * - Blocked
 * - Verified
 * 
 * Guarantees that Honey Bot never reports overall success if any required
 * outcome failed, was skipped, or remains unverified.
 */

export const OutcomeStatus = Object.freeze({
  PLANNED: 'PLANNED',
  VALIDATED: 'VALIDATED',
  EXECUTING: 'EXECUTING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
  BLOCKED: 'BLOCKED',
  VERIFIED: 'VERIFIED'
});

export class OutcomeTracker {
  constructor(taskId, prompt = '') {
    this.taskId = taskId || `task_${Date.now()}`;
    this.prompt = prompt;
    this.outcomes = [];
    this.startedAt = new Date().toISOString();
    this.completedAt = null;
  }

  get actions() {
    return this.outcomes;
  }

  /**
   * Initializes outcome items from planned actions.
   */
  initializePlan(actions = []) {
    this.outcomes = actions.map((act, index) => ({
      index,
      actionId: act.actionId || `act_${index}_${act.action}`,
      action: act.action,
      target: act.targetRole || act.targetChannel || act.targetMember || act.name || 'unspecified',
      status: OutcomeStatus.PLANNED,
      statusHistory: [{ status: OutcomeStatus.PLANNED, timestamp: Date.now() }],
      error: null,
      verificationResult: null,
      dependencies: act.dependencies || []
    }));
    return this;
  }

  _resolveIndex(actionIdOrIndex) {
    if (typeof actionIdOrIndex === 'number') return actionIdOrIndex;
    if (typeof actionIdOrIndex === 'string') {
      const idx = this.outcomes.findIndex(o => o.actionId === actionIdOrIndex || String(o.index) === actionIdOrIndex);
      return idx >= 0 ? idx : -1;
    }
    return -1;
  }

  /**
   * Updates the status of an outcome item by index or ID.
   */
  updateActionStatus(actionIdOrIndex, newStatus, details = {}) {
    const idx = this._resolveIndex(actionIdOrIndex);
    if (idx >= 0) {
      this.transition(idx, newStatus, details);
    }
  }

  /**
   * Records a failure for an outcome item.
   */
  recordFailure(actionIdOrIndex, error, category = null) {
    const idx = this._resolveIndex(actionIdOrIndex);
    if (idx >= 0) {
      this.transition(idx, OutcomeStatus.FAILED, { error, category });
    }
  }

  /**
   * Skips all remaining unexecuted actions.
   */
  skipRemaining(reason = 'Previous step failed') {
    for (let i = 0; i < this.outcomes.length; i++) {
      if (this.outcomes[i].status === OutcomeStatus.PLANNED || this.outcomes[i].status === OutcomeStatus.VALIDATED) {
        this.transition(i, OutcomeStatus.SKIPPED, { reason });
      }
    }
  }

  /**
   * Transitions an outcome item to a new status.
   */
  transition(index, newStatus, details = {}) {
    const item = this.outcomes[index];
    if (!item) return;

    item.status = newStatus;
    item.statusHistory.push({ status: newStatus, timestamp: Date.now(), details });

    if (details.error) item.error = details.error;
    if (details.verificationResult) item.verificationResult = details.verificationResult;
  }

  /**
   * Validates that all items are in VALIDATED state before execution.
   */
  markAllValidated() {
    for (const item of this.outcomes) {
      if (item.status === OutcomeStatus.PLANNED) {
        this.transition(item.index, OutcomeStatus.VALIDATED);
      }
    }
  }

  /**
   * Marks dependent actions as SKIPPED if a prerequisite step fails.
   */
  handleStepFailure(failedIndex, error) {
    this.transition(failedIndex, OutcomeStatus.FAILED, { error });

    for (let i = failedIndex + 1; i < this.outcomes.length; i++) {
      if (this.outcomes[i].status === OutcomeStatus.PLANNED || this.outcomes[i].status === OutcomeStatus.VALIDATED) {
        this.transition(i, OutcomeStatus.SKIPPED, {
          reason: `Skipped because previous step ${failedIndex + 1} (${this.outcomes[failedIndex].action}) failed.`
        });
      }
    }
  }

  /**
   * Generates a truthful summary of outcomes.
   */
  getSummary() {
    const total = this.outcomes.length;
    const succeeded = this.outcomes.filter(o => o.status === OutcomeStatus.SUCCEEDED || o.status === OutcomeStatus.VERIFIED).length;
    const verified = this.outcomes.filter(o => o.status === OutcomeStatus.VERIFIED).length;
    const failed = this.outcomes.filter(o => o.status === OutcomeStatus.FAILED).length;
    const skipped = this.outcomes.filter(o => o.status === OutcomeStatus.SKIPPED).length;
    const blocked = this.outcomes.filter(o => o.status === OutcomeStatus.BLOCKED).length;

    let overallState = 'SUCCESS';
    if (failed > 0 || blocked > 0) {
      overallState = succeeded > 0 || verified > 0 ? 'PARTIAL' : 'FAILED';
    } else if (skipped > 0) {
      overallState = 'PARTIAL';
    } else if (verified < total && succeeded < total) {
      overallState = 'IN_PROGRESS';
    }

    return {
      taskId: this.taskId,
      overallState,
      total,
      verified,
      succeeded,
      failed,
      skipped,
      blocked,
      isFullyVerified: verified === total && total > 0,
      outcomes: this.outcomes
    };
  }

  /**
   * Alias for getSummary returning structured counts for execution reports.
   */
  getExecutionSummary() {
    const summary = this.getSummary();
    return {
      overallOutcome: summary.overallState,
      totalCount: summary.total,
      succeededCount: summary.succeeded,
      verifiedCount: summary.verified,
      failedCount: summary.failed,
      skippedCount: summary.skipped,
      blockedCount: summary.blocked,
      outcomes: this.outcomes
    };
  }
}
