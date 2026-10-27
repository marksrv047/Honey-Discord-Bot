/**
 * Failure Diagnostics & Categorization Engine for Honey Bot.
 * 
 * Provides explicit, structured taxonomy for failure reporting without
 * leaking credentials, bot tokens, or private context:
 * - AMBIGUOUS_REQUEST
 * - MISSING_TARGET_OR_PARAMETER
 * - UNSUPPORTED_CAPABILITY
 * - PERMISSION_DENIED
 * - DISCORD_API_ERROR
 * - LLM_RATE_LIMIT_OR_TOKEN_LIMIT
 * - DEPENDENCY_OR_EXTERNAL_FAILURE
 * - PARTIAL_EXECUTION
 * - VERIFICATION_FAILURE
 */

export const FailureCategory = Object.freeze({
  AMBIGUOUS_REQUEST: 'AMBIGUOUS_REQUEST',
  MISSING_TARGET_OR_PARAMETER: 'MISSING_TARGET_OR_PARAMETER',
  UNSUPPORTED_CAPABILITY: 'UNSUPPORTED_CAPABILITY',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  DISCORD_API_ERROR: 'DISCORD_API_ERROR',
  LLM_RATE_LIMIT_OR_TOKEN_LIMIT: 'LLM_RATE_LIMIT_OR_TOKEN_LIMIT',
  RATE_LIMITED: 'LLM_RATE_LIMIT_OR_TOKEN_LIMIT',
  MEMBER_HIERARCHY_BLOCKED: 'PERMISSION_DENIED',
  DEPENDENCY_OR_EXTERNAL_FAILURE: 'DEPENDENCY_OR_EXTERNAL_FAILURE',
  PARTIAL_EXECUTION: 'PARTIAL_EXECUTION',
  VERIFICATION_FAILURE: 'VERIFICATION_FAILURE',
  UNKNOWN: 'UNKNOWN'
});

export class FailureDiagnostics {
  /**
   * Sanitizes error message to strip sensitive credentials and tokens.
   */
  static sanitize(msg) {
    if (!msg || typeof msg !== 'string') return '';
    return msg
      .replace(/(?:ghp_[a-zA-Z0-9]{15,}|token=[a-zA-Z0-9_\-.]+)/gi, '[REDACTED_CREDENTIAL]')
      .replace(/(?:Bot\s+[a-zA-Z0-9_\-.]{20,})/gi, '[REDACTED_BOT_TOKEN]');
  }

