import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  PermissionFlagsBits
} from 'discord.js';
import { PermissionAuditService } from './permission-audit.js';
import { GuildConfigService } from './guild-config.js';
import { checkUserAuthorization } from './permissions.js';
import { Logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = new Logger('OnboardingManager');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'onboarding-state.json');

/**
 * Onboarding and Installation Setup Manager.
 * Orchestrates first-run setup, interactive permission audits, feature configuration,
 * and safe Discord OAuth2 reauthorization.
 */
export class OnboardingManager {
  static _state = new Map(); // guildId -> State
  static _isLoaded = false;
  static _customStoragePath = null;

  static get storagePath() {
    return this._customStoragePath || STATE_FILE;
  }

  static set storagePath(p) {
    this._customStoragePath = p;
    this._isLoaded = false;
  }

  static _ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  /**
   * Loads persisted onboarding records from disk.
   */
  static loadAllState() {
    if (this._isLoaded) return this._state;
    this._ensureDataDir();

    const filePath = this.storagePath;
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this._state.clear();
          for (const [gId, val] of Object.entries(parsed)) {
            this._state.set(gId, val);
          }
        }
      }
      this._isLoaded = true;
    } catch (err) {
      logger.error('Failed to load onboarding state from disk', { error: err.message });
      this._state.clear();
      this._isLoaded = true;
    }
    return this._state;
  }

  /**
   * Persists onboarding records to disk atomically.
   */
  static saveAllState() {
    this._ensureDataDir();
    const filePath = this.storagePath;
    const tempPath = `${filePath}.tmp.${Date.now()}`;

    try {
      const obj = {};
      for (const [k, v] of this._state.entries()) {
        obj[k] = v;
      }
      fs.writeFileSync(tempPath, JSON.stringify(obj, null, 2), 'utf8');
      fs.renameSync(tempPath, filePath);
    } catch (err) {
      logger.error('Failed to persist onboarding state to disk', { error: err.message });
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
    }
  }

  /**
   * Retrieves or initializes onboarding state for a specific guild.
   */
  static getState(guildId) {
    this.loadAllState();
    if (!this._state.has(guildId)) {
      const defaultState = {
        guildId,
        completed: false,
        completedAt: null,
        completedBy: null,
        installMode: null,
        lastAuditStatus: null,
        lastSetupMessageId: null,
        lastSetupChannelId: null,
        fallbackMessageFailed: false,
        featureSettings: {
          moderation: true,
          roles: true,
          channels: true,
          music: true,
          logging: true,
          tickets: true
        }
      };
      this._state.set(guildId, defaultState);
      this.saveAllState();
    }
    return this._state.get(guildId);
  }

  /**
   * Updates state for a guild.
   */
  static updateState(guildId, updates = {}) {
    const current = this.getState(guildId);
    const updated = { ...current, ...updates, guildId };
    this._state.set(guildId, updated);
    this.saveAllState();
    return updated;
  }

  /**
   * Automatically handles new guild joining (Events.GuildCreate).
   * Locates a safe permitted channel and renders the initial Setup Panel without spamming.
   */
  static async handleGuildCreate(guild) {
    if (!guild) return null;
    const guildId = guild.id;
    logger.info(`Honey Bot joined or connected to guild: ${guild.name} (${guildId})`);

    const state = this.getState(guildId);

    // If already completed and permissions are healthy, skip auto-prompt
    if (state.completed) {
      const audit = await PermissionAuditService.auditGuild(guild);
      if (audit.overallStatus === 'ready') {
        logger.info(`Guild ${guild.name} has already completed onboarding with healthy permissions. Skipping welcome prompt.`);
        return null;
      }
      logger.warn(`Guild ${guild.name} was previously onboarded, but permissions are degraded. Presenting recheck options.`);
    }

    const audit = await PermissionAuditService.auditGuild(guild);
    state.lastAuditStatus = audit.overallStatus;

    // 1. Find Best Setup Channel
    const targetChannel = this._findBestSetupChannel(guild, audit);
    if (!targetChannel) {
      logger.error(`Cannot send setup welcome message to guild ${guild.name}: No text channel has SendMessages + EmbedLinks permissions for Honey Bot.`);
      this.updateState(guildId, { fallbackMessageFailed: true });
      return null;
    }

    const payload = this.buildSetupPayload(guild, audit);

    // 2. Prevent message spam: Try to edit existing message if it exists
    if (state.lastSetupMessageId && state.lastSetupChannelId) {
      try {
        const existingChannel = guild.channels?.cache?.get(state.lastSetupChannelId);
        if (existingChannel && typeof existingChannel.messages?.fetch === 'function') {
          const existingMsg = await existingChannel.messages.fetch(state.lastSetupMessageId).catch(() => null);
          if (existingMsg && existingMsg.editable) {
            await existingMsg.edit(payload);
            logger.info(`Updated existing setup message in #${existingChannel.name} for ${guild.name}`);
            return existingMsg;
          }
        }
      } catch (err) {
        logger.warn('Failed to edit existing setup message, will post a new one', { error: err.message });
      }
    }

    // 3. Post New Setup Message
    try {
      const newMsg = await targetChannel.send(payload);
      this.updateState(guildId, {
        lastSetupMessageId: newMsg.id,
        lastSetupChannelId: targetChannel.id,
        fallbackMessageFailed: false
      });
      logger.info(`Setup panel successfully posted in #${targetChannel.name} for ${guild.name}`);
      return newMsg;
    } catch (err) {
      logger.error(`Failed to send setup message to #${targetChannel.name}`, { error: err.message });
      this.updateState(guildId, { fallbackMessageFailed: true });
      return null;
    }
  }

  /**
   * Locates the most suitable text channel to post setup messages.
   */
  static _findBestSetupChannel(guild, audit) {
    const botMember = guild.members?.me;

    // Check system channel first
    if (guild.systemChannel) {
      const sysPerms = botMember && typeof botMember.permissionsIn === 'function'
        ? botMember.permissionsIn(guild.systemChannel)
        : null;
      if (!sysPerms || sysPerms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        return guild.systemChannel;
      }
    }

    const channels = guild.channels?.cache ? Array.from(guild.channels.cache.values()) : [];
    
    // Priority names
    const preferredNames = /^(?:general|welcome|bot-setup|admin|bot-commands|announcements)$/i;
    for (const ch of channels) {
      const isText = (ch.isTextBased && typeof ch.isTextBased === 'function' && ch.isTextBased()) || ch.type === 0;
      if (isText && preferredNames.test(ch.name)) {
        const perms = botMember && typeof botMember.permissionsIn === 'function'
          ? botMember.permissionsIn(ch)
          : null;
        if (!perms || perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
          return ch;
        }
      }
    }

    // Fallback: Any permitted text channel
    return channels.find(ch => {
      const isText = (ch.isTextBased && typeof ch.isTextBased === 'function' && ch.isTextBased()) || ch.type === 0;
      if (!isText) return false;
      const perms = botMember && typeof botMember.permissionsIn === 'function'
        ? botMember.permissionsIn(ch)
        : null;
      return !perms || perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
    }) || null;
  }

  /**
   * Generates the polished, premium First-Run Setup Embed and Interactive Component Rows.
   */
  static buildSetupPayload(guild, audit = null) {
    if (!audit) {
      audit = {
        hasAdministrator: false,
        overallStatus: 'partially_ready',
        summary: 'Audit in progress...',
        missingRecommended: [],
        missingCritical: [],
        capabilities: {},
        roleHierarchy: { botHighestRole: { name: 'Honey Bot', position: 1 }, unmanageableRoles: [] },
        inviteUrls: {
          admin: PermissionAuditService.generateInviteUrl({ guildId: guild?.id, mode: 'admin' }),
          recommended: PermissionAuditService.generateInviteUrl({ guildId: guild?.id, mode: 'recommended' })
        }
      };
    }

    const state = this.getState(guild.id);
    const guildName = guild.name || 'Your Server';
    const botRoleName = audit.roleHierarchy?.botHighestRole?.name || 'Honey Bot';
    const botPos = audit.roleHierarchy?.botHighestRole?.position ?? 0;

    // Determine status badge
    let statusBadge = '🔴 **Action Required: Critical Permissions Missing**';
    let statusDesc = 'Honey Bot cannot communicate properly because core permissions are missing.';
    let color = 0xED4245; // Discord Red

    if (audit.hasAdministrator) {
      statusBadge = '🟢 **Administrator Access Active**';
      statusDesc = 'Full autonomous administration is enabled. All commands and autonomous actions are ready.';
      color = 0x57F287; // Discord Green
    } else if (audit.overallStatus === 'ready') {
      statusBadge = '🟡 **Recommended Least-Privilege Active**';
      statusDesc = 'All core feature permissions are active. Operating under recommended zero-trust boundaries.';
      color = 0xFEE75C; // Discord Gold
    } else if (audit.overallStatus === 'partially_ready') {
      statusBadge = '🟠 **Partial Permissions Active**';
      statusDesc = 'Basic messaging is online, but some administrative modules require additional permissions.';
      color = 0xE67E22; // Discord Orange
    }

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle('🍯 Honey Bot — Installation & Permission Setup')
      .setDescription(
        `Welcome to **${guildName}**! Honey is an autonomous Discord administration agent driven by natural language (\`/go <instruction>\`).\n\n` +
        `### Current Authorization Status\n${statusBadge}\n${statusDesc}\n`
      );

    // Capability Matrix Field
    const capList = [
      { name: 'Messaging & Chat Alerts', cap: audit.capabilities?.messaging },
      { name: 'Channel & Category Control', cap: audit.capabilities?.channels },
      { name: 'Role Management & Menus', cap: audit.capabilities?.roles },
      { name: 'Moderation (Kick/Ban/Timeout)', cap: audit.capabilities?.moderation },
      { name: 'Voice & Music Playback', cap: audit.capabilities?.voice },
      { name: 'Moderation Logs & Audit', cap: audit.capabilities?.modlog },
      { name: 'Interactive Support Tickets', cap: audit.capabilities?.tickets },
      { name: 'Interactive Server Dashboard', cap: audit.capabilities?.dashboard }
    ];

    const capLines = capList.map(({ name, cap }) => {
      const icon = cap?.status === 'ready' ? '✅' : cap?.status === 'partially_ready' ? '⚠️' : '❌';
      const detail = cap?.missingPerms?.length ? ` *(needs: ${cap.missingPerms.join(', ')})*` : '';
      return `${icon} **${name}**${detail}`;
    }).join('\n');

    embed.addFields({
      name: '⚡ Feature Readiness Matrix',
      value: capLines || 'Evaluating capabilities...',
      inline: false
    });

    // Role Hierarchy Field
    const hierarchyText = audit.roleHierarchy?.hierarchyWarning
      ? `⚠️ **Hierarchy Notice:** ${audit.roleHierarchy.hierarchyWarning}\n*Action:* Open **Server Settings > Roles** and drag **@${botRoleName}** above the roles you want it to manage.`
      : `✅ **Role Hierarchy Healthy:** **@${botRoleName}** (Position ${botPos}) can manage all lower roles.`;

    embed.addFields({
      name: '🛡️ Role Hierarchy & Bot Position',
      value: hierarchyText,
      inline: false
    });

    // Missing Permissions Consequence Explanation
    if (audit.missingRecommended.length > 0 && !audit.hasAdministrator) {
      const consequences = audit.missingRecommended.slice(0, 4).map(perm => {
        const feature = audit.capabilities ? Object.values(audit.capabilities).find(c => c.missingPerms?.includes(perm))?.label : null;
        return `• **${perm}** – Disables ${feature || 'associated administration actions'}`;
      }).join('\n');

      embed.addFields({
        name: '⚠️ Missing Permissions & Consequences',
        value: consequences + (audit.missingRecommended.length > 4 ? `\n*...and ${audit.missingRecommended.length - 4} more.*` : ''),
        inline: false
      });
    }

    embed.addFields({
      name: '📖 Next Steps for Server Administrators',
      value:
        '1. **Grant Permissions:** Click **Authorize (Administrator)** or **Authorize (Least-Privilege)** below.\n' +
        '2. **Adjust Role Position:** In Discord **Server Settings > Roles**, drag Honey Bot\'s role higher.\n' +
        '3. **Verify:** Click **Check Permissions Again** to validate your changes.\n' +
        '4. **Start Managing:** Use `/help`, `/go prompt: display bot dashboard`, or `/diagnose`.',
      inline: false
    });

    embed.setFooter({
      text: `Guild ID: ${guild.id} • Tenant Isolated • Honey Bot Autonomous Admin`
    });
    embed.setTimestamp();

    // -------------------------------------------------------------
    // Action Rows
    // -------------------------------------------------------------

    // Row 1: Official Discord OAuth2 Authorization Links
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Install Honey Bot (Least-Privilege)')
        .setStyle(ButtonStyle.Link)
        .setURL(audit.inviteUrls?.recommended || PermissionAuditService.generateInviteUrl({ guildId: guild.id, mode: 'recommended', clientId: audit.botId }))
        .setEmoji('🛡️'),
      new ButtonBuilder()
        .setLabel('Optional Full-Access (Administrator)')
        .setStyle(ButtonStyle.Link)
        .setURL(audit.inviteUrls?.admin || PermissionAuditService.generateInviteUrl({ guildId: guild.id, mode: 'admin', clientId: audit.botId }))
        .setEmoji('👑')
    );

    // Row 2: Interactive Operations
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('setup:recheck')
        .setLabel('Check Permissions Again')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🔄'),
      new ButtonBuilder()
        .setCustomId('setup:features')
        .setLabel('Configure Features')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('⚙️'),
      new ButtonBuilder()
        .setCustomId('setup:guide')
        .setLabel('Setup Help Guide')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('📖'),
      new ButtonBuilder()
        .setCustomId('setup:complete')
        .setLabel(state.completed ? 'Setup Completed' : 'Mark Setup Complete')
        .setStyle(state.completed ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setEmoji('✅')
    );

    return {
      embeds: [embed],
      components: [row1, row2]
    };
  }

  /**
   * Opens the Setup Panel on demand from slash commands (/go prompt: setup, /diagnose, dashboard).
   */
  static async openSetupPanel(interaction) {
    if (!interaction.guild) {
      return await interaction.reply({
        content: 'Honey Bot setup can only be accessed inside a Discord server.',
        ephemeral: true
      });
    }

    const member = interaction.member;
    const auth = checkUserAuthorization(member, []);
    if (!auth.authorized && !member.permissions?.has?.(PermissionFlagsBits.Administrator) && interaction.guild.ownerId !== member.id) {
      const msg = '⚠️ Only Server Administrators or the Server Owner can access the installation and permission setup panel.';
      if (interaction.deferred) {
        return await interaction.editReply({ content: msg, embeds: [], components: [] });
      }
      return await interaction.reply({ content: msg, ephemeral: true });
    }

    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: false });
    }

    const audit = await PermissionAuditService.auditGuild(interaction.guild);
    const payload = this.buildSetupPayload(interaction.guild, audit);

    return await interaction.editReply(payload);
  }

  /**
   * Dispatches and handles interactive setup buttons and select menus.
   */
  static async handleInteraction(interaction) {
    if (!interaction.customId || !interaction.customId.startsWith('setup:')) {
      return false;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: 'Setup interactions must be used within a server.', ephemeral: true }).catch(() => {});
      return true;
    }

    // Strict Authorization Verification
    const member = interaction.member;
    const isOwner = guild.ownerId === member.id;
    const isAdmin = Boolean(member.permissions?.has?.(PermissionFlagsBits.Administrator));

    if (!isOwner && !isAdmin) {
      await interaction.reply({
        content: '🛑 **Access Denied:** Only Server Administrators or the Server Owner can modify bot setup configuration.',
        ephemeral: true
      }).catch(() => {});
      return true;
    }

    const action = interaction.customId.replace('setup:', '');

    try {
      if (action === 'recheck') {
        await interaction.deferUpdate();
        const audit = await PermissionAuditService.auditGuild(guild);
        this.updateState(guild.id, { lastAuditStatus: audit.overallStatus });
        const payload = this.buildSetupPayload(guild, audit);
        await interaction.editReply(payload);

        const statusNote = audit.hasAdministrator
          ? '✅ Permissions verified: Full Administrator is active!'
          : audit.overallStatus === 'ready'
            ? '✅ Permissions verified: All recommended permissions active!'
            : `⚠️ Permissions rechecked: Missing ${audit.missingRecommended.length} recommended permissions.`;

        await interaction.followUp({ content: statusNote, ephemeral: true }).catch(() => {});
        return true;
      }

      if (action === 'features') {
        const state = this.getState(guild.id);
        const feat = state.featureSettings || {};

        const featureMenu = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('setup:toggle_feature')
            .setPlaceholder('Select a module to toggle enabled/disabled status...')
            .addOptions([
              new StringSelectMenuOptionBuilder()
                .setLabel(`Moderation & Auto-Mute: ${feat.moderation !== false ? 'ENABLED' : 'DISABLED'}`)
                .setDescription('Kick, ban, timeouts, anti-spam, and honeypot guards')
                .setValue('moderation')
                .setEmoji(feat.moderation !== false ? '🛡️' : '⚪'),
              new StringSelectMenuOptionBuilder()
                .setLabel(`Voice & Music Service: ${feat.music !== false ? 'ENABLED' : 'DISABLED'}`)
                .setDescription('Voice channel audio playback and DJ controls')
                .setValue('music')
                .setEmoji(feat.music !== false ? '🎵' : '⚪'),
              new StringSelectMenuOptionBuilder()
                .setLabel(`Moderation Logging: ${feat.logging !== false ? 'ENABLED' : 'DISABLED'}`)
                .setDescription('Audit log attribution and mod-log channels')
                .setValue('logging')
                .setEmoji(feat.logging !== false ? '📜' : '⚪'),
              new StringSelectMenuOptionBuilder()
                .setLabel(`Interactive Ticket System: ${feat.tickets !== false ? 'ENABLED' : 'DISABLED'}`)
                .setDescription('Persistent ticket panel and private ticket channels')
                .setValue('tickets')
                .setEmoji(feat.tickets !== false ? '🎫' : '⚪')
            ])
        );

        const backRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('setup:recheck')
            .setLabel('Back to Setup Overview')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('⬅️')
        );

        const featureEmbed = new EmbedBuilder()
          .setColor(0xE5A93C)
          .setTitle('⚙️ Configure Optional Modules')
          .setDescription(
            'Enable or disable specific Honey Bot modules for this server. Disabling unused modules removes their permission requirements from audits.\n\n' +
            `• **Moderation:** ${feat.moderation !== false ? '🟢 Enabled' : '🔴 Disabled'}\n` +
            `• **Voice & Music:** ${feat.music !== false ? '🟢 Enabled' : '🔴 Disabled'}\n` +
            `• **Moderation Logging:** ${feat.logging !== false ? '🟢 Enabled' : '🔴 Disabled'}\n` +
            `• **Interactive Tickets:** ${feat.tickets !== false ? '🟢 Enabled' : '🔴 Disabled'}`
          );

        await interaction.update({ embeds: [featureEmbed], components: [featureMenu, backRow] });
        return true;
      }

      if (action === 'toggle_feature' && interaction.isStringSelectMenu()) {
        const selected = interaction.values[0];
        const state = this.getState(guild.id);
        const currentFeat = state.featureSettings || {};
        const newVal = currentFeat[selected] === false ? true : false;
        currentFeat[selected] = newVal;

        this.updateState(guild.id, { featureSettings: currentFeat });

        // Update in GuildConfigService as well
        try {
          const gConf = GuildConfigService.getConfig(guild.id);
          if (gConf?.featureSettings) {
            if (selected === 'music') gConf.featureSettings.musicEnabled = newVal;
            if (selected === 'moderation') gConf.featureSettings.moderationEnabled = newVal;
            if (selected === 'logging') gConf.featureSettings.loggingEnabled = newVal;
            GuildConfigService.updateConfig(guild.id, gConf, member.id, member.user?.tag || 'Admin');
          }
        } catch {}

        // Re-audit and return updated overview
        const audit = await PermissionAuditService.auditGuild(guild);
        const payload = this.buildSetupPayload(guild, audit);
        await interaction.update(payload);
        return true;
      }

      if (action === 'guide') {
        const guideEmbed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle('📖 Honey Bot — Complete Setup & Security Guide')
          .setDescription(
            '### 1. Discord Role Hierarchy Rule\n' +
            'Discord strictly enforces that bots **cannot modify, delete, or assign roles positioned higher than their own**.\n' +
            '• Go to **Server Settings > Roles**.\n' +
            '• Drag **@Honey Bot** above any roles it needs to manage (e.g. Member, Verified, VIP).\n\n' +
            '### 2. Administrator vs Recommended Permissions\n' +
            '• **Administrator:** Simplest installation. Bypasses channel overwrites and individual permission toggles.\n' +
            '• **Recommended (Least-Privilege):** Grants only the 21 specific Discord permissions required for Honey\'s advertised features.\n\n' +
            '### 3. Privileged Gateway Intents\n' +
            'In the [Discord Developer Portal](https://discord.com/developers/applications):\n' +
            '• **Server Members Intent:** Enables member hierarchy checks, kick/ban, and role menus.\n' +
            '• **Message Content Intent:** Enables anti-spam channel guards and natural-language commands.\n\n' +
            '### 4. Need to re-open setup later?\n' +
            'Type `/go prompt: setup` or `/diagnose prompt: permissions` anytime.'
          );

        await interaction.reply({ embeds: [guideEmbed], ephemeral: true });
        return true;
      }

      if (action === 'complete') {
        await interaction.deferUpdate();
        this.updateState(guild.id, {
          completed: true,
          completedAt: new Date().toISOString(),
          completedBy: member.user?.tag || member.id
        });

        const successEmbed = new EmbedBuilder()
          .setColor(0x57F287)
          .setTitle('✅ Honey Bot Setup Complete!')
          .setDescription(
            `Installation and authorization for **${guild.name}** have been marked complete by <@${member.id}>.\n\n` +
            '### Available Next Steps\n' +
            '• **Open Dashboard:** `/go prompt: display bot dashboard`\n' +
            '• **Run Server Audit:** `/diagnose`\n' +
            '• **Setup Modlogs:** `/go prompt: set up modlog in #mod-logs`\n' +
            '• **Ask for Help:** `/help`'
          )
          .setFooter({ text: 'You can re-open setup anytime using /go prompt: setup' });

        const doneRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('setup:recheck')
            .setLabel('Re-open Setup')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('⚙️'),
          new ButtonBuilder()
            .setCustomId('dash:overview')
            .setLabel('Open Server Dashboard')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('📊')
        );

        await interaction.editReply({ embeds: [successEmbed], components: [doneRow] });
        return true;
      }

      return false;
    } catch (err) {
      logger.error('Error handling setup interaction', { action, error: err.message });
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ An error occurred while processing setup.', ephemeral: true }).catch(() => {});
      }
      return true;
    }
  }
}
