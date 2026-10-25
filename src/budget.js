import { Logger } from './logger.js';

const logger = new Logger('BudgetManager');

export class BudgetExceededError extends Error {
  constructor(reason, details = {}) {
    super(`Task execution budget exceeded: ${reason}`);
    this.name = 'BudgetExceededError';
    this.reason = reason;
    this.details = details;
  }
}

/**
 * Task Execution Budget & Progress Tracker
 * Enforces strict bounds on LLM calls, input/output tokens, tool executions, retries, and overall duration.
 */
export class TaskBudget {
  constructor(options = {}) {
    this.maxModelCalls = options.maxModelCalls || 3;
    this.maxInputTokens = options.maxInputTokens || 6000;
    this.maxOutputTokens = options.maxOutputTokens || 2048;
    this.maxToolCalls = options.maxToolCalls || 20;
    this.maxDurationMs = options.maxDurationMs || 30000;
    this.maxRetriesPerCategory = options.maxRetriesPerCategory || 2;

    this.startTime = Date.now();
    this.modelCalls = 0;
    this.inputTokensUsed = 0;
    this.outputTokensUsed = 0;
    this.toolCalls = 0;
    this.retriesByCategory = {};
    this.previousToolSignatures = new Set();
  }

  /**
   * Estimates token count for a text string using conservative ~4 chars per token rule of thumb.
   */
  static estimateTokens(text) {
    if (!text) return 0;
    const str = typeof text === 'string' ? text : JSON.stringify(text);
    return Math.ceil(str.length / 3.8);
  }

  /**
   * Records a model call with token consumption.
   */
  recordModelCall(estimatedInputTokens = 0, estimatedOutputTokens = 0) {
    this.assertWithinTimeBudget();

    this.modelCalls++;
    this.inputTokensUsed += estimatedInputTokens;
    this.outputTokensUsed += estimatedOutputTokens;

    logger.debug('Recorded model call budget usage', {
      calls: `${this.modelCalls}/${this.maxModelCalls}`,
      inputTokens: `${this.inputTokensUsed}/${this.maxInputTokens}`,
      outputTokens: `${this.outputTokensUsed}/${this.maxOutputTokens}`
    });

    if (this.modelCalls > this.maxModelCalls) {
      throw new BudgetExceededError(
        `Exceeded maximum model calls limit (${this.maxModelCalls})`,
        { modelCalls: this.modelCalls, limit: this.maxModelCalls }
      );
    }

    if (this.inputTokensUsed > this.maxInputTokens) {
      throw new BudgetExceededError(
        `Exceeded maximum input token budget (${this.maxInputTokens})`,
        { inputTokensUsed: this.inputTokensUsed, limit: this.maxInputTokens }
      );
    }

    if (this.outputTokensUsed > this.maxOutputTokens) {
      throw new BudgetExceededError(
        `Exceeded maximum output token budget (${this.maxOutputTokens})`,
        { outputTokensUsed: this.outputTokensUsed, limit: this.maxOutputTokens }
      );
    }
  }

  /**
   * Records and checks tool invocation to prevent infinite loops, duplicate tool calls, or runaway execution.
   */
  recordToolCall(toolName, args = {}) {
    this.assertWithinTimeBudget();

    this.toolCalls++;
    if (this.toolCalls > this.maxToolCalls) {
      throw new BudgetExceededError(
        `Exceeded maximum tool calls limit (${this.maxToolCalls})`,
        { toolCalls: this.toolCalls, limit: this.maxToolCalls }
      );
    }

    const signature = `${toolName}:${JSON.stringify(args)}`;
    if (this.previousToolSignatures.has(signature)) {
      logger.warn(`Duplicate tool call detected in task loop: ${signature}`);
      return { isDuplicate: true, signature };
    }
    this.previousToolSignatures.add(signature);
    return { isDuplicate: false, signature };
  }

  /**
   * Tracks and bounds retries by error category.
   */
  recordRetry(category) {
    this.assertWithinTimeBudget();

    const count = (this.retriesByCategory[category] || 0) + 1;
    this.retriesByCategory[category] = count;

    if (count > this.maxRetriesPerCategory) {
      throw new BudgetExceededError(
        `Exceeded maximum retries (${this.maxRetriesPerCategory}) for category "${category}"`,
        { category, count, limit: this.maxRetriesPerCategory }
      );
    }
    return count;
  }

  /**
   * Ensures the task has not exceeded its overall time deadline.
   */
  assertWithinTimeBudget() {
    const elapsed = Date.now() - this.startTime;
    if (elapsed > this.maxDurationMs) {
      throw new BudgetExceededError(
        `Exceeded maximum task execution duration (${this.maxDurationMs}ms)`,
        { elapsedMs: elapsed, limit: this.maxDurationMs }
      );
    }
  }

  /**
   * Returns a snapshot of current budget consumption.
   */
  getSnapshot() {
    return {
      elapsedMs: Date.now() - this.startTime,
      durationLimitMs: this.maxDurationMs,
      modelCalls: this.modelCalls,
      modelCallLimit: this.maxModelCalls,
      inputTokensUsed: this.inputTokensUsed,
      inputTokenLimit: this.maxInputTokens,
      outputTokensUsed: this.outputTokensUsed,
      outputTokenLimit: this.maxOutputTokens,
      toolCalls: this.toolCalls,
      toolCallLimit: this.maxToolCalls,
      retriesByCategory: { ...this.retriesByCategory }
    };
  }
}
