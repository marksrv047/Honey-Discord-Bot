import { PermissionFlagsBits } from 'discord.js';

/**
 * Authoritative Functional Categories.
 * Internal classification categories across Honey Bot.
 */
export const FunctionalCategory = Object.freeze({
  MUSIC_VOICE: 'Music & Voice',
  MODERATION_SAFETY: 'Moderation & Member Safety',
  ROLES_PERMISSIONS: 'Roles & Permissions',
  CHANNEL_MANAGEMENT: 'Channel Management',
  SERVER_CONFIGURATION: 'Server Configuration',
  MESSAGES_EMBEDS: 'Messages & Embeds',
  REACTION_ROLES_PANELS: 'Reaction Roles & Interactive Panels',
  DIAGNOSTICS_RECOVERY: 'Diagnostics & Recovery',
  GENERAL_UTILITIES: 'General Utilities',
  UNCLASSIFIED: 'Unclassified'
});

/**
 * Standard Event Sources.
 * Distinguishes the originating interface/source independently of functional category.
 */
export const EventSource = Object.freeze({
  BOT_COMMAND: 'Bot Command Execution',
  DASHBOARD: 'Dashboard Interaction',
  SCHEDULED_TASK: 'Scheduled Task',
  EXTERNAL_EVENT: 'External Discord Administrative Event',
  RECOVERY_UNDO: 'Recovery / Undo Operation',
  UNKNOWN: 'Unknown'
});

/**
 * Truthful Execution Outcome States.
 */
export const OutcomeState = Object.freeze({
  SUCCEEDED: 'Succeeded',
  FAILED: 'Failed',
  PARTIALLY_COMPLETED: 'Partially completed',
  DENIED: 'Denied',
  UNVERIFIED: 'Unverified'
});

/**
 * Truthful Verification Statuses.
 */
export const VerificationStatus = Object.freeze({
  VERIFIED: 'Verified',
  FAILED: 'Failed',
  PARTIALLY_VERIFIED: 'Partially Verified',
  UNVERIFIED: 'Unverified',
  NOT_APPLICABLE: 'Not Applicable'
});

/**
 * Helper to convert snake_case or raw strings into Title Case display names.
 */
