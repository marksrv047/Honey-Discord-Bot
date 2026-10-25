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

    const conf = ModLogService._configCache[guildId];
    if (!conf) {
      return {
        guildId,
        channelId: null,
        channelName: null,
        enabled: false,
        updatedAt: null,
        updatedBy: null,
        preferences: {
          logBotActions: true,
          logExternalActions: true
        },
        lastDeliverySuccess: null,
        lastDeliveryFailure: null,
        pendingDeliveries: [],
        deliveredCount: 0,
        failedCount: 0
      };
    }

    return {
      lastDeliverySuccess: null,
      lastDeliveryFailure: null,
      pendingDeliveries: [],
      deliveredCount: 0,
      failedCount: 0,
      ...conf
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
      guildId,
      updatedAt: new Date().toISOString()
    };

    ModLogService._configCache[guildId] = updated;
    ModLogService._persistConfigs();
    logger.info('Updated modlog configuration', { guildId, channelId: updated.channelId, enabled: updated.enabled });
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

    return { flushed, remaining: remaining.length };
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
      outcome = 'succeeded',
      failureReason = null,
      executionId = null,
      source = '/go'
    } = actionData;

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
    const embed = ModLogService.createModLogEmbed({
      action,
      actor,
      target,
      reason,
      duration,
      count,
      outcome,
      failureReason,
      executionId,
      source
    });

    try {
      await channel.send({ embeds: [embed] });
      ModLogService.updateConfig(guild.id, {
        lastDeliverySuccess: new Date().toISOString(),
        deliveredCount: (conf.deliveredCount || 0) + 1
      });
      return { logged: true, channelId: channel.id };
    } catch (err) {
      logger.error('Failed to deliver mod-log entry', { error: err.message, guildId: guild.id });
      ModLogService._enqueuePendingDelivery(guild.id, actionData, err.message);
      return { logged: false, error: err.message, queued: true };
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
      source = '/go'
    } = data;

    // Color by severity/type
    let color = 0x5865F2; // Default Blurple
    if (action.includes('ban')) color = 0xED4245; // Red
    else if (action.includes('kick')) color = 0xE67E22; // Orange
    else if (action.includes('timeout')) color = 0xFEE75C; // Yellow
    else if (action.includes('purge')) color = 0x95A5A6; // Gray
    else if (action.includes('role') || action.includes('channel')) color = 0x3498DB; // Blue
    if (outcome === 'failed' || outcome === 'denied') color = 0x992D22; // Dark Red

    const actionTitle = formatActionTitle(action);

    const embed = new EmbedBuilder()
      .setTitle(`[Moderation] ${actionTitle}`)
      .setColor(color)
      .setTimestamp();

    // Actor
    const actorStr = actor?.tag
      ? `${actor.tag} (${actor.id ? `<@${actor.id}>` : 'External'})`
      : (actor?.id ? `<@${actor.id}>` : (actor || 'Unknown'));
    embed.addFields({ name: 'Moderator', value: actorStr, inline: true });

    // Target
    let targetStr = 'N/A';
    if (target) {
      if (typeof target === 'object') {
        targetStr = target.tag
          ? `${target.tag} (<@${target.id}>)`
          : (target.name ? `#${target.name} (<#${target.id}>)` : `${target.id || 'Unknown'}`);
      } else {
        targetStr = String(target);
      }
    }
    embed.addFields({ name: 'Target', value: targetStr, inline: true });

    // Outcome
    const outcomeText = outcome === 'succeeded' ? 'Completed' : (outcome === 'failed' ? `Failed: ${failureReason || 'Error'}` : outcome);
    embed.addFields({ name: 'Outcome', value: outcomeText, inline: true });

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
}

function formatActionTitle(action) {
  if (!action) return 'Action';
  return action
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
