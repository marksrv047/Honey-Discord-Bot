import { PermissionFlagsBits } from 'discord.js';

export const CapabilityStatus = {
  IMPLEMENTED: 'IMPLEMENTED',
  PARTIALLY_TESTED: 'PARTIALLY_TESTED',
  DISCORD_RESTRICTED: 'DISCORD_RESTRICTED',
  BLOCKED_BY_POLICY: 'BLOCKED_BY_POLICY'
};

/**
 * Central Registry & Capability Matrix of Discord Administration Operations.
 */
export const CAPABILITY_REGISTRY = {
  // =========================================================================
  // A. MESSAGING AND ANNOUNCEMENTS
  // =========================================================================
  send_message: {
    category: 'MESSAGING',
    description: 'Sends a direct message or alert to a specified channel.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MESSAGE_ID_CHECK'
  },
  send_announcement: {
    category: 'MESSAGING',
    description: 'Broadcasts a rich embed announcement with optional @everyone or @here pings.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false, // If @everyone, user intent must be explicit
    isReversible: true,
    verificationMethod: 'MESSAGE_ID_CHECK'
  },
  pin_message: {
    category: 'MESSAGING',
    description: 'Pins an important message in a channel.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ViewChannel],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MESSAGE_PIN_CHECK'
  },
  unpin_message: {
    category: 'MESSAGING',
    description: 'Unpins a message from a channel.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ViewChannel],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MESSAGE_PIN_CHECK'
  },
  add_reaction: {
    category: 'MESSAGING',
    description: 'Adds an emoji reaction to a message.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.AddReactions, PermissionFlagsBits.ReadMessageHistory],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'API_RESPONSE'
  },
  purge_messages: {
    category: 'MESSAGING',
    description: 'Bulk deletes up to 100 recent messages from a channel.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ViewChannel],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: true,
    requiresConfirmation: true, // If count > 20
    isReversible: false,
    verificationMethod: 'DELETED_COUNT_CHECK'
  },

  // =========================================================================
  // B. CHANNEL MANAGEMENT
  // =========================================================================
  create_channel: {
    category: 'CHANNELS',
    description: 'Creates text, voice, announcement, or category channels.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'CHANNEL_CACHE_CHECK'
  },
  edit_channel: {
    category: 'CHANNELS',
    description: 'Edits channel name, topic, slowmode, or category.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'CHANNEL_FETCH_CHECK'
  },
  rename_channel: {
    category: 'CHANNELS',
    description: 'Renames a channel directly.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'CHANNEL_NAME_CHECK'
  },
  move_channel: {
    category: 'CHANNELS',
    description: 'Moves a channel under a specific category.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'CHANNEL_PARENT_CHECK'
  },
  lock_channel: {
    category: 'CHANNELS',
    description: 'Locks a channel to prevent standard members from sending messages.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'OVERWRITE_CHECK'
  },
  unlock_channel: {
    category: 'CHANNELS',
    description: 'Unlocks a channel, restoring standard messaging permissions.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'OVERWRITE_CHECK'
  },
  set_channel_slowmode: {
    category: 'CHANNELS',
    description: 'Sets rate-limit per user in seconds (slowmode).',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'CHANNEL_RATE_LIMIT_CHECK'
  },
  set_channel_permission: {
    category: 'CHANNELS',
    description: 'Configures specific allow/deny permission overwrites for a role or member.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'OVERWRITE_CHECK'
  },
  delete_channel: {
    category: 'CHANNELS',
    description: 'Permanently deletes an individual channel (subject to Anti-Nuke aggregate limits).',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: true,
    requiresConfirmation: true,
    isReversible: false,
    verificationMethod: 'CHANNEL_NONEXISTENCE_CHECK'
  },

  // =========================================================================
  // C. ROLE MANAGEMENT
  // =========================================================================
  create_role: {
    category: 'ROLES',
    description: 'Creates a new role with custom color, hoist, and permissions.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageRoles],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'ROLE_CACHE_CHECK'
  },
  edit_role: {
    category: 'ROLES',
    description: 'Edits an existing role name, color, hoist, or non-admin permissions.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageRoles],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'ROLE_FETCH_CHECK'
  },
  delete_role: {
    category: 'ROLES',
    description: 'Permanently deletes a role (subject to Anti-Nuke aggregate limits).',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageRoles],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: true,
    requiresConfirmation: true,
    isReversible: false,
    verificationMethod: 'ROLE_NONEXISTENCE_CHECK'
  },
  assign_role: {
    category: 'ROLES',
    description: 'Assigns a role to a member.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageRoles],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MEMBER_ROLE_CHECK'
  },
  remove_role: {
    category: 'ROLES',
    description: 'Removes a role from a member.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageRoles],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MEMBER_ROLE_CHECK'
  },

  // =========================================================================
  // D. MEMBER MANAGEMENT
  // =========================================================================
  lookup_member: {
    category: 'MEMBERS',
    description: 'Inspects a member profile, identity, server membership, roles, permissions, hierarchy, and moderation history.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE'
  },
  change_nickname: {
    category: 'MEMBERS',
    description: 'Changes a member server nickname.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageNicknames],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MEMBER_NICKNAME_CHECK'
  },
  remove_nickname: {
    category: 'MEMBERS',
    description: 'Removes a member server nickname, resetting it to default display name.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageNicknames],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MEMBER_NICKNAME_CHECK'
  },
  inspect_nickname: {
    category: 'MEMBERS',
    description: 'Inspects a member server nickname and global username (read-only).',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE'
  },
  timeout_member: {
    category: 'MEMBERS',
    description: 'Applies communication disable timeout to a member.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ModerateMembers],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MEMBER_TIMEOUT_CHECK'
  },
  remove_timeout: {
    category: 'MEMBERS',
    description: 'Removes active timeout from a member.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ModerateMembers],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MEMBER_TIMEOUT_CHECK'
  },
  kick_member: {
    category: 'MEMBERS',
    description: 'Kicks a member from the server.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.KickMembers],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: true,
    requiresConfirmation: true,
    isReversible: false,
    verificationMethod: 'MEMBER_NONEXISTENCE_CHECK'
  },
  ban_member: {
    category: 'MEMBERS',
    description: 'Bans a user from the server with message deletion option.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.BanMembers],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: true,
    requiresConfirmation: true,
    isReversible: true,
    verificationMethod: 'BAN_FETCH_CHECK'
  },
  unban_member: {
    category: 'MEMBERS',
    description: 'Removes a ban for a specified user Snowflake ID.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.BanMembers],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'API_RESPONSE'
  },

  // =========================================================================
  // E. SERVER ADMINISTRATION
  // =========================================================================
  update_server_name: {
    category: 'SERVER',
    description: 'Updates guild name (2-100 characters).',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageGuild],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'GUILD_NAME_CHECK'
  },
  update_server_description: {
    category: 'SERVER',
    description: 'Updates guild description (requires Community enabled).',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageGuild],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'API_RESPONSE'
  },
  update_server_icon: {
    category: 'SERVER',
    description: 'Updates guild profile icon from image URL.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageGuild],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'API_RESPONSE'
  },
  update_server_banner: {
    category: 'SERVER',
    description: 'Updates guild banner (Requires Server Boost Tier 2).',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageGuild],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'API_RESPONSE'
  },
  audit_server: {
    category: 'SERVER',
    description: 'Read-only security audit of permissions and roles.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'AUDIT_RESULT'
  },
  setup_ticket_system: {
    category: 'SERVER',
    description: 'Deploys an interactive Ticket System panel with durable buttons.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.SendMessages],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'CHANNEL_CACHE_CHECK'
  },
  setup_role_menu: {
    category: 'SERVER',
    description: 'Creates a self-assignable role selection dropdown.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.SendMessages],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'MESSAGE_ID_CHECK'
  },

  // =========================================================================
  // F. BOT AND INTEGRATION MANAGEMENT
  // =========================================================================
  get_bot_invite: {
    category: 'INTEGRATIONS',
    description: 'Generates official OAuth2 installation link for authorized bot installation.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'API_RESPONSE'
  },
  explain_bot_installation: {
    category: 'INTEGRATIONS',
    description: 'Explains the Discord OAuth2 authorization flow for installing external bots.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: true,
    verificationMethod: 'EXPLANATION'
  },

  // =========================================================================
  // G. MUSIC AND VOICE PLAYBACK
  // =========================================================================
  music_play: {
    category: 'MUSIC',
    description: 'Streams audio from YouTube, SoundCloud, or search into a voice channel.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE'
  },
  music_pause: {
    category: 'MUSIC',
    description: 'Pauses active music playback in the voice channel.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE'
  },
  music_resume: {
    category: 'MUSIC',
    description: 'Resumes paused music playback in the voice channel.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE'
  },
  music_skip: {
    category: 'MUSIC',
    description: 'Skips the currently playing track in the queue.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE'
  },
  music_stop: {
    category: 'MUSIC',
    description: 'Stops music playback, clears the queue, and disconnects from the voice channel.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE'
  },
  music_queue: {
    category: 'MUSIC',
    description: 'Displays the active voice playback queue and upcoming tracks.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE'
  },
  music_nowplaying: {
    category: 'MUSIC',
    description: 'Displays currently playing song with progress bar and details.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE'
  },
  music_volume: {
    category: 'MUSIC',
    description: 'Adjusts playback volume level.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE'
  },
  music_leave: {
    category: 'MUSIC',
    description: 'Disconnects bot from voice channel.',
    status: CapabilityStatus.IMPLEMENTED,
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    requiresConfirmation: false,
    isReversible: false,
    verificationMethod: 'API_RESPONSE'
  }
};

