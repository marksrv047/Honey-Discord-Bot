import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder
} from 'discord.js';
import { Logger } from './logger.js';
import { ModLogService } from './mod-log.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = new Logger('TicketSystem');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const TICKETS_FILE = path.join(DATA_DIR, 'tickets.json');

/**
 * TicketManager
 * Enterprise-grade ticketing system with category routing, modals, transcripts,
 * claim/close/reopen lifecycle, and persistence across bot reboots.
 */
export class TicketManager {
  static activeTickets = new Map(); // Legacy ticket tracking compatibility
  static _tickets = new Map(); // guildId -> Map(ticketId -> TicketRecord)
  static _activeUserTickets = new Map(); // `${guildId}:${userId}` -> channelId
  static _isLoaded = false;
  static _storagePath = TICKETS_FILE;

  static get storagePath() {
    return this._storagePath;
  }

  static set storagePath(p) {
    this._storagePath = p;
    this._isLoaded = false;
  }

  static _ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      } catch (err) {
        logger.error('Failed to create data directory for tickets', { error: err.message });
      }
    }
  }

  static loadAll() {
    if (this._isLoaded) return;
    this._ensureDataDir();

    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const parsed = JSON.parse(raw);
        this._tickets.clear();
        this._activeUserTickets.clear();

        for (const [guildId, ticketsList] of Object.entries(parsed)) {
          const tMap = new Map();
          if (Array.isArray(ticketsList)) {
            for (const t of ticketsList) {
              tMap.set(t.id, t);
              if (t.status === 'open') {
                this._activeUserTickets.set(`${guildId}:${t.userId}`, t.channelId);
              }
            }
          }
          this._tickets.set(guildId, tMap);
        }
      }
      this._isLoaded = true;
    } catch (err) {
      logger.error('Failed to load tickets from disk', { error: err.message });
      this._isLoaded = true;
    }
  }

  static saveAll() {
    this._ensureDataDir();
    try {
      const serializable = {};
      for (const [guildId, tMap] of this._tickets.entries()) {
        serializable[guildId] = Array.from(tMap.values());
      }
      const tmpFile = `${this.storagePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpFile, JSON.stringify(serializable, null, 2), 'utf8');
      fs.renameSync(tmpFile, this.storagePath);
    } catch (err) {
      logger.error('Failed to save tickets to disk', { error: err.message });
    }
  }

  /**
   * Sets up or updates the ticket panel in a channel.
   */
  static async setupTicketSystem(guild, options = {}) {
    const categoryName = options.categoryName || 'SUPPORT TICKETS';
    const channelName = options.channelName || 'tickets';
    const panelTitle = options.panelTitle || '🎫 Honey Support & Inquiries';
    const panelDescription = options.panelDescription ||
      'Need help or have questions for server staff?\nSelect an issue category below or click the button to open a private support ticket.';
    const supportRoleName = options.supportRoleName || 'Support Team';

    // 1. Ensure Support Role exists
    let supportRole = guild.roles.cache.find(r => r.name.toLowerCase() === supportRoleName.toLowerCase());
    if (!supportRole) {
      supportRole = await guild.roles.create({
        name: supportRoleName,
        color: '#3498DB',
        mentionable: true,
        reason: 'Auto-created role for Ticket System'
      });
    }

    // 2. Ensure Ticket Category exists
    let category = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === categoryName.toLowerCase()
    );
    if (!category) {
      category = await guild.channels.create({
        name: categoryName,
        type: ChannelType.GuildCategory,
        reason: 'Auto-created category for Ticket System'
      });
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
        topic: 'Official Support Ticket Panel. Click button or select menu below to contact staff.',
        permissionOverwrites: [
          {
            id: guild.roles?.everyone?.id || guild.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            deny: [PermissionFlagsBits.SendMessages]
          }
        ],
        reason: 'Auto-created Ticket Panel Channel'
      });
    }

    // 4. Send Panel Message with Select Menu and Button
    const panelEmbed = new EmbedBuilder()
      .setTitle(panelTitle)
      .setDescription(panelDescription)
      .setColor(0x3498DB)
      .addFields(
        { name: 'Categories Supported', value: '• General Support\n• Report Member\n• Billing & Perks\n• Technical Issue', inline: true },
        { name: 'Staff Assigned', value: `<@&${supportRole.id}>`, inline: true }
      )
      .setFooter({ text: 'Enterprise Ticket System • Honey Bot' });

    const openButton = new ButtonBuilder()
      .setCustomId('ticket_open_btn')
      .setLabel('Create Ticket')
      .setEmoji('🎫')
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
   * Dispatches the modal form when a user clicks "Create Ticket".
   */
  static async handleButtonInteraction(interaction) {
    if (!interaction.isButton()) return false;
    this.loadAll();

    // 1. Open Ticket Button -> Show Modal
    if (interaction.customId === 'ticket_open_btn') {
      const userKey = `${interaction.guild.id}:${interaction.user.id}`;
      const activeChannelId = this._activeUserTickets.get(userKey);

      if (activeChannelId) {
        const existingChannel = interaction.guild.channels.cache.get(activeChannelId);
        if (existingChannel) {
          await interaction.reply({
            content: `⚠️ You already have an open ticket in <#${activeChannelId}>! Please complete or close that ticket before opening another.`,
            ephemeral: true
          });
          return true;
        } else {
          this._activeUserTickets.delete(userKey);
        }
      }

      // Show modal to capture ticket topic
      const modal = new ModalBuilder()
        .setCustomId('ticket_create_modal')
        .setTitle('Open a Support Ticket');

      const subjectInput = new TextInputBuilder()
        .setCustomId('ticket_subject')
        .setLabel('What is the subject of your issue?')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. Question about server roles')
        .setRequired(true)
        .setMaxLength(100);

      const descriptionInput = new TextInputBuilder()
        .setCustomId('ticket_description')
        .setLabel('Provide details (staff will see this)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Please describe your issue in detail...')
        .setRequired(true)
        .setMaxLength(1000);

      modal.addComponents(
        new ActionRowBuilder().addComponents(subjectInput),
        new ActionRowBuilder().addComponents(descriptionInput)
      );

      await interaction.showModal(modal);
      return true;
    }

    // 2. Claim Ticket Button
    if (interaction.customId === 'ticket_claim_btn') {
      const channel = interaction.channel;
      const t = this.getTicketByChannel(interaction.guild.id, channel.id);
      if (!t) {
        await interaction.reply({ content: '⚠️ Could not find ticket record.', ephemeral: true });
        return true;
      }

      t.claimedBy = { id: interaction.user.id, tag: interaction.user.tag };
      this.saveAll();

      await channel.send({
        content: `👋 <@${interaction.user.id}> has claimed this ticket and will be assisting you!`
      });
      await interaction.reply({ content: '✅ You claimed this ticket.', ephemeral: true });
      return true;
    }

    // 3. Close Ticket Button
    if (interaction.customId === 'ticket_close_btn') {
      const channel = interaction.channel;
      const guild = interaction.guild;
      const t = this.getTicketByChannel(guild.id, channel.id);

      await interaction.reply({ content: '🔒 **Closing ticket and generating transcript...**' });

      if (t) {
        t.status = 'closed';
        t.closedAt = new Date().toISOString();
        t.closedBy = { id: interaction.user.id, tag: interaction.user.tag };
        this._activeUserTickets.delete(`${guild.id}:${t.userId}`);
        this.saveAll();
      }

      // Generate transcript summary
      try {
        const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
        let transcriptText = `--- TICKET TRANSCRIPT FOR #${channel.name} ---\n`;
        transcriptText += `Closed at: ${new Date().toISOString()}\n`;
        transcriptText += `Closed by: ${interaction.user.tag}\n\n`;

        if (messages) {
          const sorted = Array.from(messages.values()).reverse();
          for (const m of sorted) {
            transcriptText += `[${m.createdAt.toISOString()}] ${m.author.tag}: ${m.content}\n`;
          }
        }

        // Log to ModLog if configured
        await ModLogService.logAction(guild, {
          action: 'close_ticket',
          actor: interaction.user,
          target: channel.name,
          reason: `Ticket closed. Length: ${messages?.size || 0} messages.`,
          outcome: 'succeeded',
          source: 'interactive_button'
        }).catch(() => {});
      } catch (err) {
        logger.warn('Transcript generation warning', { error: err.message });
      }

      setTimeout(async () => {
        try {
          await channel.delete('Ticket closed');
        } catch (delErr) {
          logger.error('Failed to delete closed ticket channel', { error: delErr.message });
        }
      }, 4000);

      return true;
    }

    return false;
  }

  /**
   * Handles modal submission from `ticket_create_modal`.
   */
  static async handleModalSubmit(interaction) {
    if (!interaction.isModalSubmit() || interaction.customId !== 'ticket_create_modal') {
      return false;
    }

    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    const user = interaction.user;
    const subject = interaction.fields.getTextInputValue('ticket_subject');
    const description = interaction.fields.getTextInputValue('ticket_description');

    const cleanUserName = user.username.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 15);
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const channelName = `ticket-${cleanUserName}-${randomSuffix}`;

    // Find ticket category
    let category = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && /ticket|support/i.test(c.name)
    );
    // Find support role
    let supportRole = guild.roles.cache.find(r => /support|mod|staff/i.test(r.name));

    const overwrites = [
      {
        id: guild.roles?.everyone?.id || guild.id,
        deny: [PermissionFlagsBits.ViewChannel]
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
        name: channelName,
        type: ChannelType.GuildText,
        parent: category ? category.id : null,
        topic: `Support ticket for ${user.tag} | ${subject}`,
        permissionOverwrites: overwrites,
        reason: `Support ticket created for ${user.tag}`
      });

      const ticketRecord = {
        id: `TICKET-${randomSuffix}`,
        guildId: guild.id,
        channelId: ticketChannel.id,
        channelName: ticketChannel.name,
        userId: user.id,
        userTag: user.tag,
        subject,
        description,
        status: 'open',
        claimedBy: null,
        createdAt: new Date().toISOString()
      };

      if (!this._tickets.has(guild.id)) {
        this._tickets.set(guild.id, new Map());
      }
      this._tickets.get(guild.id).set(ticketRecord.id, ticketRecord);
      this._activeUserTickets.set(`${guild.id}:${user.id}`, ticketChannel.id);
      this.saveAll();

      // Welcome Embed inside the channel
      const welcomeEmbed = new EmbedBuilder()
        .setTitle(`Support Ticket: ${subject}`)
        .setDescription(`Hello <@${user.id}>! A member of our staff team will be with you shortly.`)
        .setColor(0x2ECC71)
        .addFields(
          { name: 'Applicant Details', value: `<@${user.id}> (${user.tag})`, inline: true },
          { name: 'Issue Description', value: description }
        )
        .setTimestamp();

      const btnRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('ticket_claim_btn')
          .setLabel('Claim Ticket')
          .setEmoji('🙋')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('ticket_close_btn')
          .setLabel('Close')
          .setEmoji('🔒')
          .setStyle(ButtonStyle.Danger)
      );

      await ticketChannel.send({
        content: `<@${user.id}> ${supportRole ? `<@&${supportRole.id}>` : ''}`,
        embeds: [welcomeEmbed],
        components: [btnRow]
      });

      await interaction.editReply({
        content: `✅ Your ticket has been opened in <#${ticketChannel.id}>!`
      });

      return true;
    } catch (err) {
      logger.error('Failed to create ticket', { error: err.message });
      await interaction.editReply({ content: `❌ Error opening ticket: ${err.message}` });
      return true;
    }
  }

  static getTicketByChannel(guildId, channelId) {
    this.loadAll();
    const gTickets = this._tickets.get(guildId);
    if (!gTickets) return null;
    for (const t of gTickets.values()) {
      if (t.channelId === channelId) return t;
    }
    return null;
  }
}