function humanizeAction(actionId) {
  if (!actionId) return 'Unknown Action';
  return String(actionId)
    .replace(/[._-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Single Authoritative Action Metadata Registry.
 * Declares all metadata for executable Honey Bot capabilities:
 * - actionId: Stable action ID
 * - canonicalName: Canonical action identifier
 * - displayName: Polished human-readable name
 * - category: Authoritative functional category
 * - originatingCommand: Originating Discord command
 * - executionHandler: Target execution handler reference
 * - auditEventType: Standard dot-notated audit event type
 * - requiredPermissions: Discord bot/user permissions required
 * - targetType: Classification of primary target
 * - verificationStrategy: Strategy used to verify outcome
 */
export const ACTION_DEFINITIONS = {
  // =========================================================================
  // 1. MUSIC & VOICE
  // =========================================================================
  music_play: {
    actionId: 'music_play',
    canonicalName: 'music_play',
    displayName: 'Music Play',
    category: FunctionalCategory.MUSIC_VOICE,
    originatingCommand: '/go',
    executionHandler: 'MusicService.playTrack',
    auditEventType: 'music.play',
    requiredPermissions: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
    targetType: 'channel',
    verificationStrategy: 'PLAYBACK_STATE_VERIFIED'
  },
  play_music: {
    actionId: 'play_music',
    canonicalName: 'music_play',
    displayName: 'Music Play',
    category: FunctionalCategory.MUSIC_VOICE,
    originatingCommand: '/go',
    executionHandler: 'MusicService.playTrack',
    auditEventType: 'music.play',
    requiredPermissions: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
    targetType: 'channel',
    verificationStrategy: 'PLAYBACK_STATE_VERIFIED'
  },
  music_pause: {
    actionId: 'music_pause',
    canonicalName: 'music_pause',
    displayName: 'Music Pause',
    category: FunctionalCategory.MUSIC_VOICE,
    originatingCommand: '/go',
    executionHandler: 'MusicService.pause',
    auditEventType: 'music.pause',
    requiredPermissions: [PermissionFlagsBits.Connect],
    targetType: 'voice_player',
    verificationStrategy: 'PLAYER_STATE_PAUSED'
  },
  music_resume: {
    actionId: 'music_resume',
    canonicalName: 'music_resume',
    displayName: 'Music Resume',
    category: FunctionalCategory.MUSIC_VOICE,
    originatingCommand: '/go',
    executionHandler: 'MusicService.resume',
    auditEventType: 'music.resume',
    requiredPermissions: [PermissionFlagsBits.Connect],
    targetType: 'voice_player',
    verificationStrategy: 'PLAYER_STATE_PLAYING'
  },
  music_skip: {
    actionId: 'music_skip',
    canonicalName: 'music_skip',
    displayName: 'Music Skip',
    category: FunctionalCategory.MUSIC_VOICE,
    originatingCommand: '/go',
    executionHandler: 'MusicService.skip',
    auditEventType: 'music.skip',
    requiredPermissions: [PermissionFlagsBits.Connect],
    targetType: 'voice_player',
    verificationStrategy: 'TRACK_ADVANCED'
  },
  music_stop: {
    actionId: 'music_stop',
    canonicalName: 'music_stop',
    displayName: 'Music Stop',
    category: FunctionalCategory.MUSIC_VOICE,
    originatingCommand: '/go',
    executionHandler: 'MusicService.stop',
    auditEventType: 'music.stop',
    requiredPermissions: [PermissionFlagsBits.Connect],
    targetType: 'voice_player',
    verificationStrategy: 'QUEUE_CLEARED_AND_IDLE'
  },
  music_queue: {
    actionId: 'music_queue',
    canonicalName: 'music_queue',
    displayName: 'Music Queue',
    category: FunctionalCategory.MUSIC_VOICE,
    originatingCommand: '/go',
    executionHandler: 'MusicService.getQueue',
    auditEventType: 'music.queue',
    requiredPermissions: [],
    targetType: 'voice_player',
    verificationStrategy: 'READ_ONLY'
  },
  music_nowplaying: {
    actionId: 'music_nowplaying',
    canonicalName: 'music_nowplaying',
    displayName: 'Music Now Playing',
    category: FunctionalCategory.MUSIC_VOICE,
    originatingCommand: '/go',
    executionHandler: 'MusicService.getNowPlaying',
    auditEventType: 'music.nowplaying',
    requiredPermissions: [],
    targetType: 'voice_player',
    verificationStrategy: 'READ_ONLY'
  },
  music_volume: {
    actionId: 'music_volume',
    canonicalName: 'music_volume',
    displayName: 'Music Volume',
    category: FunctionalCategory.MUSIC_VOICE,
    originatingCommand: '/go',
    executionHandler: 'MusicService.setVolume',
    auditEventType: 'music.volume',
    requiredPermissions: [PermissionFlagsBits.Connect],
    targetType: 'voice_player',
    verificationStrategy: 'VOLUME_LEVEL_SET'
  },
  music_leave: {
    actionId: 'music_leave',
    canonicalName: 'music_leave',
    displayName: 'Disconnect Voice',
    category: FunctionalCategory.MUSIC_VOICE,
    originatingCommand: '/go',
    executionHandler: 'MusicService.leaveVoice',
    auditEventType: 'music.disconnect',
    requiredPermissions: [],
    targetType: 'channel',
    verificationStrategy: 'VOICE_CONNECTION_DESTROYED'
  },
  disconnect_voice: {
    actionId: 'disconnect_voice',
    canonicalName: 'music_leave',
    displayName: 'Disconnect Voice',
    category: FunctionalCategory.MUSIC_VOICE,
    originatingCommand: '/go',
    executionHandler: 'MusicService.leaveVoice',
    auditEventType: 'music.disconnect',
    requiredPermissions: [],
    targetType: 'channel',
    verificationStrategy: 'VOICE_CONNECTION_DESTROYED'
  },
  voice_join: {
    actionId: 'voice_join',
    canonicalName: 'connect_voice',
    displayName: 'Connect Voice',
    category: FunctionalCategory.MUSIC_VOICE,
    originatingCommand: '/go',
    executionHandler: 'MusicService.connectVoice',
    auditEventType: 'voice.connect',
    requiredPermissions: [PermissionFlagsBits.Connect],
    targetType: 'channel',
    verificationStrategy: 'VOICE_CONNECTION_READY'
  },
  connect_voice: {
    actionId: 'connect_voice',
    canonicalName: 'connect_voice',
    displayName: 'Connect Voice',
    category: FunctionalCategory.MUSIC_VOICE,
    originatingCommand: '/go',
    executionHandler: 'MusicService.connectVoice',
    auditEventType: 'voice.connect',
    requiredPermissions: [PermissionFlagsBits.Connect],
    targetType: 'channel',
    verificationStrategy: 'VOICE_CONNECTION_READY'
  },

  // =========================================================================
  // 2. MODERATION & MEMBER SAFETY
  // =========================================================================
  timeout_member: {
    actionId: 'timeout_member',
    canonicalName: 'timeout_member',
    displayName: 'Timeout Member',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/go',
    executionHandler: 'Operations.timeoutMember',
    auditEventType: 'moderation.timeout',
    requiredPermissions: [PermissionFlagsBits.ModerateMembers],
    targetType: 'member',
    verificationStrategy: 'COMMUNICATION_DISABLED_UNTIL_SET'
  },
  remove_timeout: {
    actionId: 'remove_timeout',
    canonicalName: 'remove_timeout',
    displayName: 'Remove Timeout',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/go',
    executionHandler: 'Operations.removeTimeout',
    auditEventType: 'moderation.untimeout',
    requiredPermissions: [PermissionFlagsBits.ModerateMembers],
    targetType: 'member',
    verificationStrategy: 'COMMUNICATION_DISABLED_UNTIL_NULL'
  },
  kick_member: {
    actionId: 'kick_member',
    canonicalName: 'kick_member',
    displayName: 'Kick Member',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/go',
    executionHandler: 'Operations.kickMember',
    auditEventType: 'moderation.kick',
    requiredPermissions: [PermissionFlagsBits.KickMembers],
    targetType: 'member',
    verificationStrategy: 'MEMBER_NOT_IN_GUILD'
  },
  ban_member: {
    actionId: 'ban_member',
    canonicalName: 'ban_member',
    displayName: 'Ban Member',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/go',
    executionHandler: 'Operations.banMember',
    auditEventType: 'moderation.ban',
    requiredPermissions: [PermissionFlagsBits.BanMembers],
    targetType: 'member',
    verificationStrategy: 'GUILD_BAN_EXISTS'
  },
  unban_member: {
    actionId: 'unban_member',
    canonicalName: 'unban_member',
    displayName: 'Unban Member',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/go',
    executionHandler: 'Operations.unbanMember',
    auditEventType: 'moderation.unban',
    requiredPermissions: [PermissionFlagsBits.BanMembers],
    targetType: 'user',
    verificationStrategy: 'GUILD_BAN_REMOVED'
  },
  softban_member: {
    actionId: 'softban_member',
    canonicalName: 'softban_member',
    displayName: 'Softban Member',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/go',
    executionHandler: 'Operations.softbanMember',
    auditEventType: 'moderation.softban',
    requiredPermissions: [PermissionFlagsBits.BanMembers, PermissionFlagsBits.KickMembers],
    targetType: 'member',
    verificationStrategy: 'MEMBER_NOT_IN_GUILD'
  },
  voice_mute: {
    actionId: 'voice_mute',
    canonicalName: 'voice_mute',
    displayName: 'Voice Mute',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/go',
    executionHandler: 'Operations.setVoiceMute',
    auditEventType: 'moderation.voice_mute',
    requiredPermissions: [PermissionFlagsBits.MuteMembers],
    targetType: 'member',
    verificationStrategy: 'VOICE_STATE_MUTED'
  },
  voice_unmute: {
    actionId: 'voice_unmute',
    canonicalName: 'voice_unmute',
    displayName: 'Voice Unmute',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/go',
    executionHandler: 'Operations.setVoiceMute',
    auditEventType: 'moderation.voice_unmute',
    requiredPermissions: [PermissionFlagsBits.MuteMembers],
    targetType: 'member',
    verificationStrategy: 'VOICE_STATE_UNMUTED'
  },
  voice_deafen: {
    actionId: 'voice_deafen',
    canonicalName: 'voice_deafen',
    displayName: 'Voice Deafen',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/go',
    executionHandler: 'Operations.setVoiceDeaf',
    auditEventType: 'moderation.voice_deafen',
    requiredPermissions: [PermissionFlagsBits.DeafenMembers],
    targetType: 'member',
    verificationStrategy: 'VOICE_STATE_DEAFENED'
  },
  voice_undeafen: {
    actionId: 'voice_undeafen',
    canonicalName: 'voice_undeafen',
    displayName: 'Voice Undeafen',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/go',
    executionHandler: 'Operations.setVoiceDeaf',
    auditEventType: 'moderation.voice_undeafen',
    requiredPermissions: [PermissionFlagsBits.DeafenMembers],
    targetType: 'member',
    verificationStrategy: 'VOICE_STATE_UNDEAFENED'
  },
  voice_disconnect_member: {
    actionId: 'voice_disconnect_member',
    canonicalName: 'voice_disconnect_member',
    displayName: 'Disconnect Member from Voice',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/go',
    executionHandler: 'Operations.disconnectMemberVoice',
    auditEventType: 'moderation.voice_disconnect',
    requiredPermissions: [PermissionFlagsBits.MoveMembers],
    targetType: 'member',
    verificationStrategy: 'VOICE_CHANNEL_NULL'
  },
  issue_warning: {
    actionId: 'issue_warning',
    canonicalName: 'issue_warning',
    displayName: 'Issue Warning',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/go',
    executionHandler: 'WarningManager.addWarning',
    auditEventType: 'moderation.warning',
    requiredPermissions: [PermissionFlagsBits.ModerateMembers],
    targetType: 'member',
    verificationStrategy: 'WARNING_LOGGED'
  },
  clear_warnings: {
    actionId: 'clear_warnings',
    canonicalName: 'clear_warnings',
    displayName: 'Clear Warnings',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/go',
    executionHandler: 'WarningManager.clearWarnings',
    auditEventType: 'moderation.clear_warnings',
    requiredPermissions: [PermissionFlagsBits.ModerateMembers],
    targetType: 'member',
    verificationStrategy: 'WARNINGS_EMPTY'
  },
  purge_messages: {
    actionId: 'purge_messages',
    canonicalName: 'purge_messages',
    displayName: 'Purge Messages',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/go',
    executionHandler: 'Operations.purgeMessages',
    auditEventType: 'moderation.purge',
    requiredPermissions: [PermissionFlagsBits.ManageMessages],
    targetType: 'channel',
    verificationStrategy: 'MESSAGES_DELETED_COUNT'
  },
  honeypot_setup: {
    actionId: 'honeypot_setup',
    canonicalName: 'honeypot_setup',
    displayName: 'Setup Honeypot',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/honeypot',
    executionHandler: 'Operations.setupHoneypot',
    auditEventType: 'honeypot.setup',
    requiredPermissions: [PermissionFlagsBits.ManageChannels],
    targetType: 'channel',
    verificationStrategy: 'CHANNEL_EXISTS_WITH_TOPIC'
  },
  honeypot_enable: {
    actionId: 'honeypot_enable',
    canonicalName: 'honeypot_enable',
    displayName: 'Enable Honeypot',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/honeypot',
    executionHandler: 'Operations.enableHoneypot',
    auditEventType: 'honeypot.enable',
    requiredPermissions: [PermissionFlagsBits.ManageGuild],
    targetType: 'server',
    verificationStrategy: 'CONFIG_ACTIVE'
  },
  honeypot_disable: {
    actionId: 'honeypot_disable',
    canonicalName: 'honeypot_disable',
    displayName: 'Disable Honeypot',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/honeypot',
    executionHandler: 'Operations.disableHoneypot',
    auditEventType: 'honeypot.disable',
    requiredPermissions: [PermissionFlagsBits.ManageGuild],
    targetType: 'server',
    verificationStrategy: 'CONFIG_INACTIVE'
  },
  honeypot_status: {
    actionId: 'honeypot_status',
    canonicalName: 'honeypot_status',
    displayName: 'Honeypot Status',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/honeypot',
    executionHandler: 'Operations.getHoneypotStatus',
    auditEventType: 'honeypot.status',
    requiredPermissions: [],
    targetType: 'server',
    verificationStrategy: 'READ_ONLY'
  },
  honeypot_test: {
    actionId: 'honeypot_test',
    canonicalName: 'honeypot_test',
    displayName: 'Test Honeypot',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/honeypot',
    executionHandler: 'Operations.testHoneypot',
    auditEventType: 'honeypot.test',
    requiredPermissions: [],
    targetType: 'server',
    verificationStrategy: 'DIAGNOSTIC_VERIFIED'
  },
  guard_channel: {
    actionId: 'guard_channel',
    canonicalName: 'guard_channel',
    displayName: 'Guard Channel',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/go',
    executionHandler: 'ChannelGuard.guardChannel',
    auditEventType: 'moderation.guard_channel',
    requiredPermissions: [PermissionFlagsBits.ManageChannels],
    targetType: 'channel',
    verificationStrategy: 'CHANNEL_GUARDED'
  },
  unguard_channel: {
    actionId: 'unguard_channel',
    canonicalName: 'unguard_channel',
    displayName: 'Unguard Channel',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/go',
    executionHandler: 'ChannelGuard.unguardChannel',
    auditEventType: 'moderation.unguard_channel',
    requiredPermissions: [PermissionFlagsBits.ManageChannels],
    targetType: 'channel',
    verificationStrategy: 'CHANNEL_UNGUARDED'
  },
  list_guarded_channels: {
    actionId: 'list_guarded_channels',
    canonicalName: 'list_guarded_channels',
    displayName: 'List Guarded Channels',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/go',
    executionHandler: 'ChannelGuard.getGuardedChannels',
    auditEventType: 'moderation.list_guarded',
    requiredPermissions: [],
    targetType: 'server',
    verificationStrategy: 'READ_ONLY'
  },

  // =========================================================================
  // 3. ROLES & PERMISSIONS
  // =========================================================================
  create_role: {
    actionId: 'create_role',
    canonicalName: 'create_role',
    displayName: 'Create Role',
    category: FunctionalCategory.ROLES_PERMISSIONS,
    originatingCommand: '/go',
    executionHandler: 'Operations.createRole',
    auditEventType: 'role.create',
    requiredPermissions: [PermissionFlagsBits.ManageRoles],
    targetType: 'role',
    verificationStrategy: 'ROLE_EXISTS'
  },
  edit_role: {
    actionId: 'edit_role',
    canonicalName: 'edit_role',
    displayName: 'Edit Role',
    category: FunctionalCategory.ROLES_PERMISSIONS,
    originatingCommand: '/go',
    executionHandler: 'Operations.editRole',
    auditEventType: 'role.edit',
    requiredPermissions: [PermissionFlagsBits.ManageRoles],
    targetType: 'role',
    verificationStrategy: 'ROLE_ATTRIBUTES_MATCH'
  },
  delete_role: {
    actionId: 'delete_role',
    canonicalName: 'delete_role',
    displayName: 'Delete Role',
    category: FunctionalCategory.ROLES_PERMISSIONS,
    originatingCommand: '/go',
    executionHandler: 'Operations.deleteRole',
    auditEventType: 'role.delete',
    requiredPermissions: [PermissionFlagsBits.ManageRoles],
    targetType: 'role',
    verificationStrategy: 'ROLE_NOT_EXISTS'
  },
  assign_role: {
    actionId: 'assign_role',
    canonicalName: 'assign_role',
    displayName: 'Assign Role',
    category: FunctionalCategory.ROLES_PERMISSIONS,
    originatingCommand: '/go',
    executionHandler: 'Operations.assignRole',
    auditEventType: 'role.assign',
    requiredPermissions: [PermissionFlagsBits.ManageRoles],
    targetType: 'member',
    verificationStrategy: 'MEMBER_HAS_ROLE'
  },
  remove_role: {
    actionId: 'remove_role',
    canonicalName: 'remove_role',
    displayName: 'Remove Role',
    category: FunctionalCategory.ROLES_PERMISSIONS,
    originatingCommand: '/go',
    executionHandler: 'Operations.removeRole',
    auditEventType: 'role.remove',
    requiredPermissions: [PermissionFlagsBits.ManageRoles],
    targetType: 'member',
    verificationStrategy: 'MEMBER_LACKS_ROLE'
  },
  set_channel_permission: {
    actionId: 'set_channel_permission',
    canonicalName: 'set_channel_permission',
    displayName: 'Set Channel Permission',
    category: FunctionalCategory.ROLES_PERMISSIONS,
    originatingCommand: '/go',
    executionHandler: 'Operations.setChannelPermission',
    auditEventType: 'permission.channel_set',
    requiredPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
    targetType: 'channel',
    verificationStrategy: 'OVERWRITE_MATCHES'
  },
  set_user_channel_permission: {
    actionId: 'set_user_channel_permission',
    canonicalName: 'set_channel_permission',
    displayName: 'Set User Channel Permission',
    category: FunctionalCategory.ROLES_PERMISSIONS,
    originatingCommand: '/go',
    executionHandler: 'Operations.setChannelPermission',
    auditEventType: 'permission.user_channel_set',
    requiredPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
    targetType: 'channel',
    verificationStrategy: 'OVERWRITE_MATCHES'
  },
  remove_channel_permission: {
    actionId: 'remove_channel_permission',
    canonicalName: 'remove_channel_permission',
    displayName: 'Remove Channel Permission',
    category: FunctionalCategory.ROLES_PERMISSIONS,
    originatingCommand: '/go',
    executionHandler: 'Operations.removeChannelPermission',
    auditEventType: 'permission.channel_remove',
    requiredPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
    targetType: 'channel',
    verificationStrategy: 'OVERWRITE_NOT_EXISTS'
  },
  set_category_permission: {
    actionId: 'set_category_permission',
    canonicalName: 'set_category_permission',
    displayName: 'Set Category Permission',
    category: FunctionalCategory.ROLES_PERMISSIONS,
    originatingCommand: '/go',
    executionHandler: 'Operations.setCategoryPermission',
    auditEventType: 'permission.category_set',
    requiredPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
    targetType: 'category',
    verificationStrategy: 'OVERWRITE_MATCHES'
  },
  sync_category_permissions: {
    actionId: 'sync_category_permissions',
    canonicalName: 'sync_category_permissions',
    displayName: 'Sync Category Permissions',
    category: FunctionalCategory.ROLES_PERMISSIONS,
    originatingCommand: '/go',
    executionHandler: 'Operations.syncCategoryPermissions',
    auditEventType: 'permission.category_sync',
    requiredPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
    targetType: 'category',
    verificationStrategy: 'CHILDREN_SYNCED'
  },
  inspect_category_sync: {
    actionId: 'inspect_category_sync',
    canonicalName: 'inspect_category_sync',
    displayName: 'Inspect Category Sync',
    category: FunctionalCategory.ROLES_PERMISSIONS,
    originatingCommand: '/go',
    executionHandler: 'Operations.inspectCategorySync',
    auditEventType: 'permission.inspect_sync',
    requiredPermissions: [],
    targetType: 'category',
    verificationStrategy: 'READ_ONLY'
  },

  // =========================================================================
  // 4. CHANNEL MANAGEMENT
  // =========================================================================
  create_channel: {
    actionId: 'create_channel',
    canonicalName: 'create_channel',
    displayName: 'Create Channel',
    category: FunctionalCategory.CHANNEL_MANAGEMENT,
    originatingCommand: '/go',
    executionHandler: 'Operations.createChannel',
    auditEventType: 'channel.create',
    requiredPermissions: [PermissionFlagsBits.ManageChannels],
    targetType: 'channel',
    verificationStrategy: 'CHANNEL_EXISTS'
  },
  edit_channel: {
    actionId: 'edit_channel',
    canonicalName: 'edit_channel',
    displayName: 'Edit Channel',
    category: FunctionalCategory.CHANNEL_MANAGEMENT,
    originatingCommand: '/go',
    executionHandler: 'Operations.editChannel',
    auditEventType: 'channel.edit',
    requiredPermissions: [PermissionFlagsBits.ManageChannels],
    targetType: 'channel',
    verificationStrategy: 'CHANNEL_ATTRIBUTES_MATCH'
  },
  delete_channel: {
    actionId: 'delete_channel',
    canonicalName: 'delete_channel',
    displayName: 'Delete Channel',
    category: FunctionalCategory.CHANNEL_MANAGEMENT,
    originatingCommand: '/go',
    executionHandler: 'Operations.deleteChannel',
    auditEventType: 'channel.delete',
    requiredPermissions: [PermissionFlagsBits.ManageChannels],
    targetType: 'channel',
    verificationStrategy: 'CHANNEL_NOT_EXISTS'
  },
  rename_channel: {
    actionId: 'rename_channel',
    canonicalName: 'rename_channel',
    displayName: 'Rename Channel',
    category: FunctionalCategory.CHANNEL_MANAGEMENT,
    originatingCommand: '/go',
    executionHandler: 'Operations.renameChannel',
    auditEventType: 'channel.rename',
    requiredPermissions: [PermissionFlagsBits.ManageChannels],
    targetType: 'channel',
    verificationStrategy: 'CHANNEL_NAME_MATCHES'
  },
  edit_channel_topic: {
    actionId: 'edit_channel_topic',
    canonicalName: 'edit_channel_topic',
    displayName: 'Edit Channel Topic',
    category: FunctionalCategory.CHANNEL_MANAGEMENT,
    originatingCommand: '/go',
    executionHandler: 'Operations.editChannelTopic',
    auditEventType: 'channel.edit_topic',
    requiredPermissions: [PermissionFlagsBits.ManageChannels],
    targetType: 'channel',
    verificationStrategy: 'TOPIC_MATCHES'
  },
  set_channel_slowmode: {
    actionId: 'set_channel_slowmode',
    canonicalName: 'set_channel_slowmode',
    displayName: 'Set Channel Slowmode',
    category: FunctionalCategory.CHANNEL_MANAGEMENT,
    originatingCommand: '/go',
    executionHandler: 'Operations.setChannelSlowmode',
    auditEventType: 'channel.slowmode',
    requiredPermissions: [PermissionFlagsBits.ManageChannels],
    targetType: 'channel',
    verificationStrategy: 'SLOWMODE_MATCHES'
  },
  lock_channel: {
    actionId: 'lock_channel',
    canonicalName: 'lock_channel',
    displayName: 'Lock Channel',
    category: FunctionalCategory.CHANNEL_MANAGEMENT,
    originatingCommand: '/go',
    executionHandler: 'Operations.lockChannel',
    auditEventType: 'channel.lock',
    requiredPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
    targetType: 'channel',
    verificationStrategy: 'SEND_MESSAGES_DENIED'
  },
  unlock_channel: {
    actionId: 'unlock_channel',
    canonicalName: 'unlock_channel',
    displayName: 'Unlock Channel',
    category: FunctionalCategory.CHANNEL_MANAGEMENT,
    originatingCommand: '/go',
    executionHandler: 'Operations.unlockChannel',
    auditEventType: 'channel.unlock',
    requiredPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
    targetType: 'channel',
    verificationStrategy: 'SEND_MESSAGES_ALLOWED'
  },
  move_channel: {
    actionId: 'move_channel',
    canonicalName: 'move_channel',
    displayName: 'Move Channel',
    category: FunctionalCategory.CHANNEL_MANAGEMENT,
    originatingCommand: '/go',
    executionHandler: 'Operations.moveChannel',
    auditEventType: 'channel.move',
    requiredPermissions: [PermissionFlagsBits.ManageChannels],
    targetType: 'channel',
    verificationStrategy: 'PARENT_OR_POSITION_MATCHES'
  },
  move_channel_to_category: {
    actionId: 'move_channel_to_category',
    canonicalName: 'move_channel_to_category',
    displayName: 'Move Channel to Category',
    category: FunctionalCategory.CHANNEL_MANAGEMENT,
    originatingCommand: '/go',
    executionHandler: 'Operations.moveChannelToCategory',
    auditEventType: 'channel.move_to_category',
    requiredPermissions: [PermissionFlagsBits.ManageChannels],
    targetType: 'channel',
    verificationStrategy: 'PARENT_ID_MATCHES'
  },
  create_category: {
    actionId: 'create_category',
    canonicalName: 'create_category',
    displayName: 'Create Category',
    category: FunctionalCategory.CHANNEL_MANAGEMENT,
    originatingCommand: '/go',
    executionHandler: 'Operations.createCategory',
    auditEventType: 'category.create',
    requiredPermissions: [PermissionFlagsBits.ManageChannels],
    targetType: 'category',
    verificationStrategy: 'CATEGORY_EXISTS'
  },
  rename_category: {
    actionId: 'rename_category',
    canonicalName: 'rename_category',
    displayName: 'Rename Category',
    category: FunctionalCategory.CHANNEL_MANAGEMENT,
    originatingCommand: '/go',
    executionHandler: 'Operations.renameCategory',
    auditEventType: 'category.rename',
    requiredPermissions: [PermissionFlagsBits.ManageChannels],
    targetType: 'category',
    verificationStrategy: 'CATEGORY_NAME_MATCHES'
  },
  delete_category: {
    actionId: 'delete_category',
    canonicalName: 'delete_category',
    displayName: 'Delete Category',
    category: FunctionalCategory.CHANNEL_MANAGEMENT,
    originatingCommand: '/go',
    executionHandler: 'Operations.deleteCategory',
    auditEventType: 'category.delete',
    requiredPermissions: [PermissionFlagsBits.ManageChannels],
    targetType: 'category',
    verificationStrategy: 'CATEGORY_NOT_EXISTS'
  },
  inspect_category: {
    actionId: 'inspect_category',
    canonicalName: 'inspect_category',
    displayName: 'Inspect Category',
    category: FunctionalCategory.CHANNEL_MANAGEMENT,
    originatingCommand: '/go',
    executionHandler: 'Operations.inspectCategory',
    auditEventType: 'category.inspect',
    requiredPermissions: [],
    targetType: 'category',
    verificationStrategy: 'READ_ONLY'
  },
  list_categories: {
    actionId: 'list_categories',
    canonicalName: 'list_categories',
    displayName: 'List Categories',
    category: FunctionalCategory.CHANNEL_MANAGEMENT,
    originatingCommand: '/go',
    executionHandler: 'Operations.listCategories',
    auditEventType: 'category.list',
    requiredPermissions: [],
    targetType: 'server',
    verificationStrategy: 'READ_ONLY'
  },
  configure_channel_preset: {
    actionId: 'configure_channel_preset',
    canonicalName: 'configure_channel_preset',
    displayName: 'Configure Channel Preset',
    category: FunctionalCategory.CHANNEL_MANAGEMENT,
    originatingCommand: '/go',
    executionHandler: 'Operations.configureChannelPreset',
    auditEventType: 'channel.configure_preset',
    requiredPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
    targetType: 'channel',
    verificationStrategy: 'PRESET_OVERWRITES_VERIFIED'
  },

  // =========================================================================
  // 5. SERVER CONFIGURATION
  // =========================================================================
  update_server_name: {
    actionId: 'update_server_name',
    canonicalName: 'update_server_name',
    displayName: 'Update Server Name',
    category: FunctionalCategory.SERVER_CONFIGURATION,
    originatingCommand: '/go',
    executionHandler: 'Operations.updateServerName',
    auditEventType: 'server.update_name',
    requiredPermissions: [PermissionFlagsBits.ManageGuild],
    targetType: 'server',
    verificationStrategy: 'NAME_MATCHES'
  },
  update_server_description: {
    actionId: 'update_server_description',
    canonicalName: 'update_server_description',
    displayName: 'Update Server Description',
    category: FunctionalCategory.SERVER_CONFIGURATION,
    originatingCommand: '/go',
    executionHandler: 'Operations.updateServerDescription',
    auditEventType: 'server.update_description',
    requiredPermissions: [PermissionFlagsBits.ManageGuild],
    targetType: 'server',
    verificationStrategy: 'DESCRIPTION_MATCHES'
  },
  update_server_icon: {
    actionId: 'update_server_icon',
    canonicalName: 'update_server_icon',
    displayName: 'Update Server Icon',
    category: FunctionalCategory.SERVER_CONFIGURATION,
    originatingCommand: '/go',
    executionHandler: 'Operations.updateServerIcon',
    auditEventType: 'server.update_icon',
    requiredPermissions: [PermissionFlagsBits.ManageGuild],
    targetType: 'server',
    verificationStrategy: 'ICON_UPDATED'
  },
  update_server_banner: {
    actionId: 'update_server_banner',
    canonicalName: 'update_server_banner',
    displayName: 'Update Server Banner',
    category: FunctionalCategory.SERVER_CONFIGURATION,
    originatingCommand: '/go',
    executionHandler: 'Operations.updateServerBanner',
    auditEventType: 'server.update_banner',
    requiredPermissions: [PermissionFlagsBits.ManageGuild],
    targetType: 'server',
    verificationStrategy: 'BANNER_UPDATED'
  },
  update_server_settings: {
    actionId: 'update_server_settings',
    canonicalName: 'update_server_settings',
    displayName: 'Update Server Settings',
    category: FunctionalCategory.SERVER_CONFIGURATION,
    originatingCommand: '/go',
    executionHandler: 'Operations.updateServerSettings',
    auditEventType: 'server.update_settings',
    requiredPermissions: [PermissionFlagsBits.ManageGuild],
    targetType: 'server',
    verificationStrategy: 'SETTINGS_MATCH'
  },
  setup_modlog: {
    actionId: 'setup_modlog',
    canonicalName: 'setup_modlog',
    displayName: 'Setup Moderation Log',
    category: FunctionalCategory.SERVER_CONFIGURATION,
    originatingCommand: '/modlog',
    executionHandler: 'ModLogService.setupModlogs',
    auditEventType: 'modlog.setup',
    requiredPermissions: [PermissionFlagsBits.ManageGuild],
    targetType: 'channel',
    verificationStrategy: 'TEST_DELIVERY_CONFIRMED'
  },
  inspect_modlog: {
    actionId: 'inspect_modlog',
    canonicalName: 'inspect_modlog',
    displayName: 'Inspect Moderation Log',
    category: FunctionalCategory.SERVER_CONFIGURATION,
    originatingCommand: '/modlog',
    executionHandler: 'ModLogService.getConfig',
    auditEventType: 'modlog.inspect',
    requiredPermissions: [],
    targetType: 'server',
    verificationStrategy: 'READ_ONLY'
  },
  configure_guild_policy: {
    actionId: 'configure_guild_policy',
    canonicalName: 'configure_guild_policy',
    displayName: 'Configure Guild Policy',
    category: FunctionalCategory.SERVER_CONFIGURATION,
    originatingCommand: '/go',
    executionHandler: 'GuildConfigService.updatePolicy',
    auditEventType: 'policy.configure',
    requiredPermissions: [PermissionFlagsBits.Administrator],
    targetType: 'server',
    verificationStrategy: 'POLICY_SAVED'
  },
  inspect_guild_policy: {
    actionId: 'inspect_guild_policy',
    canonicalName: 'inspect_guild_policy',
    displayName: 'Inspect Guild Policy',
    category: FunctionalCategory.SERVER_CONFIGURATION,
    originatingCommand: '/go',
    executionHandler: 'GuildConfigService.getPolicy',
    auditEventType: 'policy.inspect',
    requiredPermissions: [],
    targetType: 'server',
    verificationStrategy: 'READ_ONLY'
  },
  reset_guild_policy: {
    actionId: 'reset_guild_policy',
    canonicalName: 'reset_guild_policy',
    displayName: 'Reset Guild Policy',
    category: FunctionalCategory.SERVER_CONFIGURATION,
    originatingCommand: '/go',
    executionHandler: 'GuildConfigService.resetPolicy',
    auditEventType: 'policy.reset',
    requiredPermissions: [PermissionFlagsBits.Administrator],
    targetType: 'server',
    verificationStrategy: 'POLICY_RESET'
  },
  test_guild_policy: {
    actionId: 'test_guild_policy',
    canonicalName: 'test_guild_policy',
    displayName: 'Test Guild Policy',
    category: FunctionalCategory.SERVER_CONFIGURATION,
    originatingCommand: '/go',
    executionHandler: 'GuildConfigService.testPolicy',
    auditEventType: 'policy.test',
    requiredPermissions: [],
    targetType: 'server',
    verificationStrategy: 'READ_ONLY'
  },

  // =========================================================================
  // 6. MESSAGES & EMBEDS
  // =========================================================================
  send_message: {
    actionId: 'send_message',
    canonicalName: 'send_message',
    displayName: 'Send Message',
    category: FunctionalCategory.MESSAGES_EMBEDS,
    originatingCommand: '/go',
    executionHandler: 'Operations.sendMessage',
    auditEventType: 'message.send',
    requiredPermissions: [PermissionFlagsBits.SendMessages],
    targetType: 'channel',
    verificationStrategy: 'MESSAGE_ID_CHECK'
  },
  send_announcement: {
    actionId: 'send_announcement',
    canonicalName: 'send_announcement',
    displayName: 'Send Announcement',
    category: FunctionalCategory.MESSAGES_EMBEDS,
    originatingCommand: '/go',
    executionHandler: 'Operations.sendAnnouncement',
    auditEventType: 'message.announcement',
    requiredPermissions: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks],
    targetType: 'channel',
    verificationStrategy: 'MESSAGE_ID_CHECK'
  },
  publish_embed: {
    actionId: 'publish_embed',
    canonicalName: 'publish_embed',
    displayName: 'Publish Embed',
    category: FunctionalCategory.MESSAGES_EMBEDS,
    originatingCommand: '/go',
    executionHandler: 'Operations.publishEmbed',
    auditEventType: 'embed.publish',
    requiredPermissions: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks],
    targetType: 'channel',
    verificationStrategy: 'MESSAGE_ID_CHECK'
  },
  create_embed: {
    actionId: 'create_embed',
    canonicalName: 'publish_embed',
    displayName: 'Create Embed',
    category: FunctionalCategory.MESSAGES_EMBEDS,
    originatingCommand: '/go',
    executionHandler: 'Operations.createEmbed',
    auditEventType: 'embed.create',
    requiredPermissions: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks],
    targetType: 'channel',
    verificationStrategy: 'MESSAGE_ID_CHECK'
  },
  edit_embed: {
    actionId: 'edit_embed',
    canonicalName: 'edit_embed',
    displayName: 'Edit Embed',
    category: FunctionalCategory.MESSAGES_EMBEDS,
    originatingCommand: '/go',
    executionHandler: 'Operations.editEmbed',
    auditEventType: 'embed.edit',
    requiredPermissions: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks],
    targetType: 'channel',
    verificationStrategy: 'EMBED_UPDATED'
  },
  search_messages: {
    actionId: 'search_messages',
    canonicalName: 'search_messages',
    displayName: 'Search Messages',
    category: FunctionalCategory.MESSAGES_EMBEDS,
    originatingCommand: '/go',
    executionHandler: 'Operations.searchMessages',
    auditEventType: 'message.search',
    requiredPermissions: [PermissionFlagsBits.ReadMessageHistory],
    targetType: 'channel',
    verificationStrategy: 'READ_ONLY'
  },
  pin_message: {
    actionId: 'pin_message',
    canonicalName: 'pin_message',
    displayName: 'Pin Message',
    category: FunctionalCategory.MESSAGES_EMBEDS,
    originatingCommand: '/go',
    executionHandler: 'Operations.pinMessage',
    auditEventType: 'message.pin',
    requiredPermissions: [PermissionFlagsBits.ManageMessages],
    targetType: 'message',
    verificationStrategy: 'MESSAGE_PINNED'
  },
  unpin_message: {
    actionId: 'unpin_message',
    canonicalName: 'unpin_message',
    displayName: 'Unpin Message',
    category: FunctionalCategory.MESSAGES_EMBEDS,
    originatingCommand: '/go',
    executionHandler: 'Operations.unpinMessage',
    auditEventType: 'message.unpin',
    requiredPermissions: [PermissionFlagsBits.ManageMessages],
    targetType: 'message',
    verificationStrategy: 'MESSAGE_UNPINNED'
  },
  add_reaction: {
    actionId: 'add_reaction',
    canonicalName: 'add_reaction',
    displayName: 'Add Reaction',
    category: FunctionalCategory.MESSAGES_EMBEDS,
    originatingCommand: '/go',
    executionHandler: 'Operations.addReaction',
    auditEventType: 'message.reaction',
    requiredPermissions: [PermissionFlagsBits.AddReactions],
    targetType: 'message',
    verificationStrategy: 'REACTION_ADDED'
  },

  // =========================================================================
  // 7. REACTION ROLES & INTERACTIVE PANELS
  // =========================================================================
  setup_role_panel: {
    actionId: 'setup_role_panel',
    canonicalName: 'setup_role_panel',
    displayName: 'Setup Role Panel',
    category: FunctionalCategory.REACTION_ROLES_PANELS,
    originatingCommand: '/go',
    executionHandler: 'Operations.setupRolePanel',
    auditEventType: 'panel.role_setup',
    requiredPermissions: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageRoles],
    targetType: 'channel',
    verificationStrategy: 'PANEL_REGISTERED'
  },
  setup_role_menu: {
    actionId: 'setup_role_menu',
    canonicalName: 'setup_role_panel',
    displayName: 'Setup Role Menu',
    category: FunctionalCategory.REACTION_ROLES_PANELS,
    originatingCommand: '/go',
    executionHandler: 'Operations.setupRolePanel',
    auditEventType: 'panel.role_setup',
    requiredPermissions: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageRoles],
    targetType: 'channel',
    verificationStrategy: 'PANEL_REGISTERED'
  },
  repair_role_panel: {
    actionId: 'repair_role_panel',
    canonicalName: 'repair_role_panel',
    displayName: 'Repair Role Panel',
    category: FunctionalCategory.REACTION_ROLES_PANELS,
    originatingCommand: '/go',
    executionHandler: 'Operations.repairRolePanel',
    auditEventType: 'panel.role_repair',
    requiredPermissions: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageRoles],
    targetType: 'panel',
    verificationStrategy: 'PANEL_REPAIRED'
  },
  delete_role_panel: {
    actionId: 'delete_role_panel',
    canonicalName: 'delete_role_panel',
    displayName: 'Delete Role Panel',
    category: FunctionalCategory.REACTION_ROLES_PANELS,
    originatingCommand: '/go',
    executionHandler: 'Operations.deleteRolePanel',
    auditEventType: 'panel.role_delete',
    requiredPermissions: [PermissionFlagsBits.ManageMessages],
    targetType: 'panel',
    verificationStrategy: 'PANEL_UNREGISTERED'
  },
  setup_ticket_system: {
    actionId: 'setup_ticket_system',
    canonicalName: 'setup_ticket_system',
    displayName: 'Setup Ticket System',
    category: FunctionalCategory.REACTION_ROLES_PANELS,
    originatingCommand: '/go',
    executionHandler: 'Operations.setupTicketSystem',
    auditEventType: 'panel.ticket_setup',
    requiredPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks],
    targetType: 'channel',
    verificationStrategy: 'TICKET_PANEL_POSTED'
  },

  // =========================================================================
  // 8. DIAGNOSTICS & RECOVERY
  // =========================================================================
  audit_server: {
    actionId: 'audit_server',
    canonicalName: 'audit_server',
    displayName: 'Audit Server',
    category: FunctionalCategory.DIAGNOSTICS_RECOVERY,
    originatingCommand: '/diagnose',
    executionHandler: 'Operations.auditServer',
    auditEventType: 'diagnostics.audit',
    requiredPermissions: [],
    targetType: 'server',
    verificationStrategy: 'READ_ONLY'
  },
  diagnose_health: {
    actionId: 'diagnose_health',
    canonicalName: 'diagnose_health',
    displayName: 'Diagnose Health',
    category: FunctionalCategory.DIAGNOSTICS_RECOVERY,
    originatingCommand: '/diagnose',
    executionHandler: 'DiagnosticService.runDiagnostic',
    auditEventType: 'diagnostics.health',
    requiredPermissions: [],
    targetType: 'server',
    verificationStrategy: 'READ_ONLY'
  },
  undo_recovery: {
    actionId: 'undo_recovery',
    canonicalName: 'undo_recovery',
    displayName: 'Undo Recovery',
    category: FunctionalCategory.DIAGNOSTICS_RECOVERY,
    originatingCommand: '/undo',
    executionHandler: 'RecoveryEngine.undoLastAction',
    auditEventType: 'recovery.undo',
    requiredPermissions: [PermissionFlagsBits.Administrator],
    targetType: 'action',
    verificationStrategy: 'PRESTATE_RESTORED'
  },
  inspect_action_history: {
    actionId: 'inspect_action_history',
    canonicalName: 'inspect_action_history',
    displayName: 'Inspect Action History',
    category: FunctionalCategory.DIAGNOSTICS_RECOVERY,
    originatingCommand: '/undo',
    executionHandler: 'ActionLedger.getRecentHistory',
    auditEventType: 'recovery.inspect',
    requiredPermissions: [],
    targetType: 'server',
    verificationStrategy: 'READ_ONLY'
  },

  // =========================================================================
  // 9. GENERAL UTILITIES
  // =========================================================================
  open_dashboard: {
    actionId: 'open_dashboard',
    canonicalName: 'open_dashboard',
    displayName: 'Open Dashboard',
    category: FunctionalCategory.GENERAL_UTILITIES,
    originatingCommand: '/go',
    executionHandler: 'DashboardManager.openDashboard',
    auditEventType: 'utilities.dashboard',
    requiredPermissions: [PermissionFlagsBits.Administrator],
    targetType: 'server',
    verificationStrategy: 'PANEL_SENT'
  },
  open_setup: {
    actionId: 'open_setup',
    canonicalName: 'open_setup',
    displayName: 'Open Setup',
    category: FunctionalCategory.GENERAL_UTILITIES,
    originatingCommand: '/go',
    executionHandler: 'OnboardingManager.openSetup',
    auditEventType: 'utilities.setup',
    requiredPermissions: [PermissionFlagsBits.Administrator],
    targetType: 'server',
    verificationStrategy: 'PANEL_SENT'
  },
  list_channels: {
    actionId: 'list_channels',
    canonicalName: 'list_channels',
    displayName: 'List Channels',
    category: FunctionalCategory.GENERAL_UTILITIES,
    originatingCommand: '/go',
    executionHandler: 'Operations.listChannels',
    auditEventType: 'utilities.list_channels',
    requiredPermissions: [],
    targetType: 'server',
    verificationStrategy: 'READ_ONLY'
  },
  list_roles: {
    actionId: 'list_roles',
    canonicalName: 'list_roles',
    displayName: 'List Roles',
    category: FunctionalCategory.GENERAL_UTILITIES,
    originatingCommand: '/go',
    executionHandler: 'Operations.listRoles',
    auditEventType: 'utilities.list_roles',
    requiredPermissions: [],
    targetType: 'server',
    verificationStrategy: 'READ_ONLY'
  },
  lookup_member: {
    actionId: 'lookup_member',
    canonicalName: 'lookup_member',
    displayName: 'Lookup Member',
    category: FunctionalCategory.GENERAL_UTILITIES,
    originatingCommand: '/go',
    executionHandler: 'Operations.lookupMember',
    auditEventType: 'utilities.lookup_member',
    requiredPermissions: [],
    targetType: 'member',
    verificationStrategy: 'READ_ONLY'
  },
  change_nickname: {
    actionId: 'change_nickname',
    canonicalName: 'change_nickname',
    displayName: 'Change Nickname',
    category: FunctionalCategory.GENERAL_UTILITIES,
    originatingCommand: '/go',
    executionHandler: 'Operations.changeNickname',
    auditEventType: 'member.change_nickname',
    requiredPermissions: [PermissionFlagsBits.ManageNicknames],
    targetType: 'member',
    verificationStrategy: 'NICKNAME_MATCHES'
  },
  remove_nickname: {
    actionId: 'remove_nickname',
    canonicalName: 'remove_nickname',
    displayName: 'Remove Nickname',
    category: FunctionalCategory.GENERAL_UTILITIES,
    originatingCommand: '/go',
    executionHandler: 'Operations.removeNickname',
    auditEventType: 'member.remove_nickname',
    requiredPermissions: [PermissionFlagsBits.ManageNicknames],
    targetType: 'member',
    verificationStrategy: 'NICKNAME_CLEARED'
  },
  inspect_nickname: {
    actionId: 'inspect_nickname',
    canonicalName: 'inspect_nickname',
    displayName: 'Inspect Nickname',
    category: FunctionalCategory.GENERAL_UTILITIES,
    originatingCommand: '/go',
    executionHandler: 'Operations.inspectNickname',
    auditEventType: 'member.inspect_nickname',
    requiredPermissions: [],
    targetType: 'member',
    verificationStrategy: 'READ_ONLY'
  },
  get_bot_invite: {
    actionId: 'get_bot_invite',
    canonicalName: 'get_bot_invite',
    displayName: 'Get Bot Invite',
    category: FunctionalCategory.GENERAL_UTILITIES,
    originatingCommand: '/go',
    executionHandler: 'Operations.getBotInvite',
    auditEventType: 'utilities.bot_invite',
    requiredPermissions: [],
    targetType: 'server',
    verificationStrategy: 'READ_ONLY'
  },
  help_inquiry: {
    actionId: 'help_inquiry',
    canonicalName: 'help_inquiry',
    displayName: 'Help Inquiry',
    category: FunctionalCategory.GENERAL_UTILITIES,
    originatingCommand: '/help',
    executionHandler: 'HelpManager.getHelp',
    auditEventType: 'utilities.help',
    requiredPermissions: [],
    targetType: 'none',
    verificationStrategy: 'READ_ONLY'
  },
  conversational: {
    actionId: 'conversational',
    canonicalName: 'conversational',
    displayName: 'Conversational Guidance',
    category: FunctionalCategory.GENERAL_UTILITIES,
    originatingCommand: '/go',
    executionHandler: 'ConversationalResponse',
    auditEventType: 'utilities.conversational',
    requiredPermissions: [],
    targetType: 'none',
    verificationStrategy: 'READ_ONLY'
  },

  // =========================================================================
  // 10. ADVANCED SECURITY & MODERATION EXTENSIONS
  // =========================================================================
  lockdown_server: {
    actionId: 'lockdown_server',
    canonicalName: 'lockdown_server',
    displayName: 'Emergency Server Lockdown',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/go',
    executionHandler: 'SecurityEngine.enableLockdown',
    auditEventType: 'moderation.lockdown',
    requiredPermissions: [PermissionFlagsBits.ManageChannels],
    targetType: 'server',
    verificationStrategy: 'MUTATION_STATE_CHECK'
  },
  lift_lockdown: {
    actionId: 'lift_lockdown',
    canonicalName: 'lift_lockdown',
    displayName: 'Lift Server Lockdown',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/go',
    executionHandler: 'SecurityEngine.liftLockdown',
    auditEventType: 'moderation.lift_lockdown',
    requiredPermissions: [PermissionFlagsBits.ManageChannels],
    targetType: 'server',
    verificationStrategy: 'MUTATION_STATE_CHECK'
  },
  view_case: {
    actionId: 'view_case',
    canonicalName: 'view_case',
    displayName: 'View Moderation Case',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/go',
    executionHandler: 'CaseManager.getCase',
    auditEventType: 'moderation.case_view',
    requiredPermissions: [],
    targetType: 'case',
    verificationStrategy: 'READ_ONLY'
  },
  add_case_note: {
    actionId: 'add_case_note',
    canonicalName: 'add_case_note',
    displayName: 'Add Case Note',
    category: FunctionalCategory.MODERATION_SAFETY,
    originatingCommand: '/go',
    executionHandler: 'CaseManager.addNote',
    auditEventType: 'moderation.case_note',
    requiredPermissions: [PermissionFlagsBits.ModerateMembers],
    targetType: 'case',
    verificationStrategy: 'MUTATION_STATE_CHECK'
  },

  // =========================================================================
  // 11. ONBOARDING & SERVER TEMPLATES
  // =========================================================================
  configure_welcome: {
    actionId: 'configure_welcome',
    canonicalName: 'configure_welcome',
    displayName: 'Configure Welcome System',
    category: FunctionalCategory.SERVER_CONFIGURATION,
    originatingCommand: '/go',
    executionHandler: 'MemberOnboardingManager.updateConfig',
    auditEventType: 'server.welcome',
    requiredPermissions: [PermissionFlagsBits.ManageGuild],
    targetType: 'channel',
    verificationStrategy: 'MUTATION_STATE_CHECK'
  },
  configure_auto_roles: {
    actionId: 'configure_auto_roles',
    canonicalName: 'configure_auto_roles',
    displayName: 'Configure Auto-Roles',
    category: FunctionalCategory.ROLES_PERMISSIONS,
    originatingCommand: '/go',
    executionHandler: 'MemberOnboardingManager.updateConfig',
    auditEventType: 'role.auto_roles',
    requiredPermissions: [PermissionFlagsBits.ManageRoles],
    targetType: 'role',
    verificationStrategy: 'MUTATION_STATE_CHECK'
  },
  setup_verification: {
    actionId: 'setup_verification',
    canonicalName: 'setup_verification',
    displayName: 'Setup Verification Workflow',
    category: FunctionalCategory.REACTION_ROLES_PANELS,
    originatingCommand: '/go',
    executionHandler: 'MemberOnboardingManager.publishVerificationPanel',
    auditEventType: 'panel.verification',
    requiredPermissions: [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.SendMessages],
    targetType: 'channel',
    verificationStrategy: 'MESSAGE_ID_CHECK'
  },
  apply_server_template: {
    actionId: 'apply_server_template',
    canonicalName: 'apply_server_template',
    displayName: 'Apply Server Template',
    category: FunctionalCategory.SERVER_CONFIGURATION,
    originatingCommand: '/go',
    executionHandler: 'ServerTemplateEngine.applyTemplate',
    auditEventType: 'server.template_apply',
    requiredPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
    targetType: 'server',
    verificationStrategy: 'MUTATION_STATE_CHECK'
  },
  preview_server_template: {
    actionId: 'preview_server_template',
    canonicalName: 'preview_server_template',
    displayName: 'Preview Server Template',
    category: FunctionalCategory.SERVER_CONFIGURATION,
    originatingCommand: '/go',
    executionHandler: 'ServerTemplateEngine.generatePreview',
    auditEventType: 'server.template_preview',
    requiredPermissions: [],
    targetType: 'server',
    verificationStrategy: 'READ_ONLY'
  },

  // =========================================================================
  // 12. TICKETS & APPLICATION WORKFLOWS
  // =========================================================================
  close_ticket: {
    actionId: 'close_ticket',
    canonicalName: 'close_ticket',
    displayName: 'Close Support Ticket',
    category: FunctionalCategory.REACTION_ROLES_PANELS,
    originatingCommand: '/go',
    executionHandler: 'TicketManager.handleButtonInteraction',
    auditEventType: 'panel.ticket_close',
    requiredPermissions: [PermissionFlagsBits.ManageChannels],
    targetType: 'channel',
    verificationStrategy: 'MUTATION_STATE_CHECK'
  },
  claim_ticket: {
    actionId: 'claim_ticket',
    canonicalName: 'claim_ticket',
    displayName: 'Claim Support Ticket',
    category: FunctionalCategory.REACTION_ROLES_PANELS,
    originatingCommand: '/go',
    executionHandler: 'TicketManager.handleButtonInteraction',
    auditEventType: 'panel.ticket_claim',
    requiredPermissions: [],
    targetType: 'channel',
    verificationStrategy: 'MUTATION_STATE_CHECK'
  },
  publish_application_panel: {
    actionId: 'publish_application_panel',
    canonicalName: 'publish_application_panel',
    displayName: 'Publish Application Panel',
    category: FunctionalCategory.REACTION_ROLES_PANELS,
    originatingCommand: '/go',
    executionHandler: 'ApplicationManager.publishApplicationPanel',
    auditEventType: 'panel.application',
    requiredPermissions: [PermissionFlagsBits.SendMessages],
    targetType: 'channel',
    verificationStrategy: 'MESSAGE_ID_CHECK'
  },

  // =========================================================================
  // 13. AUTOMATION, COMMUNITY UTILITIES & SCHEDULING
  // =========================================================================
  create_workflow: {
    actionId: 'create_workflow',
    canonicalName: 'create_workflow',
    displayName: 'Create Automation Workflow',
    category: FunctionalCategory.SERVER_CONFIGURATION,
    originatingCommand: '/go',
    executionHandler: 'WorkflowEngine.registerWorkflow',
    auditEventType: 'server.workflow_create',
    requiredPermissions: [PermissionFlagsBits.ManageGuild],
    targetType: 'server',
    verificationStrategy: 'MUTATION_STATE_CHECK'
  },
  list_workflows: {
    actionId: 'list_workflows',
    canonicalName: 'list_workflows',
    displayName: 'List Automation Workflows',
    category: FunctionalCategory.GENERAL_UTILITIES,
    originatingCommand: '/go',
    executionHandler: 'WorkflowEngine.listWorkflows',
    auditEventType: 'utilities.workflow_list',
    requiredPermissions: [],
    targetType: 'server',
    verificationStrategy: 'READ_ONLY'
  },
  delete_workflow: {
    actionId: 'delete_workflow',
    canonicalName: 'delete_workflow',
    displayName: 'Delete Automation Workflow',
    category: FunctionalCategory.SERVER_CONFIGURATION,
    originatingCommand: '/go',
    executionHandler: 'WorkflowEngine.deleteWorkflow',
    auditEventType: 'server.workflow_delete',
    requiredPermissions: [PermissionFlagsBits.ManageGuild],
    targetType: 'server',
    verificationStrategy: 'MUTATION_STATE_CHECK'
  },
  create_poll: {
    actionId: 'create_poll',
    canonicalName: 'create_poll',
    displayName: 'Create Community Poll',
    category: FunctionalCategory.MESSAGES_EMBEDS,
    originatingCommand: '/go',
    executionHandler: 'CommunityUtils.createPoll',
    auditEventType: 'message.poll',
    requiredPermissions: [PermissionFlagsBits.SendMessages],
    targetType: 'channel',
    verificationStrategy: 'MESSAGE_ID_CHECK'
  },
  submit_suggestion: {
    actionId: 'submit_suggestion',
    canonicalName: 'submit_suggestion',
    displayName: 'Submit Community Suggestion',
    category: FunctionalCategory.MESSAGES_EMBEDS,
    originatingCommand: '/go',
    executionHandler: 'CommunityUtils.submitSuggestion',
    auditEventType: 'message.suggestion',
    requiredPermissions: [PermissionFlagsBits.SendMessages],
    targetType: 'channel',
    verificationStrategy: 'MESSAGE_ID_CHECK'
  },
  configure_starboard: {
    actionId: 'configure_starboard',
    canonicalName: 'configure_starboard',
    displayName: 'Configure Starboard',
    category: FunctionalCategory.SERVER_CONFIGURATION,
    originatingCommand: '/go',
    executionHandler: 'CommunityUtils.setStarboardConfig',
    auditEventType: 'server.starboard',
    requiredPermissions: [PermissionFlagsBits.ManageGuild],
    targetType: 'channel',
    verificationStrategy: 'MUTATION_STATE_CHECK'
  },
  add_auto_response: {
    actionId: 'add_auto_response',
    canonicalName: 'add_auto_response',
    displayName: 'Add Auto-Response FAQ',
    category: FunctionalCategory.SERVER_CONFIGURATION,
    originatingCommand: '/go',
    executionHandler: 'CommunityUtils.addAutoResponse',
    auditEventType: 'server.auto_response',
    requiredPermissions: [PermissionFlagsBits.ManageGuild],
    targetType: 'server',
    verificationStrategy: 'MUTATION_STATE_CHECK'
  },
  schedule_reminder: {
    actionId: 'schedule_reminder',
    canonicalName: 'schedule_reminder',
    displayName: 'Schedule Reminder',
    category: FunctionalCategory.GENERAL_UTILITIES,
    originatingCommand: '/go',
    executionHandler: 'TaskScheduler.scheduleReminder',
    auditEventType: 'utilities.reminder',
    requiredPermissions: [],
    targetType: 'channel',
    verificationStrategy: 'MUTATION_STATE_CHECK'
  },
  schedule_announcement: {
    actionId: 'schedule_announcement',
    canonicalName: 'schedule_announcement',
    displayName: 'Schedule Announcement',
    category: FunctionalCategory.MESSAGES_EMBEDS,
    originatingCommand: '/go',
    executionHandler: 'TaskScheduler.scheduleAnnouncement',
    auditEventType: 'message.scheduled_announcement',
    requiredPermissions: [PermissionFlagsBits.SendMessages],
    targetType: 'channel',
    verificationStrategy: 'MUTATION_STATE_CHECK'
  },
  create_event: {
    actionId: 'create_event',
    canonicalName: 'create_event',
    displayName: 'Create Community Event',
    category: FunctionalCategory.GENERAL_UTILITIES,
    originatingCommand: '/go',
    executionHandler: 'TaskScheduler.createCommunityEvent',
    auditEventType: 'utilities.event_create',
    requiredPermissions: [PermissionFlagsBits.SendMessages],
    targetType: 'channel',
    verificationStrategy: 'MESSAGE_ID_CHECK'
  },
  view_analytics: {
    actionId: 'view_analytics',
    canonicalName: 'view_analytics',
    displayName: 'View Server Analytics',
    category: FunctionalCategory.GENERAL_UTILITIES,
    originatingCommand: '/go',
    executionHandler: 'AnalyticsService.getOverviewMetrics',
    auditEventType: 'utilities.analytics',
    requiredPermissions: [],
    targetType: 'server',
    verificationStrategy: 'READ_ONLY'
  }
};

