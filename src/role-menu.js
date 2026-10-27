import {
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  EmbedBuilder
} from 'discord.js';
import { Logger } from './logger.js';
import { SelfRoleManager } from './self-roles.js';

const logger = new Logger('RoleMenu');

export class RoleMenuManager {
  /**
   * Deploys an interactive self-assignable role dropdown menu.
   * Delegates to SelfRoleManager for persistent tracking and multi-panel support.
   */
  static async setupRoleMenu(guild, options = {}) {
    return await SelfRoleManager.setupPanel(guild, {
      ...options,
      panelType: options.panelType || 'select'
    });
  }

  /**
   * Handles persistent interaction when a member uses the role select menu.
   */
  static async handleSelectMenuInteraction(interaction) {
    // 1. Try modern SelfRoleManager first
    if (interaction.customId?.startsWith('role:sel:')) {
      return await SelfRoleManager.handleSelectMenuInteraction(interaction);
    }

    // 2. Legacy fallback for old panels with customId 'self_assign_roles'
    if (!interaction.isStringSelectMenu() || interaction.customId !== 'self_assign_roles') {
      return false;
    }

    await interaction.deferReply({ ephemeral: true });

    const roleId = interaction.values[0];
    const role = interaction.guild.roles.cache.get(roleId);

    if (!role) {
      await interaction.editReply({ content: '❌ This role no longer exists in the server.' });
      return true;
    }

    const member = interaction.member;

    try {
      if (member.roles.cache.has(roleId)) {
        // Remove role
        await member.roles.remove(role, 'Self-service role removal');
        await interaction.editReply({ content: `➖ Removed **@${role.name}** from your profile.` });
      } else {
        // Add role
        await member.roles.add(role, 'Self-service role assignment');
        await interaction.editReply({ content: `➕ Added **@${role.name}** to your profile!` });
      }
      return true;
    } catch (err) {
      logger.error('Failed to toggle role', { error: err.message });
      await interaction.editReply({
        content: `❌ Could not modify role: ${err.message}. (Ensure the bot's role is placed higher than @${role.name} in Server Settings > Roles).`
      });
      return true;
    }
  }
}