  /**
   * Categorizes an error or failure condition into an explicit category.
   * 
   * @param {Error|string} error The error or error message
   * @param {object} context Diagnostic context (action, target, stage)
   * @returns {{
   *   category: string,
   *   userMessage: string,
   *   remediation: string,
   *   suggestedFix: string,
   *   error: string,
   *   details: object
   * }}
   */
  static categorize(error, context = {}) {
    const rawMessage = typeof error === 'string' ? error : error?.message || 'An unspecified error occurred';
    const message = this.sanitize(rawMessage);
    const lower = message.toLowerCase();
    const stage = context.stage || '';

    // 1. Ambiguity
    if (
      lower.includes('ambiguous') ||
      lower.includes('multiple matching') ||
      lower.includes('clarification needed') ||
      stage === 'clarification'
    ) {
      return {
        category: FailureCategory.AMBIGUOUS_REQUEST,
        userMessage: 'The request is ambiguous or references multiple potential targets.',
        remediation: 'Specify the exact channel, role, or user name/mention.',
        suggestedFix: 'Specify the exact channel, role, or user name/mention.',
        error: message,
        details: { message, ...context }
      };
    }

    // 2. Missing target or required parameters
    if (
      lower.includes('missing') ||
      lower.includes('no replacement nickname') ||
      lower.includes('please provide') ||
      lower.includes('required parameter')
    ) {
      return {
        category: FailureCategory.MISSING_TARGET_OR_PARAMETER,
        userMessage: 'A required target or parameter is missing.',
        remediation: 'Provide the missing parameter in your instruction.',
        suggestedFix: 'Provide the missing parameter in your instruction.',
        error: message,
        details: { message, ...context }
      };
    }

    // 3. Permission Denied & Role Hierarchy
    if (
      lower.includes('missing permissions') ||
      lower.includes('permission') ||
      lower.includes('unauthorized') ||
      lower.includes('access denied') ||
      lower.includes('role hierarchy') ||
      lower.includes('hierarchy error') ||
      stage === 'permission_denied' ||
      stage === 'authorization'
    ) {
      return {
        category: FailureCategory.PERMISSION_DENIED,
        userMessage: 'Insufficient permissions or role hierarchy violation.',
        remediation: 'Ensure Honey Bot has the necessary permissions and its role is positioned above the target in Server Settings > Roles.',
        suggestedFix: 'Ensure Honey Bot has the necessary permissions and its role is positioned above the target in Server Settings > Roles.',
        error: message,
        details: { message, ...context }
      };
    }

    // 4. Rate limit or Token limits
    if (
      lower.includes('rate limit') ||
      lower.includes('429') ||
      lower.includes('token exhaustion') ||
      lower.includes('tokens') ||
      lower.includes('quota')
    ) {
      return {
        category: FailureCategory.LLM_RATE_LIMIT_OR_TOKEN_LIMIT,
        userMessage: 'Inference rate limit or token limit encountered.',
        remediation: 'Please wait a few moments before trying again.',
        suggestedFix: 'Please wait a few moments before trying again.',
        error: message,
        details: { message, ...context }
      };
    }

    // 5. Discord API Error
    if (
      lower.includes('discord api') ||
      lower.includes('50001') ||
      lower.includes('50013') ||
      lower.includes('unknown channel') ||
      lower.includes('unknown role')
    ) {
      return {
        category: FailureCategory.DISCORD_API_ERROR,
        userMessage: 'Discord rejected the API request.',
        remediation: 'Check if the channel or role exists and bot permissions are active.',
        suggestedFix: 'Check if the channel or role exists and bot permissions are active.',
        error: message,
        details: { message, ...context }
      };
    }

    // 6. Verification Failure
    if (
      lower.includes('verification failed') ||
      lower.includes('not verified') ||
      lower.includes('mismatch') ||
      stage === 'verification'
    ) {
      return {
        category: FailureCategory.VERIFICATION_FAILURE,
        userMessage: 'The action completed but the expected server state could not be verified.',
        remediation: 'Use /diagnose to inspect the server state or retry the operation.',
        suggestedFix: 'Use /diagnose to inspect the server state or retry the operation.',
        error: message,
        details: { message, ...context }
      };
    }

    // 7. Partial Execution
    if (
      lower.includes('partially') ||
      stage === 'partial_execution'
    ) {
      return {
        category: FailureCategory.PARTIAL_EXECUTION,
        userMessage: 'Some requested operations succeeded while others failed.',
        remediation: 'Review the partial completion report and retry the remaining steps.',
        suggestedFix: 'Review the partial completion report and retry the remaining steps.',
        error: message,
        details: { message, ...context }
      };
    }

    // 8. Unsupported Capability
    if (
      lower.includes('unsupported') ||
      lower.includes('unregistered capability') ||
      lower.includes('cannot perform')
    ) {
      return {
        category: FailureCategory.UNSUPPORTED_CAPABILITY,
        userMessage: 'This capability is not supported by Honey Bot.',
        remediation: 'Use /help to discover supported server management commands.',
        suggestedFix: 'Use /help to discover supported server management commands.',
        error: message,
        details: { message, ...context }
      };
    }

    return {
      category: FailureCategory.UNKNOWN,
      userMessage: `An error occurred: ${message}`,
      remediation: 'Use /diagnose to inspect bot health.',
      suggestedFix: 'Use /diagnose to inspect bot health.',
      error: message,
      details: { message, ...context }
    };
  }
}