/**
 * Explicit Legacy & Synonym Action Mappings.
 * Ensures older action variants and aliases resolve deterministically.
 */
export const LEGACY_ACTION_MAPPINGS = {
  // Music & Voice
  play: 'music_play',
  pause: 'music_pause',
  resume: 'music_resume',
  skip: 'music_skip',
  stop: 'music_stop',
  queue: 'music_queue',
  nowplaying: 'music_nowplaying',
  volume: 'music_volume',
  join: 'voice_join',
  leave: 'music_leave',
  leave_voice: 'music_leave',

  // Moderation
  timeout: 'timeout_member',
  untimeout: 'remove_timeout',
  kick: 'kick_member',
  ban: 'ban_member',
  unban: 'unban_member',
  softban: 'softban_member',
  warn: 'issue_warning',
  purge: 'purge_messages',
  mute: 'voice_mute',
  unmute: 'voice_unmute',

  // Roles & Permissions
  role_create: 'create_role',
  role_delete: 'delete_role',
  role_edit: 'edit_role',
  role_assign: 'assign_role',
  role_remove: 'remove_role',
  channel_permission: 'set_channel_permission',
  category_permission: 'set_category_permission',

  // Channels
  channel_create: 'create_channel',
  channel_delete: 'delete_channel',
  channel_rename: 'rename_channel',
  channel_topic: 'edit_channel_topic',
  channel_slowmode: 'set_channel_slowmode',
  channel_lock: 'lock_channel',
  channel_unlock: 'unlock_channel',
  category_create: 'create_category',
  category_rename: 'rename_category',
  category_delete: 'delete_category',

  // Messages & Embeds
  announce: 'send_announcement',
  announcement: 'send_announcement',
  message: 'send_message',
  embed_create: 'publish_embed',
  embed_publish: 'publish_embed',

  // Panels & Recovery & Help & Community
  ticket_setup: 'setup_ticket_system',
  ticket_close: 'close_ticket',
  ticket_claim: 'claim_ticket',
  role_panel: 'setup_role_panel',
  undo: 'undo_recovery',
  diagnose: 'diagnose_health',
  audit: 'audit_server',
  help: 'help_inquiry',
  show_help: 'help_inquiry',
  lockdown: 'lockdown_server',
  unlock_server: 'lift_lockdown',
  poll: 'create_poll',
  suggest: 'submit_suggestion',
  suggestion: 'submit_suggestion',
  remind: 'schedule_reminder',
  reminder: 'schedule_reminder',
  analytics: 'view_analytics',
  metrics: 'view_analytics'
};

