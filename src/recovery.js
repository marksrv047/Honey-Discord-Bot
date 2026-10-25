import { Logger } from './logger.js';

const logger = new Logger('Recovery');

/**
 * Classifies Discord API errors into actionable categories.
 */
export function classifyDiscordError(err) {
  const code = err.code || err.status;
  const message = err.message || '';

  if (code === 50013 || message.includes('Missing Permissions')) {
    return {
      type: 'PERMISSION_ERROR',
      retryable: false,
      userMessage: 'Discord rejected the action: Bot lacks required permissions or role hierarchy is too low.'
    };
  }

  if (code === 50035 || message.includes('Invalid Form Body')) {
    return {
      type: 'VALIDATION_ERROR',
      retryable: false,
      userMessage: `Invalid parameter sent to Discord API: ${message}`
    };
  }

  if (code === 429 || message.includes('rate limit')) {
    return {
      type: 'RATE_LIMIT',
      retryable: true,
      userMessage: 'Discord rate limit hit. Request will backoff and retry safely.'
    };
  }

  if (code === 10003 || message.includes('Unknown Channel')) {
    return {
      type: 'RESOURCE_NOT_FOUND',
      retryable: false,
      userMessage: 'The target channel does not exist or was deleted.'
    };
  }

  if (code === 10011 || message.includes('Unknown Role')) {
    return {
      type: 'RESOURCE_NOT_FOUND',
      retryable: false,
      userMessage: 'The target role does not exist or was deleted.'
    };
  }

  return {
    type: 'UNKNOWN_ERROR',
    retryable: false,
    userMessage: message || 'An unexpected error occurred during execution.'
  };
}

/**
 * Audit ledger for rollback tracking.
 * Stores created resources per execution ID so users can safely undo bot actions.
 */
export class ActionLedger {
  static history = new Map(); // executionId -> Array of created resources

  static recordCreatedResource(executionId, type, id, name) {
    if (!this.history.has(executionId)) {
      this.history.set(executionId, []);
    }
    this.history.get(executionId).push({ type, id, name, timestamp: Date.now() });
  }

  static getCreatedResources(executionId) {
    return this.history.get(executionId) || [];
  }

  static getLastExecution(guildId) {
    // Returns the most recent execution with created resources
    const entries = Array.from(this.history.entries()).reverse();
    return entries.length > 0 ? entries[0] : null;
  }

  /**
   * Safely rolls back resources created in a specific execution.
   */
  static async rollbackExecution(guild, executionId) {
    const resources = this.history.get(executionId);
    if (!resources || resources.length === 0) {
      return { success: false, message: 'No created resources found for this execution to undo.' };
    }

    const report = [];

    for (const res of [...resources].reverse()) {
      try {
        if (res.type === 'channel') {
          const ch = guild.channels.cache.get(res.id);
          if (ch) {
            await ch.delete('Rollback of execution ' + executionId);
            report.push(`Deleted channel #${res.name}`);
          }
        } else if (res.type === 'role') {
          const role = guild.roles.cache.get(res.id);
          if (role) {
            await role.delete('Rollback of execution ' + executionId);
            report.push(`Deleted role @${res.name}`);
          }
        }
      } catch (err) {
        logger.error(`Failed to rollback resource ${res.name}`, { error: err.message });
        report.push(`Failed to delete ${res.type} ${res.name}: ${err.message}`);
      }
    }

    this.history.delete(executionId);
    return { success: true, report };
  }
}
