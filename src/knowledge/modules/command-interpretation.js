/**
 * Module 2: Discord Command Interpretation
 * 
 * Maps human natural-language requests into the bot's authoritative registered commands.
 * Grounding Rule: The bot exposes 6 registered slash commands:
 *   1. /go <instruction>
 *   2. /modlog [query] [limit]
 *   3. /diagnose
 *   4. /undo
 *   5. /help [topic]
 *   6. /honeypot <setup|status|disable|test>
 * 
 * Any natural-language administration task without a specialized top-level command
 * is executed via the universal autonomous engine powered by /go.
 */

export const REGISTERED_SLASH_COMMANDS = {
  go: {
    command: '/go',
    name: 'go',
    description: 'Execute an autonomous administrative instruction using everyday English.',
    usage: '/go instruction:<your instruction>',
    isAutonomous: true,
    supportedPhrasings: [
      'create a role called VIP',
      'lock this channel',
      'play lofi hip hop in voice chat',
      'kick the spammer',
      'clean up 20 messages'
    ]
  },
  modlog: {
    command: '/modlog',
    name: 'modlog',
    description: 'Inspect recent moderation incidents, honeypot alerts, and audit history.',
    usage: '/modlog [query:<filter>] [limit:<1-50>]',
    isAutonomous: false,
    supportedPhrasings: [
      'show me recent moderation incidents',
      'view mod logs for @user',
      'what did the mods do yesterday',
      'check ban history',
      'audit log summary'
    ]
  },
  diagnose: {
    command: '/diagnose',
    name: 'diagnose',
    description: 'Run comprehensive self-diagnostics, latency checks, and safe recovery.',
    usage: '/diagnose',
    isAutonomous: false,
    supportedPhrasings: [
      'diagnose bot',
      'run diagnostics',
      'check bot health',
      'is everything working properly',
      'test latency and Groq connectivity'
    ]
  },
  undo: {
    command: '/undo',
    name: 'undo',
    description: 'Interactively review and reverse the most recently executed administrative task.',
    usage: '/undo',
    isAutonomous: false,
    supportedPhrasings: [
      'undo the last action',
      'revert what you just did',
      'undo last task',
      'restore previous state'
    ]
  },
  help: {
    command: '/help',
    name: 'help',
    description: 'View the interactive user guide, capability registry, and operational manual.',
    usage: '/help [topic:<roles|channels|moderation|music|diagnostics>]',
    isAutonomous: false,
    supportedPhrasings: [
      'help',
      'how do I use Honey',
      'what can you do',
      'list available commands',
      'show permissions required'
    ]
  },
  honeypot: {
    command: '/honeypot',
    name: 'honeypot',
    description: 'Configure, inspect, enable, disable, and test honeypot decoy channels for compromised account defense.',
    usage: '/honeypot <setup|status|disable|test>',
    isAutonomous: false,
    supportedPhrasings: [
      'setup honeypot',
      'honeypot status',
      'test honeypot',
      'disable honeypot',
      'configure decoy channel'
    ]
  }
};

/**
 * Determines whether a user's natural-language request is a direct candidate
 * for one of the specialized non-/go commands or should be routed to /go.
 */
export function interpretCommandRoute(prompt) {
  const clean = prompt.trim().toLowerCase();

  // Diagnostics fast-match
  if (/^(?:run\s+)?diagnos(?:e|tics)|check\s+(?:bot\s+)?health|bot\s+status|system\s+check$/i.test(clean)) {
    return {
      command: '/diagnose',
      commandName: 'diagnose',
      args: {}
    };
  }

  // Undo fast-match
  if (/^undo(?:\s+(?:the\s+)?(?:last\s+)?(?:one|action|task|change))?$/i.test(clean) || /^revert(?:\s+last)?$/i.test(clean)) {
    return {
      command: '/undo',
      commandName: 'undo',
      args: {}
    };
  }

  // Modlog fast-match (pure read inspection)
  if (/^(?:view|show|check|inspect|display)\s+(?:the\s+)?(?:modlog|mod\s*logs?|moderation\s+logs?|audit\s+history)$/i.test(clean)) {
    return {
      command: '/modlog',
      commandName: 'modlog',
      args: {}
    };
  }

  // Honeypot fast-match
  if (/^(?:setup|configure|check|view|test|disable)?\s*honeypot(?:\s+(?:status|setup|test|disable))?$/i.test(clean)) {
    return {
      command: '/honeypot',
      commandName: 'honeypot',
      args: {}
    };
  }

  // Help fast-match
  if (/^(?:help|commands|how\s+to\s+use|what\s+can\s+you\s+do)$/i.test(clean)) {
    return {
      command: '/help',
      commandName: 'help',
      args: {}
    };
  }

  // Default: All administrative and autonomous operations run through /go
  return {
    command: '/go',
    commandName: 'go',
    args: { instruction: prompt.trim() }
  };
}