/**
 * Single Authoritative Action Classifier & Registry Service.
 */
export class ActionRegistry {
  /**
   * Retrieves canonical metadata definition for an action identifier.
   */
  static get(actionId) {
    if (!actionId) return null;
    const cleanId = String(actionId).toLowerCase().trim();
    if (ACTION_DEFINITIONS[cleanId]) {
      return ACTION_DEFINITIONS[cleanId];
    }
    const mapped = LEGACY_ACTION_MAPPINGS[cleanId];
    if (mapped && ACTION_DEFINITIONS[mapped]) {
      return ACTION_DEFINITIONS[mapped];
    }
    return null;
  }

  /**
   * Returns all canonical action definitions.
   */
  static getAll() {
    return Object.values(ACTION_DEFINITIONS);
  }

  /**
   * Returns all action definitions belonging to a specific functional category.
   */
  static getByCategory(category) {
    return Object.values(ACTION_DEFINITIONS).filter(a => a.category === category);
  }

  /**
   * Deterministically classifies an action based on priority:
   * 1. Canonical metadata from authoritative Action Registry.
   * 2. Execution result or explicit audit-event type passed in context.
   * 3. Explicitly defined mappings for legacy actions.
   * 4. Neutral 'Unclassified' category (NEVER falls back to Moderation).
   */
  static classify(actionId, context = {}) {
    const rawAction = actionId || context?.action;
    const cleanId = rawAction ? String(rawAction).toLowerCase().trim() : null;

    // Priority 1: Canonical Action Registry entry
    if (cleanId && ACTION_DEFINITIONS[cleanId]) {
      return {
        ...ACTION_DEFINITIONS[cleanId],
        sourceResolution: 'registry_canonical'
      };
    }

    // Priority 2: Validated execution result or explicit audit-event type in context
    if (context?.auditEventType && typeof context.auditEventType === 'string') {
      const parts = context.auditEventType.split('.');
      const prefix = parts[0];
      const categoryFromPrefix = ActionRegistry._mapPrefixToCategory(prefix);
      if (categoryFromPrefix !== FunctionalCategory.UNCLASSIFIED) {
        return {
          actionId: cleanId || context.auditEventType,
          canonicalName: cleanId || context.auditEventType,
          displayName: humanizeAction(cleanId || context.auditEventType),
          category: categoryFromPrefix,
          originatingCommand: context.source || '/go',
          executionHandler: null,
          auditEventType: context.auditEventType,
          requiredPermissions: [],
          targetType: 'unknown',
          verificationStrategy: 'NONE',
          sourceResolution: 'context_audit_event_type'
        };
      }
    }

    // Priority 3: Explicit legacy mappings
    if (cleanId && LEGACY_ACTION_MAPPINGS[cleanId]) {
      const canonicalKey = LEGACY_ACTION_MAPPINGS[cleanId];
      if (ACTION_DEFINITIONS[canonicalKey]) {
        return {
          ...ACTION_DEFINITIONS[canonicalKey],
          actionId: cleanId, // Preserve original requested identifier
          sourceResolution: 'legacy_mapping'
        };
      }
    }

    // Priority 4: Neutral 'Unclassified' fallback
    const fallbackDisplayName = cleanId ? humanizeAction(cleanId) : 'Unclassified Action';
    return {
      actionId: cleanId || 'unclassified_action',
      canonicalName: cleanId || 'unclassified_action',
      displayName: fallbackDisplayName,
      category: FunctionalCategory.UNCLASSIFIED,
      originatingCommand: context?.source || '/go',
      executionHandler: null,
      auditEventType: cleanId ? `system.${cleanId}` : 'system.unclassified',
      requiredPermissions: [],
      targetType: 'unknown',
      verificationStrategy: 'NONE',
      sourceResolution: 'unclassified_fallback'
    };
  }

