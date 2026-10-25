import crypto from 'crypto';
import { PermissionFlagsBits } from 'discord.js';
import { Logger } from './logger.js';

const logger = new Logger('SecurityGate');

export class SecurityPolicyViolationError extends Error {
  constructor(message, violationCode = 'POLICY_VIOLATION', details = {}) {
    super(`🛑 Security Policy Violation [${violationCode}]: ${message}`);
    this.name = 'SecurityPolicyViolationError';
    this.violationCode = violationCode;
    this.details = details;
  }
}

/**
 * Immutable Central Security Gate and Anti-Nuke Engine.
 * Runs in deterministic Node.js code BEFORE every mutation.
 * CANNOT be bypassed, edited, disabled, or overridden by any prompt, user, or LLM output.
 */
export class SecurityGate {
  // Aggregate limits across a single task/session
  static AGGREGATE_LIMITS = {
    maxChannelDeletions: 2,
    maxRoleDeletions: 2,
    maxMemberBans: 3,
    maxMemberKicks: 3,
    maxPermissionWipes: 3
  };

  // Nuke & Sabotage pattern matchers (direct & disguised equivalents)
  static NUKE_PATTERNS = [
    /\bnuke\b/i,
    /delete\s+(all|every)\s+channels?/i,
    /delete\s+(all|every)\s+roles?/i,
    /remove\s+all\s+roles\s+from\s+everyone/i,
    /(kick|ban)\s+(everyone|all(\s+members)?)/i,
    /destroy\s+(this\s+|the\s+)?server/i,
    /wipe\s+(this\s+|the\s+)?server/i,
    /disable\s+(all|every)\s+channels?/i,
    /remove\s+all\s+admin(istrator)?\s+permissions?/i,
    /strip\s+all\s+(permissions?|access)/i,
    /purge\s+(all|every)\s+channels?/i
  ];

  // Prompt injection & jailbreak patterns
  static INJECTION_PATTERNS = [
    /ignore\s+(all\s+)?previous\s+instructions/i,
    /pretend\s+(the\s+)?owner\s+approved/i,
    /disable\s+(anti-?nuke|security|safety)\s*(mode|gate)?/i,
    /this\s+is\s+a\s+security\s+test[;,.]?\s*(delete|nuke|ban|kick)/i,
    /exempt\s+from\s+validation/i,
    /override\s+security\s+policy/i,
    /system\s*prompt\s*injection/i
  ];

  /**
   * Sanitizes external untrusted text (usernames, channel topics, messages).
   */
  static sanitizeUntrustedInput(text) {
    if (!text) return '';
    let sanitized = String(text);
    for (const pattern of this.INJECTION_PATTERNS) {
      sanitized = sanitized.replace(pattern, '[FILTERED_HOSTILE_INJECTION]');
    }
    return sanitized;
  }

  /**
   * Evaluates the raw user prompt and intent for server-nuke sabotage or prompt injection.
   */
  static evaluatePromptSecurity(prompt, userId, guild) {
    if (!prompt) return;

    // Check for prompt injection
    for (const pattern of this.INJECTION_PATTERNS) {
      if (pattern.test(prompt)) {
        logger.error('Hostile prompt injection attempt detected', { userId, pattern: pattern.toString() });
        throw new SecurityPolicyViolationError(
          'Prompt injection attempt detected and neutralized. Security instructions cannot be overridden.',
          'PROMPT_INJECTION_DETECTED',
          { prompt }
        );
      }
    }

    // Check for explicit or disguised server-nuke requests
    for (const pattern of this.NUKE_PATTERNS) {
      if (pattern.test(prompt)) {
        logger.error('Server nuke request blocked unconditionally', { userId, pattern: pattern.toString() });
        throw new SecurityPolicyViolationError(
          'Server sabotage, mass-wiping, or nuke requests are strictly prohibited by immutable Honey Bot security policy. This restriction applies to all users including the server owner.',
          'ANTI_NUKE_TRIGGERED',
          { pattern: pattern.toString() }
        );
      }
    }
  }

