import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits
} from 'discord.js';
import { Logger } from './logger.js';
import { ModLogService } from './mod-log.js';
import { CaseManager } from './case-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = new Logger('ApplicationManager');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const APPLICATIONS_FILE = path.join(DATA_DIR, 'applications.json');

/**
 * ApplicationManager
 * Manages configurable staff applications, member reports, moderation appeals,
 * and the staff review queue with Approve / Reject / Request More Info buttons.
 */
export class ApplicationManager {
  static _apps = new Map(); // guildId -> Map(appId -> AppRecord)
  static _configs = new Map(); // guildId -> AppConfig
  static _isLoaded = false;
  static _storagePath = APPLICATIONS_FILE;

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
        logger.error('Failed to create data directory for applications', { error: err.message });
      }
    }
  }

  static getDefaultConfig() {
    return {
      reviewChannelId: null,
      staffRoleIds: [],
      staffAppEnabled: true,
      partnerAppEnabled: true,
      appealEnabled: true
    };
  }

  static loadAll() {
    if (this._isLoaded) return;
    this._ensureDataDir();

    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const parsed = JSON.parse(raw);
        this._apps.clear();
        this._configs.clear();

        for (const [guildId, data] of Object.entries(parsed)) {
          this._configs.set(guildId, { ...this.getDefaultConfig(), ...(data.config || {}) });
          const map = new Map();
          if (Array.isArray(data.applications)) {
            for (const a of data.applications) {
              map.set(a.id, a);
            }
          }
          this._apps.set(guildId, map);
        }
      }
      this._isLoaded = true;
    } catch (err) {
      logger.error('Failed to load applications from disk', { error: err.message });
      this._isLoaded = true;
    }
  }

  static saveAll() {
    this._ensureDataDir();
    try {
      const serializable = {};
      for (const [guildId, map] of this._apps.entries()) {
        serializable[guildId] = {
          config: this._configs.get(guildId) || this.getDefaultConfig(),
          applications: Array.from(map.values())
        };
      }
      const tmpFile = `${this.storagePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpFile, JSON.stringify(serializable, null, 2), 'utf8');
      fs.renameSync(tmpFile, this.storagePath);
    } catch (err) {
      logger.error('Failed to save applications to disk', { error: err.message });
    }
  }

  static getConfig(guildId) {
    this.loadAll();
    return this._configs.get(guildId) || this.getDefaultConfig();
  }

  static updateConfig(guildId, update) {
    this.loadAll();
    const current = this.getConfig(guildId);
    const updated = { ...current, ...update };
    this._configs.set(guildId, updated);
    this.saveAll();
    return updated;
  }

  /**
   * Publishes an interactive application panel in a channel.
   */
  static async publishApplicationPanel(guild, channelId, type = 'staff') {
    const channel = guild.channels.cache.get(channelId);
    if (!channel) return { success: false, error: 'Channel not found' };

    let title = '📝 Staff Application Panel';
    let description = 'Interested in joining our server staff team? Click below to fill out an application.';
    let btnLabel = 'Apply for Staff';
    let customId = 'app:open:staff';

    if (type === 'appeal') {
      title = '⚖️ Moderation Sanction Appeal';
      description = 'If you believe a warning, timeout, or moderation action was applied in error, submit an appeal for review.';
      btnLabel = 'Submit Appeal';
      customId = 'app:open:appeal';
    } else if (type === 'report') {
      title = '🚨 Member Report System';
      description = 'Report rule violations, harassment, or scam bots privately to the server moderation team.';
      btnLabel = 'Submit Report';
      customId = 'app:open:report';
    }

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(0x5865F2)
      .setFooter({ text: 'Official Honey Application & Review Gateway' });

    const btn = new ButtonBuilder()
      .setCustomId(customId)
      .setLabel(btnLabel)
      .setEmoji('📋')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(btn);

    const msg = await channel.send({ embeds: [embed], components: [row] });
    return { success: true, messageId: msg.id };
  }

  /**
   * Handles button click to display the appropriate submission modal.
   */
  static async handleButtonInteraction(interaction) {
    if (!interaction.isButton()) return false;

    // Open Modal Handlers
    if (interaction.customId === 'app:open:staff') {
      const modal = new ModalBuilder()
        .setCustomId('app:submit:staff')
        .setTitle('Staff Team Application');

      const expInput = new TextInputBuilder()
        .setCustomId('staff_experience')
        .setLabel('Previous moderation experience?')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Describe any past staff/mod experience on Discord servers...')
        .setRequired(true);

      const timezoneInput = new TextInputBuilder()
        .setCustomId('staff_timezone')
        .setLabel('Timezone and weekly availability?')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. EST (UTC-5), 15 hours/week')
        .setRequired(true);

      const scenarioInput = new TextInputBuilder()
        .setCustomId('staff_scenario')
        .setLabel('How would you handle a user spamming?')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Explain your steps when addressing a public lounge raid or spam...')
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(expInput),
        new ActionRowBuilder().addComponents(timezoneInput),
        new ActionRowBuilder().addComponents(scenarioInput)
      );

      await interaction.showModal(modal);
      return true;
    }

    if (interaction.customId === 'app:open:appeal') {
      const modal = new ModalBuilder()
        .setCustomId('app:submit:appeal')
        .setTitle('Moderation Appeal');

      const caseIdInput = new TextInputBuilder()
        .setCustomId('appeal_case_id')
        .setLabel('Case ID or Action (if known)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. CASE-0004 or Timeout yesterday')
        .setRequired(true);

      const reasonInput = new TextInputBuilder()
        .setCustomId('appeal_reason')
        .setLabel('Why should this sanction be reconsidered?')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Explain the context and why you believe this was an error...')
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(caseIdInput),
        new ActionRowBuilder().addComponents(reasonInput)
      );

      await interaction.showModal(modal);
      return true;
    }

    // Review Decision Handlers: Approve, Reject, Request Info
    if (interaction.customId.startsWith('app:review:')) {
      const parts = interaction.customId.split(':');
      const action = parts[2]; // 'approve' | 'reject' | 'info'
      const appId = parts[3];

      const guild = interaction.guild;
      const app = this.getApplication(guild.id, appId);
      if (!app) {
        await interaction.reply({ content: '⚠️ Application record not found.', ephemeral: true });
        return true;
      }

      app.status = action === 'approve' ? 'approved' : (action === 'reject' ? 'rejected' : 'info_requested');
      app.reviewedBy = { id: interaction.user.id, tag: interaction.user.tag };
      app.reviewedAt = new Date().toISOString();
      this.saveAll();

      const actionText = action === 'approve' ? '✅ Approved' : (action === 'reject' ? '❌ Rejected' : '💬 Additional Info Requested');
      await interaction.update({
        content: `**Decision Recorded:** ${actionText} by <@${interaction.user.id}> on <t:${Math.floor(Date.now() / 1000)}:R>`,
        components: [] // Remove review buttons once finalized
      });

      // If it was an appeal and approved, resolve with CaseManager
      if (app.type === 'appeal' && app.caseId) {
        CaseManager.resolveAppeal(guild.id, app.caseId, {
          decision: action === 'approve' ? 'accepted' : 'denied',
          moderator: interaction.user,
          notes: `Handled via application review: ${actionText}`
        });
      }

      logger.info(`Application ${appId} in guild ${guild.id} set to ${app.status} by ${interaction.user.tag}`);
      return true;
    }

    return false;
  }

  /**
   * Handles modal submissions from staff application or appeal.
   */
  static async handleModalSubmit(interaction) {
    if (!interaction.isModalSubmit() || !interaction.customId.startsWith('app:submit:')) {
      return false;
    }

    await interaction.deferReply({ ephemeral: true });
    const guild = interaction.guild;
    const user = interaction.user;
    const appType = interaction.customId.split(':')[2];

    const appId = `APP-${Math.floor(1000 + Math.random() * 9000)}`;
    const answers = {};

    if (appType === 'staff') {
      answers.experience = interaction.fields.getTextInputValue('staff_experience');
      answers.availability = interaction.fields.getTextInputValue('staff_timezone');
      answers.scenario = interaction.fields.getTextInputValue('staff_scenario');
    } else if (appType === 'appeal') {
      answers.caseId = interaction.fields.getTextInputValue('appeal_case_id');
      answers.reason = interaction.fields.getTextInputValue('appeal_reason');
    }

    const appRecord = {
      id: appId,
      guildId: guild.id,
      userId: user.id,
      userTag: user.tag,
      type: appType,
      caseId: answers.caseId || null,
      answers,
      status: 'pending',
      createdAt: new Date().toISOString(),
      reviewedBy: null,
      reviewedAt: null
    };

    this.loadAll();
    if (!this._apps.has(guild.id)) {
      this._apps.set(guild.id, new Map());
    }
    this._apps.get(guild.id).set(appId, appRecord);
    this.saveAll();

    // Dispatch to Staff Review Channel if configured
    const conf = this.getConfig(guild.id);
    if (conf.reviewChannelId) {
      const reviewChannel = guild.channels.cache.get(conf.reviewChannelId);
      if (reviewChannel && reviewChannel.isTextBased()) {
        const reviewEmbed = new EmbedBuilder()
          .setTitle(`📋 New ${appType.toUpperCase()} Submission: [${appId}]`)
          .setDescription(`Submitted by <@${user.id}> (${user.tag})`)
          .setColor(appType === 'appeal' ? 0xFEE75C : 0x5865F2)
          .setTimestamp();

        for (const [q, a] of Object.entries(answers)) {
          reviewEmbed.addFields({ name: q.toUpperCase(), value: String(a).slice(0, 1024) });
        }

        const reviewRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`app:review:approve:${appId}`)
            .setLabel('Approve')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`app:review:reject:${appId}`)
            .setLabel('Reject')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`app:review:info:${appId}`)
            .setLabel('Request More Info')
            .setStyle(ButtonStyle.Secondary)
        );

        await reviewChannel.send({ embeds: [reviewEmbed], components: [reviewRow] });
      }
    }

    await interaction.editReply({
      content: `✅ Your **${appType}** submission has been registered as \`${appId}\` and forwarded to server staff for review!`
    });

    return true;
  }

  static getApplication(guildId, appId) {
    this.loadAll();
    const gApps = this._apps.get(guildId);
    if (!gApps) return null;
    return gApps.get(appId) || null;
  }

  static listApplications(guildId, status = null) {
    this.loadAll();
    const gApps = this._apps.get(guildId);
    if (!gApps) return [];
    let list = Array.from(gApps.values());
    if (status) {
      list = list.filter(a => a.status === status);
    }
    return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
}