  /**
   * Maps an audit event type prefix to a functional category.
   */
  static _mapPrefixToCategory(prefix) {
    switch (String(prefix).toLowerCase()) {
      case 'music':
      case 'voice':
        return FunctionalCategory.MUSIC_VOICE;
      case 'moderation':
      case 'honeypot':
        return FunctionalCategory.MODERATION_SAFETY;
      case 'role':
      case 'permission':
        return FunctionalCategory.ROLES_PERMISSIONS;
      case 'channel':
      case 'category':
        return FunctionalCategory.CHANNEL_MANAGEMENT;
      case 'server':
      case 'policy':
      case 'modlog':
        return FunctionalCategory.SERVER_CONFIGURATION;
      case 'message':
      case 'embed':
        return FunctionalCategory.MESSAGES_EMBEDS;
      case 'panel':
      case 'ticket':
        return FunctionalCategory.REACTION_ROLES_PANELS;
      case 'diagnostics':
      case 'recovery':
        return FunctionalCategory.DIAGNOSTICS_RECOVERY;
      case 'utilities':
      case 'member':
        return FunctionalCategory.GENERAL_UTILITIES;
      default:
        return FunctionalCategory.UNCLASSIFIED;
    }
  }

  /**
   * Normalizes an event source into structured origin metadata.
   * Separates the event source from the functional category and command name.
   */
  static normalizeEventSource(source) {
    if (!source) {
      return {
        eventSource: EventSource.BOT_COMMAND,
        originatingCommand: '/go',
        interfaceName: 'Slash Command (/go)'
      };
    }

    const s = String(source).trim();

    if (/^(?:gateway_event|gateway|external(?:_event)?|discord_audit_log)$/i.test(s)) {
      return {
        eventSource: EventSource.EXTERNAL_EVENT,
        originatingCommand: null,
        interfaceName: 'External Discord Administrative Event'
      };
    }

    if (/^dashboard(?::.*)?$/i.test(s)) {
      return {
        eventSource: EventSource.DASHBOARD,
        originatingCommand: null,
        interfaceName: 'Interactive Dashboard'
      };
    }

    if (/^(?:scheduled_task|scheduler|cron)$/i.test(s)) {
      return {
        eventSource: EventSource.SCHEDULED_TASK,
        originatingCommand: null,
        interfaceName: 'Task Scheduler'
      };
    }

    if (/^(?:recovery|undo|revert)$/i.test(s)) {
      return {
        eventSource: EventSource.RECOVERY_UNDO,
        originatingCommand: '/undo',
        interfaceName: 'Recovery Engine'
      };
    }

    if (/^\/undo$/i.test(s)) {
      return {
        eventSource: EventSource.BOT_COMMAND,
        originatingCommand: '/undo',
        interfaceName: 'Slash Command (/undo)'
      };
    }

    if (/^\/modlog$/i.test(s)) {
      return {
        eventSource: EventSource.BOT_COMMAND,
        originatingCommand: '/modlog',
        interfaceName: 'Slash Command (/modlog)'
      };
    }

    if (/^\/diagnose$/i.test(s)) {
      return {
        eventSource: EventSource.BOT_COMMAND,
        originatingCommand: '/diagnose',
        interfaceName: 'Slash Command (/diagnose)'
      };
    }

    if (/^\/honeypot$/i.test(s)) {
      return {
        eventSource: EventSource.BOT_COMMAND,
        originatingCommand: '/honeypot',
        interfaceName: 'Slash Command (/honeypot)'
      };
    }

    if (/^\/help$/i.test(s)) {
      return {
        eventSource: EventSource.BOT_COMMAND,
        originatingCommand: '/help',
        interfaceName: 'Slash Command (/help)'
      };
    }

    return {
      eventSource: EventSource.BOT_COMMAND,
      originatingCommand: s.startsWith('/') ? s : `/${s}`,
      interfaceName: s.startsWith('/') ? `Slash Command (${s})` : `Command (${s})`
    };
  }

