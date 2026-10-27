import { PermissionFlagsBits } from 'discord.js';
import { ActionRegistry, FunctionalCategory } from './action-registry.js';

export const CapabilityStatus = {
  IMPLEMENTED: 'IMPLEMENTED',
  PARTIALLY_TESTED: 'PARTIALLY_TESTED',
  DISCORD_RESTRICTED: 'DISCORD_RESTRICTED',
  BLOCKED_BY_POLICY: 'BLOCKED_BY_POLICY'
};

/**
 * Single Authoritative Capability Matrix of Discord Administration Operations.
 * Each operation declares:
 * - Stable action identifier
 * - Human-readable description
 * - Natural-language synonyms and examples
 * - Required arguments and target type
 * - Preconditions, permissions, and side effects
 * - Risk classification and confirmation requirements
 * - Verification method and reversibility
 * - Known Discord API limitations
 */
export const CAPABILITY_REGISTRY = {
  // =========================================================================
  // A. MESSAGING AND ANNOUNCEMENTS
  // =========================================================================
  send_message: {
    action: 'send_message',
    category: 'MESSAGING',
    description: 'Sends a direct message or alert to a specified channel.',
    synonyms: ['post message', 'say in channel', 'write message', 'send chat', 'message channel'],
    examples: ['Send a message in #general saying welcome', 'Post "Hello everyone" to #lounge'],
    requiredArgs: ['targetChannel', 'content'],
    targetType: 'channel',
    riskLevel: 'LOW',
    preconditions: ['Channel exists', 'Bot has SendMessages and ViewChannel'],
    sideEffects: 'Creates a new message in the target channel',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MESSAGE_ID_CHECK',
    discordLimitations: '2000 character limit per message; cannot send messages to announcement channels without permission.'
  },
  send_announcement: {
    action: 'send_announcement',
    category: 'MESSAGING',
    description: 'Broadcasts a rich embed announcement with optional @everyone or @here pings.',
    synonyms: ['post announcement', 'broadcast', 'make announcement', 'publish announcement', 'announce'],
    examples: ['Post an announcement in #announcements: Server maintenance tonight', 'Announce new event in #updates mentioning everyone'],
    requiredArgs: ['targetChannel', 'message'],
    targetType: 'channel',
    riskLevel: 'LOW',
    preconditions: ['Channel exists', 'Bot has SendMessages, ViewChannel, and MentionEveryone if pinging'],
    sideEffects: 'Sends an embed and optionally notifies guild members',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MESSAGE_ID_CHECK',
    discordLimitations: 'Mentions are subject to bot MentionEveryone permission and role mentionability.'
  },
  publish_embed: {
    action: 'publish_embed',
    category: 'MESSAGING',
    description: 'Publishes a rich Discord embed with custom title, description, color, fields, footer, and interactive components.',
    synonyms: ['create embed', 'make embed', 'send embed', 'post embed', 'publish embed', 'announcement embed', 'rules embed', 'welcome embed'],
    examples: ['Publish an embed in #announcements with title "Server Update"', 'Make an announcement embed with a title, description, fields, footer, timestamp, and buttons'],
    requiredArgs: ['targetChannel'],
    targetType: 'channel',
    riskLevel: 'LOW',
    preconditions: ['Channel exists', 'Bot has SendMessages, ViewChannel, and EmbedLinks'],
    sideEffects: 'Sends a formatted rich embed message in the destination channel',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MESSAGE_ID_CHECK',
    discordLimitations: 'Max 10 embeds per message, 4,096 char description limit, 25 fields per embed, 6,000 total characters.'
  },
  create_embed: {
    action: 'create_embed',
    category: 'MESSAGING',
    description: 'Creates and publishes a rich Discord embed to a specified channel.',
    synonyms: ['build embed', 'generate embed'],
    examples: ['Create rules embed in #rules', 'Create welcome embed in #welcome'],
    requiredArgs: ['targetChannel'],
    targetType: 'channel',
    riskLevel: 'LOW',
    preconditions: ['Channel exists', 'Bot has SendMessages, ViewChannel, and EmbedLinks'],
    sideEffects: 'Sends a formatted embed message',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MESSAGE_ID_CHECK',
    discordLimitations: 'Max 10 embeds per message, 6000 total character limit.'
  },
  edit_embed: {
    action: 'edit_embed',
    category: 'MESSAGING',
    description: 'Edits an existing bot-authored embed message.',
    synonyms: ['update embed', 'modify embed', 'change embed'],
    examples: ['Edit embed 123456789 in #announcements to change description', 'Make that embed blue'],
    requiredArgs: ['targetChannel', 'messageId'],
    targetType: 'message',
    riskLevel: 'LOW',
    preconditions: ['Channel exists', 'Message was authored by Honey Bot'],
    sideEffects: 'Modifies the existing bot embed message in place',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MESSAGE_ID_CHECK',
    discordLimitations: 'Discord only allows bots to edit messages they originally sent.'
  },
  pin_message: {
    action: 'pin_message',
    category: 'MESSAGING',
    description: 'Pins an important message to the top of a channel.',
    synonyms: ['pin', 'pin this message', 'stick message'],
    examples: ['Pin message 123456789 in #announcements', 'Pin that message'],
    requiredArgs: ['targetChannel', 'messageId'],
    targetType: 'message',
    riskLevel: 'LOW',
    preconditions: ['Message exists in target channel', 'Channel has fewer than 50 pinned messages'],
    sideEffects: 'Adds message to pinned list and triggers system pin notice',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ViewChannel],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MESSAGE_PIN_CHECK',
    discordLimitations: 'Discord limits channels to a maximum of 50 pinned messages.'
  },
  unpin_message: {
    action: 'unpin_message',
    category: 'MESSAGING',
    description: 'Unpins a message from a channel.',
    synonyms: ['unpin', 'unstick message', 'remove pin'],
    examples: ['Unpin message 123456789 from #announcements'],
    requiredArgs: ['targetChannel', 'messageId'],
    targetType: 'message',
    riskLevel: 'LOW',
    preconditions: ['Message exists and is currently pinned'],
    sideEffects: 'Removes message from pinned list',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ViewChannel],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MESSAGE_PIN_CHECK',
    discordLimitations: 'Message must currently be pinned.'
  },
  add_reaction: {
    action: 'add_reaction',
    category: 'MESSAGING',
    description: 'Adds an emoji reaction to a message.',
    synonyms: ['react', 'add emoji', 'react with'],
    examples: ['React with 👍 to message 123456789 in #general'],
    requiredArgs: ['targetChannel', 'messageId', 'emoji'],
    targetType: 'message',
    riskLevel: 'LOW',
    preconditions: ['Message exists', 'Emoji is valid Unicode or available guild custom emoji'],
    sideEffects: 'Adds bot reaction to message',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.AddReactions, PermissionFlagsBits.ReadMessageHistory],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'Cannot use custom emojis from external servers unless bot has Nitro permissions.'
  },
  purge_messages: {
    action: 'purge_messages',
    category: 'MESSAGING',
    description: 'Bulk deletes up to 100 recent messages from a channel with optional author or content filters.',
    synonyms: ['bulk delete', 'clear chat', 'delete messages', 'clean channel', 'wipe messages', 'clear messages', 'prune messages'],
    examples: ['Delete 10 messages in #general', 'Purge 25 messages from Alex', 'Clear my messages in this channel'],
    requiredArgs: ['targetChannel', 'count'],
    targetType: 'channel',
    riskLevel: 'HIGH',
    preconditions: ['Messages must be newer than 14 days old (Discord API bulk delete limit)'],
    sideEffects: 'Irrevocably deletes messages from the channel',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ViewChannel],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: true,
    requiresConfirmation: true, // If count > 20
    isReversible: false,
    verificationMethod: 'DELETED_COUNT_CHECK',
    discordLimitations: 'Discord API prohibits bulk deletion of messages older than 14 days; maximum 100 messages per call.'
  },
  search_messages: {
    action: 'search_messages',
    category: 'MESSAGING',
    description: 'Read-only inspection and search for messages in a channel matching author, keyword, or recency filters.',
    synonyms: ['find messages', 'search messages', 'look for message', 'locate message', 'check messages'],
    examples: ['Find my messages from yesterday', 'Search for messages containing "password"', 'Find messages from Alex'],
    requiredArgs: ['targetChannel'],
    targetType: 'channel',
    riskLevel: 'LOW',
    preconditions: ['Bot has ReadMessageHistory and ViewChannel in target channel'],
    sideEffects: 'None (read-only search)',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ViewChannel],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'Searches recent message history cache (up to 100 messages per fetch).'
  },

  // =========================================================================
  // B. CHANNEL MANAGEMENT
  // =========================================================================
  create_channel: {
    action: 'create_channel',
    category: 'CHANNELS',
    description: 'Creates text, voice, announcement, or category channels.',
    synonyms: ['make channel', 'new channel', 'add channel', 'set up channel', 'open channel'],
    examples: ['Create a text channel called project-updates', 'Create a private staff channel', 'Create a voice channel named Gaming'],
    requiredArgs: ['name'],
    targetType: 'channel',
    riskLevel: 'LOW',
    preconditions: ['Guild has fewer than 500 channels', 'Channel name is 1-100 characters'],
    sideEffects: 'Adds a new channel to the server layout',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'CHANNEL_CACHE_CHECK',
    discordLimitations: 'Discord limits servers to 500 total channels (including categories); text channel names are lowercased and hyphenated.'
  },
  edit_channel: {
    action: 'edit_channel',
    category: 'CHANNELS',
    description: 'Edits channel name, topic, slowmode, or category.',
    synonyms: ['modify channel', 'update channel', 'change channel settings'],
    examples: ['Change channel topic to Rules and Guidelines', 'Set #general slowmode to 5s'],
    requiredArgs: ['targetChannel'],
    targetType: 'channel',
    riskLevel: 'LOW',
    preconditions: ['Channel exists and is manageable by bot'],
    sideEffects: 'Updates channel metadata',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'CHANNEL_FETCH_CHECK',
    discordLimitations: 'Channel rename rate-limits apply (Discord limits channel renames to twice per 10 minutes).'
  },
  rename_channel: {
    action: 'rename_channel',
    category: 'CHANNELS',
    description: 'Renames a channel directly.',
    synonyms: ['change channel name', 'channel rename', 'change name of channel'],
    examples: ['Rename #general to lounge', 'Rename this channel to announcements'],
    requiredArgs: ['targetChannel', 'name'],
    targetType: 'channel',
    riskLevel: 'LOW',
    preconditions: ['Channel exists', 'Name is 1-100 characters'],
    sideEffects: 'Changes channel identifier display name',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'CHANNEL_NAME_CHECK',
    discordLimitations: 'Discord API enforces a strict rate limit of 2 channel renames per 10 minutes per channel.'
  },
  move_channel: {
    action: 'move_channel',
    category: 'CHANNELS',
    description: 'Moves a channel under a specific category.',
    synonyms: ['categorize channel', 'reorder channel', 'relocate channel'],
    examples: ['Move #welcome under Information category', 'Move this channel to Archives'],
    requiredArgs: ['targetChannel', 'category'],
    targetType: 'channel',
    riskLevel: 'LOW',
    preconditions: ['Target channel and parent category exist'],
    sideEffects: 'Changes channel parent and position in channel list',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'CHANNEL_PARENT_CHECK',
    discordLimitations: 'Target category must have fewer than 50 child channels.'
  },
  create_category: {
    action: 'create_category',
    category: 'CATEGORIES',
    description: 'Creates a Discord channel category with optional private overwrites.',
    synonyms: ['make category', 'add category', 'new category', 'set up category'],
    examples: ['Create a Support category', 'Create a private Staff category'],
    requiredArgs: ['name'],
    targetType: 'category',
    riskLevel: 'LOW',
    preconditions: ['Guild has fewer than 500 total channels'],
    sideEffects: 'Adds a new channel category to the server',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'CHANNEL_CACHE_CHECK',
    discordLimitations: 'Category names cannot exceed 100 characters.'
  },
  rename_category: {
    action: 'rename_category',
    category: 'CATEGORIES',
    description: 'Renames an existing channel category.',
    synonyms: ['change category name', 'update category name', 'rename category'],
    examples: ['Rename the Support category to Customer Support'],
    requiredArgs: ['targetCategory', 'newName'],
    targetType: 'category',
    riskLevel: 'LOW',
    preconditions: ['Category exists and bot has ManageChannels'],
    sideEffects: 'Updates category display name',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'CHANNEL_NAME_CHECK',
    discordLimitations: 'Discord channel rename rate limits apply (2 per 10 minutes).'
  },
  delete_category: {
    action: 'delete_category',
    category: 'CATEGORIES',
    description: 'Deletes a category, either unparenting child channels or deleting them when confirmed.',
    synonyms: ['remove category', 'destroy category', 'delete category'],
    examples: ['Delete empty category Support', 'Delete Support category and its channels'],
    requiredArgs: ['targetCategory'],
    targetType: 'category',
    riskLevel: 'HIGH',
    preconditions: ['Category exists', 'Bot has ManageChannels', 'Subject to Anti-Nuke rules'],
    sideEffects: 'Removes category; if confirmed, may delete child channels',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: true,
    requiresConfirmation: true,
    isReversible: false,
    verificationMethod: 'CHANNEL_NONEXISTENCE_CHECK',
    discordLimitations: 'Deleting child channels is irreversible.'
  },
  inspect_category: {
    action: 'inspect_category',
    category: 'CATEGORIES',
    description: 'Inspects a category, listing child channels, sync state, and permission overwrites.',
    synonyms: ['show category', 'view category', 'channels inside category', 'inspect category'],
    examples: ['Show me the channels inside Support', 'Inspect Support category'],
    requiredArgs: ['targetCategory'],
    targetType: 'category',
    riskLevel: 'LOW',
    preconditions: ['Category exists in guild'],
    sideEffects: 'None (read-only inspection)',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ViewChannel],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None'
  },
  list_categories: {
    action: 'list_categories',
    category: 'CATEGORIES',
    description: 'Lists all categories in the server and their child channels.',
    synonyms: ['show categories', 'get categories', 'category inventory'],
    examples: ['List all categories', 'Show server categories'],
    requiredArgs: [],
    targetType: 'server',
    riskLevel: 'LOW',
    preconditions: ['Guild available'],
    sideEffects: 'None (read-only)',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None'
  },
  move_channel_to_category: {
    action: 'move_channel_to_category',
    category: 'CATEGORIES',
    description: 'Moves a channel into or out of a category with optional permission synchronization.',
    synonyms: ['put channel in category', 'move channel under category', 'categorize channel'],
    examples: ['Move #tickets into Support', 'Move #general out of category'],
    requiredArgs: ['targetChannel'],
    targetType: 'channel',
    riskLevel: 'LOW',
    preconditions: ['Target channel exists and category exists if provided'],
    sideEffects: 'Updates channel parent and optionally permission overwrites',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'CHANNEL_PARENT_CHECK',
    discordLimitations: 'Maximum 50 child channels per category.'
  },
  set_category_permission: {
    action: 'set_category_permission',
    category: 'CATEGORIES',
    description: 'Configures explicit allow/deny permission overwrites on a category.',
    synonyms: ['category permissions', 'grant category access', 'restrict category'],
    examples: ['Make all channels in Support read-only for Member', 'Allow Support Team to view Support category'],
    requiredArgs: ['targetCategory', 'targetRoleOrMember'],
    targetType: 'category',
    riskLevel: 'MEDIUM',
    preconditions: ['Category and target role/member exist'],
    sideEffects: 'Updates category permission overwrite table and affects synchronized children',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'OVERWRITE_CHECK',
    discordLimitations: 'Maximum 500 permission overwrites per category.'
  },
  sync_category_permissions: {
    action: 'sync_category_permissions',
    category: 'CATEGORIES',
    description: 'Synchronizes child channel permissions with the parent category.',
    synonyms: ['sync category', 'synchronize child channels', 'sync permissions with category'],
    examples: ['Synchronize the child channels with the category permissions', 'Sync #tickets with Support'],
    requiredArgs: ['targetCategory'],
    targetType: 'category',
    riskLevel: 'MEDIUM',
    preconditions: ['Category and child channels exist'],
    sideEffects: 'Locks child channel permissions to match parent category',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'OVERWRITE_CHECK',
    discordLimitations: 'Overwrites existing channel-specific custom overrides.'
  },
  inspect_category_sync: {
    action: 'inspect_category_sync',
    category: 'CATEGORIES',
    description: 'Inspects which child channels have permissions synchronized vs differing overrides.',
    synonyms: ['check category sync', 'show unsynchronized channels'],
    examples: ['Show me which channels have permission overrides that differ from their category'],
    requiredArgs: ['targetCategory'],
    targetType: 'category',
    riskLevel: 'LOW',
    preconditions: ['Category exists'],
    sideEffects: 'None (read-only inspection)',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ViewChannel],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None'
  },
  lock_channel: {
    action: 'lock_channel',
    category: 'CHANNELS',
    description: 'Locks a channel to prevent standard members from sending messages.',
    synonyms: ['close channel', 'lockdown channel', 'freeze channel', 'mute channel', 'lock down'],
    examples: ['Lock this channel', 'Lock down #general', 'Close this channel'],
    requiredArgs: ['targetChannel'],
    targetType: 'channel',
    riskLevel: 'MEDIUM',
    preconditions: ['Channel exists', 'Bot has ManageChannels and ManageRoles'],
    sideEffects: 'Sets SendMessages: false overwrite on @everyone role',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'OVERWRITE_CHECK',
    discordLimitations: 'Does not affect administrators or roles with explicit SendMessages: true overwrite.'
  },
  unlock_channel: {
    action: 'unlock_channel',
    category: 'CHANNELS',
    description: 'Unlocks a channel, restoring standard messaging permissions.',
    synonyms: ['open channel', 'unfreeze channel', 'restore channel', 'open up channel'],
    examples: ['Unlock this channel', 'Open up #general', 'Unfreeze chat'],
    requiredArgs: ['targetChannel'],
    targetType: 'channel',
    riskLevel: 'LOW',
    preconditions: ['Channel exists', 'Bot has ManageChannels and ManageRoles'],
    sideEffects: 'Removes or allows SendMessages overwrite on @everyone role',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'OVERWRITE_CHECK',
    discordLimitations: 'Restores default @everyone permissions.'
  },
  set_channel_slowmode: {
    action: 'set_channel_slowmode',
    category: 'CHANNELS',
    description: 'Sets rate-limit per user in seconds (slowmode).',
    synonyms: ['slowmode', 'make slower', 'slow down channel', 'rate limit channel', 'chat delay'],
    examples: ['Set slowmode to 10s', 'Make general slower', 'Make chat 5s slowmode', 'Slow down #chat to 30 seconds'],
    requiredArgs: ['targetChannel', 'seconds'],
    targetType: 'channel',
    riskLevel: 'LOW',
    preconditions: ['Channel exists', 'Seconds between 0 and 21600 (6 hours)'],
    sideEffects: 'Imposes rate limit on non-moderators in channel',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'CHANNEL_RATE_LIMIT_CHECK',
    discordLimitations: 'Discord supports slowmode values from 0s up to 21600s (6h); does not restrict members with ManageMessages or ManageChannels.'
  },
  set_channel_permission: {
    action: 'set_channel_permission',
    category: 'CHANNELS',
    description: 'Configures specific allow/deny permission overwrites for a role or member.',
    synonyms: ['channel permission', 'grant access', 'restrict access', 'channel override'],
    examples: ['Give Moderator role access to #staff', 'Hide #private from @everyone'],
    requiredArgs: ['targetChannel', 'targetRoleOrMember'],
    targetType: 'channel',
    riskLevel: 'MEDIUM',
    preconditions: ['Channel and target role/member exist'],
    sideEffects: 'Updates channel permission overwrite table',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'OVERWRITE_CHECK',
    discordLimitations: 'Maximum 500 permission overwrites per channel.'
  },
  delete_channel: {
    action: 'delete_channel',
    category: 'CHANNELS',
    description: 'Permanently deletes an individual channel (subject to Anti-Nuke aggregate limits).',
    synonyms: ['remove channel', 'destroy channel', 'wipe channel'],
    examples: ['Delete #test-channel', 'Remove the channel you just created'],
    requiredArgs: ['targetChannel'],
    targetType: 'channel',
    riskLevel: 'HIGH',
    preconditions: ['Channel exists', 'Subject to Anti-Nuke rate limits (< 3 channels per hour)'],
    sideEffects: 'Permanently removes channel and all message history',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: true,
    requiresConfirmation: true,
    isReversible: false,
    verificationMethod: 'CHANNEL_NONEXISTENCE_CHECK',
    discordLimitations: 'Channel deletion is irreversible; message history cannot be recovered from Discord.'
  },
  list_channels: {
    action: 'list_channels',
    category: 'CHANNELS',
    description: 'Lists all text, voice, and category channels in the server.',
    synonyms: ['show channels', 'get channels', 'display channels', 'channel inventory'],
    examples: ['List all channels', 'Show server channels'],
    requiredArgs: [],
    targetType: 'server',
    riskLevel: 'LOW',
    preconditions: ['Guild available'],
    sideEffects: 'None (read-only)',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },

  // =========================================================================
  // C. ROLE MANAGEMENT
  // =========================================================================
  create_role: {
    action: 'create_role',
    category: 'ROLES',
    description: 'Creates a new role with custom color, hoist, and permissions.',
    synonyms: ['new role', 'make role', 'add role', 'set up role'],
    examples: ['Create a role called VIP', 'Create role Moderator with color #8B0000 and hoist it'],
    requiredArgs: ['name'],
    targetType: 'role',
    riskLevel: 'LOW',
    preconditions: ['Guild has fewer than 250 roles', 'Role name 1-100 characters', 'Color valid hex code'],
    sideEffects: 'Adds a new role to guild hierarchy',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageRoles],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'ROLE_CACHE_CHECK',
    discordLimitations: 'Discord limits servers to 250 total roles. Bot cannot grant permissions it does not possess.'
  },
  edit_role: {
    action: 'edit_role',
    category: 'ROLES',
    description: 'Edits an existing role name, color, hoist, or non-admin permissions.',
    synonyms: ['modify role', 'update role', 'rename role', 'recolor role', 'change role color'],
    examples: ['Rename Moderator role to Staff', 'Change its color to dark red', 'Set VIP role color to #FFD700 and hoist it'],
    requiredArgs: ['targetRole'],
    targetType: 'role',
    riskLevel: 'LOW',
    preconditions: ['Role exists', 'Role is below bot highest role in hierarchy', 'Role is below actor highest role'],
    sideEffects: 'Modifies role attributes across all members with this role',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageRoles],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'ROLE_FETCH_CHECK',
    discordLimitations: 'Bot cannot edit managed/bot integration roles or roles higher than its highest role in hierarchy.'
  },
  delete_role: {
    action: 'delete_role',
    category: 'ROLES',
    description: 'Permanently deletes a role (subject to Anti-Nuke aggregate limits).',
    synonyms: ['remove role from server', 'destroy role', 'wipe role'],
    examples: ['Delete the Inactive role', 'Remove role VIP'],
    requiredArgs: ['targetRole'],
    targetType: 'role',
    riskLevel: 'HIGH',
    preconditions: ['Role exists', 'Role is below bot and actor in hierarchy', 'Subject to Anti-Nuke limits'],
    sideEffects: 'Removes role from all members and deletes role entity',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageRoles],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: true,
    requiresConfirmation: true,
    isReversible: false,
    verificationMethod: 'ROLE_NONEXISTENCE_CHECK',
    discordLimitations: 'Cannot delete the @everyone role, nitro booster role, or bot integration managed roles.'
  },
  assign_role: {
    action: 'assign_role',
    category: 'ROLES',
    description: 'Assigns a role to a member.',
    synonyms: ['give role', 'grant role', 'add role to user', 'make member role'],
    examples: ['Give Alex the VIP role', 'Assign Moderator role to @Sarah', 'Add Member role to John'],
    requiredArgs: ['targetMember', 'targetRole'],
    targetType: 'member',
    riskLevel: 'LOW',
    preconditions: ['Member and role exist', 'Role is below bot highest role in hierarchy'],
    sideEffects: 'Updates member roles list and grants role permissions to member',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageRoles],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MEMBER_ROLE_CHECK',
    discordLimitations: 'Bot cannot assign roles higher than its own highest role.'
  },
  remove_role: {
    action: 'remove_role',
    category: 'ROLES',
    description: 'Removes a role from a member.',
    synonyms: ['take role', 'revoke role', 'strip role', 'remove role from user'],
    examples: ['Remove Moderator role from Alex', 'Revoke VIP from @John', 'Take away Staff role from Sarah'],
    requiredArgs: ['targetMember', 'targetRole'],
    targetType: 'member',
    riskLevel: 'LOW',
    preconditions: ['Member and role exist', 'Member currently possesses role', 'Role is below bot highest role'],
    sideEffects: 'Revokes role permissions from member',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageRoles],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MEMBER_ROLE_CHECK',
    discordLimitations: 'Bot cannot remove roles higher than its own highest role.'
  },
  list_roles: {
    action: 'list_roles',
    category: 'ROLES',
    description: 'Lists all roles in the server with member counts and hierarchy positions.',
    synonyms: ['show roles', 'get roles', 'display roles', 'role inventory'],
    examples: ['List all roles', 'Show server roles'],
    requiredArgs: [],
    targetType: 'server',
    riskLevel: 'LOW',
    preconditions: ['Guild available'],
    sideEffects: 'None (read-only)',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },

  // =========================================================================
  // D. MEMBER MANAGEMENT
  // =========================================================================
  lookup_member: {
    action: 'lookup_member',
    category: 'MEMBERS',
    description: 'Inspects a member profile, identity, server membership, roles, permissions, hierarchy, and moderation history.',
    synonyms: ['inspect member', 'who is', 'member profile', 'user info', 'look up user', 'view profile'],
    examples: ['Inspect Alex profile', 'Who is @Sarah', 'View my member profile', 'Look up member John'],
    requiredArgs: ['targetMember'],
    targetType: 'member',
    riskLevel: 'LOW',
    preconditions: ['Member exists or user snowflake valid'],
    sideEffects: 'None (read-only profile lookup)',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'Presence and activity data depend on gateway intents.'
  },
  change_nickname: {
    action: 'change_nickname',
    category: 'MEMBERS',
    description: 'Changes a member server nickname.',
    synonyms: ['rename member', 'set nickname', 'change nick', 'rename user', 'make member show up as', 'rename on server', 'make nick', 'change nickname', 'change someone nickname', 'change member nickname', 'change user nickname'],
    examples: ["Change Alex's nick to Night Owl", "Rename Alex to Night Owl on the server", "I want Alex to show up as Night Owl", "Make Alex's server nickname Night Owl", "Make Alex's nick Night Owl"],
    requiredArgs: ['targetMember', 'nickname'],
    targetType: 'member',
    riskLevel: 'LOW',
    preconditions: ['Member exists in server', 'Member is not server owner', 'Member is below bot in hierarchy', 'Nickname 1-32 characters'],
    sideEffects: 'Updates member displayed nickname in this server',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageNicknames],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MEMBER_NICKNAME_CHECK',
    discordLimitations: 'Discord strictly limits nicknames to 32 characters; bots cannot alter the server owner nickname or members with higher roles.'
  },
  remove_nickname: {
    action: 'remove_nickname',
    category: 'MEMBERS',
    description: 'Removes a member server nickname, resetting it to default display name.',
    synonyms: ['reset nickname', 'clear nickname', 'remove nick', 'delete nickname', 'reset member name'],
    examples: ["Remove Sarah's server nickname", "Reset Alex's nickname", "Clear my nickname"],
    requiredArgs: ['targetMember'],
    targetType: 'member',
    riskLevel: 'LOW',
    preconditions: ['Member exists in server', 'Member is below bot in hierarchy'],
    sideEffects: 'Clears server nickname, displaying original global username or display name',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageNicknames],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MEMBER_NICKNAME_CHECK',
    discordLimitations: 'Bots cannot alter the server owner nickname or members with higher roles.'
  },
  inspect_nickname: {
    action: 'inspect_nickname',
    category: 'MEMBERS',
    description: 'Inspects a member server nickname and global username (read-only).',
    synonyms: ['check nickname', 'what is nickname', 'view nickname', 'show nickname'],
    examples: ["What is Alex's current nickname?", "Check my nickname", "Inspect nickname for @Sarah"],
    requiredArgs: ['targetMember'],
    targetType: 'member',
    riskLevel: 'LOW',
    preconditions: ['Member exists in server'],
    sideEffects: 'None (read-only inspection)',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  timeout_member: {
    action: 'timeout_member',
    category: 'MEMBERS',
    description: 'Applies communication disable timeout to a member.',
    synonyms: ['timeout', 'mute member', 'disable communication', 'silence member'],
    examples: ['Timeout Alex for 10m for spamming', 'Mute @Sarah for 30 minutes'],
    requiredArgs: ['targetMember', 'durationMinutes'],
    targetType: 'member',
    riskLevel: 'MEDIUM',
    preconditions: ['Member exists', 'Member is below bot and actor in hierarchy', 'Duration between 1 and 40320 minutes (28 days)'],
    sideEffects: 'Prevents member from sending messages, adding reactions, or speaking in voice channels',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ModerateMembers],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MEMBER_TIMEOUT_CHECK',
    discordLimitations: 'Discord limits maximum timeout duration to 28 days (40,320 minutes); cannot timeout server owner or higher roles.'
  },
  remove_timeout: {
    action: 'remove_timeout',
    category: 'MEMBERS',
    description: 'Removes active timeout from a member.',
    synonyms: ['untimeout', 'unmute', 'remove mute', 'restore communication'],
    examples: ['Remove timeout from Alex', 'Untimeout @Sarah', 'Unmute John'],
    requiredArgs: ['targetMember'],
    targetType: 'member',
    riskLevel: 'LOW',
    preconditions: ['Member exists', 'Member currently has active timeout', 'Member is below bot in hierarchy'],
    sideEffects: 'Restores member ability to chat and speak',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ModerateMembers],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MEMBER_TIMEOUT_CHECK',
    discordLimitations: 'None.'
  },
  kick_member: {
    action: 'kick_member',
    category: 'MEMBERS',
    description: 'Kicks a member from the server.',
    synonyms: ['kick', 'boot member', 'eject member'],
    examples: ['Kick Alex for violating server rules', 'Kick @spammer'],
    requiredArgs: ['targetMember'],
    targetType: 'member',
    riskLevel: 'HIGH',
    preconditions: ['Member exists in server', 'Member is below bot and actor in hierarchy'],
    sideEffects: 'Removes member from server; member can rejoin with a valid invite',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.KickMembers],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: true,
    requiresConfirmation: true,
    isReversible: false,
    verificationMethod: 'MEMBER_NONEXISTENCE_CHECK',
    discordLimitations: 'Cannot kick server owner or members with equal/higher role hierarchy than the bot.'
  },
  ban_member: {
    action: 'ban_member',
    category: 'MEMBERS',
    description: 'Bans a user from the server with optional message deletion.',
    synonyms: ['ban', 'ban user', 'permaban', 'blacklist member'],
    examples: ['Ban Alex for severe raiding', 'Ban 123456789 because of harassment'],
    requiredArgs: ['targetMember'],
    targetType: 'member',
    riskLevel: 'CRITICAL',
    preconditions: ['Target is valid snowflake or member', 'Member is below bot and actor in hierarchy'],
    sideEffects: 'Permanently bans user and their IP from joining; optionally removes recent messages',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.BanMembers],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: true,
    requiresConfirmation: true,
    isReversible: true,
    verificationMethod: 'BAN_FETCH_CHECK',
    discordLimitations: 'Cannot ban server owner or members with equal/higher role hierarchy than the bot.'
  },
  unban_member: {
    action: 'unban_member',
    category: 'MEMBERS',
    description: 'Removes a ban for a specified user Snowflake ID.',
    synonyms: ['unban', 'remove ban', 'pardon user', 'lift ban'],
    examples: ['Unban 123456789', 'Lift ban on user 987654321'],
    requiredArgs: ['targetMemberId'],
    targetType: 'member',
    riskLevel: 'LOW',
    preconditions: ['User is currently banned in the guild'],
    sideEffects: 'Removes ban entry allowing user to rejoin',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.BanMembers],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'Requires target user snowflake ID.'
  },

  // =========================================================================
  // E. SERVER ADMINISTRATION
  // =========================================================================
  update_server_name: {
    action: 'update_server_name',
    category: 'SERVER',
    description: 'Updates guild name (2-100 characters).',
    synonyms: ['rename server', 'change server name', 'set guild name'],
    examples: ['Change server name to Community Hub', 'Rename server to Gaming Lounge'],
    requiredArgs: ['name'],
    targetType: 'server',
    riskLevel: 'LOW',
    preconditions: ['Name is 2-100 characters'],
    sideEffects: 'Updates server name across all client views',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageGuild],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'GUILD_NAME_CHECK',
    discordLimitations: 'Discord limits guild name changes to twice per 10 minutes.'
  },
  update_server_description: {
    action: 'update_server_description',
    category: 'SERVER',
    description: 'Updates guild description (requires Community enabled).',
    synonyms: ['change server description', 'set server bio'],
    examples: ['Set server description to The official community for developers'],
    requiredArgs: ['description'],
    targetType: 'server',
    riskLevel: 'LOW',
    preconditions: ['Server has Community feature enabled'],
    sideEffects: 'Updates server public description',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageGuild],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'Requires Community feature to be enabled in Discord Server Settings.'
  },
  update_server_icon: {
    action: 'update_server_icon',
    category: 'SERVER',
    description: 'Updates guild profile icon from image URL.',
    synonyms: ['change server icon', 'set server avatar', 'update server image'],
    examples: ['Change server icon to https://example.com/icon.png'],
    requiredArgs: ['iconUrl'],
    targetType: 'server',
    riskLevel: 'LOW',
    preconditions: ['Valid image URL (png/jpeg/gif)'],
    sideEffects: 'Replaces server icon',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageGuild],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'Image must be accessible URL and under 10MB.'
  },
  update_server_banner: {
    action: 'update_server_banner',
    category: 'SERVER',
    description: 'Updates guild banner (Requires Server Boost Tier 2).',
    synonyms: ['change server banner', 'set server banner image'],
    examples: ['Set server banner to https://example.com/banner.png'],
    requiredArgs: ['bannerUrl'],
    targetType: 'server',
    riskLevel: 'LOW',
    preconditions: ['Server is Boost Tier 2 or higher'],
    sideEffects: 'Replaces server banner header',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageGuild],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'Requires Discord Server Boost Tier 2 (7+ server boosts).'
  },
  audit_server: {
    action: 'audit_server',
    category: 'SERVER',
    description: 'Read-only security audit of permissions, role hierarchy, and excessive @everyone privileges.',
    synonyms: ['audit permissions', 'security audit', 'server audit', 'check security'],
    examples: ['Audit server permissions', 'Run a security audit', 'Check whether bot can manage this role'],
    requiredArgs: [],
    targetType: 'server',
    riskLevel: 'LOW',
    preconditions: ['Guild available'],
    sideEffects: 'None (read-only audit)',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'AUDIT_RESULT',
    discordLimitations: 'None.'
  },
  setup_ticket_system: {
    action: 'setup_ticket_system',
    category: 'SERVER',
    description: 'Deploys an interactive Ticket System panel with durable buttons.',
    synonyms: ['ticket system', 'support tickets', 'create ticket panel', 'set up tickets'],
    examples: ['Set up a ticket system', 'Create a support ticket panel'],
    requiredArgs: [],
    targetType: 'server',
    riskLevel: 'LOW',
    preconditions: ['Bot has ManageChannels, ManageRoles, SendMessages'],
    sideEffects: 'Creates ticket category, channel, support role, and interactive panel',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.SendMessages],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'CHANNEL_CACHE_CHECK',
    discordLimitations: 'Re-uses existing ticket channels and roles if already present.'
  },
  setup_role_menu: {
    action: 'setup_role_menu',
    category: 'SERVER',
    description: 'Creates a self-assignable role selection dropdown.',
    synonyms: ['reaction roles', 'role dropdown', 'self roles', 'role selector'],
    examples: ['Create a role menu for Gamer, Artist, and Musician'],
    requiredArgs: ['targetChannel', 'roles'],
    targetType: 'server',
    riskLevel: 'LOW',
    preconditions: ['Specified roles exist and are below bot highest role'],
    sideEffects: 'Posts an interactive message with role selection select menu',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.SendMessages],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MESSAGE_ID_CHECK',
    discordLimitations: 'Roles must be below the bot highest role to be assignable.'
  },
  setup_role_panel: {
    action: 'setup_role_panel',
    category: 'SERVER',
    description: 'Builds a persistent self-role panel with buttons, select menus, or reaction emojis.',
    synonyms: ['self-role panel', 'reaction role system', 'interactive self roles', 'button roles', 'reaction roles'],
    examples: ['Create a reaction-role system for choosing game roles', 'Build a self-role channel with selectable roles and interactive buttons'],
    requiredArgs: ['roles'],
    targetType: 'server',
    riskLevel: 'LOW',
    preconditions: ['Bot has ManageRoles, ManageChannels, and SendMessages', 'Target roles are below bot role in hierarchy'],
    sideEffects: 'Creates or uses dedicated channel, posts interactive embed with buttons/select menu, and saves configuration persistently',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.SendMessages],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MESSAGE_ID_CHECK',
    discordLimitations: 'Max 25 roles per panel. Reaction roles require GuildMessageReactions intent and message access.'
  },
  repair_role_panel: {
    action: 'repair_role_panel',
    category: 'SERVER',
    description: 'Repairs or rebuilds a self-role panel whose message or mappings were deleted.',
    synonyms: ['rebuild role panel', 'fix self roles', 'repair reaction roles'],
    examples: ['Repair self-role panel panel_123', 'Rebuild self role system'],
    requiredArgs: ['panelId'],
    targetType: 'server',
    riskLevel: 'LOW',
    preconditions: ['Panel was previously registered'],
    sideEffects: 'Re-publishes or updates panel message in Discord',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.SendMessages],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'MESSAGE_ID_CHECK',
    discordLimitations: 'Requires configured roles to exist in server.'
  },
  delete_role_panel: {
    action: 'delete_role_panel',
    category: 'SERVER',
    description: 'Deletes and unregisters a self-role panel.',
    synonyms: ['remove role panel', 'delete self roles'],
    examples: ['Delete self-role panel panel_123'],
    requiredArgs: ['panelId'],
    targetType: 'server',
    riskLevel: 'MEDIUM',
    preconditions: ['Panel exists'],
    sideEffects: 'Deletes panel message and removes record from persistent storage',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageMessages],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: true,
    requiresConfirmation: true,
    isReversible: false,
    verificationMethod: 'STATE_CHECK',
    discordLimitations: 'Panel configuration is wiped.'
  },
  configure_channel_preset: {
    action: 'configure_channel_preset',
    category: 'CHANNELS',
    description: 'Applies standardized channel permission presets (rules, welcome, announcements, staff).',
    synonyms: ['set rules permissions', 'configure rules channel', 'make channel read only', 'set welcome permissions', 'create private staff channel'],
    examples: ['Configure rules permissions on #rules', 'Make #announcements read-only'],
    requiredArgs: ['targetChannel', 'preset'],
    targetType: 'channel',
    riskLevel: 'LOW',
    preconditions: ['Channel exists', 'Bot has ManageRoles or ManageChannels'],
    sideEffects: 'Updates channel permission overwrites for @everyone and relevant roles',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'CHANNEL_PERMISSIONS_CHECK',
    discordLimitations: 'Overwrites existing specific permission overrides for configured roles.'
  },

  // =========================================================================
  // F. BOT AND INTEGRATION MANAGEMENT
  // =========================================================================
  get_bot_invite: {
    action: 'get_bot_invite',
    category: 'INTEGRATIONS',
    description: 'Generates official OAuth2 installation link for authorized bot installation.',
    synonyms: ['invite bot', 'bot link', 'bot invite link', 'add bot link'],
    examples: ['Get bot invite link', 'How do I invite Honey Bot?'],
    requiredArgs: [],
    targetType: 'server',
    riskLevel: 'LOW',
    preconditions: ['Client ID available'],
    sideEffects: 'Returns official Discord OAuth2 authorization URL',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  explain_bot_installation: {
    action: 'explain_bot_installation',
    category: 'INTEGRATIONS',
    description: 'Explains the Discord OAuth2 authorization flow for installing external bots.',
    synonyms: ['how to add bot', 'install bot guide', 'oauth2 guide'],
    examples: ['How do I add another bot?', 'Can you install a bot?'],
    requiredArgs: [],
    targetType: 'server',
    riskLevel: 'LOW',
    preconditions: [],
    sideEffects: 'Provides educational instructions on official Discord OAuth2 flow',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'EXPLANATION',
    discordLimitations: 'Bots cannot directly install other bots; human OAuth2 completion is required by Discord API.'
  },

  // =========================================================================
  // G. MUSIC AND VOICE PLAYBACK
  // =========================================================================
  music_play: {
    action: 'music_play',
    category: 'MUSIC',
    description: 'Streams audio from YouTube, SoundCloud, or search into a voice channel.',
    synonyms: ['play music', 'play song', 'stream audio', 'play track'],
    examples: ['Play lofi hip hop', 'Play https://youtube.com/watch?v=...'],
    requiredArgs: ['query'],
    targetType: null,
    riskLevel: 'LOW',
    preconditions: ['Invoking user in voice channel or bot already connected'],
    sideEffects: 'Connects to voice channel and plays audio stream',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'Requires voice connection; audio depends on external stream availability.'
  },
  music_pause: {
    action: 'music_pause',
    category: 'MUSIC',
    description: 'Pauses active music playback in the voice channel.',
    synonyms: ['pause', 'pause song', 'hold music'],
    examples: ['Pause', 'Pause music'],
    requiredArgs: [],
    targetType: null,
    riskLevel: 'LOW',
    preconditions: ['Music actively playing'],
    sideEffects: 'Pauses voice audio stream',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  music_resume: {
    action: 'music_resume',
    category: 'MUSIC',
    description: 'Resumes paused music playback in the voice channel.',
    synonyms: ['resume', 'unpause', 'continue music'],
    examples: ['Resume', 'Unpause music'],
    requiredArgs: [],
    targetType: null,
    riskLevel: 'LOW',
    preconditions: ['Music currently paused'],
    sideEffects: 'Resumes voice audio stream',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  music_skip: {
    action: 'music_skip',
    category: 'MUSIC',
    description: 'Skips the currently playing track in the queue.',
    synonyms: ['skip', 'next track', 'skip song'],
    examples: ['Skip', 'Skip track', 'Next song'],
    requiredArgs: [],
    targetType: null,
    riskLevel: 'LOW',
    preconditions: ['Music actively playing'],
    sideEffects: 'Advances queue to next song',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  music_stop: {
    action: 'music_stop',
    category: 'MUSIC',
    description: 'Stops music playback, clears the queue, and disconnects from the voice channel.',
    synonyms: ['stop music', 'halt music', 'stop playback', 'kill music'],
    examples: ['Stop music', 'Stop playback'],
    requiredArgs: [],
    targetType: null,
    riskLevel: 'LOW',
    preconditions: ['Bot connected to voice'],
    sideEffects: 'Stops audio, empties queue, disconnects voice adapter',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  music_queue: {
    action: 'music_queue',
    category: 'MUSIC',
    description: 'Displays the active voice playback queue and upcoming tracks.',
    synonyms: ['queue', 'show queue', 'music queue', 'view queue', 'whats in queue'],
    examples: ['Queue', 'Show queue', 'What is playing next?'],
    requiredArgs: [],
    targetType: null,
    riskLevel: 'LOW',
    preconditions: ['Bot connected to voice'],
    sideEffects: 'None (read-only view)',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  music_nowplaying: {
    action: 'music_nowplaying',
    category: 'MUSIC',
    description: 'Displays currently playing song with progress bar and details.',
    synonyms: ['now playing', 'np', 'current song', 'whats playing'],
    examples: ['np', 'Now playing', 'What song is this?'],
    requiredArgs: [],
    targetType: null,
    riskLevel: 'LOW',
    preconditions: ['Music actively playing'],
    sideEffects: 'None (read-only view)',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  music_volume: {
    action: 'music_volume',
    category: 'MUSIC',
    description: 'Adjusts playback volume level (0 to 150%).',
    synonyms: ['volume', 'set volume', 'change volume', 'sound level'],
    examples: ['Volume 80', 'Set volume to 50%'],
    requiredArgs: ['volume'],
    targetType: null,
    riskLevel: 'LOW',
    preconditions: ['Music actively playing', 'Volume between 0 and 150'],
    sideEffects: 'Adjusts gain on audio transformer',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  music_leave: {
    action: 'music_leave',
    category: 'MUSIC',
    description: 'Disconnects bot from voice channel.',
    synonyms: ['leave voice', 'disconnect', 'leave call', 'leave vc'],
    examples: ['Leave voice', 'Disconnect'],
    requiredArgs: [],
    targetType: null,
    riskLevel: 'LOW',
    preconditions: ['Bot currently in voice channel'],
    sideEffects: 'Destroys voice connection',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  music_shuffle: {
    action: 'music_shuffle',
    category: 'MUSIC',
    description: 'Randomizes the ordering of upcoming tracks in the music queue.',
    synonyms: ['shuffle', 'shuffle queue', 'randomize songs', 'shuffle playlist'],
    examples: ['Shuffle queue', 'Randomize upcoming songs'],
    requiredArgs: [],
    targetType: null,
    riskLevel: 'LOW',
    preconditions: ['Bot connected to voice channel with queued tracks'],
    sideEffects: 'Shuffles array of queued tracks',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  music_clear: {
    action: 'music_clear',
    category: 'MUSIC',
    description: 'Clears all pending tracks from the music queue.',
    synonyms: ['clear queue', 'empty queue', 'purge queue'],
    examples: ['Clear queue', 'Empty music queue'],
    requiredArgs: [],
    targetType: null,
    riskLevel: 'LOW',
    preconditions: ['Active music subscription with pending queue'],
    sideEffects: 'Empties queue array',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  music_loop: {
    action: 'music_loop',
    category: 'MUSIC',
    description: 'Configures playback repeat mode (off, track, or queue).',
    synonyms: ['loop', 'repeat song', 'loop queue', 'loop track'],
    examples: ['Loop track', 'Set loop queue', 'Loop off'],
    requiredArgs: [],
    targetType: null,
    riskLevel: 'LOW',
    preconditions: ['Active music playback in voice channel'],
    sideEffects: 'Sets loop mode flag',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  music_help: {
    action: 'music_help',
    category: 'MUSIC',
    description: 'Displays the comprehensive Music Engine architecture and capability guide embed.',
    synonyms: ['music help', 'music capabilities', 'audio guide', 'music info'],
    examples: ['Music help', 'Show music capabilities'],
    requiredArgs: [],
    targetType: null,
    riskLevel: 'LOW',
    preconditions: [],
    sideEffects: 'Sends embed',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  honeypot_setup: {
    action: 'honeypot_setup',
    category: 'MODERATION',
    description: 'Sets up or creates an intrusion honeypot channel for compromised-account and spam bot protection.',
    synonyms: ['setup honeypot', 'create honeypot', 'configure honeypot'],
    examples: ['Set up honeypot in #honeypot', 'Create a honeypot channel'],
    requiredArgs: [],
    targetType: 'channel',
    riskLevel: 'LOW',
    preconditions: ['ManageChannels permission if creating channel'],
    sideEffects: 'Creates or links honeypot channel',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  honeypot_enable: {
    action: 'honeypot_enable',
    category: 'MODERATION',
    description: 'Enables active enforcement for the configured honeypot channel.',
    synonyms: ['enable honeypot', 'activate honeypot', 'turn on honeypot'],
    examples: ['Enable honeypot', 'Activate honeypot enforcement'],
    requiredArgs: [],
    targetType: null,
    riskLevel: 'MEDIUM',
    preconditions: ['Honeypot channel configured'],
    sideEffects: 'Activates message monitoring and instant kick enforcement',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.KickMembers],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'Strict mode requires explicit administrator confirmation.'
  },
  honeypot_disable: {
    action: 'honeypot_disable',
    category: 'MODERATION',
    description: 'Disables honeypot enforcement without deleting channel or configuration.',
    synonyms: ['disable honeypot', 'deactivate honeypot', 'pause honeypot'],
    examples: ['Disable honeypot', 'Pause honeypot protection'],
    requiredArgs: [],
    targetType: null,
    riskLevel: 'LOW',
    preconditions: [],
    sideEffects: 'Deactivates honeypot enforcement',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  honeypot_status: {
    action: 'honeypot_status',
    category: 'MODERATION',
    description: 'Displays current honeypot configuration, mode, channel, and recent events.',
    synonyms: ['honeypot status', 'check honeypot', 'view honeypot'],
    examples: ['Honeypot status', 'Check honeypot configuration'],
    requiredArgs: [],
    targetType: null,
    riskLevel: 'LOW',
    preconditions: [],
    sideEffects: 'Sends status embed',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  honeypot_test: {
    action: 'honeypot_test',
    category: 'MODERATION',
    description: 'Performs a non-destructive diagnostic check of honeypot configuration, permissions, and handlers.',
    synonyms: ['test honeypot', 'diagnose honeypot', 'honeypot health check'],
    examples: ['Test honeypot', 'Run honeypot diagnostic test'],
    requiredArgs: [],
    targetType: null,
    riskLevel: 'LOW',
    preconditions: [],
    sideEffects: 'Sends diagnostic test embed without kicking members',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'Non-destructive diagnostic test.'
  },

  // =========================================================================
  // USER PERMISSION & MODERATION ENGINE
  // =========================================================================
  set_user_channel_permission: {
    action: 'set_user_channel_permission',
    category: 'PERMISSIONS',
    description: 'Sets or clears individual member channel permission overwrites with Allow, Deny, and Inherit states.',
    synonyms: ['allow member in channel', 'deny member in channel', 'stop user from sending messages', 'make channel read-only for user', 'reset user channel permissions'],
    examples: ['Allow Alex to send messages in #general', 'Stop Jordan from sending messages in #announcements', 'Let Priya view #staff-chat but not send messages there', 'Reset Sam\'s send-message permission in #general'],
    requiredArgs: ['targetMember', 'targetChannel'],
    targetType: 'member_channel',
    riskLevel: 'MEDIUM',
    preconditions: ['Target member exists in guild', 'Target channel exists', 'Bot has ManageChannels and ViewChannel'],
    sideEffects: 'Updates or creates member-specific permission overwrite on target channel',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ViewChannel],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'CHANNEL_OVERWRITE_CHECK',
    discordLimitations: 'Cannot restrict members with Administrator permission; Administrator bypasses all channel overwrites.'
  },
  inspect_user_permissions: {
    action: 'inspect_user_permissions',
    category: 'PERMISSIONS',
    description: 'Inspects and explains user permissions, distinguishing channel overwrites, role permissions, and Administrator bypass.',
    synonyms: ['show user permissions', 'explain permissions for user', 'why can user delete messages', 'does user have admin'],
    examples: ['Show Alex\'s permissions in #general', 'Why can Jordan delete messages?', 'Does Priya have administrator privileges?'],
    requiredArgs: ['targetMember'],
    targetType: 'member',
    riskLevel: 'LOW',
    preconditions: ['Target member exists in guild'],
    sideEffects: 'None (read-only diagnostic report)',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ViewChannel],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'Discord calculates effective permissions combining base role, channel overwrites, and Administrator.'
  },
  timeout_member: {
    action: 'timeout_member',
    category: 'MODERATION',
    description: 'Times out a member for a specified duration (up to 28 days).',
    synonyms: ['timeout', 'mute member', 'mute in text', 'time out', 'silence member'],
    examples: ['Timeout Alex for 10 minutes for spamming', 'Give Jordan a 1 hour timeout'],
    requiredArgs: ['targetMember', 'durationMinutes'],
    targetType: 'member',
    riskLevel: 'MEDIUM',
    preconditions: ['Target member exists in guild', 'Bot has ModerateMembers', 'Target role lower than bot and actor'],
    sideEffects: 'Disables member communication across all channels for the specified duration',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ModerateMembers],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MEMBER_TIMEOUT_CHECK',
    discordLimitations: 'Maximum timeout duration is 28 days (40320 minutes). Server owner and higher-ranking roles cannot be timed out.'
  },
  remove_timeout: {
    action: 'remove_timeout',
    category: 'MODERATION',
    description: 'Removes an active timeout from a member.',
    synonyms: ['untimeout', 'unmute', 'remove timeout', 'cancel timeout'],
    examples: ['Remove timeout from Alex', 'Untimeout Jordan'],
    requiredArgs: ['targetMember'],
    targetType: 'member',
    riskLevel: 'LOW',
    preconditions: ['Target member exists in guild', 'Member is currently timed out'],
    sideEffects: 'Restores member communication ability',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ModerateMembers],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MEMBER_TIMEOUT_CHECK',
    discordLimitations: 'None.'
  },
  kick_member: {
    action: 'kick_member',
    category: 'MODERATION',
    description: 'Kicks a member from the server.',
    synonyms: ['kick', 'boot', 'remove member', 'get user out'],
    examples: ['Kick Jordan for repeated disruptions', 'Boot user 123456789 from server'],
    requiredArgs: ['targetMember'],
    targetType: 'member',
    riskLevel: 'HIGH',
    preconditions: ['Target member exists in guild', 'Target role lower than bot and actor', 'Not server owner'],
    sideEffects: 'Removes member from guild',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.KickMembers],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: true,
    requiresConfirmation: true,
    isReversible: false,
    verificationMethod: 'MEMBER_REMOVAL_CHECK',
    discordLimitations: 'User can rejoin if they have a valid invite link. Cannot kick server owner or higher roles.'
  },
  ban_member: {
    action: 'ban_member',
    category: 'MODERATION',
    description: 'Permanently bans a user from the server with optional message deletion.',
    synonyms: ['ban', 'permanently ban', 'ban user', 'ban member'],
    examples: ['Ban this user for repeated raids', 'Ban Alex with reason: harassment'],
    requiredArgs: ['targetMember'],
    targetType: 'user',
    riskLevel: 'HIGH',
    preconditions: ['Bot has BanMembers', 'Target role lower than bot and actor if in server', 'Not server owner'],
    sideEffects: 'Adds user to guild ban list and removes them from server',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.BanMembers],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: true,
    requiresConfirmation: true,
    isReversible: true,
    verificationMethod: 'GUILD_BAN_CHECK',
    discordLimitations: 'Cannot ban server owner or users with roles higher than the bot\'s highest role.'
  },
  unban_member: {
    action: 'unban_member',
    category: 'MODERATION',
    description: 'Unbans a previously banned user by ID or username.',
    synonyms: ['unban', 'remove ban', 'lift ban', 'pardon user'],
    examples: ['Unban user 123456789', 'Unban Alex'],
    requiredArgs: ['targetMember'],
    targetType: 'user',
    riskLevel: 'MEDIUM',
    preconditions: ['User is currently in guild ban list', 'Bot has BanMembers'],
    sideEffects: 'Removes user from guild ban list',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.BanMembers],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'GUILD_BAN_CHECK',
    discordLimitations: 'Does not automatically re-invite user to server.'
  },
  softban_member: {
    action: 'softban_member',
    category: 'MODERATION',
    description: 'Kicks a member and deletes their recent messages (1 day) by banning and immediately unbanning.',
    synonyms: ['softban', 'soft ban', 'kick and purge messages'],
    examples: ['Softban Alex for spam', 'Softban Jordan'],
    requiredArgs: ['targetMember'],
    targetType: 'member',
    riskLevel: 'HIGH',
    preconditions: ['Target member exists in guild', 'Bot has BanMembers', 'Target role lower than bot and actor'],
    sideEffects: 'Deletes 1 day of messages and kicks member',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.BanMembers],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: true,
    requiresConfirmation: true,
    isReversible: false,
    verificationMethod: 'MEMBER_REMOVAL_CHECK',
    discordLimitations: 'User can rejoin with an invite link. Only deletes messages from the last 24 hours.'
  },
  voice_mute: {
    action: 'voice_mute',
    category: 'VOICE_MODERATION',
    description: 'Server-mutes a member in voice channel.',
    synonyms: ['voice mute', 'mute in voice', 'server mute in voice', 'mute mic'],
    examples: ['Mute Alex in voice', 'Server mute Jordan in voice'],
    requiredArgs: ['targetMember'],
    targetType: 'member',
    riskLevel: 'LOW',
    preconditions: ['Target member is actively connected to a voice channel', 'Bot has MuteMembers'],
    sideEffects: 'Prevents member from transmitting audio in voice channels',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.MuteMembers],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'VOICE_STATE_CHECK',
    discordLimitations: 'Requires member to be connected to a voice channel.'
  },
  voice_unmute: {
    action: 'voice_unmute',
    category: 'VOICE_MODERATION',
    description: 'Server-unmutes a member in voice channel.',
    synonyms: ['voice unmute', 'unmute in voice', 'server unmute in voice'],
    examples: ['Unmute Alex in voice', 'Server unmute Jordan in voice'],
    requiredArgs: ['targetMember'],
    targetType: 'member',
    riskLevel: 'LOW',
    preconditions: ['Target member is actively connected to a voice channel', 'Bot has MuteMembers'],
    sideEffects: 'Allows member to transmit audio in voice channels again',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.MuteMembers],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'VOICE_STATE_CHECK',
    discordLimitations: 'Requires member to be connected to a voice channel.'
  },
  voice_deafen: {
    action: 'voice_deafen',
    category: 'VOICE_MODERATION',
    description: 'Server-deafens a member in voice channel.',
    synonyms: ['voice deafen', 'deafen in voice', 'server deafen'],
    examples: ['Deafen Alex in voice', 'Server deafen Jordan'],
    requiredArgs: ['targetMember'],
    targetType: 'member',
    riskLevel: 'LOW',
    preconditions: ['Target member is actively connected to a voice channel', 'Bot has DeafenMembers'],
    sideEffects: 'Prevents member from hearing audio in voice channels',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.DeafenMembers],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'VOICE_STATE_CHECK',
    discordLimitations: 'Requires member to be connected to a voice channel.'
  },
  voice_undeafen: {
    action: 'voice_undeafen',
    category: 'VOICE_MODERATION',
    description: 'Server-undeafens a member in voice channel.',
    synonyms: ['voice undeafen', 'undeafen in voice', 'server undeafen'],
    examples: ['Undeafen Alex in voice', 'Server undeafen Jordan'],
    requiredArgs: ['targetMember'],
    targetType: 'member',
    riskLevel: 'LOW',
    preconditions: ['Target member is actively connected to a voice channel', 'Bot has DeafenMembers'],
    sideEffects: 'Allows member to hear audio in voice channels again',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.DeafenMembers],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'VOICE_STATE_CHECK',
    discordLimitations: 'Requires member to be connected to a voice channel.'
  },
  voice_move: {
    action: 'voice_move',
    category: 'VOICE_MODERATION',
    description: 'Moves a member from their current voice channel to another voice channel.',
    synonyms: ['move user to voice', 'move member to voice channel', 'drag to voice'],
    examples: ['Move Alex to voice channel #lounge-voice', 'Drag Jordan to #meeting-room'],
    requiredArgs: ['targetMember', 'targetChannel'],
    targetType: 'member_channel',
    riskLevel: 'LOW',
    preconditions: ['Target member is actively connected to voice', 'Target channel is voice', 'Bot has MoveMembers'],
    sideEffects: 'Moves member to designated voice channel',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.MoveMembers],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'VOICE_STATE_CHECK',
    discordLimitations: 'Requires member to already be in voice.'
  },
  voice_disconnect: {
    action: 'voice_disconnect',
    category: 'VOICE_MODERATION',
    description: 'Disconnects a member from their current voice channel.',
    synonyms: ['disconnect from voice', 'kick from voice', 'drop from voice', 'dc from voice'],
    examples: ['Disconnect Alex from voice', 'Kick Jordan from the voice channel'],
    requiredArgs: ['targetMember'],
    targetType: 'member',
    riskLevel: 'LOW',
    preconditions: ['Target member is actively connected to voice', 'Bot has MoveMembers'],
    sideEffects: 'Forces member to disconnect from voice',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.MoveMembers],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'VOICE_STATE_CHECK',
    discordLimitations: 'Member can reconnect freely.'
  },
  issue_warning: {
    action: 'issue_warning',
    category: 'MODERATION',
    description: 'Issues a moderation warning to a member and persists it in moderation history.',
    synonyms: ['warn member', 'issue warning', 'give warning', 'log warning'],
    examples: ['Warn Alex for spamming', 'Issue warning to Jordan: inappropriate language'],
    requiredArgs: ['targetMember', 'reason'],
    targetType: 'member',
    riskLevel: 'LOW',
    preconditions: ['Target member exists in guild'],
    sideEffects: 'Records warning in persistent storage and moderation log',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'WARNING_PERSISTENCE_CHECK',
    discordLimitations: 'Honey Bot internal persistence; not native Discord audit-log warning.'
  },
  inspect_warnings: {
    action: 'inspect_warnings',
    category: 'MODERATION',
    description: 'Inspects a member\'s recorded warnings.',
    synonyms: ['show warnings', 'check warnings', 'list warnings', 'view warnings'],
    examples: ['Show warnings for Alex', 'Check Jordan\'s warnings'],
    requiredArgs: ['targetMember'],
    targetType: 'member',
    riskLevel: 'LOW',
    preconditions: ['Target member exists in guild'],
    sideEffects: 'None (read-only view)',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  clear_warnings: {
    action: 'clear_warnings',
    category: 'MODERATION',
    description: 'Clears all moderation warnings for a member.',
    synonyms: ['clear warnings', 'reset warnings', 'wipe warnings', 'remove all warnings'],
    examples: ['Clear warnings for Alex', 'Reset warnings for Jordan'],
    requiredArgs: ['targetMember'],
    targetType: 'member',
    riskLevel: 'MEDIUM',
    preconditions: ['Target member exists in guild'],
    sideEffects: 'Deletes user\'s warning records from persistent storage',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: true,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'WARNING_PERSISTENCE_CHECK',
    discordLimitations: 'None.'
  },
  inspect_member_moderation: {
    action: 'inspect_member_moderation',
    category: 'MODERATION',
    description: 'Inspects a member\'s active moderation state including timeout, warnings, voice state, and roles.',
    synonyms: ['inspect moderation state', 'show member moderation', 'check moderation for user'],
    examples: ['Inspect Alex\'s moderation state', 'Check Jordan\'s moderation history'],
    requiredArgs: ['targetMember'],
    targetType: 'member',
    riskLevel: 'LOW',
    preconditions: ['Target member exists in guild'],
    sideEffects: 'None (read-only view)',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  configure_guild_policy: {
    action: 'configure_guild_policy',
    category: 'POLICY',
    description: 'Configures server-isolated Honey Bot access policy (authorized roles, members, capabilities).',
    synonyms: ['allow role', 'authorize role', 'set bot permissions', 'configure access rules', 'grant bot access'],
    examples: ['Allow Moderator role to use Honey Bot in this server', 'Let Support Team inspect members but not kick or ban'],
    requiredArgs: [],
    targetType: 'server',
    riskLevel: 'HIGH',
    preconditions: ['Guild exists', 'Caller is policy admin'],
    sideEffects: 'Updates guild-isolated authorization policy',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: true,
    isReversible: true,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  inspect_guild_policy: {
    action: 'inspect_guild_policy',
    category: 'POLICY',
    description: 'Inspects currently authorized roles, member exceptions, policy admins, and policy status for this server.',
    synonyms: ['show authorized roles', 'who can use honey bot', 'show access policy', 'check access rules'],
    examples: ['Show me the roles currently authorized to operate Honey Bot in this server', 'Who can configure bot access?'],
    requiredArgs: [],
    targetType: 'server',
    riskLevel: 'LOW',
    preconditions: ['Guild exists'],
    sideEffects: 'None (read-only view)',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  test_guild_policy: {
    action: 'test_guild_policy',
    category: 'POLICY',
    description: 'Dry-run policy evaluation to test whether a role or member is authorized for a specific action.',
    synonyms: ['test policy', 'check permissions for role', 'would role be allowed'],
    examples: ['Would a member with Moderator role be allowed to ban someone in this server?'],
    requiredArgs: [],
    targetType: 'server',
    riskLevel: 'LOW',
    preconditions: ['Guild exists'],
    sideEffects: 'None (simulated test only, zero mutations)',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  reset_guild_policy: {
    action: 'reset_guild_policy',
    category: 'POLICY',
    description: 'Resets this server\'s Honey Bot access configuration to its clean bootstrap defaults.',
    synonyms: ['reset policy', 'reset access rules to default', 'restore default bot permissions'],
    examples: ['Reset this server\'s bot access configuration to its defaults'],
    requiredArgs: [],
    targetType: 'server',
    riskLevel: 'HIGH',
    preconditions: ['Guild exists', 'Caller is administrator'],
    sideEffects: 'Resets server policy to defaults (Administrator-only)',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: true,
    requiresConfirmation: true,
    isReversible: true,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  connect_voice: {
    action: 'connect_voice',
    category: 'MUSIC',
    description: 'Connects Honey Bot to a voice channel.',
    synonyms: ['join voice', 'connect to voice', 'join voice channel', 'join channel'],
    examples: ['Join the General voice channel', 'Connect to voice'],
    requiredArgs: [],
    targetType: 'channel',
    riskLevel: 'LOW',
    preconditions: ['Target voice channel exists', 'Bot has Connect permission'],
    sideEffects: 'Establishes voice channel connection',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.Connect],
    requiredUserPermissions: [],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'VOICE_CONNECTION_CHECK',
    discordLimitations: 'Bot must have Connect permission and channel must not be full.'
  },
  music_play: {
    action: 'music_play',
    category: 'MUSIC',
    description: 'Streams music or audio from YouTube, SoundCloud, or direct audio link.',
    synonyms: ['play song', 'stream music', 'play track', 'play audio', 'play'],
    examples: ['Play lofi hip hop', 'Play https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    requiredArgs: ['query'],
    targetType: 'channel',
    riskLevel: 'LOW',
    preconditions: ['Voice connection established', 'Bot has Speak permission'],
    sideEffects: 'Plays audio stream in connected voice channel',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
    requiredUserPermissions: [],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'AUDIO_PLAYER_STATE_CHECK',
    discordLimitations: 'Supports YouTube, SoundCloud, and direct audio streams.'
  },
  music_pause: {
    action: 'music_pause',
    category: 'MUSIC',
    description: 'Pauses active music playback.',
    synonyms: ['pause song', 'pause audio', 'pause playback'],
    examples: ['Pause music'],
    requiredArgs: [],
    targetType: 'channel',
    riskLevel: 'LOW',
    preconditions: ['Music is currently playing'],
    sideEffects: 'Pauses audio stream',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  music_resume: {
    action: 'music_resume',
    category: 'MUSIC',
    description: 'Resumes paused music playback.',
    synonyms: ['unpause', 'resume song', 'resume music'],
    examples: ['Resume playback'],
    requiredArgs: [],
    targetType: 'channel',
    riskLevel: 'LOW',
    preconditions: ['Music is currently paused'],
    sideEffects: 'Resumes audio stream',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  music_skip: {
    action: 'music_skip',
    category: 'MUSIC',
    description: 'Skips the currently playing track to next in queue.',
    synonyms: ['next song', 'skip track', 'skip'],
    examples: ['Skip this song'],
    requiredArgs: [],
    targetType: 'channel',
    riskLevel: 'LOW',
    preconditions: ['A track is playing'],
    sideEffects: 'Advances track queue',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  music_stop: {
    action: 'music_stop',
    category: 'MUSIC',
    description: 'Stops music playback, clears queue, and disconnects from voice.',
    synonyms: ['stop music', 'clear queue and leave', 'stop song'],
    examples: ['Stop the music'],
    requiredArgs: [],
    targetType: 'channel',
    riskLevel: 'LOW',
    preconditions: ['Bot is connected to voice'],
    sideEffects: 'Stops playback and disconnects',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  music_queue: {
    action: 'music_queue',
    category: 'MUSIC',
    description: 'Displays the list of upcoming songs in the queue.',
    synonyms: ['show queue', 'view playlist', 'song queue'],
    examples: ['Show music queue'],
    requiredArgs: [],
    targetType: 'channel',
    riskLevel: 'LOW',
    preconditions: ['Bot is connected to voice'],
    sideEffects: 'None (read-only view)',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  music_nowplaying: {
    action: 'music_nowplaying',
    category: 'MUSIC',
    description: 'Displays information about the currently playing song.',
    synonyms: ['np', 'current track', 'what song is playing'],
    examples: ['What song is playing right now?'],
    requiredArgs: [],
    targetType: 'channel',
    riskLevel: 'LOW',
    preconditions: ['A track is playing'],
    sideEffects: 'None (read-only view)',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'None.'
  },
  music_volume: {
    action: 'music_volume',
    category: 'MUSIC',
    description: 'Sets the playback volume level between 0 and 150 percent.',
    synonyms: ['set volume', 'change volume', 'sound volume'],
    examples: ['Set volume to 50'],
    requiredArgs: ['volume'],
    targetType: 'channel',
    riskLevel: 'LOW',
    preconditions: ['Bot is connected to voice'],
    sideEffects: 'Adjusts audio volume',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'API_RESPONSE',
    discordLimitations: 'Volume bounded between 0 and 150.'
  },
  music_leave: {
    action: 'music_leave',
    category: 'MUSIC',
    description: 'Disconnects Honey Bot from the current voice channel.',
    synonyms: ['leave voice', 'disconnect', 'leave channel'],
    examples: ['Leave voice channel'],
    requiredArgs: [],
    targetType: 'channel',
    riskLevel: 'LOW',
    preconditions: ['Bot is connected to voice'],
    sideEffects: 'Disconnects voice connection',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'VOICE_CONNECTION_CHECK',
    discordLimitations: 'None.'
  }
};

/**
 * Operations explicitly prohibited or restricted by Discord API or Honey Bot security policy.
 */
export const RESTRICTED_OPERATIONS = [
  {
    operation: 'transfer_server_ownership',
    reason: 'Discord API strictly prohibits bots from transferring server ownership. Only the server owner can transfer ownership manually via Discord Server Settings.',
    status: CapabilityStatus.DISCORD_RESTRICTED,
    supportedAlternative: 'You can manage roles, permissions, and administrative capabilities via Honey Bot instead.'
  },
  {
    operation: 'delete_server',
    reason: 'Bots cannot delete a Discord server. Only the server owner with password and 2FA can delete a server in Discord Server Settings.',
    status: CapabilityStatus.DISCORD_RESTRICTED,
    supportedAlternative: 'You can delete or reorganize individual channels and roles via Honey Bot.'
  },
  {
    operation: 'direct_install_arbitrary_bot',
    reason: 'Discord API requires human OAuth2 authorization to add bots. Bots cannot directly install other bots into a server without an administrator completing the OAuth2 flow.',
    status: CapabilityStatus.DISCORD_RESTRICTED,
    supportedAlternative: 'Use "/go get bot invite" or visit the external bot official website to authorize it via Discord OAuth2.'
  },
  {
    operation: 'server_nuke',
    reason: 'Wiping, mass deleting channels or roles, and mass banning are strictly prohibited by Honey Bot Anti-Nuke security policy.',
    status: CapabilityStatus.BLOCKED_BY_POLICY,
    supportedAlternative: 'You can perform targeted deletions of individual channels or roles with confirmation.'
  },
  {
    operation: 'grant_administrator_permission',
    reason: 'Granting Administrator permissions via the automated agent is blocked by security policy to prevent privilege escalation.',
    status: CapabilityStatus.BLOCKED_BY_POLICY,
    supportedAlternative: 'Grant specific administrative permissions (e.g. ManageChannels, ManageRoles) instead.'
  },
  {
    operation: 'modify_global_account',
    reason: 'Bots cannot modify a user\'s global Discord username, email address, password, or private account settings. Server-specific nicknames can be managed instead via change_nickname.',
    status: CapabilityStatus.DISCORD_RESTRICTED,
    supportedAlternative: 'Manage server-specific nicknames using "/go Change [user]\'s nickname to [name]".'
  }
];

/**
 * Regex-based unsupported Discord operations used by the pre-filter.
 */
export const UNSUPPORTED_DISCORD_OPERATIONS = [
  {
    pattern: /transfer\s+(server\s+)?ownership/i,
    reason: 'Discord API strictly prohibits bots from transferring server ownership. Only the server owner can do this manually in Discord Server Settings.',
    supportedAlternative: 'Manage roles and administrator permissions via Honey Bot instead.'
  },
  {
    pattern: /delete\s+(this\s+|the\s+)?server/i,
    reason: 'Discord API strictly prohibits bots from deleting servers. Only the server owner with 2FA can delete a server in Server Settings.',
    supportedAlternative: 'Delete individual channels or reset server configuration with /go.'
  },
  {
    pattern: /(install|add)\s+((an|another|external)\s+)?bot/i,
    reason: 'Discord API requires human OAuth2 authorization to add bots. Bots cannot directly install other bots without an administrator visiting the bot\'s official OAuth2 URL.',
    supportedAlternative: 'Ask for the bot\'s invite link with "/go invite link" or authorize it via Discord\'s official website.'
  },
  {
    pattern: /(?:change|set|update|modify)\s+(?:.*['’]s\s+|my\s+)?(?:global\s+)?(?:discord\s+username|username\s+globally|global\s+tag|email|password|account\s+settings)/i,
    reason: 'Discord API prohibits bots from modifying a user\'s global Discord username, email, password, or account settings.',
    supportedAlternative: 'Manage server-specific nicknames using "/go Change [user]\'s nickname to [name]".'
  }
];

/**
 * Authoritative Capability Registry Helper Class
 * Provides semantic discovery, contextual help, and explanatory handling for unsupported requests.
 */
export class CapabilityRegistry {
  /**
   * Retrieves capability declaration by action identifier.
   */
  static get(actionId) {
    return CAPABILITY_REGISTRY[actionId] || null;
  }

  /**
   * Retrieves all registered capabilities.
   */
  static getAll() {
    return Object.values(CAPABILITY_REGISTRY);
  }

  /**
   * Retrieves capabilities grouped by category.
   */
  static getByCategory(category) {
    const cleanCat = String(category).toUpperCase();
    return Object.values(CAPABILITY_REGISTRY).filter(c => c.category === cleanCat);
  }

  /**
   * Finds a capability matching a natural-language query or synonym.
   */
  static findMatchingCapability(query) {
    if (!query) return null;
    const qLower = String(query).toLowerCase().trim();

    // 1. Direct action key match
    if (CAPABILITY_REGISTRY[qLower]) {
      return CAPABILITY_REGISTRY[qLower];
    }

    // 2. Exact synonym match
    for (const cap of Object.values(CAPABILITY_REGISTRY)) {
      if (cap.synonyms && cap.synonyms.some(s => s.toLowerCase() === qLower)) {
        return cap;
      }
    }

    // 3. Synonym substring / pattern match
    for (const cap of Object.values(CAPABILITY_REGISTRY)) {
      if (cap.synonyms && cap.synonyms.some(s => qLower.includes(s.toLowerCase()) || s.toLowerCase().includes(qLower))) {
        return cap;
      }
    }

    // 4. Example match
    for (const cap of Object.values(CAPABILITY_REGISTRY)) {
      if (cap.examples && cap.examples.some(ex => ex.toLowerCase().includes(qLower) || qLower.includes(ex.toLowerCase()))) {
        return cap;
      }
    }

    // 5. Keyword overlap match
    const qWords = qLower.split(/[\s'’]+/).filter(w => w.length >= 3 && !/^(the|and|for|someone|user|member|with|from|you|can)$/.test(w));
    if (qWords.length > 0) {
      for (const cap of Object.values(CAPABILITY_REGISTRY)) {
        const textToMatch = `${cap.action} ${cap.synonyms?.join(' ') || ''} ${cap.description}`.toLowerCase();
        if (qWords.every(w => textToMatch.includes(w))) {
          return cap;
        }
      }
    }

    return null;
  }

  /**
   * Checks if a request matches an unsupported or restricted operation and provides an explanation.
   */
  static getExplanationForUnsupported(query) {
    if (!query) return null;
    const q = String(query).trim();

    for (const item of UNSUPPORTED_DISCORD_OPERATIONS) {
      if (item.pattern.test(q)) {
        return {
          isUnsupported: true,
          reason: item.reason,
          supportedAlternative: item.supportedAlternative
        };
      }
    }

    const qLower = q.toLowerCase();
    for (const item of RESTRICTED_OPERATIONS) {
      if (qLower.includes(item.operation.replace(/_/g, ' '))) {
        return {
          isUnsupported: true,
          reason: item.reason,
          supportedAlternative: item.supportedAlternative
        };
      }
    }

    return null;
  }

  /**
   * Returns metadata for the five officially registered Discord slash commands.
   */
  static getRegisteredSlashCommands() {
    return REGISTERED_SLASH_COMMANDS;
  }

  /**
   * Returns all supported capability categories with metadata and capability lists.
   */
  static getAllCategories() {
    const categories = Object.values(CAPABILITY_CATEGORIES).sort((a, b) => a.order - b.order);
    return categories.map(cat => ({
      ...cat,
      capabilities: CapabilityRegistry.getByCategory(cat.key).map(cap => CapabilityRegistry.toAuthoritative(cap))
    }));
  }

  /**
   * Formats a capability into an authoritative user-facing descriptor.
   */
  static toAuthoritative(cap) {
    if (!cap) return null;
    const catMeta = CAPABILITY_CATEGORIES[cap.category] || { name: cap.category, description: '' };
    const title = cap.title || humanizeActionTitle(cap.action);
    const primaryExample = cap.examples && cap.examples[0] ? cap.examples[0] : cap.action.replace(/_/g, ' ');
    const isMutating = Boolean(
      cap.isDestructive ||
      cap.requiresConfirmation ||
      !['READ_ONLY', 'INSPECT', 'AUDIT', 'SEARCH', 'LIST', 'LOOKUP'].includes(cap.riskLevel) &&
      !['list_channels', 'list_roles', 'list_categories', 'inspect_category', 'inspect_nickname', 'lookup_member', 'search_messages', 'inspect_guild_policy', 'test_guild_policy', 'music_queue', 'music_nowplaying'].includes(cap.action)
    );

    const classified = ActionRegistry.classify(cap.action || cap.actionId);

    return {
      action: cap.action,
      actionId: cap.action || classified.actionId,
      canonicalName: classified.canonicalName || cap.action,
      title,
      displayName: classified.displayName || title,
      description: cap.description,
      category: cap.category,
      categoryName: catMeta.name,
      functionalCategory: classified.category || FunctionalCategory.UNCLASSIFIED,
      originatingCommand: classified.originatingCommand || '/go',
      executionHandler: classified.executionHandler || null,
      auditEventType: classified.auditEventType || `system.${cap.action}`,
      targetType: cap.targetType || classified.targetType || 'unknown',
      verificationStrategy: cap.verificationMethod || classified.verificationStrategy || 'NONE',
      examples: cap.examples || [],
      goExample: `/go prompt: ${primaryExample}`,
      requiredBotPermissions: cap.requiredBotPermissions || classified.requiredPermissions || [],
      requiredUserPermissions: cap.requiredUserPermissions || [],
      requiredPermissions: cap.requiredBotPermissions || classified.requiredPermissions || [],
      isMutating,
      requiresConfirmation: Boolean(cap.requiresConfirmation || cap.riskLevel === 'HIGH' || cap.isDestructive),
      isImplemented: cap.status === CapabilityStatus.IMPLEMENTED || !cap.status,
      limitations: cap.discordLimitations || 'Subject to Discord rate limits and role hierarchy permissions.'
    };
  }

  /**
   * Searches capabilities by semantic relevance, keywords, and natural-language synonyms.
   */
  static searchCapabilities(query) {
    if (!query) return [];
    const qLower = String(query).toLowerCase().trim();

    // Generic overarching capability inquiries should fall through to general help
    if (/^(?:what\s+(?:are\s+your|can\s+you\s+do|capabilities)|capabilities\??|help\??|how\s+does\s+it\s+work\??)/i.test(qLower)) {
      return [];
    }

    // 1. Check if query matches category directly
    for (const cat of Object.values(CAPABILITY_CATEGORIES)) {
      const catKeyLower = cat.key.toLowerCase();
      const catNameLower = cat.name.toLowerCase();
      if (qLower === catKeyLower || qLower === catNameLower || new RegExp(`\\b${catNameLower}\\b`, 'i').test(qLower)) {
        return CapabilityRegistry.getByCategory(cat.key).map(c => CapabilityRegistry.toAuthoritative(c));
      }
    }

    // 2. Direct single match
    const single = CapabilityRegistry.findMatchingCapability(qLower);
    if (single) {
      return [CapabilityRegistry.toAuthoritative(single)];
    }

    // 3. Multi-word search across action, title, description, and synonyms
    const stopWords = new Set([
      'the', 'and', 'for', 'someone', 'user', 'member', 'with', 'from', 'you', 'your',
      'can', 'how', 'what', 'show', 'tell', 'all', 'our', 'this', 'that', 'are', 'is',
      'was', 'were', 'about', 'please', 'does', 'capabilities', 'capability', 'help'
    ]);
    const words = qLower
      .split(/[\s'’.,!?-]+/)
      .filter(w => w.length >= 3 && !stopWords.has(w));

    if (words.length === 0) return [];

    const matches = [];
    for (const cap of Object.values(CAPABILITY_REGISTRY)) {
      const auth = CapabilityRegistry.toAuthoritative(cap);
      const text = `${auth.action} ${auth.title} ${auth.description} ${cap.synonyms?.join(' ') || ''}`.toLowerCase();
      const matchCount = words.filter(w => {
        const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
      }).length;
      if (matchCount > 0) {
        matches.push({ capability: auth, score: matchCount });
      }
    }

    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, 10).map(m => m.capability);
  }
}

/**
 * Clean human-readable titles for internal capability action IDs.
 */
export function humanizeActionTitle(actionId) {
  if (!actionId) return 'Action';
  const explicit = {
    send_message: 'Send a message',
    send_announcement: 'Post an announcement',
    pin_message: 'Pin a message',
    unpin_message: 'Unpin a message',
    add_reaction: 'Add a reaction',
    purge_messages: 'Purge messages',
    search_messages: 'Search messages',
    create_channel: 'Create a channel',
    edit_channel: 'Edit a channel',
    rename_channel: 'Rename a channel',
    delete_channel: 'Delete a channel',
    set_channel_slowmode: 'Set channel slowmode',
    lock_channel: 'Lock a channel',
    unlock_channel: 'Unlock a channel',
    edit_channel_topic: 'Edit a channel topic',
    move_channel_to_category: 'Move channel to category',
    create_category: 'Create a category',
    rename_category: 'Rename a category',
    delete_category: 'Delete a category',
    inspect_category: 'Inspect a category',
    list_categories: 'List categories',
    set_category_permission: 'Set category permissions',
    sync_category_permissions: 'Sync category permissions',
    inspect_category_sync: 'Inspect category permission sync',
    create_role: 'Create a role',
    edit_role: 'Edit a role',
    delete_role: 'Delete a role',
    assign_role: 'Assign a role',
    remove_role: 'Remove a role',
    change_nickname: 'Change a nickname',
    remove_nickname: 'Remove a nickname',
    inspect_nickname: 'Inspect member nickname',
    lookup_member: 'Lookup member profile',
    timeout_member: 'Timeout a member',
    remove_timeout: 'Remove a timeout',
    kick_member: 'Kick a member',
    ban_member: 'Ban a member',
    unban_member: 'Unban a user',
    mute_member: 'Server mute a member',
    unmute_member: 'Server unmute a member',
    deafen_member: 'Server deafen a member',
    undeafen_member: 'Server undeafen a member',
    disconnect_member: 'Disconnect member from voice',
    move_member_voice: 'Move member to voice channel',
    music_play: 'Play music in voice',
    music_pause: 'Pause music playback',
    music_resume: 'Resume music playback',
    music_skip: 'Skip current track',
    music_stop: 'Stop music and disconnect',
    music_queue: 'View song queue',
    music_nowplaying: 'Show current track',
    music_volume: 'Adjust music volume',
    music_leave: 'Disconnect bot from voice',
    setup_ticket_system: 'Setup ticket system',
    audit_server: 'Audit server security',
    list_channels: 'List server channels',
    list_roles: 'List server roles',
    configure_guild_policy: 'Configure server policy',
    inspect_guild_policy: 'Inspect server policy',
    test_guild_policy: 'Test server policy rules',
    reset_guild_policy: 'Reset server policy'
  };
  if (explicit[actionId]) return explicit[actionId];
  return String(actionId)
    .replace(/_/g, ' ')
    .replace(/^\w/, c => c.toUpperCase());
}

/**
 * Authoritative category mapping for Honey Bot administration operations.
 */
export const CAPABILITY_CATEGORIES = {
  CHANNELS: {
    key: 'CHANNELS',
    name: 'Channel management',
    description: 'Create, rename, edit topics, lock/unlock, slowmode, and move channels.',
    order: 1
  },
  CATEGORIES: {
    key: 'CATEGORIES',
    name: 'Category management',
    description: 'Create, rename, delete categories, move channels into categories, and sync permissions.',
    order: 2
  },
  ROLES: {
    key: 'ROLES',
    name: 'Role management and permissions',
    description: 'Create, edit, delete, assign, and revoke roles; manage channel permission overwrites.',
    order: 3
  },
  MEMBERS: {
    key: 'MEMBERS',
    name: 'Member management',
    description: 'Change and remove nicknames, inspect member profiles, and view roles.',
    order: 4
  },
  MODERATION: {
    key: 'MODERATION',
    name: 'Member moderation',
    description: 'Timeout, remove timeouts, kick, ban, and unban members.',
    order: 5
  },
  VOICE_MODERATION: {
    key: 'VOICE_MODERATION',
    name: 'Voice moderation',
    description: 'Server-mute, deafen, disconnect, or move members in voice channels.',
    order: 6
  },
  MESSAGING: {
    key: 'MESSAGING',
    name: 'Announcements, messaging & cleanup',
    description: 'Post rich announcements, send direct messages, pin/unpin, and purge messages.',
    order: 7
  },
  INTEGRATIONS: {
    key: 'INTEGRATIONS',
    name: 'Tickets and community tools',
    description: 'Setup interactive ticket panels and onboarding tools.',
    order: 8
  },
  MUSIC: {
    key: 'MUSIC',
    name: 'Music and voice audio',
    description: 'Stream audio tracks, manage queue, pause, resume, skip, and adjust volume.',
    order: 9
  },
  SERVER: {
    key: 'SERVER',
    name: 'Server inspection and audits',
    description: 'Audit server security, list channels and roles, and check server configuration.',
    order: 10
  },
  POLICY: {
    key: 'POLICY',
    name: 'Server policy & access control',
    description: 'Configure guild-isolated operator roles, member exceptions, and allowed/denied capabilities.',
    order: 11
  }
};

/**
 * Exactly five registered top-level Discord slash commands.
 */
export const REGISTERED_SLASH_COMMANDS = [
  {
    name: '/go',
    command: '/go',
    description: 'Natural-language execution of supported Discord actions.',
    optionName: 'prompt',
    optionType: 'string',
    required: true,
    usage: '/go prompt: <instruction>',
    example: '/go prompt: Timeout Alex for 10 minutes for spamming.'
  },
  {
    name: '/modlog',
    command: '/modlog',
    description: 'Natural-language configuration and management of moderation logging.',
    optionName: 'prompt',
    optionType: 'string',
    required: true,
    usage: '/modlog prompt: <instruction>',
    example: '/modlog prompt: Set #staff-logs as the log channel and test it.'
  },
  {
    name: '/diagnose',
    command: '/diagnose',
    description: 'Health checks, diagnostics, and supported safe repairs.',
    optionName: 'prompt',
    optionType: 'string',
    required: false,
    usage: '/diagnose [prompt: <problem>]',
    example: '/diagnose'
  },
  {
    name: '/undo',
    command: '/undo',
    description: 'Reversal of supported, reversible actions.',
    optionName: 'prompt',
    optionType: 'string',
    required: false,
    usage: '/undo [prompt: <what to undo>]',
    example: '/undo'
  },
  {
    name: '/help',
    command: '/help',
    description: 'An approachable explanation of Honey Bot and how to use it.',
    optionName: 'prompt',
    optionType: 'string',
    required: false,
    usage: '/help [prompt: <question>]',
    example: '/help prompt: What moderation capabilities are supported?'
  },
  {
    name: '/honeypot',
    command: '/honeypot',
    description: 'Configure, inspect, enable, disable, and safely test honeypot channels.',
    optionName: 'subcommand',
    optionType: 'subcommand',
    required: true,
    usage: '/honeypot <setup|enable|disable|status|configure|test>',
    example: '/honeypot status'
  }
];
