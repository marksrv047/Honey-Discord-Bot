import {
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ComponentType
} from 'discord.js';
import { Logger } from './logger.js';

const logger = new Logger('TicketSystem');

/**
 * Manages the interactive Ticket System.
 */
export class TicketManager {
  // In-memory active user ticket tracking to prevent ticket spam
  static activeTickets = new Map(); // userId -> channelId

  /**
   * Sets up the complete Ticket System panel in the guild.
   */
  static async setupTicketSystem(guild, options = {}) {
    const categoryName = options.categoryName || 'SUPPORT TICKETS';
    const channelName = options.channelName || 'tickets';
    const panelTitle = options.panelTitle || 'Support & Assistance';
    const panelDescription = options.panelDescription || 'Need help or want to speak with staff? Click the button below to open a private ticket.';
    const supportRoleName = options.supportRoleName || 'Support Team';
    const buttonText = options.buttonText || 'Create Ticket';
    const buttonEmoji = options.buttonEmoji || '🎫';

    // 1. Ensure Support Role exists
    let supportRole = guild.roles.cache.find(r => r.name.toLowerCase() === supportRoleName.toLowerCase());
    if (!supportRole) {
      supportRole = await guild.roles.create({
        name: supportRoleName,
        color: '#3498DB',
        mentionable: true,
        reason: 'Auto-created for Ticket System'
      });
      logger.info('Created Support role for tickets', { roleName: supportRole.name });
    }

    // 2. Ensure Ticket Category exists
    let category = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === categoryName.toLowerCase()
    );
    if (!category) {
      category = await guild.channels.create({
        name: categoryName,
        type: ChannelType.GuildCategory,
        reason: 'Auto-created Category for Ticket System'
      });
      logger.info('Created Ticket Category', { categoryName: category.name });
    }

    // 3. Ensure Panel Channel exists
    let panelChannel = guild.channels.cache.find(
      c => c.name.toLowerCase() === channelName.toLowerCase() && c.parentId === category.id
    );
    if (!panelChannel) {
      panelChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: 'Official Support Ticket Panel. Click button below to contact staff.',
        permissionOverwrites: [
          {
            id: guild.roles?.everyone?.id || guild.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            deny: [PermissionFlagsBits.SendMessages] // Read-only channel
          }
        ],
        reason: 'Auto-created Ticket Panel Channel'
      });
      logger.info('Created Ticket Panel Channel', { channelName: panelChannel.name });
    }

    // 4. Send Panel Message with Persistent Button
    const panelEmbed = new EmbedBuilder()
      .setTitle(panelTitle)
      .setDescription(panelDescription)
      .setColor(0x3498DB)
      .addFields(
        { name: 'Support Staff', value: `<@&${supportRole.id}>`, inline: true },
        { name: 'Privacy', value: 'Private 1-on-1 text channel', inline: true }
      )
      .setFooter({ text: 'Powered by Admin Agent • Zero-Cost Autonomous Infrastructure' });

    const openButton = new ButtonBuilder()
      .setCustomId('ticket_open_btn')
      .setLabel(buttonText)
      .setEmoji(buttonEmoji)
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(openButton);

    const sentMessage = await panelChannel.send({
      embeds: [panelEmbed],
      components: [row]
    });

    return {
      success: true,
      category: category.name,
      channel: panelChannel.name,
      messageId: sentMessage.id,
      supportRole: supportRole.name
    };
  }

  /**
   * Handles persistent button interactions (ticket_open_btn, ticket_close_btn).
   */
  static async handleButtonInteraction(interaction) {
    if (!interaction.isButton()) return false;

    // Handle Open Ticket
    if (interaction.customId === 'ticket_open_btn') {
      await interaction.deferReply({ ephemeral: true });

      const guild = interaction.guild;
      const user = interaction.user;

      // Check duplicate ticket
      const existingChannelId = TicketManager.activeTickets.get(user.id);
      if (existingChannelId) {
        const existingChannel = guild.channels.cache.get(existingChannelId);
        if (existingChannel) {
          await interaction.editReply({
            content: `⚠️ You already have an open ticket in <#${existingChannelId}>!`
          });
          return true;
        }
      }

      // Find ticket category
      let category = guild.channels.cache.find(
        c => c.type === ChannelType.GuildCategory && /ticket|support/i.test(c.name)
      );

      // Find support role
      let supportRole = guild.roles.cache.find(r => /support|mod|staff/i.test(r.name));

      const cleanUserName = user.username.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 15);
      const ticketChannelName = `ticket-${cleanUserName}-${Math.floor(1000 + Math.random() * 9000)}`;

      const overwrites = [
        {
          id: guild.roles?.everyone?.id || guild.id,
          deny: [PermissionFlagsBits.ViewChannel] // Hide from everyone
        },
        {
          id: user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.ReadMessageHistory
          ]
        }
      ];

      if (supportRole) {
        overwrites.push({
          id: supportRole.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.ReadMessageHistory
          ]
        });
      }

      try {
        const ticketChannel = await guild.channels.create({
          name: ticketChannelName,
          type: ChannelType.GuildText,
          parent: category ? category.id : null,
          topic: `Support ticket for ${user.tag} (ID: ${user.id})`,
          permissionOverwrites: overwrites,
          reason: `Ticket created for ${user.tag}`
        });

        TicketManager.activeTickets.set(user.id, ticketChannel.id);

        // Send Welcome Message inside the ticket channel
        const welcomeEmbed = new EmbedBuilder()
          .setTitle(`Ticket: ${user.username}`)
          .setDescription(`Welcome <@${user.id}>! A member of the staff will assist you shortly.\n\nPlease describe your inquiry in detail.`)
          .setColor(0x2ECC71)
          .setTimestamp();

        const closeButton = new ButtonBuilder()
          .setCustomId('ticket_close_btn')
          .setLabel('Close Ticket')
          .setEmoji('🔒')
          .setStyle(ButtonStyle.Danger);

        const closeRow = new ActionRowBuilder().addComponents(closeButton);

        await ticketChannel.send({
          content: `<@${user.id}> ${supportRole ? `<@&${supportRole.id}>` : ''}`,
          embeds: [welcomeEmbed],
          components: [closeRow]
        });

        await interaction.editReply({
          content: `✅ Your ticket has been created: <#${ticketChannel.id}>`
        });
        return true;
      } catch (err) {
        logger.error('Failed to create ticket channel', { error: err.message });
        await interaction.editReply({
          content: `❌ Failed to create ticket: ${err.message}`
        });
        return true;
      }
    }

    // Handle Close Ticket
    if (interaction.customId === 'ticket_close_btn') {
      const channel = interaction.channel;
      await interaction.reply({
        content: '🔒 **Closing ticket in 5 seconds...**'
      });

      // Cleanup user tracking
      for (const [userId, chId] of TicketManager.activeTickets.entries()) {
        if (chId === channel.id) {
          TicketManager.activeTickets.delete(userId);
          break;
        }
      }

      setTimeout(async () => {
        try {
          await channel.delete('Ticket closed by user/staff');
        } catch (err) {
          logger.error('Failed to delete closed ticket channel', { error: err.message });
        }
      }, 5000);

      return true;
    }

    return false;
  }
}