  /**
   * Evaluates planned action sequence against aggregate destruction limits and forbidden mutations.
   * Runs before ANY action can be scheduled or confirmed.
   */
  static evaluateActionSequence(actions, invokingMember, guild) {
    if (!actions || !Array.isArray(actions) || actions.length === 0) return;

    let channelDeletions = 0;
    let roleDeletions = 0;
    let memberBans = 0;
    let memberKicks = 0;

    for (const act of actions) {
      const actionType = act.action;

      // 1. Check for Privilege Escalation (Granting Administrator)
      if (actionType === 'create_role' || actionType === 'edit_role') {
        const perms = act.permissions || [];
        const hasAdmin = perms.includes('Administrator') || perms.includes(PermissionFlagsBits.Administrator?.toString());
        if (hasAdmin) {
          logger.error('Unauthorized privilege escalation attempt blocked', { action: actionType });
          throw new SecurityPolicyViolationError(
            'Granting Administrator permissions via automated agent is prohibited to prevent privilege escalation.',
            'UNAUTHORIZED_ADMIN_GRANT',
            { action: act }
          );
        }
      }

      // 2. Protect Server Owner from any moderation action
      if (['ban_member', 'kick_member', 'timeout_member'].includes(actionType)) {
        const targetId = act.targetMember || act.targetMemberId;
        if (targetId && (targetId === guild?.ownerId || String(targetId) === String(guild?.ownerId))) {
          logger.error('Prohibited moderation action against Server Owner', { targetId });
          throw new SecurityPolicyViolationError(
            'The Server Owner is permanently immune to moderation actions. Kicking, banning, or timing out the server owner is strictly prohibited.',
            'PROTECTED_RESOURCE_VIOLATION',
            { targetId }
          );
        }
      }

      // 3. Protect Honey Bot from moderating itself
      if (['ban_member', 'kick_member', 'timeout_member'].includes(actionType)) {
        const botId = guild?.members?.me?.id;
        const targetId = act.targetMember || act.targetMemberId;
        if (targetId && botId && String(targetId) === String(botId)) {
          throw new SecurityPolicyViolationError(
            'Honey Bot cannot moderate or ban itself.',
            'PROTECTED_RESOURCE_VIOLATION'
          );
        }
      }

      // Track destructive counts
      if (actionType === 'delete_channel') channelDeletions++;
      if (actionType === 'delete_role') roleDeletions++;
      if (actionType === 'ban_member') memberBans++;
      if (actionType === 'kick_member') memberKicks++;
    }

    // 4. Enforce Aggregate Destruction Limits (Anti-Nuke Safeguard)
    if (channelDeletions > this.AGGREGATE_LIMITS.maxChannelDeletions) {
      throw new SecurityPolicyViolationError(
        `Anti-Nuke Triggered: Request deletes ${channelDeletions} channels, exceeding the safe aggregate limit (${this.AGGREGATE_LIMITS.maxChannelDeletions}). Bulk channel deletion is blocked.`,
        'AGGREGATE_LIMIT_EXCEEDED',
        { channelDeletions, limit: this.AGGREGATE_LIMITS.maxChannelDeletions }
      );
    }

    if (roleDeletions > this.AGGREGATE_LIMITS.maxRoleDeletions) {
      throw new SecurityPolicyViolationError(
        `Anti-Nuke Triggered: Request deletes ${roleDeletions} roles, exceeding the safe aggregate limit (${this.AGGREGATE_LIMITS.maxRoleDeletions}). Bulk role deletion is blocked.`,
        'AGGREGATE_LIMIT_EXCEEDED',
        { roleDeletions, limit: this.AGGREGATE_LIMITS.maxRoleDeletions }
      );
    }

    if (memberBans > this.AGGREGATE_LIMITS.maxMemberBans || memberKicks > this.AGGREGATE_LIMITS.maxMemberKicks) {
      throw new SecurityPolicyViolationError(
        'Anti-Nuke Triggered: Mass kick/ban operation blocked. Moderation actions must be targeted and bounded.',
        'AGGREGATE_LIMIT_EXCEEDED'
      );
    }
  }

  /**
   * Cryptographically binds a confirmation token to the exact action sequence and user ID.
   * Prevents confirmation parameter tampering or reuse attacks.
   */
  static generateConfirmationToken(userId, guildId, actionSequence) {
    const serialized = JSON.stringify({ userId, guildId, actionSequence });
    return crypto.createHash('sha256').update(serialized).digest('hex').substring(0, 32);
  }

  /**
   * Verifies that a received confirmation token matches the exact proposed actions.
   */
  static verifyConfirmationToken(token, userId, guildId, actionSequence) {
    const expected = this.generateConfirmationToken(userId, guildId, actionSequence);
    return token === expected;
  }
}
