import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChannelType, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import {
  ActionRegistry,
  FunctionalCategory,
  EventSource,
  OutcomeState,
  VerificationStatus
} from './action-registry.js';
import { HoneypotRetentionService } from './honeypot-retention.js';
import { Logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = new Logger('ModLogService');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'modlog-config.json');

/**
 * Three Authoritative Logging Categories
 */
export const LogCategory = {
  MODERATION: 'MODERATION',
  HONEYPOT_SECURITY: 'HONEYPOT_SECURITY',
  BOT_OPERATIONS: 'BOT_OPERATIONS'
};

/**
 * Centralized Moderation Logging & Configuration Service.
 * - Per-guild persistent storage (isolated, safe atomic write)
 * - Strict channel validation & permission auditing
 * - Immutable moderation logging pipeline for all actions (/go, /undo, external)
 * - Automatic deduplication against gateway audit-log events
 */
export class ModLogService {
  static _configCache = null;
  static _recentActionSignatures = new Map(); // signature -> timestamp (TTL 15s)

  /**
   * Initializes data directory and loads configuration cache.
   */
  static _ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  /**
   * Loads all guild configurations from disk.
   */
  static loadAllConfigs() {
    ModLogService._ensureDataDir();
    if (!fs.existsSync(CONFIG_FILE)) {
      ModLogService._configCache = {};
      return ModLogService._configCache;
    }

    try {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      ModLogService._configCache = JSON.parse(data);
    } catch (err) {
      logger.error('Failed to parse modlog-config.json, initializing fresh cache', { error: err.message });
      ModLogService._configCache = {};
    }
    return ModLogService._configCache;
  }

  /**
   * Saves configurations atomically to disk.
   */
  static _persistConfigs() {
    ModLogService._ensureDataDir();
    const tempFile = `${CONFIG_FILE}.tmp.${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const payload = JSON.stringify(ModLogService._configCache || {}, null, 2);
    try {
      fs.writeFileSync(tempFile, payload, 'utf8');
      fs.renameSync(tempFile, CONFIG_FILE);
    } catch (err) {
      try {
        fs.writeFileSync(CONFIG_FILE, payload, 'utf8');
      } catch (writeErr) {
        logger.error('Failed to write modlog-config.json', { error: writeErr.message });
      }
    } finally {
      if (fs.existsSync(tempFile)) {
        try {
          fs.unlinkSync(tempFile);
        } catch {}
      }
    }
  }

  /**
   * Retrieves configuration for a specific guild.
   */
  static getConfig(guildId) {
    if (!guildId) return null;
    if (!ModLogService._configCache) {
      ModLogService.loadAllConfigs();
    }

    const defaultPreferences = {
      logBotActions: true,
      logExternalActions: true,
      filterEvents: [
        'all',
        'moderation',
        'roles',
        'channels',
        'categories',
        'permissions',
        'policy',
        'music',
        'messaging',
        'panels',
        'diagnostics',
        'recovery',
        'utilities'
      ],
      logSuccess: true,
      logFailed: true,
      logDenied: true
    };

    const conf = ModLogService._configCache[guildId] || {};
    const modLogChannelId = conf.modLogChannelId || conf.channelId || null;
    const modLogChannelName = conf.modLogChannelName || conf.channelName || null;

    return {
      guildId,
      channelId: modLogChannelId, // backward-compatible alias to modLogChannelId
      channelName: modLogChannelName,
      modLogChannelId,
      modLogChannelName,
      honeypotLogChannelId: conf.honeypotLogChannelId || null,
      honeypotLogChannelName: conf.honeypotLogChannelName || null,
      botLogChannelId: conf.botLogChannelId || null,
      botLogChannelName: conf.botLogChannelName || null,
      honeypotRetentionHours: conf.honeypotRetentionHours === 48 ? 48 : 24,
      enabled: conf.enabled !== undefined ? conf.enabled : false,
      revision: conf.revision || 1,
      setupStatus: conf.setupStatus || (modLogChannelId && conf.enabled ? 'configured' : 'unconfigured'),
      updatedAt: conf.updatedAt || null,
      updatedBy: conf.updatedBy || null,
      preferences: {
        ...defaultPreferences,
        ...(conf.preferences || {})
      },
      lastDeliverySuccess: conf.lastDeliverySuccess || null,
      lastDeliveryFailure: conf.lastDeliveryFailure || null,
      pendingDeliveries: conf.pendingDeliveries || [],
      deliveredCount: conf.deliveredCount || 0,
      failedCount: conf.failedCount || 0
    };
  }

  /**
   * Updates configuration for a specific guild.
   */
  static updateConfig(guildId, updates = {}) {
    if (!guildId) throw new Error('guildId is required to update modlog config');
    if (!ModLogService._configCache) {
      ModLogService.loadAllConfigs();
    }

    const current = ModLogService.getConfig(guildId);
    
    // Synchronize legacy channelId with modLogChannelId
    const effectiveModChannelId = updates.modLogChannelId || updates.channelId || current.modLogChannelId || current.channelId;
    const effectiveModChannelName = updates.modLogChannelName || updates.channelName || current.modLogChannelName || current.channelName;

    const updated = {
      ...current,
      ...updates,
      channelId: effectiveModChannelId,
      channelName: effectiveModChannelName,
      modLogChannelId: effectiveModChannelId,
      modLogChannelName: effectiveModChannelName,
      preferences: {
        ...current.preferences,
        ...(updates.preferences || {})
      },
      revision: (current.revision || 1) + 1,
      guildId,
      updatedAt: new Date().toISOString()
    };

    ModLogService._configCache[guildId] = updated;
    ModLogService._persistConfigs();
    logger.info('Updated modlog configuration', { guildId, channelId: updated.channelId, enabled: updated.enabled, revision: updated.revision });
    return updated;
  }

  /**
   * Validates whether a channel can be used for moderation logging.
   */
  static async validateLogChannel(guild, channelRef) {
    if (!guild) {
      return { valid: false, channel: null, error: 'No guild context provided.' };
    }

    // Resolve channel from ID, mention, or name
    let channel = null;
    const cleanRef = String(channelRef || '').trim();

    if (/^\d{17,20}$/.test(cleanRef)) {
      channel = guild.channels?.cache?.get?.(cleanRef) || await guild.channels?.fetch?.(cleanRef).catch(() => null);
    } else if (/^<#(\d{17,20})>$/.test(cleanRef)) {
      const id = cleanRef.match(/^<#(\d+)>$/)[1];
      channel = guild.channels?.cache?.get?.(id) || await guild.channels?.fetch?.(id).catch(() => null);
    } else if (guild.channels?.cache?.has?.(cleanRef)) {
      channel = guild.channels.cache.get(cleanRef);
    } else {
      const name = cleanRef.replace(/^#/, '').toLowerCase();
      if (typeof guild.channels?.cache?.find === 'function') {
        channel = guild.channels.cache.find(c => c.name?.toLowerCase() === name);
      } else if (guild.channels?.cache && typeof guild.channels.cache.values === 'function') {
        for (const c of guild.channels.cache.values()) {
          if (c.name?.toLowerCase() === name) {
            channel = c;
            break;
          }
        }
      }
    }

    if (!channel) {
      return { valid: false, channel: null, error: `Channel "${channelRef}" not found in this server.` };
    }

    // Check guild ownership
    if (channel.guildId !== guild.id) {
      return { valid: false, channel: null, error: `Channel #${channel.name} belongs to a different server.` };
    }

