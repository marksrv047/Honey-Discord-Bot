/**
 * Module 5: Moderation and Safety
 * 
 * Defines capabilities, constraints, phrasing distinctions, and safety rules
 * for disciplinary actions (timeout, kick, ban, unban, warnings).
 */

export const MODERATION_CAPABILITIES = {
  timeout_member: {
    action: 'timeout_member',
    category: 'MODERATION',
    description: 'Temporarily restricts a member from sending messages, speaking, or reacting (communication disable).',
    phrasings: [
      'timeout Alex for ten minutes',
      'stop Alex from chatting for ten minutes',
      'temporarily restrict Alex from sending messages',
      'shush @user for 1 hour',
      'mute Alex for 15m'
    ],
    requiredArgs: ['targetMember', 'durationMinutes'],
    optionalArgs: ['reason'],
    constraints: {
      minMinutes: 1,
      maxMinutes: 40320, // 28 days Discord API limit
      hierarchyCheckRequired: true
    },
    riskLevel: 'MEDIUM',
    isReversible: true,
    undoAction: 'remove_timeout'
  },
  remove_timeout: {
    action: 'remove_timeout',
    category: 'MODERATION',
    description: 'Removes an active communication timeout from a member early.',
    phrasings: [
      'remove timeout from Alex',
      'unmute Alex',
      'let Alex speak again'
    ],
    requiredArgs: ['targetMember'],
    riskLevel: 'LOW',
    isReversible: true
  },
  kick_member: {
    action: 'kick_member',
    category: 'MODERATION',
    description: 'Expels a member from the server. Member can rejoin if they have a valid invite.',
    phrasings: [
      'kick Alex',
      'remove Alex from the server',
      'get Alex out of here',
      'can you boot Alex',
      'yeet @user from the server',
      'remove Alex from the server, but don’t permanently ban them'
    ],
    requiredArgs: ['targetMember'],
    optionalArgs: ['reason'],
    constraints: {
      hierarchyCheckRequired: true,
      cannotKickOwner: true
    },
    riskLevel: 'HIGH',
    requiresConfirmation: false,
    isReversible: false,
    warning: 'Member is immediately removed but retains ability to rejoin with an invite link.'
  },
  ban_member: {
    action: 'ban_member',
    category: 'MODERATION',
    description: 'Permanently bans a member from the guild and IP, optionally deleting recent messages.',
    phrasings: [
      'ban this member',
      'permanently expel @spammer',
      'ban Alex for raiding',
      'drop the banhammer on @attacker'
    ],
    requiredArgs: ['targetMember'],
    optionalArgs: ['reason', 'deleteMessageDays'],
    constraints: {
      hierarchyCheckRequired: true,
      cannotBanOwner: true,
      deleteMessageDaysMax: 7
    },
    riskLevel: 'HIGH',
    requiresConfirmation: true,
    isReversible: true,
    undoAction: 'unban_member'
  },
  unban_member: {
    action: 'unban_member',
    category: 'MODERATION',
    description: 'Lifts a ban from a user by ID or tag, allowing them to rejoin.',
    phrasings: [
      'unban user 123456789',
      'lift the ban on Alex',
      'revoke ban for @user'
    ],
    requiredArgs: ['targetUser'],
    riskLevel: 'MEDIUM',
    isReversible: false
  },
  warn_user: {
    action: 'warn_user',
    category: 'MODERATION',
    description: 'Issues a formal recorded warning to a member without immediate expulsion.',
    phrasings: [
      'warn Alex for excessive caps',
      'give a warning to @user for swearing',
      'record a warning against Alex'
    ],
    requiredArgs: ['targetMember', 'reason'],
    riskLevel: 'LOW',
    isReversible: true,
    undoAction: 'clear_warnings'
  }
};

/**
 * Distinguishes moderation severity from everyday phrasing.
 * Ensures the bot never escalates an ambiguous request into a permanent ban without clarification.
 */
export function classifyModerationIntent(phrase) {
  const p = phrase.toLowerCase();
  
  if (/\b(?:perm(?:anent(?:ly)?)?|forever|never let (?:them|him|her) back)\b/i.test(p) && /\b(?:ban|kick|remove|expel|out)\b/i.test(p)) {
    return { candidateAction: 'ban_member', confidence: 0.9, requiresConfirmation: true };
  }
  if (/\b(?:temporar(?:y|ily)|for \d+\s*(?:m|min|minute|h|hour|d|day)s?|mute|shush|silence|gag)\b/i.test(p)) {
    return { candidateAction: 'timeout_member', confidence: 0.9, requiresConfirmation: false };
  }
  if (/\b(?:kick|boot|yeet|toss|eject)\b/i.test(p) && !/\b(?:ban|perm)\b/i.test(p)) {
    return { candidateAction: 'kick_member', confidence: 0.9, requiresConfirmation: false };
  }
  // Avoid triggering on non-member removals (roles, channels, nicknames, timeouts, messages, permissions)
  if (/\b(?:role|nickname|timeout|permission|message|channel|category)\b/i.test(p)) {
    return null;
  }

  if (/\b(?:get\s+rid\s+of\s+(@?\w+)|get\s+(@?\w+)\s+out\s+of\s+here|i\s+need\s+(@?\w+)\s+gone(?:\s+from\s+this\s+server)?)\b/i.test(p)) {
    const match = phrase.match(/\b(?:get\s+rid\s+of\s+(@?\w+)|get\s+(@?\w+)\s+out\s+of\s+here|i\s+need\s+(@?\w+)\s+gone(?:\s+from\s+this\s+server)?)\b/i);
    const target = match ? (match[1] || match[2] || match[3] || 'this member') : 'this member';
    return {
      candidateAction: 'ambiguous_moderation',
      confidence: 0.4,
      requiresClarification: true,
      clarificationQuestion: `Would you like to kick, permanently ban, or temporarily timeout ${target}?`
    };
  }

  return null;
}
