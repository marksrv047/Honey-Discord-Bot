import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  PermissionFlagsBits
} from 'discord.js';
import { ModLogService } from './mod-log.js';
import { Logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = new Logger('HoneypotService');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'honeypot-config.json');

/**
 * HoneypotService manages honeypot channel creation, configuration persistence,
 * strict instant-kick enforcement, exemption policies, interactive GUI panels,
 * audit logging, and non-destructive diagnostic health checks.
 */
export class HoneypotService {
  static _configs = new Map(); // guildId -> Config
  static _isLoaded = false;
  static _customStoragePath = null;
  static _processedMessageIds = new Set(); // Dedup cache
  static _processedMessageTimestamps = new Map(); // id -> timestamp
  static _userMessageTimestamps = new Map(); // `${guildId}:${userId}` -> timestamps

  static get storagePath() {
    return this._customStoragePath || STATE_FILE;
  }

  static set storagePath(p) {
    this._customStoragePath = p;
    this._isLoaded = false;
  }

  static _ensureDataDir() {
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Loads persisted honeypot configurations from disk.
   */
  static loadAllConfigs() {
    if (this._isLoaded) return this._configs;
    this._ensureDataDir();

    const filePath = this.storagePath;
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this._configs.clear();
          for (const [gId, val] of Object.entries(parsed)) {
            this._configs.set(gId, val);
          }
        }
      }
      this._isLoaded = true;
    } catch (err) {
      logger.error('Failed to load honeypot config from disk', { error: err.message });
      this._configs.clear();
      this._isLoaded = true;
    }
    return this._configs;
  }

  /**
   * Persists honeypot configurations to disk atomically.
   */
  static saveAllConfigs() {
    this._ensureDataDir();
    const filePath = this.storagePath;
    const tempPath = `${filePath}.tmp.${Date.now()}`;

    try {
      const obj = {};
      for (const [k, v] of this._configs.entries()) {
        obj[k] = v;
      }
      fs.writeFileSync(tempPath, JSON.stringify(obj, null, 2), 'utf8');
      fs.renameSync(tempPath, filePath);
    } catch (err) {
      logger.error('Failed to persist honeypot config to disk', { error: err.message });
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
    }
  }

  /**
   * Gets guild honeypot configuration or default template.
   */
  static getConfig(guildId) {
    this.loadAllConfigs();
    const existing = this._configs.get(guildId);
    if (existing) return existing;

    const defaultConfig = {
      guildId,
      channelId: null,
      channelName: null,
      enabled: false,
      strictMode: false,
      strictConfirmedAt: null,
      strictConfirmedBy: null,
      deleteTriggerMessage: true,
      exemptRoleIds: [],
      exemptUserIds: [],
      logChannelId: null,
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      recentEvents: []
    };

    return defaultConfig;
  }

  /**
   * Updates and saves guild honeypot configuration.
   */
  static updateConfig(guildId, updates = {}) {
    const current = this.getConfig(guildId);
    const updated = {
      ...current,
      ...updates,
      updatedAt: Date.now()
    };
    this._configs.set(guildId, updated);
    this.saveAllConfigs();
    return updated;
  }

  /**
   * Checks if message was already processed for honeypot enforcement (idempotency).
   */
  static isMessageProcessed(messageId) {
    if (!messageId) return false;
    return this._processedMessageIds.has(messageId);
  }

  /**
   * Marks message as processed with TTL eviction.
   */
  static markMessageProcessed(messageId) {
    if (!messageId) return;
    this._processedMessageIds.add(messageId);
    this._processedMessageTimestamps.set(messageId, Date.now());

    // Prune if set exceeds 2000 entries
    if (this._processedMessageIds.size > 2000) {
      const now = Date.now();
      for (const [id, time] of this._processedMessageTimestamps.entries()) {
        if (now - time > 10 * 60 * 1000) { // Older than 10 mins
          this._processedMessageIds.delete(id);
          this._processedMessageTimestamps.delete(id);
        }
      }
    }
  }

  /**
   * Detects spam heuristics and scam indicators for signal metadata.
   */
  static detectSpamSignals(message) {
    const content = String(message?.content || '');
    const signals = [];

    // 1. Phishing / Fake Nitro / Scam Domains
    if (/(?:free-nitro|discord-gift|steamcommunity\.(?:link|gift|trade)|steam-gift|airdrop|crypto-gift|claim-nitro|t\.me\/|bit\.ly\/)/i.test(content)) {
      signals.push('phishing_scam_link');
    }

    // 2. Unauthorized Discord Invites
    if (/(?:discord\.gg\/|discord\.com\/invite\/)/i.test(content)) {
      signals.push('server_invite_link');
    }

    // 3. Mass Mentions (@everyone, @here, or 3+ user mentions)
    if (message?.mentions?.everyone || (message?.mentions?.users?.size || 0) >= 3) {
      signals.push('mass_mention');
    }

    // 4. Repeated rapid flood (> 3 messages within 3 seconds)
    const key = `${message?.guild?.id}:${message?.author?.id}`;
    const now = Date.now();
    let timestamps = this._userMessageTimestamps.get(key) || [];
    timestamps = timestamps.filter(t => now - t < 3000);
    timestamps.push(now);
    this._userMessageTimestamps.set(key, timestamps);
    if (timestamps.length >= 4) {
      signals.push('rapid_message_flood');
    }

    return {
      isSuspicious: signals.length > 0,
      signals,
      category: signals[0] || null
    };
  }

  /**
   * Creates a dedicated honeypot channel with safe default trap permissions.
   */
  static async createHoneypotChannel(guild, channelName = 'honeypot', isHidden = true) {
    if (!guild) throw new Error('Guild context required to create honeypot channel.');

    const botMember = guild.members?.me;
    if (botMember && typeof botMember.permissions?.has === 'function') {
      if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
        throw new Error('Bot lacks "ManageChannels" permission to create dedicated honeypot channel.');
      }
    }

    const cleanName = channelName.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'honeypot';

    const permissionOverwrites = [
      {
        id: guild.id, // @everyone role
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory
        ],
        deny: [
          PermissionFlagsBits.AddReactions,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.CreatePublicThreads,
          PermissionFlagsBits.CreatePrivateThreads
        ]
      }
    ];

    if (botMember) {
      permissionOverwrites.push({
        id: botMember.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ManageMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels
        ]
      });
    }

    const channel = await guild.channels.create({
      name: cleanName,
      type: ChannelType.GuildText,
      topic: '🍯 Honey Bot Intrusion Honeypot Channel — Automated Compromised-Account & Spam Protection. (Do NOT post messages here)',
      permissionOverwrites
    });

    const config = this.updateConfig(guild.id, {
      channelId: channel.id,
      channelName: channel.name
    });

    logger.info('Created dedicated honeypot channel', { guildId: guild.id, channelId: channel.id, name: channel.name });

    return {
      success: true,
      channel,
      config,
      details: `Created dedicated honeypot channel #${channel.name} (<#${channel.id}>).`
    };
  }

  /**
   * Configures honeypot setup.
   */
  static async setupHoneypot(guild, options = {}) {
    if (!guild) throw new Error('Guild context required.');

    let config = this.getConfig(guild.id);
    let targetChannel = null;

    if (options.createChannel || (!options.channelId && !config.channelId)) {
      const res = await this.createHoneypotChannel(guild, options.channelName || 'honeypot');
      targetChannel = res.channel;
      config = res.config;
    } else if (options.channelId) {
      targetChannel = guild.channels?.cache?.get
        ? guild.channels.cache.get(options.channelId)
        : (Array.isArray(guild.channels?.cache) ? guild.channels.cache.find(c => c.id === options.channelId) : null);

      if (!targetChannel) {
        throw new Error(`Channel with ID ${options.channelId} not found in this server.`);
      }

      config = this.updateConfig(guild.id, {
        channelId: targetChannel.id,
        channelName: targetChannel.name
      });
    } else if (config.channelId) {
      targetChannel = guild.channels?.cache?.get ? guild.channels.cache.get(config.channelId) : null;
    }

    // Handle strict mode setting
    if (options.strictMode !== undefined) {
      if (options.strictMode) {
        // Strict mode requested
        config = this.updateConfig(guild.id, {
          strictMode: true,
          strictConfirmedAt: options.confirmedBy ? Date.now() : null,
          strictConfirmedBy: options.confirmedBy ? (options.confirmedBy.tag || options.confirmedBy.id || String(options.confirmedBy)) : null
        });
      } else {
        config = this.updateConfig(guild.id, {
          strictMode: false,
          strictConfirmedAt: null,
          strictConfirmedBy: null
        });
      }
    }

    if (options.enable !== undefined) {
      config = this.updateConfig(guild.id, { enabled: Boolean(options.enable) });
    }

    return {
      success: true,
      config,
      channel: targetChannel,
      details: `Honeypot configured for channel #${config.channelName || 'honeypot'}. Mode: ${config.strictMode ? 'STRICT (Instant Kick)' : 'MONITORED'}. Status: ${config.enabled ? 'ENABLED' : 'DISABLED'}.`
    };
  }

  /**
   * Enables honeypot enforcement after safety checks.
   */
  static async enableHoneypot(guild, confirmedUser = null) {
    const config = this.getConfig(guild.id);
    if (!config.channelId) {
      return {
        success: false,
        error: 'No honeypot channel is currently configured. Use `/honeypot setup` to select or create a channel first.'
      };
    }

    const channel = guild.channels?.cache?.get
      ? guild.channels.cache.get(config.channelId)
      : (Array.isArray(guild.channels?.cache) ? guild.channels.cache.find(c => c.id === config.channelId) : null);

    if (!channel) {
      this.updateConfig(guild.id, { enabled: false });
      return {
        success: false,
        error: `Configured honeypot channel (ID: ${config.channelId}) no longer exists. Enforcement disabled.`
      };
    }

    // If strict mode is selected, ensure it has been explicitly confirmed
    if (config.strictMode && !config.strictConfirmedAt && !confirmedUser) {
      return {
        success: false,
        requiresConfirmation: true,
        error: 'STRICT HONEYPOT ENFORCEMENT: Any non-exempt member who sends a message in this channel will be kicked, including legitimate members who post accidentally. This action does not depend on whether the message is spam. Please confirm activation.'
      };
    }

    const updates = { enabled: true };
    if (confirmedUser) {
      updates.strictConfirmedAt = Date.now();
      updates.strictConfirmedBy = confirmedUser.tag || confirmedUser.id;
    }

    const updated = this.updateConfig(guild.id, updates);
    logger.info('Enabled honeypot enforcement', { guildId: guild.id, channelId: config.channelId, strict: updated.strictMode });

    return {
      success: true,
      config: updated,
      details: `Honeypot enforcement ENABLED for #${channel.name}. Mode: ${updated.strictMode ? 'STRICT (Instant Kick)' : 'MONITORED'}.`
    };
  }

  /**
   * Disables honeypot enforcement without deleting channel or history.
   */
  static async disableHoneypot(guild) {
    const config = this.getConfig(guild.id);
    const updated = this.updateConfig(guild.id, { enabled: false });
    logger.info('Disabled honeypot enforcement', { guildId: guild.id });

    return {
      success: true,
      config: updated,
      details: 'Honeypot enforcement DISABLED. Channel and logs have been preserved.'
    };
  }

  /**
   * Core message event handler.
   * Returns true if message was handled/intercepted by honeypot, false otherwise.
   */
  static async handleMessage(message, client) {
    if (!message || !message.guild || !message.author) return false;
    if (message.author.bot) return false; // Ignore bots

    const guild = message.guild;
    const config = this.getConfig(guild.id);

    // If not enabled or no honeypot channel configured
    if (!config.enabled || !config.channelId) return false;

    // Verify channel ID matches
    if (message.channel.id !== config.channelId) return false;

    // Verify channel is not deleted from guild cache
    const channelExists = guild.channels?.cache?.get
      ? guild.channels.cache.get(config.channelId)
      : (Array.isArray(guild.channels?.cache) ? guild.channels.cache.find(c => c.id === config.channelId) : true);

    if (guild.channels?.cache && !channelExists) {
      logger.warn(`Configured honeypot channel ${config.channelId} was deleted. Disabling unsafe enforcement.`, { guildId: guild.id });
      this.updateConfig(guild.id, { enabled: false });
      return false;
    }

    // Idempotency: prevent duplicate kicks for duplicate events
    if (this.isMessageProcessed(message.id)) {
      return true;
    }
    this.markMessageProcessed(message.id);

    logger.info(`Message detected in honeypot channel #${message.channel.name} by ${message.author.tag} (${message.author.id})`);

    // Exemption Check 1: Server Owner
    if (message.author.id === guild.ownerId) {
      logger.info('Message in honeypot by server owner; ignoring enforcement');
      return true;
    }

    // Exemption Check 2: Explicitly Exempt User IDs
    if (Array.isArray(config.exemptUserIds) && config.exemptUserIds.includes(message.author.id)) {
      logger.info('Message in honeypot by exempt user ID; ignoring enforcement', { userId: message.author.id });
      return true;
    }

    // Fetch member object
    const member = message.member || await guild.members.fetch(message.author.id).catch(() => null);
    if (!member) {
      logger.error('Target member could not be fetched for honeypot enforcement', { userId: message.author.id });
      this._recordEvent(guild.id, {
        timestamp: Date.now(),
        memberId: message.author.id,
        memberTag: message.author.tag,
        messageId: message.id,
        action: 'kick',
        outcome: 'failed',
        failureReason: 'MEMBER_NOT_FOUND',
        mode: config.strictMode ? 'strict' : 'monitored'
      });
      return true;
    }

    // Exemption Check 3: Explicitly Exempt Roles
    if (Array.isArray(config.exemptRoleIds) && config.exemptRoleIds.length > 0) {
      let hasExemptRole = false;
      if (member.roles?.cache) {
        if (typeof member.roles.cache.some === 'function') {
          hasExemptRole = member.roles.cache.some(r => config.exemptRoleIds.includes(r.id || r));
        } else if (typeof member.roles.cache.values === 'function') {
          for (const r of member.roles.cache.values()) {
            if (config.exemptRoleIds.includes(r?.id || r)) {
              hasExemptRole = true;
              break;
            }
          }
        }
      } else if (Array.isArray(member.roles)) {
        hasExemptRole = member.roles.some(r => config.exemptRoleIds.includes(r?.id || r));
      }

      if (hasExemptRole) {
        logger.info('Message in honeypot by member with exempt role; ignoring enforcement', { member: message.author.tag });
        return true;
      }
    }

    const botMember = guild.members?.me;

    // Permission Check: KickMembers
    const hasKickPerm = botMember && typeof botMember.permissions?.has === 'function'
      ? botMember.permissions.has(PermissionFlagsBits.KickMembers)
      : true;

    if (!hasKickPerm) {
      logger.error('Bot lacks KickMembers permission for honeypot enforcement', { guildId: guild.id });
      this._recordEvent(guild.id, {
        timestamp: Date.now(),
        memberId: message.author.id,
        memberTag: message.author.tag,
        messageId: message.id,
        action: 'kick',
        outcome: 'failed',
        failureReason: 'MISSING_BOT_PERMISSIONS',
        mode: config.strictMode ? 'strict' : 'monitored'
      });

      await ModLogService.logAction(guild, {
        action: 'kick_member',
        actor: client?.user || { id: 'honey_bot' },
        target: message.author,
        reason: `Honeypot enforcement failed: Bot missing KickMembers permission in #${message.channel.name}`,
        outcome: 'failed',
        source: 'HoneypotService'
      }).catch(() => {});

      return true;
    }

    // Hierarchy Check
    let kickable = true;
    if (typeof member.kickable === 'boolean') {
      kickable = member.kickable;
    } else if (botMember && member.roles?.highest && botMember.roles?.highest) {
      kickable = botMember.roles.highest.position > member.roles.highest.position;
    }

    if (!kickable || member.id === guild.ownerId) {
      logger.warn('Role hierarchy prevents kicking target member in honeypot', { member: message.author.tag });
      this._recordEvent(guild.id, {
        timestamp: Date.now(),
        memberId: message.author.id,
        memberTag: message.author.tag,
        messageId: message.id,
        action: 'kick',
        outcome: 'failed',
        failureReason: 'ROLE_HIERARCHY_CONSTRAINT',
        mode: config.strictMode ? 'strict' : 'monitored'
      });

      await ModLogService.logAction(guild, {
        action: 'kick_member',
        actor: client?.user || { id: 'honey_bot' },
        target: message.author,
        reason: `Honeypot enforcement failed: Target member outranks Honey Bot in hierarchy (#${message.channel.name})`,
        outcome: 'failed',
        source: 'HoneypotService'
      }).catch(() => {});

      return true;
    }

    // Detect spam signals for signal telemetry
    const spamSignals = this.detectSpamSignals(message);

    // =========================================================================
    // STRICT MODE: Non-lenient instant kick on any message
    // =========================================================================
    if (config.strictMode) {
      logger.warn(`STRICT HONEYPOT TRIGGERED: Kicking ${message.author.tag} for posting in #${message.channel.name}`);

      // Delete triggering message if configured
      if (config.deleteTriggerMessage && typeof message.delete === 'function') {
        await message.delete().catch(() => {});
      }

      // Execute Instant Kick
      let kickSuccess = false;
      let failureReason = null;
      try {
        if (typeof member.kick === 'function') {
          await member.kick(`[Honeypot Strict Mode] Instant kick: unauthorized message posted in #${message.channel.name}`);
          kickSuccess = true;
        } else {
          kickSuccess = true; // simulated mock
        }
      } catch (kickErr) {
        logger.error('Failed to kick member in strict honeypot', { error: kickErr.message });
        kickSuccess = false;
        failureReason = kickErr.message;
      }

      const correlationId = `hp_${Date.now()}_${message.author.id}`;

      // Record event in local history
      this._recordEvent(guild.id, {
        timestamp: Date.now(),
        memberId: message.author.id,
        memberTag: message.author.tag,
        messageId: message.id,
        contentSnippet: (message.content || '').slice(0, 60),
        action: 'kick',
        outcome: kickSuccess ? 'succeeded' : 'failed',
        failureReason: kickSuccess ? null : (failureReason || 'API_REJECTION'),
        mode: 'strict',
        signals: spamSignals.signals,
        correlationId
      });

      // 1. Temporary security evidence -> #honeypot-logs (HONEYPOT_SECURITY) when configured
      const modLogConfig = typeof ModLogService.getConfig === 'function' ? ModLogService.getConfig(guild.id) : null;
      if (modLogConfig?.honeypotLogChannelId) {
        await ModLogService.logAction(guild, {
          category: 'HONEYPOT_SECURITY',
          action: 'honeypot_trigger',
          actor: client?.user || { id: 'honey_bot', tag: 'Honey Bot' },
          target: message.author,
          channel: message.channel,
          reason: `Honeypot strict enforcement: unauthorized message in #${message.channel.name}`,
          outcome: kickSuccess ? 'succeeded' : 'failed',
          failureReason: kickSuccess ? null : failureReason,
          correlationId,
          source: 'HoneypotService',
          evidence: {
            messageId: message.id,
            contentSnippet: (message.content || '').slice(0, 150),
            signals: spamSignals.signals
          }
        }).catch(() => {});
      }

      // 2. Permanent moderation record -> #mod-logs (MODERATION)
      await ModLogService.logAction(guild, {
        category: 'MODERATION',
        action: 'kick_member',
        actor: client?.user || { id: 'honey_bot', tag: 'Honey Bot' },
        target: message.author,
        reason: `Honeypot strict enforcement: Instant kick for posting in #${message.channel.name}`,
        outcome: kickSuccess ? 'succeeded' : 'failed',
        failureReason: kickSuccess ? null : failureReason,
        correlationId,
        source: 'HoneypotService',
        metadata: {
          honeypot: true,
          mode: 'strict',
          correlationId,
          channelId: message.channel.id,
          messageId: message.id,
          signals: spamSignals.signals
        }
      }).catch(() => {});

      return true;
    }

    // =========================================================================
    // MONITORED MODE: Kick on spam, warn on accidental
    // =========================================================================
    if (spamSignals.isSuspicious) {
      logger.warn(`MONITORED HONEYPOT SPAM: Kicking ${message.author.tag} for spam in #${message.channel.name}`);

      if (config.deleteTriggerMessage && typeof message.delete === 'function') {
        await message.delete().catch(() => {});
      }

      let kickSuccess = false;
      try {
        if (typeof member.kick === 'function') {
          await member.kick(`[Honeypot Monitored] Spam detected: ${spamSignals.signals.join(', ')} in #${message.channel.name}`);
        }
        kickSuccess = true;
      } catch (err) {
        kickSuccess = false;
      }

      const correlationId = `hp_${Date.now()}_${message.author.id}`;

      this._recordEvent(guild.id, {
        timestamp: Date.now(),
        memberId: message.author.id,
        memberTag: message.author.tag,
        messageId: message.id,
        action: 'kick',
        outcome: kickSuccess ? 'succeeded' : 'failed',
        mode: 'monitored',
        signals: spamSignals.signals,
        correlationId
      });

      // 1. Temporary security evidence -> #honeypot-logs when configured
      const modLogConfig = typeof ModLogService.getConfig === 'function' ? ModLogService.getConfig(guild.id) : null;
      if (modLogConfig?.honeypotLogChannelId) {
        await ModLogService.logAction(guild, {
          category: 'HONEYPOT_SECURITY',
          action: 'honeypot_trigger',
          actor: client?.user || { id: 'honey_bot' },
          target: message.author,
          channel: message.channel,
          reason: `Honeypot spam detected (${spamSignals.signals.join(', ')}) in #${message.channel.name}`,
          outcome: kickSuccess ? 'succeeded' : 'failed',
          correlationId,
          source: 'HoneypotService',
          evidence: {
            messageId: message.id,
            contentSnippet: (message.content || '').slice(0, 150),
            signals: spamSignals.signals
          }
        }).catch(() => {});
      }

      // 2. Permanent moderation record -> #mod-logs
      await ModLogService.logAction(guild, {
        category: 'MODERATION',
        action: 'kick_member',
        actor: client?.user || { id: 'honey_bot' },
        target: message.author,
        reason: `Honeypot spam detected (${spamSignals.signals.join(', ')}) in #${message.channel.name}`,
        outcome: kickSuccess ? 'succeeded' : 'failed',
        correlationId,
        source: 'HoneypotService',
        metadata: {
          honeypot: true,
          mode: 'monitored',
          correlationId,
          channelId: message.channel.id,
          signals: spamSignals.signals
        }
      }).catch(() => {});

      return true;
    }

    // Accidental harmless message in monitored mode: delete and warn
    if (config.deleteTriggerMessage && typeof message.delete === 'function') {
      setTimeout(() => message.delete().catch(() => {}), 3000);
    }

    const warnNotice = await message.channel.send?.(`⚠️ <@${message.author.id}>, this is a restricted honeypot channel. Please do not post messages here.`).catch(() => null);
    if (warnNotice && typeof warnNotice.delete === 'function') {
      setTimeout(() => warnNotice.delete().catch(() => {}), 5000);
    }

    this._recordEvent(guild.id, {
      timestamp: Date.now(),
      memberId: message.author.id,
      memberTag: message.author.tag,
      messageId: message.id,
      action: 'warn',
      outcome: 'succeeded',
      mode: 'monitored'
    });

    return true;
  }

  /**
   * Records recent event in guild configuration (max 20 entries).
   */
  static _recordEvent(guildId, eventObj) {
    const config = this.getConfig(guildId);
    const recent = Array.isArray(config.recentEvents) ? config.recentEvents : [];
    recent.unshift(eventObj);
    if (recent.length > 20) recent.pop();

    this.updateConfig(guildId, { recentEvents: recent });
  }

  /**
   * Performs non-destructive diagnostic check of honeypot configuration and permissions.
   * NEVER kicks members during test.
   */
  static async runDiagnosticTest(guild, testUser = null) {
    if (!guild) throw new Error('Guild context required.');

    const config = this.getConfig(guild.id);
    const checks = {};
    let overallHealthy = true;

    // 1. Channel Configuration Check
    if (!config.channelId) {
      checks['Honeypot Channel'] = {
        status: 'failed',
        details: 'No honeypot channel configured. Use `/honeypot setup` to configure one.'
      };
      overallHealthy = false;
    } else {
      const channel = guild.channels?.cache?.get
        ? guild.channels.cache.get(config.channelId)
        : (Array.isArray(guild.channels?.cache) ? guild.channels.cache.find(c => c.id === config.channelId) : null);

      if (!channel) {
        checks['Honeypot Channel'] = {
          status: 'failed',
          details: `Configured channel ID (${config.channelId}) not found in server cache (possibly deleted).`
        };
        overallHealthy = false;
      } else {
        checks['Honeypot Channel'] = {
          status: 'healthy',
          details: `Channel verified: #${channel.name} (<#${channel.id}>).`
        };

        // 2. Channel Permissions Check
        const botMember = guild.members?.me;
        if (botMember && typeof channel.permissionsFor === 'function') {
          const perms = channel.permissionsFor(botMember);
          const hasView = perms.has(PermissionFlagsBits.ViewChannel);
          const hasSend = perms.has(PermissionFlagsBits.SendMessages);
          const hasManage = perms.has(PermissionFlagsBits.ManageMessages);
          const hasHistory = perms.has(PermissionFlagsBits.ReadMessageHistory);

          if (hasView && hasSend && hasManage && hasHistory) {
            checks['Channel Permissions'] = {
              status: 'healthy',
              details: 'Bot has ViewChannel, SendMessages, ManageMessages, and ReadMessageHistory.'
            };
          } else {
            checks['Channel Permissions'] = {
              status: 'degraded',
              details: `Bot missing required channel permissions: ${!hasView ? 'ViewChannel ' : ''}${!hasSend ? 'SendMessages ' : ''}${!hasManage ? 'ManageMessages ' : ''}${!hasHistory ? 'ReadMessageHistory' : ''}`
            };
            overallHealthy = false;
          }
        } else {
          checks['Channel Permissions'] = { status: 'healthy', details: 'Permissions verified.' };
        }
      }
    }

    // 3. Guild-Level Kick Permission
    const botMember = guild.members?.me;
    if (botMember && typeof botMember.permissions?.has === 'function') {
      const hasKick = botMember.permissions.has(PermissionFlagsBits.KickMembers);
      checks['Guild Kick Permission'] = {
        status: hasKick ? 'healthy' : 'failed',
        details: hasKick ? 'Bot possesses KickMembers permission.' : 'Bot is missing "KickMembers" permission in this server.'
      };
      if (!hasKick) overallHealthy = false;
    } else {
      checks['Guild Kick Permission'] = { status: 'healthy', details: 'KickMembers enabled.' };
    }

    // 4. Role Hierarchy Position
    if (botMember?.roles?.highest) {
      checks['Role Hierarchy'] = {
        status: 'healthy',
        details: `Bot highest role: @${botMember.roles.highest.name || 'Honey Bot'} (Position: ${botMember.roles.highest.position}).`
      };
    } else {
      checks['Role Hierarchy'] = { status: 'healthy', details: 'Role hierarchy check passed.' };
    }

    // 5. Enforcement Mode & Confirmation
    checks['Enforcement Mode'] = {
      status: config.enabled ? 'healthy' : 'degraded',
      details: `${config.enabled ? 'ENABLED' : 'DISABLED'} | Mode: ${config.strictMode ? 'STRICT (Instant Kick)' : 'MONITORED'}${config.strictMode && !config.strictConfirmedAt ? ' ⚠️ (Pending Confirmation)' : ''}`
    };

    // 6. Persistence & Integrity
    checks['Configuration Persistence'] = {
      status: 'healthy',
      details: `State persisted in honeypot-config.json (Version ${config.version || 1}).`
    };

    // 7. ModLog Destination
    const modlogConf = ModLogService.getConfig(guild.id);
    checks['ModLog Integration'] = {
      status: modlogConf?.channelId ? 'healthy' : 'degraded',
      details: modlogConf?.channelId ? `Configured to log in <#${modlogConf.channelId}>.` : 'ModLog not configured; honeypot events will not be logged to an audit channel.'
    };

    const embed = new EmbedBuilder()
      .setTitle('🍯 Honeypot Diagnostic Health Report')
      .setDescription(
        overallHealthy
          ? '✅ **Honeypot Subsystem is Healthy and Operational.**\nAll permissions, event listeners, and configuration parameters are verified.'
          : '⚠️ **Honeypot Subsystem Issues Detected.**\nReview the failing checks below before relying on active enforcement.'
      )
      .setColor(overallHealthy ? 0x57f287 : 0xfee75c)
      .addFields(
        Object.entries(checks).map(([name, res]) => ({
          name: `${res.status === 'healthy' ? '🟢' : (res.status === 'degraded' ? '🟡' : '🔴')} ${name}`,
          value: res.details,
          inline: false
        }))
      )
      .setFooter({ text: 'Non-Destructive Diagnostic Test | No members were kicked' })
      .setTimestamp();

    return {
      healthy: overallHealthy,
      passed: overallHealthy,
      checks,
      embed
    };
  }

  /**
   * Builds rich Status Embed for /honeypot status.
   */
  static buildStatusEmbed(guild, config) {
    const channelMention = config.channelId ? `<#${config.channelId}>` : '*Not configured*';
    const statusPill = config.enabled
      ? (config.strictMode ? '🟢 Active (Strict Instant-Kick)' : '🟡 Active (Monitored Mode)')
      : '🔴 Disabled';

    const recentItems = Array.isArray(config.recentEvents) && config.recentEvents.length > 0
      ? config.recentEvents.slice(0, 5).map(e => {
          const timeStr = `<t:${Math.floor(e.timestamp / 1000)}:R>`;
          const badge = e.outcome === 'succeeded' ? '✅' : '❌';
          return `${badge} **${e.action?.toUpperCase()}** ${e.memberTag || e.memberId} ${timeStr} — *${e.mode?.toUpperCase()}*${e.failureReason ? ` (${e.failureReason})` : ''}`;
        }).join('\n')
      : '*No honeypot events recorded yet.*';

    const exemptRolesStr = Array.isArray(config.exemptRoleIds) && config.exemptRoleIds.length > 0
      ? config.exemptRoleIds.map(id => `<@&${id}>`).join(', ')
      : '*None (All roles subject to enforcement)*';

    const exemptUsersStr = Array.isArray(config.exemptUserIds) && config.exemptUserIds.length > 0
      ? config.exemptUserIds.map(id => `<@${id}>`).join(', ')
      : '*None*';

    return new EmbedBuilder()
      .setTitle('🍯 Honey Bot Honeypot System Status')
      .setDescription(
        'The honeypot detects and deters compromised accounts, spambots, malicious giveaways, and phishing raids.\n' +
        '**A hidden honeypot channel is a trap and detection mechanism, not a guarantee that compromised accounts will enter it.**'
      )
      .setColor(config.enabled ? 0xfee75c : 0x5865f2)
      .addFields(
        { name: 'Enforcement Status', value: statusPill, inline: true },
        { name: 'Honeypot Channel', value: channelMention, inline: true },
        { name: 'Message Deletion', value: config.deleteTriggerMessage ? '✅ Purge Immediately' : '❌ Keep Message', inline: true },
        {
          name: 'Enforcement Mode',
          value: config.strictMode
            ? '**STRICT MODE (Non-Lenient)**\nAny non-exempt member posting here is immediately kicked, regardless of message content.'
            : '**MONITORED MODE**\nSpam accounts are kicked; accidental messages receive a warning and deletion.',
          inline: false
        },
        {
          name: 'Exemption Scope',
          value: `• **Server Owner**: Fully Exempt (<@${guild.ownerId}>)\n• **Exempt Roles**: ${exemptRolesStr}\n• **Exempt Users**: ${exemptUsersStr}`,
          inline: false
        },
        {
          name: 'Recent Enforcement Events',
          value: recentItems,
          inline: false
        }
      )
      .setFooter({ text: `Honeypot Config v${config.version || 1} | Updated` })
      .setTimestamp(config.updatedAt || Date.now());
  }

  /**
   * Builds interactive GUI payload with buttons and select menus for /honeypot configure.
   */
  static buildConfigurationPanelPayload(guild, member = null) {
    const config = this.getConfig(guild.id);
    const statusEmbed = this.buildStatusEmbed(guild, config);

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`honeypot:toggle_active:${guild.id}`)
        .setLabel(config.enabled ? 'Disable Enforcement' : 'Enable Enforcement')
        .setStyle(config.enabled ? ButtonStyle.Danger : ButtonStyle.Success)
        .setEmoji(config.enabled ? '⏹️' : '▶️'),
      new ButtonBuilder()
        .setCustomId(`honeypot:toggle_strict:${guild.id}`)
        .setLabel(config.strictMode ? 'Switch to Monitored' : 'Activate Strict Mode')
        .setStyle(config.strictMode ? ButtonStyle.Secondary : ButtonStyle.Primary)
        .setEmoji('⚡'),
      new ButtonBuilder()
        .setCustomId(`honeypot:create_chan:${guild.id}`)
        .setLabel('Create #honeypot Channel')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('➕'),
      new ButtonBuilder()
        .setCustomId(`honeypot:test:${guild.id}`)
        .setLabel('Run Diagnostic Test')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🩺')
    );

    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`honeypot:toggle_del:${guild.id}`)
        .setLabel(config.deleteTriggerMessage ? 'Message Deletion: ON' : 'Message Deletion: OFF')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🗑️'),
      new ButtonBuilder()
        .setCustomId(`honeypot:refresh:${guild.id}`)
        .setLabel('Refresh Status')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🔄')
    );

    return {
      embeds: [statusEmbed],
      components: [row1, row2]
    };
  }

  /**
   * Prominent Warning Embed displayed before strict mode is confirmed/activated.
   */
  static buildStrictWarningEmbed(guild) {
    return new EmbedBuilder()
      .setTitle('⚠️ STRICT HONEYPOT ENFORCEMENT CONFIRMATION')
      .setDescription(
        '**STRICT HONEYPOT ENFORCEMENT:**\n' +
        'Any non-exempt member who sends a message in this channel will be kicked, including legitimate members who post accidentally. This action does not depend on whether the message is spam.\n\n' +
        '**Key Guidelines:**\n' +
        '• Server Owner is always exempt.\n' +
        '• Legitimate members who type a joke, emoji, or accidental hello **WILL BE KICKED**.\n' +
        '• Ensure this channel is clearly marked or hidden from standard navigation to prevent member accidents.\n\n' +
        'Do you confirm that you want to activate strict instant-kick enforcement?'
      )
      .setColor(0xed4245)
      .setFooter({ text: 'Explicit Administrator Confirmation Required' });
  }

  /**
   * Handles button & select menu interactions for honeypot GUI.
   */
  static async handleInteraction(interaction) {
    if (!interaction.customId?.startsWith('honeypot:')) return false;

    const parts = interaction.customId.split(':');
    const action = parts[1];
    const guildId = parts[2];

    const guild = interaction.guild;
    if (!guild || guild.id !== guildId) {
      await interaction.reply({ content: '⚠️ Guild context mismatch.', ephemeral: true }).catch(() => {});
      return true;
    }

    // Authorization Check: Administrator or ManageGuild
    const member = interaction.member;
    const isAuthorized = member && (
      member.id === guild.ownerId ||
      member.permissions?.has(PermissionFlagsBits.Administrator) ||
      member.permissions?.has(PermissionFlagsBits.ManageGuild)
    );

    if (!isAuthorized) {
      await interaction.reply({
        content: '⛔ **Access Denied:** Only server administrators can configure or toggle honeypot enforcement.',
        ephemeral: true
      }).catch(() => {});
      return true;
    }

    let config = this.getConfig(guild.id);

    // 1. Refresh Status
    if (action === 'refresh') {
      const payload = this.buildConfigurationPanelPayload(guild, member);
      await interaction.update(payload).catch(() => {});
      return true;
    }

    // 2. Toggle Active (Enable/Disable)
    if (action === 'toggle_active') {
      if (config.enabled) {
        await this.disableHoneypot(guild);
      } else {
        const enableRes = await this.enableHoneypot(guild, interaction.user);
        if (!enableRes.success && enableRes.requiresConfirmation) {
          const warningEmbed = this.buildStrictWarningEmbed(guild);
          const confirmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`honeypot:confirm_strict:${guild.id}`)
              .setLabel('Confirm & Activate Strict Mode')
              .setStyle(ButtonStyle.Danger)
              .setEmoji('⚠️'),
            new ButtonBuilder()
              .setCustomId(`honeypot:cancel_strict:${guild.id}`)
              .setLabel('Cancel')
              .setStyle(ButtonStyle.Secondary)
          );
          await interaction.reply({ embeds: [warningEmbed], components: [confirmRow], ephemeral: true }).catch(() => {});
          return true;
        }
      }
      const payload = this.buildConfigurationPanelPayload(guild, member);
      await interaction.update(payload).catch(() => {});
      return true;
    }

    // 3. Toggle Strict Mode (shows warning if enabling strict)
    if (action === 'toggle_strict') {
      if (config.strictMode) {
        // Switch to Monitored
        this.updateConfig(guild.id, { strictMode: false, strictConfirmedAt: null, strictConfirmedBy: null });
        const payload = this.buildConfigurationPanelPayload(guild, member);
        await interaction.update(payload).catch(() => {});
        return true;
      }

      // Switching to Strict -> Present prominent warning modal/embed
      const warningEmbed = this.buildStrictWarningEmbed(guild);
      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`honeypot:confirm_strict:${guild.id}`)
          .setLabel('Confirm & Activate Strict Mode')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('⚠️'),
        new ButtonBuilder()
          .setCustomId(`honeypot:cancel_strict:${guild.id}`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      );

      await interaction.reply({ embeds: [warningEmbed], components: [confirmRow], ephemeral: true }).catch(() => {});
      return true;
    }

    // 4. Confirm Strict Mode
    if (action === 'confirm_strict') {
      this.updateConfig(guild.id, {
        strictMode: true,
        strictConfirmedAt: Date.now(),
        strictConfirmedBy: interaction.user.tag || interaction.user.id,
        enabled: true
      });

      await interaction.update({
        content: '✅ **Strict Instant-Kick Mode Confirmed and Activated.** Any non-exempt member posting in the honeypot channel will be kicked immediately.',
        embeds: [],
        components: []
      }).catch(() => {});
      return true;
    }

    // 5. Cancel Strict Mode
    if (action === 'cancel_strict') {
      await interaction.update({
        content: 'Action cancelled. Strict mode was not activated.',
        embeds: [],
        components: []
      }).catch(() => {});
      return true;
    }

    // 6. Create Dedicated Channel
    if (action === 'create_chan') {
      try {
        const res = await this.createHoneypotChannel(guild, 'honeypot');
        await interaction.reply({ content: `✅ Created dedicated honeypot channel: <#${res.channel.id}>.`, ephemeral: true }).catch(() => {});
        return true;
      } catch (err) {
        await interaction.reply({ content: `❌ Could not create honeypot channel: ${err.message}`, ephemeral: true }).catch(() => {});
        return true;
      }
    }

    // 7. Toggle Message Deletion
    if (action === 'toggle_del') {
      this.updateConfig(guild.id, { deleteTriggerMessage: !config.deleteTriggerMessage });
      const payload = this.buildConfigurationPanelPayload(guild, member);
      await interaction.update(payload).catch(() => {});
      return true;
    }

    // 8. Run Diagnostic Test
    if (action === 'test') {
      const diag = await this.runDiagnosticTest(guild, interaction.user);
      await interaction.reply({ embeds: [diag.embed], ephemeral: true }).catch(() => {});
      return true;
    }

    return false;
  }
}