    // Check channel type: must be Text or Announcement
    const allowedTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
    if (!allowedTypes.includes(channel.type)) {
      return {
        valid: false,
        channel,
        error: `Channel #${channel.name} is not a text channel. Moderation logs require a text or announcement channel.`
      };
    }

    // Check bot permissions
    const botMember = guild.members?.me || await guild.members.fetchMe().catch(() => null);
    if (!botMember) {
      return { valid: false, channel, error: 'Could not resolve bot permissions in server.' };
    }

    const permissions = channel.permissionsFor(botMember);
    if (!permissions) {
      return { valid: false, channel, error: `Could not evaluate bot permissions in #${channel.name}.` };
    }

    const required = [
      { name: 'ViewChannel', flag: PermissionFlagsBits.ViewChannel },
      { name: 'SendMessages', flag: PermissionFlagsBits.SendMessages },
      { name: 'EmbedLinks', flag: PermissionFlagsBits.EmbedLinks }
    ];

    const missing = required.filter(p => !permissions.has(p.flag)).map(p => p.name);
    if (missing.length > 0) {
      return {
        valid: false,
        channel,
        error: `Bot lacks required permissions in #${channel.name}: ${missing.join(', ')}.`
      };
    }

    return { valid: true, channel, error: null };
  }

  /**
   * Sets and persists the moderation log channel for a guild.
   */
  static async setLogChannel(guild, channelRef, userTagOrId = 'System') {
    const current = ModLogService.getConfig(guild?.id);
    const validation = await ModLogService.validateLogChannel(guild, channelRef);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error,
        preservedChannelId: current?.channelId || null,
        preservedChannelName: current?.channelName || null
      };
    }

    const channel = validation.channel;
    const updated = ModLogService.updateConfig(guild.id, {
      channelId: channel.id,
      channelName: channel.name,
      enabled: true,
      updatedBy: userTagOrId
    });

    return { success: true, channel, config: updated };
  }

  /**
   * Sets the Moderation log channel (#mod-logs).
   */
  static async setModLogChannel(guild, channelRef, userTagOrId = 'System') {
    return ModLogService.setLogChannel(guild, channelRef, userTagOrId);
  }

  /**
   * Sets the Honeypot security log channel (#honeypot-logs).
   */
  static async setHoneypotLogChannel(guild, channelRef, userTagOrId = 'System') {
    const current = ModLogService.getConfig(guild?.id);
    const validation = await ModLogService.validateLogChannel(guild, channelRef);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error,
        preservedChannelId: current?.honeypotLogChannelId || null
      };
    }

    const channel = validation.channel;
    const updated = ModLogService.updateConfig(guild.id, {
      honeypotLogChannelId: channel.id,
      honeypotLogChannelName: channel.name,
      updatedBy: userTagOrId
    });

    return { success: true, channel, config: updated };
  }

  /**
   * Sets the Bot Operations log channel (#bot-logs).
   */
  static async setBotLogChannel(guild, channelRef, userTagOrId = 'System') {
    const current = ModLogService.getConfig(guild?.id);
    const validation = await ModLogService.validateLogChannel(guild, channelRef);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error,
        preservedChannelId: current?.botLogChannelId || null
      };
    }

    const channel = validation.channel;
    const updated = ModLogService.updateConfig(guild.id, {
      botLogChannelId: channel.id,
      botLogChannelName: channel.name,
      updatedBy: userTagOrId
    });

    return { success: true, channel, config: updated };
  }

  /**
   * Sets the Honeypot log retention period (24 or 48 hours).
   */
  static setHoneypotRetention(guildId, hours, userTagOrId = 'System') {
    const retention = Number(hours) === 48 ? 48 : 24;
    const updated = ModLogService.updateConfig(guildId, {
      honeypotRetentionHours: retention,
      updatedBy: userTagOrId
    });
    return { success: true, retentionHours: retention, config: updated };
  }

  /**
   * Returns a structured view of all three logging channels.
   */
  static getThreeChannelStatus(guild) {
    if (!guild) return null;
    const conf = ModLogService.getConfig(guild.id);
    return {
      guildId: guild.id,
      enabled: conf.enabled,
      channels: {
        moderation: {
          category: LogCategory.MODERATION,
          name: '#mod-logs',
          configuredId: conf.modLogChannelId || conf.channelId || null,
          configuredName: conf.modLogChannelName || conf.channelName || null,
          status: (conf.modLogChannelId || conf.channelId) ? 'configured' : 'unconfigured'
        },
        honeypot: {
          category: LogCategory.HONEYPOT_SECURITY,
          name: '#honeypot-logs',
          configuredId: conf.honeypotLogChannelId || null,
          configuredName: conf.honeypotLogChannelName || null,
          retentionHours: conf.honeypotRetentionHours || 24,
          status: conf.honeypotLogChannelId ? 'configured' : 'unconfigured'
        },
        botOperations: {
          category: LogCategory.BOT_OPERATIONS,
          name: '#bot-logs',
          configuredId: conf.botLogChannelId || null,
          configuredName: conf.botLogChannelName || null,
          status: conf.botLogChannelId ? 'configured' : 'unconfigured'
        }
      }
    };
  }

  /**
   * Creates a dedicated moderation logging channel with proper bot permissions and restrictive visibility.
   */
  static async createLogChannel(guild, options = {}) {
    const {
      channelName = 'mod-logs',
      isPrivate = true,
      userTagOrId = 'System',
      testDelivery = true
    } = options;

    if (!guild) {
      return { success: false, error: 'No guild context provided.' };
    }

    const botMember = guild.members?.me || await guild.members.fetchMe().catch(() => null);
    if (!botMember) {
      return { success: false, error: 'Could not resolve bot permissions in server.' };
    }

    if (!botMember.permissions?.has(PermissionFlagsBits.ManageChannels)) {
      return {
        success: false,
        error: 'Bot lacks ManageChannels permission to create a moderation log channel.'
      };
    }

    const overwrites = [
      {
        id: botMember.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ReadMessageHistory
        ]
      }
    ];

    if (isPrivate && guild.roles?.everyone) {
      overwrites.push({
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel]
      });
    }

    let channel = guild.channels?.cache?.find?.(
      c => c.name?.toLowerCase() === channelName.toLowerCase() && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
    );

    if (!channel) {
      try {
        channel = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          topic: 'Honey Bot Moderation & Administration Logs',
          permissionOverwrites: overwrites,
          reason: `Created mod-logs channel on request by ${userTagOrId}`
        });
      } catch (err) {
        logger.error('Failed to create moderation log channel', { error: err.message, guildId: guild.id });
        return {
          success: false,
          error: `Failed to create channel #${channelName}: ${err.message}`
        };
      }
    } else {
      try {
        await channel.permissionOverwrites.edit(botMember.id, {
          ViewChannel: true,
          SendMessages: true,
          EmbedLinks: true,
          ReadMessageHistory: true
        });
      } catch (err) {
        logger.warn('Could not update bot overwrites on existing channel', { error: err.message });
      }
    }

    const updated = ModLogService.updateConfig(guild.id, {
      channelId: channel.id,
      channelName: channel.name,
      enabled: true,
      setupStatus: 'configured',
      updatedBy: userTagOrId
    });

    const validation = await ModLogService.validateLogChannel(guild, channel.id);
    if (!validation.valid) {
      ModLogService.updateConfig(guild.id, { setupStatus: 'testing_failed' });
      return {
        success: false,
        channel,
        config: updated,
        error: `Channel was created but validation failed: ${validation.error}`
      };
    }

    let testResult = null;
    if (testDelivery) {
      testResult = await ModLogService.testLogChannel(guild);
      if (!testResult.success) {
        ModLogService.updateConfig(guild.id, { setupStatus: 'testing_failed' });
        return {
          success: false,
          channel,
          config: updated,
          deliverySuccess: false,
          error: `Channel was configured, but test entry delivery failed: ${testResult.error}`
        };
      }
    }

    return {
      success: true,
      channel,
      channelId: channel.id,
      created: true,
      tested: testResult ? testResult.success : true,
      config: updated,
      deliverySuccess: testResult ? testResult.success : true
    };
  }

  /**
   * Complete natural-language setup workflow for moderation logs.
   */
  static async setupModlogs(guild, options = {}) {
    const {
      channelRef = null,
      channelName = 'mod-logs',
      isPrivate = true,
      createIfMissing = false,
      userTagOrId = 'System',
      testDelivery = true
    } = options;

    if (!guild) {
      return { success: false, error: 'No guild context provided.' };
    }

    if (channelRef && channelRef !== 'auto' && channelRef !== 'create') {
      const setRes = await ModLogService.setLogChannel(guild, channelRef, userTagOrId);
      if (!setRes.success) {
        return {
          success: false,
          error: setRes.error,
          setupStatus: 'failed'
        };
      }

      if (testDelivery) {
        const testRes = await ModLogService.testLogChannel(guild);
        if (!testRes.success) {
          ModLogService.updateConfig(guild.id, { setupStatus: 'testing_failed' });
          return {
            success: false,
            channel: setRes.channel,
            config: setRes.config,
            deliverySuccess: false,
            error: `Configured channel #${setRes.channel?.name}, but test message delivery failed: ${testRes.error}`
          };
        }
      }

      return {
        success: true,
        channel: setRes.channel,
        channelId: setRes.channel.id,
        created: false,
        tested: testDelivery,
        config: setRes.config,
        deliverySuccess: true
      };
    }

    const existing = guild.channels?.cache?.find?.(
      c => (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) &&
           (c.name?.toLowerCase() === channelName.toLowerCase() || c.name?.toLowerCase() === 'mod-logs' || c.name?.toLowerCase() === 'moderation-logs')
    );

    if (existing && !createIfMissing) {
      return await ModLogService.setupModlogs(guild, {
        channelRef: existing.id,
        userTagOrId,
        testDelivery
      });
    }

    return await ModLogService.createLogChannel(guild, {
      channelName,
      isPrivate,
      userTagOrId,
      testDelivery
    });
  }

  /**
   * Updates moderation logging preferences (e.g. event filters, success/failure/denial filters).
   */
  static updatePreferences(guildId, preferencesUpdate = {}, userTagOrId = 'System') {
    const conf = ModLogService.getConfig(guildId);
    const updated = ModLogService.updateConfig(guildId, {
      preferences: {
        ...conf.preferences,
        ...preferencesUpdate
      },
      updatedBy: userTagOrId
    });
    return { success: true, config: updated };
  }

  /**
   * Enables moderation logging for a guild.
   */
  static async enableLogging(guild, userTagOrId = 'System') {
    const conf = ModLogService.getConfig(guild.id);
    if (!conf.channelId) {
      return {
        success: false,
        error: 'No moderation log channel has been configured. Please specify a channel first (e.g. "/modlog prompt: set #mod-logs as log channel").'
      };
    }

    const validation = await ModLogService.validateLogChannel(guild, conf.channelId);
    if (!validation.valid) {
      return {
        success: false,
        error: `Cannot enable logging: Configured channel #${conf.channelName || conf.channelId} is invalid: ${validation.error}`
      };
    }

    const updated = ModLogService.updateConfig(guild.id, {
      enabled: true,
      updatedBy: userTagOrId
    });

    return { success: true, channel: validation.channel, config: updated };
  }

  /**
   * Disables moderation logging for a guild while preserving the channel configuration.
   */
  static disableLogging(guildId, userTagOrId = 'System') {
    const conf = ModLogService.getConfig(guildId);
    const updated = ModLogService.updateConfig(guildId, {
      enabled: false,
      updatedBy: userTagOrId
    });

    return {
      success: true,
      config: updated,
      preservedChannelId: conf.channelId,
      preservedChannelName: conf.channelName
    };
  }

  /**
   * Tests a configured log channel by category.
   */
  static async testLogChannel(guild, category = LogCategory.MODERATION) {
    const conf = ModLogService.getConfig(guild.id);
    let targetChannelId = null;
    let title = 'Moderation Log Test';
    let color = 0xE5A93C;

    if (category === LogCategory.HONEYPOT_SECURITY) {
      targetChannelId = conf.honeypotLogChannelId || conf.channelId;
      title = 'Honeypot Security Log Test';
      color = 0xE74C3C;
    } else if (category === LogCategory.BOT_OPERATIONS) {
      targetChannelId = conf.botLogChannelId || conf.channelId;
      title = 'Honey Bot Operations Log Test';
      color = 0x3498DB;
    } else {
      targetChannelId = conf.modLogChannelId || conf.channelId;
    }

    if (!targetChannelId) {
      return { success: false, error: `No channel configured for category ${category}.`, category };
    }

    const validation = await ModLogService.validateLogChannel(guild, targetChannelId);
    if (!validation.valid) {
      ModLogService.updateConfig(guild.id, {
        lastDeliveryFailure: {
          timestamp: new Date().toISOString(),
          error: validation.error,
          category: 'validation_error'
        },
        failedCount: (conf.failedCount || 0) + 1
      });
      return { success: false, error: validation.error, channel: validation.channel, category };
    }

    const channel = validation.channel;
    try {
      const testEmbed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(`This is a test message to confirm Honey Bot can deliver ${category} records to this channel.`)
        .setColor(color)
        .addFields(
          { name: 'Category', value: category, inline: true },
          { name: 'Status', value: 'Delivery Verified', inline: true },
          { name: 'Permissions', value: 'View, Send & Embed OK', inline: true }
        )
        .setTimestamp();

      const sent = await channel.send({ embeds: [testEmbed] });
      ModLogService.updateConfig(guild.id, {
        lastDeliverySuccess: new Date().toISOString(),
        deliveredCount: (conf.deliveredCount || 0) + 1
      });
      return { success: true, channel, messageId: sent.id, category };
    } catch (err) {
      logger.error('Failed to send test mod-log message', { error: err.message, channelId: channel.id, category });
      ModLogService.updateConfig(guild.id, {
        lastDeliveryFailure: {
          timestamp: new Date().toISOString(),
          error: err.message,
          category: 'delivery_error'
        },
        failedCount: (conf.failedCount || 0) + 1
      });
      return { success: false, error: `Failed to deliver message to #${channel.name}: ${err.message}`, channel, category };
    }
  }

  /**
   * Tests all three logging destinations for a guild.
   */
  static async testAllChannels(guild) {
    if (!guild) return { success: false, error: 'No guild context' };
    const conf = ModLogService.getConfig(guild.id);
    const results = {
      moderation: await ModLogService.testLogChannel(guild, LogCategory.MODERATION),
      honeypot: conf.honeypotLogChannelId ? await ModLogService.testLogChannel(guild, LogCategory.HONEYPOT_SECURITY) : { success: false, error: 'Unconfigured' },
      botOperations: conf.botLogChannelId ? await ModLogService.testLogChannel(guild, LogCategory.BOT_OPERATIONS) : { success: false, error: 'Unconfigured' }
    };
    return {
      success: results.moderation.success || results.honeypot.success || results.botOperations.success,
      results
    };
  }

  /**
   * Enqueues an undelivered moderation log for subsequent retry.
   */
  static _enqueuePendingDelivery(guildId, actionData, errorMsg) {
    const conf = ModLogService.getConfig(guildId);
    const queue = Array.isArray(conf.pendingDeliveries) ? [...conf.pendingDeliveries] : [];
    queue.push({
      ...actionData,
      enqueuedAt: new Date().toISOString(),
      error: errorMsg
    });
    if (queue.length > 50) queue.shift();

    const category = errorMsg?.includes('Missing Permissions') ? 'permission_denied'
      : (errorMsg === 'channel_missing' ? 'channel_missing' : 'api_error');

    ModLogService.updateConfig(guildId, {
      pendingDeliveries: queue,
      lastDeliveryFailure: {
        timestamp: new Date().toISOString(),
        error: errorMsg,
        category
      },
      failedCount: (conf.failedCount || 0) + 1
    });
  }

  /**
   * Generates a unique deduplication signature for an action.
   */
  static _generateSignature(guildId, action, targetId) {
    return `${guildId}:${String(action).toLowerCase()}:${String(targetId || '').toLowerCase()}`;
  }

  /**
   * Records an executed action in the deduplication cache.
   */
  static recordActionSignature(guildId, action, targetId) {
    const sig = ModLogService._generateSignature(guildId, action, targetId);
    ModLogService._recentActionSignatures.set(sig, Date.now());

    // Purge expired signatures older than 15 seconds
    const cutoff = Date.now() - 15000;
    for (const [k, v] of ModLogService._recentActionSignatures.entries()) {
      if (v < cutoff) ModLogService._recentActionSignatures.delete(k);
    }
  }

  /**
   * Checks whether an action has already been logged recently by Honey Bot.
   */
  static isDeduplicated(guildId, action, targetId) {
    const sig = ModLogService._generateSignature(guildId, action, targetId);
    const timestamp = ModLogService._recentActionSignatures.get(sig);
    if (timestamp && Date.now() - timestamp < 15000) {
      return true;
    }
    return false;
  }

  /**
   * Retries delivering queued log records.
   */
  static async flushPendingDeliveries(guild) {
    if (!guild) return { flushed: 0, remaining: 0 };
    const conf = ModLogService.getConfig(guild.id);
    if (!conf.enabled || !conf.channelId || !conf.pendingDeliveries || conf.pendingDeliveries.length === 0) {
      return { flushed: 0, remaining: (conf.pendingDeliveries || []).length };
    }

    const channel = guild.channels?.cache?.get?.(conf.channelId) || await guild.channels?.fetch?.(conf.channelId).catch(() => null);
    if (!channel) return { flushed: 0, remaining: conf.pendingDeliveries.length };

    const queue = [...conf.pendingDeliveries];
    const remaining = [];
    let flushed = 0;

    for (const item of queue) {
      try {
        const embed = ModLogService.createModLogEmbed(item);
        await channel.send({ embeds: [embed] });
        flushed++;
      } catch (err) {
        remaining.push(item);
      }
    }

    ModLogService.updateConfig(guild.id, {
      pendingDeliveries: remaining,
      lastDeliverySuccess: flushed > 0 ? new Date().toISOString() : conf.lastDeliverySuccess,
      deliveredCount: (conf.deliveredCount || 0) + flushed
    });

    return { flushed, delivered: flushed, remaining: remaining.length };
  }

  /**
   * Retrieves pending log delivery records for a guild.
   */
  static getPendingDeliveries(guildId) {
    const conf = ModLogService.getConfig(guildId);
    return conf?.pendingDeliveries || [];
  }

  /**
   * Runs targeted diagnostics on mod-log configuration, channel access, and delivery health.
   */
  static async troubleshoot(guild, options = {}) {
    const { autoRepair = false, userTagOrId = 'System' } = options;
    if (!guild) {
      return { healthy: false, error: 'No guild context provided.' };
    }

    const conf = ModLogService.getConfig(guild.id);
    const findings = [];
    const repairs = [];

    // 1. Check destination configured
    if (!conf || !conf.channelId) {
      return {
        healthy: false,
        status: 'unconfigured',
        channel: null,
        findings: ['No moderation log channel is configured for this server.'],
        userMessage: 'No mod-log channel is configured for this server.',
        pendingCount: 0
      };
    }

    // 2. Check channel exists
    const channel = guild.channels?.cache?.get?.(conf.channelId) || await guild.channels?.fetch?.(conf.channelId).catch(() => null);
    if (!channel) {
      return {
        healthy: false,
        status: 'channel_missing',
        channel: null,
        findings: [`The configured log channel (ID: ${conf.channelId}) no longer exists in this server.`],
        userMessage: 'The configured log channel no longer exists. Configure a new destination using /modlog.',
        pendingCount: (conf.pendingDeliveries || []).length
      };
    }

    // 3. Check bot permissions
    const botMember = guild.members?.me || await guild.members.fetchMe().catch(() => null);
    const perms = channel.permissionsFor(botMember);
    const required = [
      { name: 'ViewChannel', flag: PermissionFlagsBits.ViewChannel },
      { name: 'SendMessages', flag: PermissionFlagsBits.SendMessages },
      { name: 'EmbedLinks', flag: PermissionFlagsBits.EmbedLinks }
    ];
    const missingPerms = perms ? required.filter(p => !perms.has(p.flag)).map(p => p.name) : ['All'];

    if (missingPerms.length > 0) {
      const permMsg = missingPerms.includes('SendMessages')
        ? `The configured channel is #${channel.name}, but Honey Bot cannot send messages there. Grant the bot Send Messages permission and try again.`
        : `The configured channel is #${channel.name}, but Honey Bot lacks permissions: ${missingPerms.join(', ')}. Grant the required permissions and try again.`;

      return {
        healthy: false,
        status: 'permission_denied',
        channel,
        missingPerms,
        findings: [`Missing permissions in #${channel.name}: ${missingPerms.join(', ')}`],
        userMessage: permMsg,
        pendingCount: (conf.pendingDeliveries || []).length
      };
    }

    // 4. Check if logging is disabled
    if (!conf.enabled) {
      findings.push(`Mod logging is currently disabled (destination preserved: #${channel.name}).`);
      if (autoRepair) {
        ModLogService.updateConfig(guild.id, { enabled: true, updatedBy: userTagOrId });
        repairs.push(`Re-enabled moderation logging for #${channel.name}.`);
      }
    }

    // 5. Check pending deliveries
    const pendingCount = (conf.pendingDeliveries || []).length;
    if (pendingCount > 0) {
      findings.push(`I found ${pendingCount} recent action${pendingCount > 1 ? 's' : ''} that succeeded, but ${pendingCount > 1 ? 'their log entries are' : 'its log entry is'} still pending delivery.`);
      if (autoRepair && conf.enabled) {
        const flushRes = await ModLogService.flushPendingDeliveries(guild);
        if (flushRes.flushed > 0) {
          repairs.push(`Delivered ${flushRes.flushed} pending log entr${flushRes.flushed > 1 ? 'ies' : 'y'}.`);
        }
      }
    }

    // 6. Check last failure
    if (conf.lastDeliveryFailure && !repairs.length && pendingCount === 0 && conf.enabled) {
      findings.push(`Recent delivery error recorded at ${conf.lastDeliveryFailure.timestamp}: ${conf.lastDeliveryFailure.error}`);
    }

    const isHealthy = missingPerms.length === 0 && conf.enabled && pendingCount === 0;

    let userMessage = '';
    if (!conf.enabled && !repairs.length) {
      userMessage = 'Mod logging is disabled for this server. The previous channel configuration has been preserved.';
    } else if (pendingCount > 0 && !repairs.length) {
      userMessage = 'I found a recent ban that succeeded, but its log entry is still pending delivery.';
    } else if (repairs.length > 0) {
      userMessage = `Repaired moderation logging: ${repairs.join(' ')}`;
    } else {
      userMessage = `Mod logging is configured for #${channel.name}. The channel is accessible and healthy.`;
    }

    return {
      healthy: isHealthy,
      status: isHealthy ? 'healthy' : 'issues_found',
      channel,
      findings,
      repairs,
      userMessage,
      pendingCount
    };
  }

  /**
   * Categorizes an action into an authoritative functional category.
   * Deterministically resolves category via ActionRegistry; never silently falls back to Moderation.
   */
  static getActionCategory(action) {
    const classified = ActionRegistry.classify(action);
    return classified.category;
  }

  /**
   * Classifies an event into one of the three authoritative logging channels:
   * 1. MODERATION (#mod-logs)
   * 2. HONEYPOT_SECURITY (#honeypot-logs)
   * 3. BOT_OPERATIONS (#bot-logs)
   */
  static classifyCategory(action, actionData = {}) {
    if (actionData.category && Object.values(LogCategory).includes(actionData.category)) {
      return actionData.category;
    }
    if (actionData.metadata?.honeypotSecurity || action === 'honeypot_trigger' || action === 'honeypot_evidence') {
      return LogCategory.HONEYPOT_SECURITY;
    }

    const act = String(action || '').toLowerCase();

    // Explicit Moderation Actions
    const moderationActions = [
      'ban_member', 'unban_member', 'kick_member', 'softban_member',
      'timeout_member', 'remove_timeout', 'voice_mute', 'voice_unmute',
      'voice_deafen', 'voice_undeafen', 'voice_disconnect',
      'purge_messages', 'delete_message', 'edit_message',
      'issue_warning', 'clear_warnings', 'lock_channel', 'unlock_channel',
      'set_channel_slowmode'
    ];
    if (moderationActions.includes(act) || act.includes('ban_') || act.includes('kick_') || act.includes('timeout_') || act.includes('warning')) {
      return LogCategory.MODERATION;
    }

    // Honeypot triggers & security evidence
    if (act.includes('honeypot_trigger') || act.includes('honeypot_detection')) {
      return LogCategory.HONEYPOT_SECURITY;
    }

    // Routine server configuration, resource lifecycle, and bot health belong in BOT_OPERATIONS
    return LogCategory.BOT_OPERATIONS;
  }

  /**
   * Checks whether an action matches configured filter preferences.
   * Supports both legacy lowercase string tokens ('moderation', 'roles', 'channels', 'categories', etc.)
   * and standard FunctionalCategory names ('Music & Voice', 'Moderation & Member Safety', etc.).
   */
  static matchesEventFilter(filterEvents, functionalCategory, action) {
    if (!Array.isArray(filterEvents) || filterEvents.includes('all')) return true;
    const catLower = String(functionalCategory || '').toLowerCase();
    const actLower = String(action || '').toLowerCase();

    for (const filter of filterEvents) {
      const f = String(filter || '').toLowerCase().trim();
      if (!f || f === 'all') return true;
      if (f === catLower || catLower.includes(f)) return true;
      if (f === 'moderation' && (catLower.includes('moderation') || /kick|ban|timeout|warn|purge|honeypot/i.test(actLower))) return true;
      if (f === 'roles' && (catLower.includes('role') || /role/i.test(actLower))) return true;
      if (f === 'permissions' && (catLower.includes('permission') || /permission|overwrite/i.test(actLower))) return true;
      if (f === 'channels' && (catLower.includes('channel') || /channel/i.test(actLower))) return true;
      if (f === 'categories' && (catLower.includes('channel') || /category/i.test(actLower))) return true;
      if (f === 'policy' && (catLower.includes('server') || /policy|access/i.test(actLower))) return true;
      if (f === 'music' && (catLower.includes('music') || /music|voice|play|pause|track|skip/i.test(actLower))) return true;
      if ((f === 'messages' || f === 'messaging') && (catLower.includes('message') || /message|embed|announcement/i.test(actLower))) return true;
      if (f === 'panels' && (catLower.includes('panel') || /panel|ticket/i.test(actLower))) return true;
      if ((f === 'diagnostics' || f === 'recovery') && (catLower.includes('diagnostic') || /diagnos|audit|undo|recover/i.test(actLower))) return true;
      if (f === 'utilities' && (catLower.includes('util') || /dashboard|setup|lookup|nickname/i.test(actLower))) return true;
    }
    return false;
  }

  /**
   * Logs an action to the appropriate designated channel (#mod-logs, #honeypot-logs, or #bot-logs).
   * Completely decoupled from action execution: failures to log never throw or fail the action.
   */
  static async logAction(guild, actionData) {
    if (!guild) return { logged: false, reason: 'no_guild' };

    const conf = ModLogService.getConfig(guild.id);
    if (!conf || !conf.enabled) {
      return { logged: false, reason: 'logging_disabled_or_unconfigured' };
    }

    // Determine target category
    const category = actionData.category || ModLogService.classifyCategory(actionData.action, actionData);

    // Resolve destination channel ID
    let targetChannelId = null;
    if (category === LogCategory.HONEYPOT_SECURITY) {
      targetChannelId = conf.honeypotLogChannelId || conf.modLogChannelId || conf.channelId;
    } else if (category === LogCategory.BOT_OPERATIONS) {
      targetChannelId = conf.botLogChannelId || conf.modLogChannelId || conf.channelId;
    } else {
      // MODERATION
      targetChannelId = conf.modLogChannelId || conf.channelId;
    }

    if (!targetChannelId) {
      return { logged: false, reason: 'channel_unconfigured', category };
    }

    const {
      action,
      actor,
      target,
      outcome = actionData.outcome || actionData.status || 'succeeded',
      source = '/go'
    } = actionData;

    // Check outcome filters
    const prefs = conf.preferences || {};
    if (outcome === 'succeeded' && prefs.logSuccess === false) {
      return { logged: false, reason: 'filtered_success' };
    }
    if (outcome === 'failed' && prefs.logFailed === false) {
      return { logged: false, reason: 'filtered_failure' };
    }
    if (outcome === 'denied' && prefs.logDenied === false) {
      return { logged: false, reason: 'filtered_denied' };
    }

    // Check event category filters deterministically
    const classified = ActionRegistry.classify(action, actionData);
    const filterEvents = prefs.filterEvents;
    if (!ModLogService.matchesEventFilter(filterEvents, classified.category, action)) {
      return { logged: false, reason: 'filtered_event_category' };
    }

    // Check deduplication
    const targetId = target?.id || target?.name || target || 'unknown';
    if (source === 'gateway_event' && ModLogService.isDeduplicated(guild.id, action, targetId)) {
      logger.info('Deduplicated gateway event already logged by bot', { action, targetId });
      return { logged: false, reason: 'deduplicated' };
    }

    // Record signature if originated from Honey Bot
    if (source !== 'gateway_event') {
      ModLogService.recordActionSignature(guild.id, action, targetId);
    }

    // Resolve channel
    const channel = guild.channels?.cache?.get?.(targetChannelId) || await guild.channels?.fetch?.(targetChannelId).catch(() => null);
    if (!channel) {
      logger.warn('Log channel missing or deleted', { guildId: guild.id, channelId: targetChannelId, category });
      ModLogService._enqueuePendingDelivery(guild.id, actionData, 'channel_missing');
      return { logged: false, reason: 'channel_missing', queued: true, category };
    }

    // Build category-specific embed
    let embed;
    if (category === LogCategory.HONEYPOT_SECURITY) {
      embed = ModLogService.createHoneypotLogEmbed({
        ...actionData,
        retentionHours: conf.honeypotRetentionHours || 24
      });
    } else {
      embed = ModLogService.createModLogEmbed(actionData);
    }

    try {
      const sent = await channel.send({ embeds: [embed] });

      // If Honeypot Security evidence, register for 24h/48h expiry cleanup
      if (category === LogCategory.HONEYPOT_SECURITY && sent?.id) {
        HoneypotRetentionService.recordLogMessage(
          guild.id,
          channel.id,
          sent.id,
          conf.honeypotRetentionHours || 24,
          actionData.correlationId
        );
      }

      ModLogService.updateConfig(guild.id, {
        lastDeliverySuccess: new Date().toISOString(),
        deliveredCount: (conf.deliveredCount || 0) + 1
      });
      return { logged: true, channelId: channel.id, category, messageId: sent?.id };
    } catch (err) {
      logger.warn('Failed to deliver log embed, attempting plain-text fallback', { error: err.message, guildId: guild.id, category });
      try {
        const plainText = ModLogService.formatPlainTextLog(actionData);
        await channel.send({ content: plainText });
        ModLogService.updateConfig(guild.id, {
          lastDeliverySuccess: new Date().toISOString(),
          deliveredCount: (conf.deliveredCount || 0) + 1
        });
        return { logged: true, channelId: channel.id, category, fallback: true };
      } catch (fallbackErr) {
        logger.error('Failed to deliver log entry via plain text', { error: fallbackErr.message, guildId: guild.id, category });
        ModLogService._enqueuePendingDelivery(guild.id, actionData, fallbackErr.message);
        return { logged: false, error: fallbackErr.message, queued: true, category };
      }
    }
  }

  /**
   * Formats a temporary security evidence embed for Honeypot events (#honeypot-logs).
   */
  static createHoneypotLogEmbed(data) {
    const {
      target,
      channel,
      outcome = 'succeeded',
      failureReason = null,
      correlationId = null,
      evidence = {},
      retentionHours = 24
    } = data;

    const embed = new EmbedBuilder()
      .setTitle('[Honeypot Security Event] Honeypot Trigger Detected')
      .setColor(0xE74C3C)
      .setTimestamp();

    const targetStr = target?.tag
      ? `${target.tag} (<@${target.id}>)`
      : (target?.id ? `<@${target.id}>` : (target || 'Unknown'));
    embed.addFields({ name: 'Target User', value: targetStr, inline: true });

    const channelStr = channel?.id ? `<#${channel.id}>` : (channel?.name ? `#${channel.name}` : (channel || 'Unknown'));
    embed.addFields({ name: 'Honeypot Channel', value: channelStr, inline: true });

    const kickText = outcome === 'succeeded' ? 'Kicked successfully' : `Kick failed: ${failureReason || 'Hierarchy/Permission'}`;
    embed.addFields({ name: 'Kick Attempt', value: kickText, inline: true });

    const signals = evidence.signals && evidence.signals.length > 0 ? evidence.signals.join(', ') : 'Strict mode intrusion';
    embed.addFields({ name: 'Signals Detected', value: signals, inline: true });

    if (evidence.contentSnippet) {
      const snippet = String(evidence.contentSnippet).replace(/`/g, "'").slice(0, 300);
      embed.addFields({ name: 'Captured Evidence', value: `\`\`\`\n${snippet}\n\`\`\``, inline: false });
    }

    embed.addFields(
      { name: 'Retention & Expiry', value: `Expires in ${retentionHours}h (Automatic cleanup)`, inline: true },
      { name: 'Correlation ID', value: `\`${correlationId || 'none'}\``, inline: true }
    );

    embed.setFooter({ text: 'Honeypot Security Evidence • Temporary log' });
    return embed;
  }

  /**
   * Formats an operational embed for Honey Bot operations & server changes (#bot-logs).
   */
  static createBotLogEmbed(data) {
    const {
      action,
      actor,
      target,
      reason,
      outcome = 'succeeded',
      failureReason = null,
      executionId = null,
      changes = null,
      source = '/go'
    } = data;

    const classified = ActionRegistry.classify(action, data);
    let color = 0x3498DB; // Blue
    if (outcome === 'failed') color = 0x992D22;
    else if (outcome === 'partially_completed') color = 0xE67E22;

    const embed = new EmbedBuilder()
      .setTitle(`[Honey Bot Operations] ${classified.displayName || action}`)
      .setColor(color)
      .setTimestamp();

    const actorStr = actor?.tag
      ? `${actor.tag} (${actor.id ? `<@${actor.id}>` : 'System'})`
      : (actor?.id ? `<@${actor.id}>` : (actor || 'Honey Bot System'));
    embed.addFields({ name: 'Initiator', value: actorStr, inline: true });

    let targetStr = 'Server';
    if (target) {
      if (typeof target === 'object') {
        targetStr = target.tag
          ? `${target.tag} (<@${target.id}>)`
          : (target.name ? `${target.type === 4 ? '📁 ' : '#'}${target.name} (${target.id})` : `${target.id || 'N/A'}`);
      } else {
        targetStr = String(target);
      }
    }
    embed.addFields({ name: 'Resource Affected', value: targetStr, inline: true });

    const statusText = outcome === 'succeeded' ? 'SUCCESS' : (outcome === 'failed' ? `FAILED: ${failureReason || 'Error'}` : outcome.toUpperCase());
    embed.addFields({ name: 'Status', value: statusText, inline: true });

    if (changes) {
      embed.addFields({ name: 'Changes / Details', value: String(changes).slice(0, 512), inline: false });
    } else if (reason) {
      embed.addFields({ name: 'Details', value: String(reason).slice(0, 512), inline: false });
    }

    embed.addFields(
      { name: 'Event Source', value: String(source), inline: true },
      { name: 'Execution ID', value: `\`${executionId || data.correlationId || 'N/A'}\``, inline: true }
    );

    embed.setFooter({ text: 'Honey Bot Operations & Health Audit' });
    return embed;
  }

  /**
   * Formats a clean, readable embed for moderation logs.
   */
  static createModLogEmbed(data) {
    const {
      action,
      actor,
      target,
      reason,
      duration,
      count,
      outcome = 'succeeded',
      failureReason = null,
      executionId = null,
      correlationId = null,
      source = '/go',
      scope = null,
      changes = null,
      affectedChannels = null,
      unsynchronizedChannels = null,
      succeeded = null,
      failed = null,
      remainingWork = null
    } = data;

    // 1. Authoritative Deterministic Classification
    const classified = ActionRegistry.classify(action, data);
    const sourceInfo = ActionRegistry.normalizeEventSource(source);
    const truthful = ActionRegistry.determineTruthfulOutcome(data, classified.verificationStrategy);

    // 2. Color determination by functional category and outcome
    let color = 0x5865F2; // Default blurple
    switch (classified.category) {
      case FunctionalCategory.MUSIC_VOICE:
        color = 0x1DB954; // Audio green
        break;
      case FunctionalCategory.MODERATION_SAFETY:
        const actStr = String(action).toLowerCase();
        if (actStr.includes('ban') || actStr.includes('kick')) color = 0xED4245;
        else if (actStr.includes('timeout') || actStr.includes('warn')) color = 0xFEE75C;
        else color = 0xE67E22;
        break;
      case FunctionalCategory.ROLES_PERMISSIONS:
        color = String(action).includes('permission') ? 0x9B59B6 : 0x1ABC9C;
        break;
      case FunctionalCategory.CHANNEL_MANAGEMENT:
        color = 0x3498DB;
        break;
      case FunctionalCategory.SERVER_CONFIGURATION:
        color = 0x95A5A6;
        break;
      case FunctionalCategory.MESSAGES_EMBEDS:
        color = 0x5865F2;
        break;
      case FunctionalCategory.REACTION_ROLES_PANELS:
        color = 0xE91E63;
        break;
      case FunctionalCategory.DIAGNOSTICS_RECOVERY:
        color = 0xF1C40F;
        break;
      case FunctionalCategory.GENERAL_UTILITIES:
        color = 0x7289DA;
        break;
      default:
        color = 0x7F8C8D;
        break;
    }

    if (truthful.outcome === OutcomeState.PARTIALLY_COMPLETED) color = 0xE67E22;
    if (truthful.outcome === OutcomeState.FAILED || truthful.outcome === OutcomeState.DENIED) color = 0x992D22;

    const embed = new EmbedBuilder()
      .setTitle(`[${classified.category}] ${classified.displayName}`)
      .setColor(color)
      .setTimestamp();

    // Actor / Initiator
    const actorStr = actor?.tag
      ? `${actor.tag} (${actor.id ? `<@${actor.id}>` : 'External'})`
      : (actor?.id ? `<@${actor.id}>` : (actor || 'Unknown'));
    const isExternal = sourceInfo.eventSource === EventSource.EXTERNAL_EVENT;
    const isModeration = classified.category === FunctionalCategory.MODERATION_SAFETY;
    const actorFieldName = isExternal ? 'External Actor' : (isModeration ? 'Moderator' : 'Initiated by');
    embed.addFields({ name: actorFieldName, value: actorStr, inline: true });

    // Target
    let targetStr = 'N/A';
    if (target) {
      if (typeof target === 'object') {
        targetStr = target.tag
          ? `${target.tag} (<@${target.id}>)`
          : (target.name ? `${target.type === 4 ? '📁 ' : '#'}${target.name} (${target.id})` : `${target.id || 'Unknown'}`);
      } else {
        targetStr = String(target);
      }
    }
    embed.addFields({ name: 'Target', value: targetStr, inline: true });

    // Scope if specified
    if (scope) {
      embed.addFields({ name: 'Scope', value: String(scope), inline: true });
    }

    // Outcome / Result
    let outcomeText;
    if (truthful.outcome === OutcomeState.SUCCEEDED) {
      outcomeText = isModeration ? 'Completed' : (truthful.verificationStatus === VerificationStatus.VERIFIED ? 'Succeeded and verified' : 'Succeeded');
    } else if (truthful.outcome === OutcomeState.FAILED) {
      outcomeText = `Failed: ${failureReason || 'Error'}`;
    } else if (truthful.outcome === OutcomeState.DENIED) {
      outcomeText = `Denied: ${failureReason || 'Unauthorized'}`;
    } else {
      outcomeText = truthful.outcome;
    }
    const outcomeFieldName = isModeration ? 'Outcome' : 'Result';
    embed.addFields({ name: outcomeFieldName, value: outcomeText, inline: true });

    // Functional Category & Verification Status & Event Source
    embed.addFields(
      { name: 'Category', value: classified.category, inline: true },
      { name: 'Verification Status', value: truthful.verificationStatus, inline: true },
      { name: 'Event Source', value: sourceInfo.eventSource, inline: true }
    );

    // Specific category/permission fields
    if (changes) {
      embed.addFields({ name: 'Changes', value: String(changes).slice(0, 512), inline: false });
    }
    if (affectedChannels) {
      const affText = Array.isArray(affectedChannels) ? affectedChannels.join(', ') : String(affectedChannels);
      embed.addFields({ name: 'Affected child channels', value: affText.slice(0, 512), inline: false });
    }
    if (unsynchronizedChannels) {
      const unsyncText = Array.isArray(unsynchronizedChannels) ? unsynchronizedChannels.join(', ') : String(unsynchronizedChannels);
      embed.addFields({ name: 'Unsynchronized channels', value: unsyncText.slice(0, 512), inline: false });
    }

    // Partial operation fields
    if (succeeded) {
      embed.addFields({ name: 'Succeeded', value: String(succeeded).slice(0, 512), inline: false });
    }
    if (failed) {
      embed.addFields({ name: 'Failed', value: String(failed).slice(0, 512), inline: false });
    }
    if (remainingWork) {
      embed.addFields({ name: 'Remaining work', value: String(remainingWork).slice(0, 512), inline: false });
    }

    // Stated reason (sanitized, max 512 chars)
    const cleanReason = String(reason || 'No reason provided').slice(0, 512);
    embed.addFields({ name: 'Reason', value: cleanReason, inline: false });

    // Additional fields
    if (duration) {
      embed.addFields({ name: 'Duration', value: `${duration}m`, inline: true });
    }
    if (count) {
      embed.addFields({ name: 'Count', value: String(count), inline: true });
    }

    const footerParts = [`Source: ${sourceInfo.interfaceName}`];
    if (executionId) footerParts.push(`Execution: ${executionId}`);
    if (correlationId || data.correlationId) footerParts.push(`Correlation ID: ${correlationId || data.correlationId}`);
    embed.setFooter({ text: footerParts.join(' • ') });

    return embed;
  }

  /**
   * Formats a fallback plain-text moderation log entry when embeds cannot be delivered.
   */
  static formatPlainTextLog(data) {
    const {
      action,
      actor,
      target,
      reason,
      duration,
      count,
      outcome = 'succeeded',
      failureReason = null,
      executionId = null,
      correlationId = null,
      source = '/go',
      changes = null,
      affectedChannels = null,
      remainingWork = null
    } = data;

    const classified = ActionRegistry.classify(action, data);
    const sourceInfo = ActionRegistry.normalizeEventSource(source);
    const truthful = ActionRegistry.determineTruthfulOutcome(data, classified.verificationStrategy);

    const actorStr = actor?.tag ? `${actor.tag} (${actor.id || ''})` : (actor?.id ? `<@${actor.id}>` : (actor || 'Unknown'));
    let targetStr = 'N/A';
    if (target) {
      if (typeof target === 'object') {
        targetStr = target.tag
          ? `${target.tag} (${target.id})`
          : (target.name ? `${target.type === 4 ? '📁 ' : '#'}${target.name} (${target.id})` : `${target.id || 'Unknown'}`);
      } else {
        targetStr = String(target);
      }
    }

    const isModeration = classified.category === FunctionalCategory.MODERATION_SAFETY;
    let outcomeText;
    if (truthful.outcome === OutcomeState.SUCCEEDED) {
      outcomeText = isModeration ? 'Completed' : (truthful.verificationStatus === VerificationStatus.VERIFIED ? 'Succeeded and verified' : 'Succeeded');
    } else if (truthful.outcome === OutcomeState.FAILED) {
      outcomeText = `Failed: ${failureReason || 'Error'}`;
    } else if (truthful.outcome === OutcomeState.DENIED) {
      outcomeText = `Denied: ${failureReason || 'Unauthorized'}`;
    } else {
      outcomeText = truthful.outcome;
    }

    const lines = [
      `📋 **[${classified.category}] ${classified.displayName}**`,
      `• **Target:** ${targetStr}`,
      `• **Action:** ${classified.displayName}${duration ? ` for ${duration}m` : ''}${count ? ` (count: ${count})` : ''}`,
      `• **Category:** ${classified.category}`,
      `• **Initiated by:** ${actorStr}`,
      `• **Reason:** ${reason || 'No reason provided'}`,
      `• **Result:** ${outcomeText}`,
      `• **Verification Status:** ${truthful.verificationStatus}`,
      `• **Event Source:** ${sourceInfo.eventSource}`
    ];

    if (changes) lines.push(`• **Changes:** ${changes}`);
    if (affectedChannels) lines.push(`• **Affected channels:** ${Array.isArray(affectedChannels) ? affectedChannels.join(', ') : affectedChannels}`);
    if (remainingWork) lines.push(`• **Remaining work:** ${remainingWork}`);

    lines.push(`• **Time:** ${new Date().toISOString()}`);
    lines.push(`• **Execution ID:** ${executionId || 'N/A'} (Source: ${sourceInfo.interfaceName})`);

    return lines.join('\n');
  }
}

function formatActionTitle(action) {
  if (!action) return 'Action';
  return action
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
