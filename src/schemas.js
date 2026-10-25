import { z } from 'zod';

/**
 * Valid channel types supported by Discord.js v14
 */
export const ChannelTypeEnum = z.enum([
  'GUILD_TEXT',
  'GUILD_VOICE',
  'GUILD_ANNOUNCEMENT',
  'GUILD_CATEGORY',
  'GUILD_STAGE_VOICE'
]);

/**
 * Standard Hex color validator (e.g. #FFFFFF, #3498DB)
 */
export const HexColorSchema = z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, {
  message: 'Color must be a valid hex code like #FF5733 or #3498DB'
});

/**
 * Common standard permission string names
 */
export const DiscordPermissionEnum = z.enum([
  'ViewChannel',
  'SendMessages',
  'ManageChannels',
  'ManageRoles',
  'ManageGuild',
  'KickMembers',
  'BanMembers',
  'CreateInstantInvite',
  'ChangeNickname',
  'ManageNicknames',
  'ReadMessageHistory',
  'MentionEveryone',
  'EmbedLinks',
  'AttachFiles',
  'Connect',
  'Speak',
  'MuteMembers',
  'DeafenMembers',
  'MoveMembers',
  'UseVAD',
  'ModerateMembers',
  'Administrator'
]);

// --- ACTION SCHEMAS ---

export const UpdateServerNameSchema = z.object({
  action: z.literal('update_server_name'),
  name: z.string().min(2).max(100)
});

export const UpdateServerDescriptionSchema = z.object({
  action: z.literal('update_server_description'),
  description: z.string().max(120)
});

export const UpdateServerIconSchema = z.object({
  action: z.literal('update_server_icon'),
  iconUrl: z.string().url()
});

export const UpdateServerBannerSchema = z.object({
  action: z.literal('update_server_banner'),
  bannerUrl: z.string().url()
});

export const UpdateServerSettingsSchema = z.object({
  action: z.literal('update_server_settings'),
  systemChannel: z.string().optional(),
  rulesChannel: z.string().optional(),
  verificationLevel: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH']).optional()
});

export const CreateRoleSchema = z.object({
  action: z.literal('create_role'),
  name: z.string().min(1).max(100),
  color: HexColorSchema.optional().default('#99AAB5'),
  hoist: z.boolean().optional().default(false), // Display separately in sidebar
  mentionable: z.boolean().optional().default(false),
  permissions: z.array(DiscordPermissionEnum).optional().default([])
});

export const EditRoleSchema = z.object({
  action: z.literal('edit_role'),
  targetRole: z.string().min(1), // Role name or ID
  name: z.string().min(1).max(100).optional(),
  color: z.string().optional(), // Hex code or standard color name (e.g. #8B0000 or dark red)
  hoist: z.boolean().optional(),
  mentionable: z.boolean().optional(),
  permissions: z.array(DiscordPermissionEnum).optional()
});

export const DeleteRoleSchema = z.object({
  action: z.literal('delete_role'),
  targetRole: z.string().min(1)
});

export const AssignRoleSchema = z.object({
  action: z.literal('assign_role'),
  targetRole: z.string().min(1),
  targetMember: z.string().min(1) // Member username or ID
});

export const RemoveRoleSchema = z.object({
  action: z.literal('remove_role'),
  targetRole: z.string().min(1),
  targetMember: z.string().min(1)
});

export const CreateChannelSchema = z.object({
  action: z.literal('create_channel'),
  name: z.string().min(1).max(100),
  type: ChannelTypeEnum.default('GUILD_TEXT'),
  category: z.string().optional(), // Parent category name or ID
  topic: z.string().max(1024).optional(),
  slowmodeSeconds: z.number().int().min(0).max(21600).optional().default(0),
  nsfw: z.boolean().optional().default(false),
  isPrivate: z.boolean().optional().default(false),
  allowedRoles: z.array(z.string()).optional().default([]), // Role names or IDs
  deniedRoles: z.array(z.string()).optional().default([])
});

export const EditChannelSchema = z.object({
  action: z.literal('edit_channel'),
  targetChannel: z.string().min(1),
  name: z.string().min(1).max(100).optional(),
  topic: z.string().max(1024).optional(),
  slowmodeSeconds: z.number().int().min(0).max(21600).optional(),
  nsfw: z.boolean().optional(),
  category: z.string().optional()
});

export const DeleteChannelSchema = z.object({
  action: z.literal('delete_channel'),
  targetChannel: z.string().min(1)
});

