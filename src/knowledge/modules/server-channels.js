/**
 * Module 3: Server and Channel Management
 * 
 * Defines capabilities, constraints, accepted phrasing, and validation rules
 * for text channels, voice channels, announcements, and categories.
 */

export const CHANNEL_CAPABILITIES = {
  create_channel: {
    action: 'create_channel',
    category: 'CHANNELS',
    description: 'Creates a new text, voice, or announcement channel.',
    phrasings: [
      'create a channel called announcements',
      'make an announcements channel',
      'we need a new place for announcements',
      'create text channel lounge',
      'add voice channel Hangout'
    ],
    requiredArgs: ['name'],
    optionalArgs: ['type', 'parent', 'topic'],
    constraints: {
      maxChannelsPerGuild: 500,
      nameMaxLength: 100,
      validTypes: ['GUILD_TEXT', 'GUILD_VOICE', 'GUILD_ANNOUNCEMENT']
    },
    riskLevel: 'LOW',
    isReversible: true,
    undoAction: 'delete_channel'
  },
  delete_channel: {
    action: 'delete_channel',
    category: 'CHANNELS',
    description: 'Permanently deletes a specified channel.',
    phrasings: [
      'remove the old test channel',
      'delete channel #junk',
      'remove channel archive'
    ],
    requiredArgs: ['targetChannel'],
    riskLevel: 'HIGH',
    requiresConfirmation: true,
    isReversible: false,
    warning: 'Channel messages and history are irrecoverable after deletion.'
  },
  rename_channel: {
    action: 'rename_channel',
    category: 'CHANNELS',
    description: 'Renames an existing channel.',
    phrasings: [
      'rename this channel to general-chat',
      'change channel name to lounge',
      'call this room lobby'
    ],
    requiredArgs: ['targetChannel', 'newName'],
    riskLevel: 'LOW',
    isReversible: true,
    undoAction: 'rename_channel'
  },
  edit_channel_topic: {
    action: 'edit_channel_topic',
    category: 'CHANNELS',
    description: 'Updates the topic or description displayed at the top of a channel.',
    phrasings: [
      'set channel topic to Server Rules and FAQ',
      'change the topic here to Casual discussion only'
    ],
    requiredArgs: ['targetChannel', 'topic'],
    constraints: {
      maxLength: 1024
    },
    riskLevel: 'LOW',
    isReversible: true
  },
  set_channel_slowmode: {
    action: 'set_channel_slowmode',
    category: 'CHANNELS',
    description: 'Configures rate limit per user (slowmode) in seconds.',
    phrasings: [
      'make general slower',
      'set slowmode to 10 seconds in this channel',
      'slow down chat to 5s'
    ],
    requiredArgs: ['targetChannel', 'seconds'],
    constraints: {
      minSeconds: 0,
      maxSeconds: 21600 // 6 hours
    },
    riskLevel: 'LOW',
    isReversible: true
  },
  lock_channel: {
    action: 'lock_channel',
    category: 'CHANNELS',
    description: 'Denies SendMessages permission for @everyone, locking the channel for regular members.',
    phrasings: [
      'lock this channel',
      'close this channel',
      'lock down #general',
      'prevent regular members from posting here',
      'can you make this room private'
    ],
    requiredArgs: ['targetChannel'],
    riskLevel: 'LOW',
    isReversible: true,
    undoAction: 'unlock_channel'
  },
  unlock_channel: {
    action: 'unlock_channel',
    category: 'CHANNELS',
    description: 'Restores SendMessages permission for @everyone, reopening the channel.',
    phrasings: [
      'unlock this channel',
      'reopen #general',
      'lift the channel lock'
    ],
    requiredArgs: ['targetChannel'],
    riskLevel: 'LOW',
    isReversible: true,
    undoAction: 'lock_channel'
  },
  create_category: {
    action: 'create_category',
    category: 'CATEGORIES',
    description: 'Creates a new channel category header.',
    phrasings: [
      'create category Staff Only',
      'add a new category called Information'
    ],
    requiredArgs: ['name'],
    riskLevel: 'LOW',
    isReversible: true,
    undoAction: 'delete_category'
  },
  move_channel_to_category: {
    action: 'move_channel_to_category',
    category: 'CATEGORIES',
    description: 'Moves a channel into a designated category folder.',
    phrasings: [
      'move #announcements into Information',
      'put #staff-chat under Staff category'
    ],
    requiredArgs: ['targetChannel', 'targetCategory'],
    riskLevel: 'LOW',
    isReversible: true
  },
  sync_category_permissions: {
    action: 'sync_category_permissions',
    category: 'CATEGORIES',
    description: 'Synchronizes a channel permission overwrites with its parent category.',
    phrasings: [
      'sync permissions for #chat with its category',
      'make channel permissions match the category'
    ],
    requiredArgs: ['targetChannel'],
    riskLevel: 'LOW',
    isReversible: false
  }
};
