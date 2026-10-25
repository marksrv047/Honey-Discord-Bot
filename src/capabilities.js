import { PermissionFlagsBits } from 'discord.js';

/**
 * Registry of all real Discord API capabilities supported by the agent.
 * Maps actions to required permissions, boost requirements, and impact level.
 */
export const CAPABILITY_REGISTRY = {
  update_server_name: {
    description: 'Updates the guild name (2-100 characters).',
    requiredBotPermissions: [PermissionFlagsBits.ManageGuild],
    requiredUserPermissions: [PermissionFlagsBits.ManageGuild],
    isDestructive: false,
    boostRequirement: 0,
  },
  update_server_description: {
    description: 'Updates guild description (requires Community enabled).',
    requiredBotPermissions: [PermissionFlagsBits.ManageGuild],
    requiredUserPermissions: [PermissionFlagsBits.ManageGuild],
    isDestructive: false,
    boostRequirement: 0,
  },
  update_server_icon: {
    description: 'Updates guild profile picture/icon from an image URL.',
    requiredBotPermissions: [PermissionFlagsBits.ManageGuild],
    requiredUserPermissions: [PermissionFlagsBits.ManageGuild],
    isDestructive: false,
    boostRequirement: 0,
  },
  update_server_banner: {
    description: 'Updates guild background banner (Requires Nitro Boost Tier 2).',
    requiredBotPermissions: [PermissionFlagsBits.ManageGuild],
    requiredUserPermissions: [PermissionFlagsBits.ManageGuild],
    isDestructive: false,
    boostRequirement: 2, // Boost Tier 2 (7+ boosts)
  },
  update_server_settings: {
    description: 'Configures system channel, rules channel, and verification level.',
    requiredBotPermissions: [PermissionFlagsBits.ManageGuild],
    requiredUserPermissions: [PermissionFlagsBits.ManageGuild],
    isDestructive: false,
    boostRequirement: 0,
  },
  create_role: {
    description: 'Creates a new role with custom color, hoist, and permissions.',
    requiredBotPermissions: [PermissionFlagsBits.ManageRoles],
    requiredUserPermissions: [PermissionFlagsBits.ManageRoles],
    isDestructive: false,
    boostRequirement: 0,
  },
  edit_role: {
    description: 'Edits an existing role name, color, hoist, or permissions.',
    requiredBotPermissions: [PermissionFlagsBits.ManageRoles],
    requiredUserPermissions: [PermissionFlagsBits.ManageRoles],
    isDestructive: false,
    boostRequirement: 0,
  },
  delete_role: {
    description: 'Deletes a role from the server.',
    requiredBotPermissions: [PermissionFlagsBits.ManageRoles],
    requiredUserPermissions: [PermissionFlagsBits.ManageRoles],
    isDestructive: true,
    boostRequirement: 0,
  },
  assign_role: {
    description: 'Assigns a role to a member.',
    requiredBotPermissions: [PermissionFlagsBits.ManageRoles],
    requiredUserPermissions: [PermissionFlagsBits.ManageRoles],
    isDestructive: false,
    boostRequirement: 0,
  },
  remove_role: {
    description: 'Removes a role from a member.',
    requiredBotPermissions: [PermissionFlagsBits.ManageRoles],
    requiredUserPermissions: [PermissionFlagsBits.ManageRoles],
    isDestructive: false,
    boostRequirement: 0,
  },
  create_channel: {
    description: 'Creates text, voice, announcement, or category channels with permission overwrites.',
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels],
    requiredUserPermissions: [PermissionFlagsBits.ManageChannels],
    isDestructive: false,
    boostRequirement: 0,
  },
  edit_channel: {
    description: 'Edits channel name, topic, slowmode, or category.',
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels],
    requiredUserPermissions: [PermissionFlagsBits.ManageChannels],
    isDestructive: false,
    boostRequirement: 0,
  },
  delete_channel: {
    description: 'Permanently deletes a channel or category.',
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels],
    requiredUserPermissions: [PermissionFlagsBits.ManageChannels],
    isDestructive: true,
    boostRequirement: 0,
  },
  set_channel_permission: {
    description: 'Configures permission overwrites for roles/members on a channel.',
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
    requiredUserPermissions: [PermissionFlagsBits.ManageChannels],
    isDestructive: false,
    boostRequirement: 0,
  },
  timeout_member: {
    description: 'Applies Discord communication disable timeout to a member.',
    requiredBotPermissions: [PermissionFlagsBits.ModerateMembers],
    requiredUserPermissions: [PermissionFlagsBits.ModerateMembers],
    isDestructive: false,
    boostRequirement: 0,
  },
  remove_timeout: {
    description: 'Removes an active timeout from a member.',
    requiredBotPermissions: [PermissionFlagsBits.ModerateMembers],
    requiredUserPermissions: [PermissionFlagsBits.ModerateMembers],
    isDestructive: false,
    boostRequirement: 0,
  },
  kick_member: {
    description: 'Kicks a member from the server.',
    requiredBotPermissions: [PermissionFlagsBits.KickMembers],
    requiredUserPermissions: [PermissionFlagsBits.KickMembers],
    isDestructive: true,
    boostRequirement: 0,
  },
  ban_member: {
    description: 'Bans a member from the server with optional message deletion.',
    requiredBotPermissions: [PermissionFlagsBits.BanMembers],
    requiredUserPermissions: [PermissionFlagsBits.BanMembers],
    isDestructive: true,
    boostRequirement: 0,
  },
  unban_member: {
    description: 'Removes a ban for a specified user ID.',
    requiredBotPermissions: [PermissionFlagsBits.BanMembers],
    requiredUserPermissions: [PermissionFlagsBits.BanMembers],
    isDestructive: false,
    boostRequirement: 0,
  },
  change_nickname: {
    description: 'Changes a member nickname.',
    requiredBotPermissions: [PermissionFlagsBits.ManageNicknames],
    requiredUserPermissions: [PermissionFlagsBits.ManageNicknames],
    isDestructive: false,
    boostRequirement: 0,
  },
  setup_ticket_system: {
    description: 'Deploys an interactive Ticket System panel with durable buttons.',
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.SendMessages],
    requiredUserPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
    isDestructive: false,
    boostRequirement: 0,
  },
  audit_server: {
    description: 'Read-only audit of server permissions, roles, and channel security risks.',
    requiredBotPermissions: [],
    requiredUserPermissions: [PermissionFlagsBits.ManageGuild],
    isDestructive: false,
    boostRequirement: 0,
  },
  setup_role_menu: {
    description: 'Creates a self-assignable role selection dropdown in a designated channel.',
    requiredBotPermissions: [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.SendMessages],
    requiredUserPermissions: [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels],
    isDestructive: false,
    boostRequirement: 0,
  },
  setup_automod_rule: {
    description: 'Configures native Discord AutoMod rules for spam, invite blocking, and keywords.',
    requiredBotPermissions: [PermissionFlagsBits.ManageGuild],
    requiredUserPermissions: [PermissionFlagsBits.ManageGuild],
    isDestructive: false,
    boostRequirement: 0,
  },
  setup_mod_logs: {
    description: 'Creates a private moderation logging channel for staff.',
    requiredBotPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.SendMessages],
    requiredUserPermissions: [PermissionFlagsBits.ManageChannels],
    isDestructive: false,
    boostRequirement: 0,
  },
  send_announcement: {
    description: 'Broadcasts a formatted rich announcement into a specified channel with optional @everyone ping.',
    requiredBotPermissions: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    boostRequirement: 0,
  },
  send_message: {
    description: 'Sends a direct message or notification to a specific channel.',
    requiredBotPermissions: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: false,
    boostRequirement: 0,
  },
  purge_messages: {
    description: 'Bulk deletes up to 100 recent messages from a channel.',
    requiredBotPermissions: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ViewChannel],
    requiredUserPermissions: [PermissionFlagsBits.Administrator],
    isDestructive: true,
    boostRequirement: 0,
  }
};

/**
 * Explicit list of actions that Discord DOES NOT permit bots to do.
 * When the AI detects these requests, it must explain the exact limitation.
 */
export const UNSUPPORTED_DISCORD_OPERATIONS = [
  {
    pattern: /transfer\s+ownership/i,
    reason: 'Discord API strictly prohibits bots from transferring server ownership. The server owner must do this manually in Server Settings > Members.'
  },
  {
    pattern: /vanity\s+url/i,
    reason: 'Setting a custom vanity URL requires Server Boost Level 3 (14 boosts) and is managed in Server Settings > Vanity URL.'
  },
  {
    pattern: /delete\s+server/i,
    reason: 'Bots cannot delete a Discord server. Only the server owner can delete the server with 2FA/Password.'
  },
  {
    pattern: /read\s+audit\s+log\s+without\s+permission/i,
    reason: 'Viewing audit logs requires the View Audit Log permission.'
  }
];
