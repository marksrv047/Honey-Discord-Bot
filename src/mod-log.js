import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChannelType, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { Logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = new Logger('ModLogService');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'modlog-config.json');

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
    const tempFile = `${CONFIG_FILE}.tmp.${Date.now()}`;
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
      filterEvents: ['moderation', 'roles', 'channels', 'categories', 'permissions', 'policy'],
      logSuccess: true,
      logFailed: true,
      logDenied: true
    };

    const conf = ModLogService._configCache[guildId];
    if (!conf) {
      return {
        guildId,
        channelId: null,
        channelName: null,
        enabled: false,
        revision: 1,
        setupStatus: 'unconfigured',
        updatedAt: null,
        updatedBy: null,
        preferences: defaultPreferences,
        lastDeliverySuccess: null,
        lastDeliveryFailure: null,
        pendingDeliveries: [],
        deliveredCount: 0,
        failedCount: 0
      };
    }

    return {
      revision: conf.revision || 1,
      setupStatus: conf.setupStatus || (conf.channelId && conf.enabled ? 'configured' : 'unconfigured'),
      lastDeliverySuccess: null,
      lastDeliveryFailure: null,
      pendingDeliveries: [],
      deliveredCount: 0,
      failedCount: 0,
      ...conf,
      preferences: {
        ...defaultPreferences,
        ...(conf.preferences || {})
      }
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
    const updated = {
      ...current,
      ...updates,
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
   * Tests the configured mod-log channel by sending a test embed.
   */
  static async testLogChannel(guild) {
    const conf = ModLogService.getConfig(guild.id);
    if (!conf.channelId) {
      return { success: false, error: 'No moderation log channel is currently configured for this server.' };
    }

    const validation = await ModLogService.validateLogChannel(guild, conf.channelId);
    if (!validation.valid) {
      ModLogService.updateConfig(guild.id, {
        lastDeliveryFailure: {
          timestamp: new Date().toISOString(),
          error: validation.error,
          category: 'validation_error'
        },
        failedCount: (conf.failedCount || 0) + 1
      });
      return { success: false, error: validation.error, channel: validation.channel };
    }

    const channel = validation.channel;
    try {
      const testEmbed = new EmbedBuilder()
        .setTitle('Moderation Log Test')
        .setDescription('This is a test message to confirm Honey Bot can deliver moderation records to this channel.')
        .setColor(0x5865F2)
        .addFields(
          { name: 'Status', value: 'Delivery Verified', inline: true },
          { name: 'Permissions', value: 'View, Send & Embed OK', inline: true }
        )
        .setTimestamp();

      const sent = await channel.send({ embeds: [testEmbed] });
      ModLogService.updateConfig(guild.id, {
        lastDeliverySuccess: new Date().toISOString(),
        deliveredCount: (conf.deliveredCount || 0) + 1
      });
      return { success: true, channel, messageId: sent.id };
    } catch (err) {
      logger.error('Failed to send test mod-log message', { error: err.message, channelId: channel.id });
      ModLogService.updateConfig(guild.id, {
        lastDeliveryFailure: {
          timestamp: new Date().toISOString(),
          error: err.message,
          category: 'delivery_error'
        },
        failedCount: (conf.failedCount || 0) + 1
      });
      return { success: false, error: `Failed to deliver message to #${channel.name}: ${err.message}`, channel };
    }
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
   * Categorizes an action into an event category for filtering.
   */
  static getActionCategory(action) {
    const act = String(action || '').toLowerCase();
    if (/category|sync_category/i.test(act)) return 'categories';
    if (/permission|overwrite/i.test(act)) return 'permissions';
    if (/policy|access|modlog/i.test(act)) return 'policy';
    if (/role/i.test(act)) return 'roles';
    if (/channel/i.test(act)) return 'channels';
    if (/timeout|kick|ban|unban|purge|mute|deafen|warn/i.test(act)) return 'moderation';
    return 'moderation';
  }

  /**
   * Logs a moderation or administrative action to the guild's configured log channel.
   * Completely decoupled from action execution: failures to log never throw or fail the action.
   */
  static async logAction(guild, actionData) {
    if (!guild) return { logged: false, reason: 'no_guild' };

    const conf = ModLogService.getConfig(guild.id);
    if (!conf || !conf.enabled || !conf.channelId) {
      return { logged: false, reason: 'logging_disabled_or_unconfigured' };
    }

    const {
      action,
      actor,
      target,
      reason,
      duration,
      count,
      outcome = actionData.outcome || actionData.status || 'succeeded',
      failureReason = null,
      executionId = null,
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

    // Check event category filters
    const eventCategory = ModLogService.getActionCategory(action);
    const filterEvents = prefs.filterEvents;
    if (Array.isArray(filterEvents) && !filterEvents.includes('all') && !filterEvents.includes(eventCategory)) {
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
    const channel = guild.channels?.cache?.get?.(conf.channelId) || await guild.channels?.fetch?.(conf.channelId).catch(() => null);
    if (!channel) {
      logger.warn('Mod-log channel missing or deleted', { guildId: guild.id, channelId: conf.channelId });
      ModLogService._enqueuePendingDelivery(guild.id, actionData, 'channel_missing');
      return { logged: false, reason: 'channel_missing', queued: true };
    }

    // Build embed
    const embed = ModLogService.createModLogEmbed(actionData);

    try {
      await channel.send({ embeds: [embed] });
      ModLogService.updateConfig(guild.id, {
        lastDeliverySuccess: new Date().toISOString(),
        deliveredCount: (conf.deliveredCount || 0) + 1
      });
      return { logged: true, channelId: channel.id };
    } catch (err) {
      logger.warn('Failed to deliver mod-log embed, attempting plain-text fallback', { error: err.message, guildId: guild.id });
      try {
        const plainText = ModLogService.formatPlainTextLog(actionData);
        await channel.send({ content: plainText });
        ModLogService.updateConfig(guild.id, {
          lastDeliverySuccess: new Date().toISOString(),
          deliveredCount: (conf.deliveredCount || 0) + 1
        });
        return { logged: true, channelId: channel.id, fallback: true };
      } catch (fallbackErr) {
        logger.error('Failed to deliver mod-log entry via plain text', { error: fallbackErr.message, guildId: guild.id });
        ModLogService._enqueuePendingDelivery(guild.id, actionData, fallbackErr.message);
        return { logged: false, error: fallbackErr.message, queued: true };
      }
    }
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
      source = '/go',
      scope = null,
      changes = null,
      affectedChannels = null,
      unsynchronizedChannels = null,
      succeeded = null,
      failed = null,
      remainingWork = null
    } = data;

    // Determine category and color
    const category = ModLogService.getActionCategory(action);
    let color = 0x5865F2; // Blurple
    if (category === 'categories' || category === 'channels') color = 0x3498DB; // Blue
    else if (category === 'permissions') color = 0x9B59B6; // Purple
    else if (category === 'roles') color = 0x1ABC9C; // Teal
    else if (action.includes('ban') || action.includes('delete')) color = 0xED4245; // Red
    else if (action.includes('kick')) color = 0xE67E22; // Orange
    else if (action.includes('timeout')) color = 0xFEE75C; // Yellow
    else if (action.includes('purge')) color = 0x95A5A6; // Gray

    if (outcome === 'partial') color = 0xE67E22; // Orange
    if (outcome === 'failed' || outcome === 'denied') color = 0x992D22; // Dark Red

    const categoryTitle = category.charAt(0).toUpperCase() + category.slice(1);
    const actionTitle = formatActionTitle(action);

    const embed = new EmbedBuilder()
      .setTitle(`[${categoryTitle}] ${actionTitle}`)
      .setColor(color)
      .setTimestamp();

    // Actor / Initiator
    const actorStr = actor?.tag
      ? `${actor.tag} (${actor.id ? `<@${actor.id}>` : 'External'})`
      : (actor?.id ? `<@${actor.id}>` : (actor || 'Unknown'));
    const actorFieldName = category === 'moderation' ? 'Moderator' : 'Initiated by';
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

    // Outcome
    let outcomeText = outcome === 'succeeded'
      ? (category === 'moderation' ? 'Completed' : 'Succeeded and verified')
      : (outcome === 'failed' ? `Failed: ${failureReason || 'Error'}` : outcome);
    if (outcome === 'partial') outcomeText = 'Partially completed';
    const outcomeFieldName = category === 'moderation' ? 'Outcome' : 'Result';
    embed.addFields({ name: outcomeFieldName, value: outcomeText, inline: true });

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

    const footerParts = [`Source: ${source}`];
    if (executionId) footerParts.push(`Execution: ${executionId}`);
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
      source = '/go',
      changes = null,
      affectedChannels = null,
      remainingWork = null
    } = data;

    const actionTitle = formatActionTitle(action);
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

    const outcomeText = outcome === 'succeeded' ? 'Succeeded and verified' : (outcome === 'failed' ? `Failed: ${failureReason || 'Error'}` : outcome);
    const lines = [
      `📋 **[Moderation] ${actionTitle}**`,
      `• **Target:** ${targetStr}`,
      `• **Action:** ${actionTitle}${duration ? ` for ${duration}m` : ''}${count ? ` (count: ${count})` : ''}`,
      `• **Initiated by:** ${actorStr}`,
      `• **Reason:** ${reason || 'No reason provided'}`,
      `• **Result:** ${outcomeText}`
    ];

    if (changes) lines.push(`• **Changes:** ${changes}`);
    if (affectedChannels) lines.push(`• **Affected channels:** ${Array.isArray(affectedChannels) ? affectedChannels.join(', ') : affectedChannels}`);
    if (remainingWork) lines.push(`• **Remaining work:** ${remainingWork}`);

    lines.push(`• **Time:** ${new Date().toISOString()}`);
    lines.push(`• **Execution ID:** ${executionId || 'N/A'} (Source: ${source})`);

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
