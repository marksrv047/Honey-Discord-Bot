/**
 * Module 7: Message Search and Management
 * 
 * Defines message manipulation capabilities, bulk purge policies, search boundaries,
 * and pin management.
 * 
 * CRITICAL SAFETY INVARIANT:
 * Searching or reading messages must NEVER trigger deletion or modification.
 */

export const MESSAGE_CAPABILITIES = {
  purge_messages: {
    action: 'purge_messages',
    category: 'MESSAGING',
    description: 'Bulk deletes a specified number of recent messages from a channel.',
    phrasings: [
      'delete 20 messages in #general',
      'purge 50 messages',
      'clean up the last 15 messages',
      'clear 10 messages from chat'
    ],
    requiredArgs: ['targetChannel', 'count'],
    constraints: {
      minCount: 1,
      maxCount: 100, // Anti-nuke batch limit
      discordAgeLimitDays: 14 // Discord API rejects bulk delete for messages older than 14 days
    },
    riskLevel: 'HIGH',
    requiresConfirmation: false, // confirmed dynamically if count > 20
    isDestructive: true,
    isReversible: false,
    warning: 'Bulk deleted messages cannot be recovered from Discord.'
  },
  search_messages: {
    action: 'search_messages',
    category: 'MESSAGING',
    description: 'Searches recent channel messages matching a query without altering or deleting them.',
    phrasings: [
      'find today’s spam messages',
      'search for messages mentioning giveaway',
      'find messages from Alex in #general',
      'show recent messages containing discord.gg'
    ],
    requiredArgs: ['targetChannel'],
    optionalArgs: ['query', 'author', 'limit'],
    constraints: {
      defaultLimit: 25,
      maxLimit: 100
    },
    riskLevel: 'LOW',
    isDestructive: false,
    isReversible: true,
    safetyRule: 'SEARCH IS STRICTLY READ-ONLY. NEVER DELETE MESSAGES DURING A SEARCH.'
  },
  pin_message: {
    action: 'pin_message',
    category: 'MESSAGING',
    description: 'Pins an important message to the top of a channel.',
    phrasings: [
      'pin message 123456789 in #announcements',
      'pin that message'
    ],
    requiredArgs: ['targetChannel', 'messageId'],
    constraints: {
      maxPinsPerChannel: 50
    },
    riskLevel: 'LOW',
    isReversible: true,
    undoAction: 'unpin_message'
  },
  unpin_message: {
    action: 'unpin_message',
    category: 'MESSAGING',
    description: 'Unpins a message from a channel.',
    phrasings: [
      'unpin message 123456789 from #announcements',
      'unpin that message'
    ],
    requiredArgs: ['targetChannel', 'messageId'],
    riskLevel: 'LOW',
    isReversible: true,
    undoAction: 'pin_message'
  }
};
