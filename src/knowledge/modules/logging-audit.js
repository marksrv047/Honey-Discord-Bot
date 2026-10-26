/**
 * Module 8: Logging and Audit History
 * 
 * Defines capabilities, inspection queries, and channel configuration for
 * security events, moderation audit logs, and honeypot records.
 */

export const LOGGING_CAPABILITIES = {
  inspect_modlog: {
    action: 'inspect_modlog',
    category: 'LOGGING',
    description: 'Inspects recent moderation records, safety alerts, or incident logs.',
    phrasings: [
      'show me the last few moderation incidents',
      'what is the modlog channel',
      'where is the modlog channel',
      'state the modlog channel',
      'modlog status',
      'view mod logs for today'
    ],
    optionalArgs: ['query', 'limit'],
    constraints: {
      defaultLimit: 10,
      maxLimit: 50
    },
    riskLevel: 'LOW',
    isDestructive: false
  },
  setup_modlog: {
    action: 'setup_modlog',
    category: 'LOGGING',
    description: 'Designates or creates a dedicated channel for security and audit logs.',
    phrasings: [
      'set up modlog in #mod-logs',
      'create a modlog channel',
      'set up modlog',
      'enable audit logging in #security-log'
    ],
    requiredArgs: ['targetChannel'],
    riskLevel: 'LOW',
    isReversible: true
  }
};