/**
 * Operations explicitly prohibited or restricted by Discord API or Honey Bot security policy.
 */
export const RESTRICTED_OPERATIONS = [
  {
    operation: 'transfer_server_ownership',
    reason: 'Discord API strictly prohibits bots from transferring server ownership. Only the server owner can transfer ownership manually via Server Settings.',
    status: CapabilityStatus.DISCORD_RESTRICTED
  },
  {
    operation: 'delete_server',
    reason: 'Bots cannot delete a Discord server. Only the server owner with password/2FA can delete a server in Server Settings.',
    status: CapabilityStatus.DISCORD_RESTRICTED
  },
  {
    operation: 'direct_install_arbitrary_bot',
    reason: 'Discord API requires human OAuth2 authorization to add bots. Bots cannot directly install other bots into a server without an administrator completing the OAuth2 flow.',
    status: CapabilityStatus.DISCORD_RESTRICTED
  },
  {
    operation: 'server_nuke',
    reason: 'Wiping, mass deleting channels or roles, and mass banning are strictly prohibited by Honey Bot Anti-Nuke security policy.',
    status: CapabilityStatus.BLOCKED_BY_POLICY
  },
  {
    operation: 'grant_administrator_permission',
    reason: 'Granting Administrator permissions via the automated agent is blocked to prevent privilege escalation.',
    status: CapabilityStatus.BLOCKED_BY_POLICY
  },
  {
    operation: 'modify_global_account',
    reason: 'Bots cannot modify a user\'s global Discord username, email address, password, or private account settings. Server-specific nicknames can be managed instead via change_nickname.',
    status: CapabilityStatus.DISCORD_RESTRICTED
  }
];

/**
 * Regex-based unsupported Discord operations used by the Planner pre-filter.
 */
export const UNSUPPORTED_DISCORD_OPERATIONS = [
  {
    pattern: /transfer\s+(server\s+)?ownership/i,
    reason: 'Discord API strictly prohibits bots from transferring server ownership. Only the server owner can do this manually in Discord Server Settings.'
  },
  {
    pattern: /delete\s+(this\s+|the\s+)?server/i,
    reason: 'Discord API strictly prohibits bots from deleting servers. Only the server owner with 2FA can delete a server in Server Settings.'
  },
  {
    pattern: /(install|add)\s+((an|another|external)\s+)?bot/i,
    reason: 'Discord API requires human OAuth2 authorization to add bots. Bots cannot directly install other bots without an administrator visiting the bot\'s official OAuth2 URL.'
  },
  {
    pattern: /(?:change|set|update|modify)\s+(?:.*['’]s\s+|my\s+)?(?:global\s+)?(?:discord\s+username|username\s+globally|global\s+tag|email|password|account\s+settings)/i,
    reason: 'Discord API prohibits bots from modifying a user\'s global Discord username, email, password, or account settings. You can manage server-specific nicknames using "/go Change [user]\'s nickname to [name]".'
  }
];
