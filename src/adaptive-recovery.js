import { Logger } from './logger.js';

const logger = new Logger('AdaptiveRecovery');

/**
 * Standard Failure Taxonomies
 */
export const FailureCategory = {
  INTERPRETATION_ERROR: 'INTERPRETATION_ERROR',
  MISSING_PARAMETERS: 'MISSING_PARAMETERS',
  INVALID_TARGET: 'INVALID_TARGET',
  INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  DISCORD_API_ERROR: 'DISCORD_API_ERROR',
  UNSUPPORTED_CAPABILITY: 'UNSUPPORTED_CAPABILITY',
  PROVIDER_RATE_LIMIT: 'PROVIDER_RATE_LIMIT',
  INVALID_MEDIA_SOURCE: 'INVALID_MEDIA_SOURCE',
  PLAYBACK_ERROR: 'PLAYBACK_ERROR',
  TIMEOUT_ERROR: 'TIMEOUT_ERROR',
  PERSISTENCE_FAILURE: 'PERSISTENCE_FAILURE',
  UNKNOWN: 'UNKNOWN'
};

/**
 * Adaptive Recovery Strategies
 */
export const RecoveryStrategy = {
  BOUNDED_RETRY: 'BOUNDED_RETRY',
  CLARIFY_REQUEST: 'CLARIFY_REQUEST',
  EXPLAIN_LIMITATION: 'EXPLAIN_LIMITATION',
  RECONCILE_AND_PARTIAL: 'RECONCILE_AND_PARTIAL',
  ROLLBACK_ATOMIC: 'ROLLBACK_ATOMIC',
  SAFE_FALLBACK: 'SAFE_FALLBACK',
  MANUAL_INTERVENTION_NEEDED: 'MANUAL_INTERVENTION_NEEDED'
};

/**
 * Adaptive Recovery and Diagnostics Engine
 */