  /**
   * Computes truthful execution outcome and verification status.
   */
  static determineTruthfulOutcome(actionData, verificationStrategy = 'NONE') {
    const rawOutcome = String(actionData.outcome || actionData.status || '').toLowerCase();
    const verified = actionData.verified ?? actionData.verificationStatus;

    if (rawOutcome === 'denied') {
      return {
        outcome: OutcomeState.DENIED,
        verificationStatus: VerificationStatus.FAILED,
        isVerified: false
      };
    }

    if (rawOutcome === 'failed') {
      return {
        outcome: OutcomeState.FAILED,
        verificationStatus: VerificationStatus.FAILED,
        isVerified: false
      };
    }

    if (rawOutcome === 'partial' || rawOutcome === 'partially_completed') {
      return {
        outcome: OutcomeState.PARTIALLY_COMPLETED,
        verificationStatus: VerificationStatus.PARTIALLY_VERIFIED,
        isVerified: false
      };
    }

    if (rawOutcome === 'succeeded' || rawOutcome === 'completed') {
      if (verificationStrategy === 'READ_ONLY' || verificationStrategy === 'NONE') {
        return {
          outcome: OutcomeState.SUCCEEDED,
          verificationStatus: VerificationStatus.NOT_APPLICABLE,
          isVerified: true
        };
      }

      if (verified === true || verified === 'passed') {
        return {
          outcome: OutcomeState.SUCCEEDED,
          verificationStatus: VerificationStatus.VERIFIED,
          isVerified: true
        };
      }

      // Action succeeded execution, but verification step was not performed or failed
      if (verified === false || verified === 'failed') {
        return {
          outcome: OutcomeState.SUCCEEDED,
          verificationStatus: VerificationStatus.FAILED,
          isVerified: false
        };
      }

      return {
        outcome: OutcomeState.SUCCEEDED,
        verificationStatus: VerificationStatus.UNVERIFIED,
        isVerified: false
      };
    }

    return {
      outcome: OutcomeState.UNVERIFIED,
      verificationStatus: VerificationStatus.UNVERIFIED,
      isVerified: false
    };
  }
}