export const SetChannelPermissionSchema = z.object({
  action: z.literal('set_channel_permission'),
  targetChannel: z.string().min(1),
  targetRoleOrMember: z.string().min(1),
  allow: z.array(DiscordPermissionEnum).optional().default([]),
  deny: z.array(DiscordPermissionEnum).optional().default([])
});

export const TimeoutMemberSchema = z.object({
  action: z.literal('timeout_member'),
  targetMember: z.string().min(1),
  durationMinutes: z.number().int().min(1).max(40320), // Max 28 days
  reason: z.string().max(512).optional().default('Timeout issued via /go agent')
});

export const RemoveTimeoutSchema = z.object({
  action: z.literal('remove_timeout'),
  targetMember: z.string().min(1),
  reason: z.string().max(512).optional().default('Timeout removed via /go agent')
});

export const KickMemberSchema = z.object({
  action: z.literal('kick_member'),
  targetMember: z.string().min(1),
  reason: z.string().max(512).optional().default('Kicked via /go agent')
});

export const BanMemberSchema = z.object({
  action: z.literal('ban_member'),
  targetMember: z.string().min(1),
  deleteMessageDays: z.number().int().min(0).max(7).optional().default(0),
  reason: z.string().max(512).optional().default('Banned via /go agent')
});

export const UnbanMemberSchema = z.object({
  action: z.literal('unban_member'),
  targetMemberId: z.string().regex(/^\d{17,20}$/, { message: 'Must be a valid Discord User Snowflake ID' }),
  reason: z.string().max(512).optional().default('Unbanned via /go agent')
});

export const ChangeNicknameSchema = z.object({
  action: z.literal('change_nickname'),
  targetMember: z.string().min(1),
  nickname: z.string().max(32).nullable().optional(),
  reason: z.string().max(512).optional().default('Nickname changed via /go agent')
});

export const SetupTicketSystemSchema = z.object({
  action: z.literal('setup_ticket_system'),
  categoryName: z.string().default('SUPPORT TICKETS'),
  channelName: z.string().default('tickets'),
  panelTitle: z.string().default('Support & Assistance'),
  panelDescription: z.string().default('Need help or want to speak with staff? Click the button below to open a private ticket.'),
  supportRoleName: z.string().default('Support Team'),
  buttonText: z.string().default('Create Ticket'),
  buttonEmoji: z.string().default('🎫')
});

export const AuditServerSchema = z.object({
  action: z.literal('audit_server'),
  scope: z.enum(['permissions', 'channels', 'roles', 'all']).default('all')
});

export const SetupRoleMenuSchema = z.object({
  action: z.literal('setup_role_menu'),
  channelName: z.string().default('roles'),
  title: z.string().default('Self-Assignable Roles'),
  description: z.string().default('Select the roles you want from the dropdown menu below:'),
  roles: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    emoji: z.string().optional(),
    color: HexColorSchema.optional()
  })).min(1).max(25)
});

export const SetupAutoModRuleSchema = z.object({
  action: z.literal('setup_automod_rule'),
  name: z.string().min(1).max(100),
  ruleType: z.enum(['INVITES', 'SPAM', 'MENTION_SPAM', 'KEYWORDS']),
  keywords: z.array(z.string()).optional().default([]),
  actionType: z.enum(['BLOCK', 'TIMEOUT', 'ALERT']).default('BLOCK'),
  timeoutDurationSeconds: z.number().int().min(60).max(2419200).optional().default(300)
});

export const SetupModLogsSchema = z.object({
  action: z.literal('setup_mod_logs'),
  channelName: z.string().default('mod-logs'),
  staffRoleName: z.string().default('Staff')
});

export const SendAnnouncementSchema = z.object({
  action: z.literal('send_announcement'),
  targetChannel: z.string().default('current'),
  message: z.string().min(1).max(2000),
  title: z.string().optional(),
  mentionEveryone: z.boolean().default(false)
});

export const SendMessageSchema = z.object({
  action: z.literal('send_message'),
  targetChannel: z.string().default('current'),
  content: z.string().min(1).max(2000),
  mentionEveryone: z.boolean().default(false)
});

export const PurgeMessagesSchema = z.object({
  action: z.literal('purge_messages'),
  targetChannel: z.string().default('current'),
  count: z.number().int().min(1).max(100).default(5),
  author: z.string().optional(),
  authorId: z.string().optional(),
  contains: z.string().optional()
});

