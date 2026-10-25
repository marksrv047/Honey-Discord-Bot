import {
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  EmbedBuilder
} from 'discord.js';
import { Logger } from './logger.js';

const logger = new Logger('RoleMenu');

export class RoleMenuManager {
  /**
   * Deploys an interactive self-assignable role dropdown menu.
   */
  static async setupRoleMenu(guild, options = {}) {
    const channelName = options.channelName || 'roles';
    const title = options.title || '🎭 Self-Assignable Roles';
    const description = options.description || 'Select a role from the dropdown below to assign or remove it:';
    const roleConfigs = options.roles || [];

    if (roleConfigs.length === 0) {
      throw new Error('At least one role configuration is required to create a role menu.');
    }

    // 1. Ensure or find channel
    let channel = guild.channels.cache.find(c => c.name.toLowerCase() === channelName.toLowerCase());
    if (!channel) {
      channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic: 'Pick your self-assignable roles here!',
        permissionOverwrites: [
          {
            id: guild.roles?.everyone?.id || guild.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            deny: [PermissionFlagsBits.SendMessages]
          }
        ],
        reason: 'Auto-created for Self-Assignable Roles Menu'
      });
      logger.info('Created role menu channel', { channelName: channel.name });
    }

    // 2. Ensure each role exists
    const menuOptions = [];

    for (const rConfig of roleConfigs.slice(0, 25)) {
      let role = guild.roles.cache.find(r => r.name.toLowerCase() === rConfig.name.toLowerCase());
      if (!role) {
        role = await guild.roles.create({
          name: rConfig.name,
          color: rConfig.color || '#99AAB5',
          mentionable: false,
          reason: 'Created for self-assignable role menu'
        });
        logger.info('Created role for menu', { roleName: role.name });
      }

      const optionBuilder = new StringSelectMenuOptionBuilder()
        .setLabel(role.name)
        .setValue(role.id)
        .setDescription(rConfig.description || `Toggle the ${role.name} role`);

      if (rConfig.emoji) {
        try {
          optionBuilder.setEmoji(rConfig.emoji);
        } catch {
          // Ignore invalid emoji
        }
      }

      menuOptions.push(optionBuilder);
    }

    // 3. Build Select Menu and Embed
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('self_assign_roles')
      .setPlaceholder('Choose a role to toggle...')
      .addOptions(menuOptions);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(0x9B59B6)
      .setFooter({ text: 'Click a role again at any time to remove it' });

    const sent = await channel.send({
      embeds: [embed],
      components: [row]
    });

    return {
      success: true,
      channel: channel.name,
      messageId: sent.id,
      rolesCreatedOrLinked: menuOptions.length
    };
  }

  /**
   * Handles persistent interaction when a member uses the role select menu.
   */
  static async handleSelectMenuInteraction(interaction) {
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
