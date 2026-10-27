import { Logger } from './logger.js';

const logger = new Logger('InteractionLifecycle');

/**
 * Standard Execution Outcomes
 */
export const ExecutionOutcome = Object.freeze({
  SUCCESS: 'SUCCESS',
  PARTIAL_SUCCESS: 'PARTIAL_SUCCESS',
  FAILED: 'FAILED',
  TIMED_OUT: 'TIMED_OUT',
  BLOCKED: 'BLOCKED',
  UNVERIFIED: 'UNVERIFIED'
});

/**
 * Interaction Response Lifecycle State
 */
export const ResponseState = Object.freeze({
  UNACKNOWLEDGED: 'UNACKNOWLEDGED',
  DEFERRED: 'DEFERRED',
  REPLIED: 'REPLIED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED'
});

/**
 * Safely manages Discord interaction responses.
 * Prevents double replies, handles 3-second timeouts via prompt deferrals,
 * suppresses raw internal stack traces, and guarantees bounded execution.
 */
export class InteractionLifecycle {
  constructor(interaction, options = {}) {
    this.interaction = interaction;
    this.commandName = interaction.commandName || 'interaction';
    this.executionId = options.executionId || Logger.generateExecutionId();
    this.timeoutMs = options.timeoutMs || (this.commandName === 'go' ? 25000 : 15000);
    this.isEphemeral = options.ephemeral || false;
    this.autoDefer = options.autoDefer !== false;

    this.state = ResponseState.UNACKNOWLEDGED;
    this.startTime = Date.now();
    this.completedTime = null;
    this.timeoutTimer = null;
    this.isDone = false;
    this.outcome = ExecutionOutcome.UNVERIFIED;
    this.error = null;

    // Track initial Discord state
    if (interaction.deferred) this.state = ResponseState.DEFERRED;
    if (interaction.replied) this.state = ResponseState.REPLIED;
  }

  /**
   * Prompts deferral of the interaction safely within the 3-second Discord window.
   */
  async defer(ephemeral = this.isEphemeral) {
    if (this.state !== ResponseState.UNACKNOWLEDGED) {
      return true; // Already acknowledged
    }

    if (this.interaction.deferred || this.interaction.replied) {
      this.state = this.interaction.replied ? ResponseState.REPLIED : ResponseState.DEFERRED;
      return true;
    }

    try {
      if (typeof this.interaction.deferReply === 'function') {
        await this.interaction.deferReply({ ephemeral });
        this.state = ResponseState.DEFERRED;
        return true;
      }
    } catch (err) {
      if (err.code === 10062 || err.code === 40060) {
        this.state = ResponseState.EXPIRED;
        logger.warn(`Interaction expired before deferral [${this.executionId}]: ${err.message}`);
      } else {
        logger.error(`Failed to defer interaction [${this.executionId}]`, { error: err.message });
      }
      return false;
    }
  }

  /**
   * Dispatches the final or updated response to Discord.
   * Chooses reply vs editReply vs followUp based on interaction state.
   */
  async respond(payload) {
    if (this.state === ResponseState.EXPIRED) {
      logger.warn(`Cannot respond: interaction token expired [${this.executionId}]`);
      return false;
    }

    const normalized = typeof payload === 'string' ? { content: payload } : { ...payload };

    try {
      if (this.state === ResponseState.DEFERRED || this.interaction.deferred) {
        if (typeof this.interaction.editReply === 'function') {
          await this.interaction.editReply(normalized);
          this.state = ResponseState.REPLIED;
          return true;
        }
      } else if (this.state === ResponseState.UNACKNOWLEDGED && !this.interaction.replied) {
        if (typeof this.interaction.reply === 'function') {
          await this.interaction.reply(normalized);
          this.state = ResponseState.REPLIED;
          return true;
        }
      } else {
        // Already replied, use followUp
        if (typeof this.interaction.followUp === 'function') {
          await this.interaction.followUp(normalized);
          return true;
        }
      }
    } catch (err) {
      if (err.code === 10062) {
        this.state = ResponseState.EXPIRED;
        logger.warn(`Interaction token expired during response [${this.executionId}]`);
      } else if (err.code === 40060) {
        logger.warn(`Interaction already acknowledged [${this.executionId}], attempting fallback followUp`);
        try {
          if (typeof this.interaction.followUp === 'function') {
            await this.interaction.followUp(normalized);
            return true;
          }
        } catch {}
      } else {
        logger.error(`Failed to deliver interaction response [${this.executionId}]`, { error: err.message });
      }
      return false;
    }

    return false;
  }

  /**
   * Responds with a sanitized, friendly error message.
   * Strips raw stack traces, tokens, and internal paths.
   */
  async respondWithError(errorMessage, category = 'Execution Error') {
    const sanitized = Logger.redactSecrets(errorMessage || 'An unexpected error occurred while executing this command.');
    // Strip file paths, URLs, and stack lines
    const cleanMessage = sanitized
      .replace(/(?:\r\n|\r|\n)\s*at\s+.*/g, '')
      .replace(/\s+at\s+.*$/m, '')
      .replace(/file:\/\/\S+/g, '[redacted_path]')
      .replace(/[A-Za-z]:\\[\w\\.-]+/g, '[redacted_path]')
      .trim();

    const content = `❌ **${category}:** ${cleanMessage}`;
    return await this.respond({
      content,
      embeds: [],
      components: []
    });
  }

  /**
   * Starts the hard execution timeout guard.
   */
  startTimeoutGuard(onTimeout) {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);

    this.timeoutTimer = setTimeout(async () => {
      if (this.isDone) return;
      this.isDone = true;
      this.outcome = ExecutionOutcome.TIMED_OUT;
      const durationMs = Date.now() - this.startTime;

      logger.warn(`Interaction timed out after ${durationMs}ms [${this.executionId}] for /${this.commandName}`);

      try {
        if (typeof onTimeout === 'function') {
          await onTimeout(this);
        } else {
          await this.respond({
            content: `⏳ **Operation Timed Out:** The command \`/${this.commandName}\` took longer than ${Math.round(this.timeoutMs / 1000)}s to complete. Any partial state changes have been safely recorded.`,
            embeds: [],
            components: []
          });
        }
      } catch (err) {
        logger.warn('Failed to send timeout response', { error: err.message });
      }
    }, this.timeoutMs);
    if (typeof this.timeoutTimer?.unref === 'function') {
      this.timeoutTimer.unref();
    }
  }

  /**
   * Concludes the interaction lifecycle.
   */
  finish(outcome = ExecutionOutcome.SUCCESS, details = {}) {
    if (this.isDone) return;
    this.isDone = true;
    this.outcome = outcome;
    this.completedTime = Date.now();
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    return {
      executionId: this.executionId,
      commandName: this.commandName,
      outcome: this.outcome,
      durationMs: this.completedTime - this.startTime,
      details
    };
  }
}