export const SearchMessagesSchema = z.object({
  action: z.literal('search_messages'),
  targetChannel: z.string().default('current'),
  count: z.number().int().min(1).max(100).default(25),
  author: z.string().optional(),
  authorId: z.string().optional(),
  contains: z.string().optional()
});

export const PinMessageSchema = z.object({
  action: z.literal('pin_message'),
  targetChannel: z.string().default('current'),
  messageId: z.string().min(1)
});

export const UnpinMessageSchema = z.object({
  action: z.literal('unpin_message'),
  targetChannel: z.string().default('current'),
  messageId: z.string().min(1)
});

export const AddReactionSchema = z.object({
  action: z.literal('add_reaction'),
  targetChannel: z.string().default('current'),
  messageId: z.string().min(1),
  emoji: z.string().min(1)
});

export const MoveChannelSchema = z.object({
  action: z.literal('move_channel'),
  targetChannel: z.string().default('current'),
  category: z.string().min(1)
});

export const LookupMemberSchema = z.object({
  action: z.literal('lookup_member'),
  targetMember: z.string().min(1)
});

export const GetBotInviteSchema = z.object({
  action: z.literal('get_bot_invite')
});

export const ExplainBotInstallationSchema = z.object({
  action: z.literal('explain_bot_installation')
});

export const MusicPlaySchema = z.object({
  action: z.literal('music_play'),
  query: z.string().min(1).optional(),
  targetRef: z.string().optional()
});

export const MusicPauseSchema = z.object({
  action: z.literal('music_pause')
});

export const MusicResumeSchema = z.object({
  action: z.literal('music_resume')
});

export const MusicSkipSchema = z.object({
  action: z.literal('music_skip')
});

export const MusicStopSchema = z.object({
  action: z.literal('music_stop')
});

export const MusicQueueSchema = z.object({
  action: z.literal('music_queue')
});

export const MusicNowPlayingSchema = z.object({
  action: z.literal('music_nowplaying')
});

export const MusicVolumeSchema = z.object({
  action: z.literal('music_volume'),
  volume: z.number().min(0).max(150).optional()
});

export const MusicLeaveSchema = z.object({
  action: z.literal('music_leave')
});

/**
 * Discriminated union of all supported actions
 */
export const ActionSchema = z.discriminatedUnion('action', [
  UpdateServerNameSchema,
  UpdateServerDescriptionSchema,
  UpdateServerIconSchema,
  UpdateServerBannerSchema,
  UpdateServerSettingsSchema,
  CreateRoleSchema,
  EditRoleSchema,
  DeleteRoleSchema,
  AssignRoleSchema,
  RemoveRoleSchema,
  CreateChannelSchema,
  EditChannelSchema,
  DeleteChannelSchema,
  SetChannelPermissionSchema,
  TimeoutMemberSchema,
  RemoveTimeoutSchema,
  KickMemberSchema,
  BanMemberSchema,
  UnbanMemberSchema,
  ChangeNicknameSchema,
  SetupTicketSystemSchema,
  AuditServerSchema,
  SetupRoleMenuSchema,
  SetupAutoModRuleSchema,
  SetupModLogsSchema,
  SendAnnouncementSchema,
  SendMessageSchema,
  PurgeMessagesSchema,
  SearchMessagesSchema,
  PinMessageSchema,
  UnpinMessageSchema,
  AddReactionSchema,
  MoveChannelSchema,
  LookupMemberSchema,
  GetBotInviteSchema,
  ExplainBotInstallationSchema,
  MusicPlaySchema,
  MusicPauseSchema,
  MusicResumeSchema,
  MusicSkipSchema,
  MusicStopSchema,
  MusicQueueSchema,
  MusicNowPlayingSchema,
  MusicVolumeSchema,
  MusicLeaveSchema
]);

/**
 * Top-level plan produced by the AI
 */
export const PlanSchema = z.object({
  thoughtProcess: z.string().describe('Short explanation of intent understanding and planned steps'),
  clarificationNeeded: z.string().nullable().optional().describe('Set if user prompt is dangerously ambiguous'),
  conversationalResponse: z.string().nullable().optional().describe('Warm, charming response when user is casually chatting, greeting, asking who Honey is, or asking general server advice'),
  isHighImpact: z.boolean().default(false).describe('True if plan contains destructive or mass modifications'),
  actions: z.array(ActionSchema).max(25, { message: 'Max 25 actions allowed per single prompt' })
});

/**
 * Validates a raw plan from AI against strict schemas
 */
export function validatePlan(rawJson) {
  return PlanSchema.safeParse(rawJson);
}