export class AdaptiveRecoveryEngine {
  /**
   * Classifies an error into an actionable failure taxonomy.
   */
  static classifyFailure(err) {
    if (!err) return { category: FailureCategory.UNKNOWN, retryable: false };

    const message = (err.message || String(err)).toLowerCase();
    const code = err.code || err.status;

    // 1. Provider Rate Limits & Quotas
    if (code === 429 || message.includes('rate limit') || message.includes('quota') || message.includes('tpm') || message.includes('rpm')) {
      return {
        category: FailureCategory.PROVIDER_RATE_LIMIT,
        retryable: true,
        backoffSeconds: 30,
        strategy: RecoveryStrategy.BOUNDED_RETRY,
        userGuidance: 'AI inference rate limit reached. Backing off temporarily.'
      };
    }

    // 2. Insufficient Permissions & Hierarchy
    if (code === 50013 || message.includes('missing permissions') || message.includes('hierarchy') || message.includes('higher than')) {
      return {
        category: FailureCategory.INSUFFICIENT_PERMISSIONS,
        retryable: false,
        strategy: RecoveryStrategy.EXPLAIN_LIMITATION,
        userGuidance: 'Bot or user lacks required Discord permissions or the target is higher in role hierarchy.'
      };
    }

    // 3. Invalid Target Resolution
    if (code === 10003 || code === 10011 || code === 10007 || message.includes('unknown channel') || message.includes('unknown role') || message.includes('unknown member') || message.includes('not found in guild')) {
      return {
        category: FailureCategory.INVALID_TARGET,
        retryable: false,
        strategy: RecoveryStrategy.CLARIFY_REQUEST,
        userGuidance: 'The target channel, role, or user was not found. Please specify by mentioning (#channel or @user).'
      };
    }

    // 4. Missing Parameters
    if (message.includes('missing parameter') || message.includes('no name specified') || message.includes('duration required')) {
      return {
        category: FailureCategory.MISSING_PARAMETERS,
        retryable: false,
        strategy: RecoveryStrategy.CLARIFY_REQUEST,
        userGuidance: 'Essential parameter missing. Clarification requested.'
      };
    }

    // 5. Unsupported Capabilities
    if (message.includes('unsupported') || message.includes('not implemented') || message.includes('prohibited')) {
      return {
        category: FailureCategory.UNSUPPORTED_CAPABILITY,
        retryable: false,
        strategy: RecoveryStrategy.EXPLAIN_LIMITATION,
        userGuidance: 'The requested operation is not supported by Discord or bot security policy.'
      };
    }

    // 6. Media and Audio Source Errors
    if (message.includes('status code: 410') || message.includes('sign in') || message.includes('age-restricted') || message.includes('private video') || message.includes('unsupported format')) {
      return {
        category: FailureCategory.INVALID_MEDIA_SOURCE,
        retryable: false,
        strategy: RecoveryStrategy.SAFE_FALLBACK,
        userGuidance: 'Audio source unavailable or restricted. Try searching by artist and track name.'
      };
    }

    // 7. Voice Connection & Playback
    if (message.includes('voice connection') || message.includes('ffmpeg') || message.includes('audio player') || message.includes('stream')) {
      return {
        category: FailureCategory.PLAYBACK_ERROR,
        retryable: true,
        strategy: RecoveryStrategy.BOUNDED_RETRY,
        userGuidance: 'Voice streaming interrupted. Attempting single reconnect.'
      };
    }

    // 8. Timeouts
    if (message.includes('timed out') || message.includes('etimedout') || message.includes('timeout')) {
      return {
        category: FailureCategory.TIMEOUT_ERROR,
        retryable: true,
        strategy: RecoveryStrategy.RECONCILE_AND_PARTIAL,
        userGuidance: 'Operation timed out. Reconciling completed steps before resuming.'
      };
    }

    // 9. Persistence Errors
    if (message.includes('enoent') || message.includes('eacces') || message.includes('failed to persist')) {
      return {
        category: FailureCategory.PERSISTENCE_FAILURE,
        retryable: false,
        strategy: RecoveryStrategy.MANUAL_INTERVENTION_NEEDED,
        userGuidance: 'Data persistence error. State maintained in memory.'
      };
    }

    // 10. Discord API Errors (General)
    if (code >= 500 || message.includes('discord api') || message.includes('network')) {
      return {
        category: FailureCategory.DISCORD_API_ERROR,
        retryable: true,
        strategy: RecoveryStrategy.BOUNDED_RETRY,
        userGuidance: 'Discord API transient error. Backoff and retry scheduled.'
      };
    }

    return {
      category: FailureCategory.UNKNOWN,
      retryable: false,
      strategy: RecoveryStrategy.EXPLAIN_LIMITATION,
      userGuidance: 'An unexpected error occurred during execution.'
    };
  }

  /**
   * Generates a truthful multi-step execution summary separating verified,
   * failed, skipped, and unverified actions.
   */
  static generateTruthfulReport(planActions, executionResults = []) {
    const succeeded = [];
    const failed = [];
    const skipped = [];
    const unverified = [];

    for (const action of planActions) {
      const match = executionResults.find(r => r.action === action.action);
      if (!match) {
        skipped.push({ action: action.action, reason: 'Step was not reached.' });
        continue;
      }

      if (match.status === 'COMPLETED' && match.verified) {
        succeeded.push({ action: action.action, details: match.details || 'Verified' });
      } else if (match.status === 'UNVERIFIED' || match.verificationStatus === 'inconclusive') {
        unverified.push({ action: action.action, details: match.details || 'Completed but unconfirmed by Discord state' });
      } else if (match.status === 'SKIPPED') {
        skipped.push({ action: action.action, reason: match.details || 'Prerequisite step failed' });
      } else {
        failed.push({ action: action.action, error: match.details || match.observedOutcome || 'Action failed' });
      }
    }

    return {
      isFullySuccessful: failed.length === 0 && unverified.length === 0 && skipped.length === 0,
      hasPartialSuccess: succeeded.length > 0 && (failed.length > 0 || skipped.length > 0),
      succeeded,
      failed,
      skipped,
      unverified,
      summary: `Completed: ${succeeded.length}, Failed: ${failed.length}, Skipped: ${skipped.length}, Unverified: ${unverified.length}`
    };
  }
}
