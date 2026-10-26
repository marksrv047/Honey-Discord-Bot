import fs from 'node:fs';
import path from 'node:path';
import { PermissionFlagsBits } from 'discord.js';
import { WarningManager } from './warnings.js';
import { ModLogService } from './mod-log.js';
import { Logger } from './logger.js';

const logger = new Logger('ChannelGuard');
const GUARD_FILE = path.resolve(process.cwd(), 'data', 'channel-guard.json');

/**
 * ChannelGuard provides auto-moderation for guarded/honeypot channels:
 * - Warns normal users with a tagged message, then deletes both messages after a few seconds
 * - Tracks warnings; kicks user after 3 warnings
 * - Instantly kicks accounts posting spam (invites, mass mentions, scam links, rapid floods)
 */
export class ChannelGuard {
  static _guardedCache = new Map(); // guildId -> Set<channelId>
  static _isLoaded = false;
  static _userMessageTimestamps = new Map(); // `${guildId}:${userId}` -> Array<number>

  static _ensureDataDir() {
    const dir = path.dirname(GUARD_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  static _loadConfig() {
    if (this._isLoaded) return;
    this._ensureDataDir();
    try {
      if (fs.existsSync(GUARD_FILE)) {
        const raw = fs.readFileSync(GUARD_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        for (const [guildId, chList] of Object.entries(parsed)) {
          this._guardedCache.set(guildId, new Set(Array.isArray(chList) ? chList : []));
        }
      }
      this._isLoaded = true;
    } catch (err) {
      logger.error('Failed to load channel-guard.json', { error: err.message });
      this._isLoaded = true;
    }
  }

  static _saveConfig() {
    this._ensureDataDir();
    try {
      const serializable = {};
      for (const [guildId, set] of this._guardedCache.entries()) {
        serializable[guildId] = Array.from(set);
      }
      const tmpFile = `${GUARD_FILE}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpFile, JSON.stringify(serializable, null, 2), 'utf-8');
      fs.renameSync(tmpFile, GUARD_FILE);
    } catch (err) {
      logger.error('Failed to save channel-guard.json', { error: err.message });
    }
  }

  /**
   * Guards a channel in a guild.
   */
  static guardChannel(guildId, channelId) {
    this._loadConfig();
    if (!this._guardedCache.has(guildId)) {
      this._guardedCache.set(guildId, new Set());
    }
    this._guardedCache.get(guildId).add(channelId);
    this._saveConfig();
    return true;
  }

  /**
   * Removes guard from a channel.
   */
  static unguardChannel(guildId, channelId) {
    this._loadConfig();
    if (!this._guardedCache.has(guildId)) return false;
    const deleted = this._guardedCache.get(guildId).delete(channelId);
    this._saveConfig();
    return deleted;
  }

  /**
   * Returns all guarded channel IDs for a guild.
   */
  static getGuardedChannels(guildId) {
    this._loadConfig();
    const set = this._guardedCache.get(guildId);
    return set ? Array.from(set) : [];
  }

  /**
   * Checks whether a channel is guarded.
   * Considers explicit configuration and standard naming conventions (honeypot, rules-only, guard).
   */
  static isChannelGuarded(guildId, channelId, channelName = '') {
    this._loadConfig();
    const set = this._guardedCache.get(guildId);
    if (set && set.has(channelId)) return true;

    // Convention check: honeypot or trap channels are guarded by default
    const lowerName = String(channelName || '').toLowerCase();
    if (
      lowerName.includes('honeypot') ||
      lowerName.includes('intrusion-trap') ||
      lowerName.includes('no-chat') ||
      lowerName.includes('no-talking') ||
      lowerName === 'announcements-only'
    ) {
      return true;
    }

    return false;
  }

  /**
   * Determines if message content or structure represents spam.
   */
  static isSpam(message) {
    const content = String(message.content || '');

    // 1. Mass mentions (@everyone, @here, or 4+ user mentions)
    if (message.mentions?.everyone || (message.mentions?.users?.size || 0) >= 4) {
      return { isSpam: true, reason: 'Mass mention violation' };
    }

    // 2. Discord invite links
    if (/(?:discord\.gg\/|discord\.com\/invite\/)/i.test(content)) {
      return { isSpam: true, reason: 'Unauthorized server invite link' };
    }

    // 3. Phishing / free nitro / scam domains
    if (
      /(?:free-nitro|discord-gift|steamcommunity\.(?:link|gift|trade)|steam-gift|airdrop|crypto-gift|claim-nitro)/i.test(content)
    ) {
      return { isSpam: true, reason: 'Malicious / phishing link detected' };
    }

    // 4. Rapid repeated messaging flood (> 3 messages within 3 seconds)
    const key = `${message.guild?.id}:${message.author?.id}`;
    const now = Date.now();
    let timestamps = this._userMessageTimestamps.get(key) || [];
    timestamps = timestamps.filter(t => now - t < 3000);
    timestamps.push(now);
    this._userMessageTimestamps.set(key, timestamps);

    if (timestamps.length >= 4) {
      return { isSpam: true, reason: 'Message flood / rapid spam' };
    }

    return { isSpam: false };
  }

  /**
   * Main Message Handler for guarded channels.
   * Intercepts messages posted by non-admin users in guarded channels.
   */
  static async handleMessage(message, client) {
    if (!message || !message.guild || !message.author || message.author.bot) return;

    const guild = message.guild;
    const member = message.member || await guild.members.fetch(message.author.id).catch(() => null);
    if (!member) return;

    // Exempt server owner, administrators, and staff with ManageMessages
    if (
      member.id === guild.ownerId ||
      member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.permissions.has(PermissionFlagsBits.ManageGuild) ||
      member.permissions.has(PermissionFlagsBits.ManageMessages)
    ) {
      return;
    }

    const isGuarded = this.isChannelGuarded(guild.id, message.channel.id, message.channel.name);
    if (!isGuarded) return;

    logger.info(`Guarded channel violation detected by ${message.author.tag} in #${message.channel.name}`);

    // Check for SPAM: instant kick
    const spamCheck = this.isSpam(message);
    if (spamCheck.isSpam) {
      logger.warn(`Spam detected in guarded channel by ${message.author.tag}: ${spamCheck.reason}`);

      // Delete the spam message instantly
      await message.delete().catch(() => {});

      // Instant kick
      const kickSuccess = await member.kick(`Honey Bot Guard: Instant kick for spam (${spamCheck.reason})`).then(() => true).catch(err => {
        logger.error('Failed to kick spam account', { error: err.message });
        return false;
      });

      // Temporary channel notice (self-deletes after 5 seconds)
      const notice = await message.channel.send(
        `🛑 <@${message.author.id}> has been kicked immediately for posting spam in this channel.`
      ).catch(() => null);

      if (notice) {
        setTimeout(() => notice.delete().catch(() => {}), 5000);
      }

      // Log to ModLogService
      await ModLogService.logAction(guild, {
        action: 'kick_member',
        actor: client.user,
        target: message.author,
        reason: `Instant kick: ${spamCheck.reason} in guarded channel #${message.channel.name}`,
        outcome: kickSuccess ? 'succeeded' : 'failed',
        source: 'ChannelGuard'
      }).catch(() => {});

      return;
    }

    // NORMAL USER MESSAGE IN GUARDED CHANNEL:
    // 1. Send warning message tagging user
    const botWarning = await message.channel.send(
      `⚠️ <@${message.author.id}>, please do not post messages in this channel.`
    ).catch(() => null);

    // 2. Delete user's message after 4 seconds
    setTimeout(async () => {
      await message.delete().catch(() => {});
    }, 4000);

    // 3. Delete bot's warning message after 5 seconds
    if (botWarning) {
      setTimeout(async () => {
        await botWarning.delete().catch(() => {});
      }, 5000);
    }

    // 4. Record warning in WarningManager
    const warn = WarningManager.addWarning(guild.id, message.author.id, {
      reason: `Unauthorized message in guarded channel #${message.channel.name}`,
      moderatorId: client.user.id,
      moderatorTag: 'Honey Guard'
    });

    const userWarnings = WarningManager.getWarnings(guild.id, message.author.id);
    const warnCount = userWarnings.length;

    // 5. If user keeps sending messages, kick them after 3 warnings
    if (warnCount >= 3) {
      logger.warn(`User ${message.author.tag} reached ${warnCount} warnings in guarded channel, kicking member`);
      
      const kickSuccess = await member.kick(
        `Honey Bot Guard: Reached ${warnCount} warnings for unauthorized messages in #${message.channel.name}`
      ).then(() => true).catch(err => {
        logger.error('Failed to kick user after warning threshold', { error: err.message });
        return false;
      });

      const kickNotice = await message.channel.send(
        `🛑 <@${message.author.id}> was kicked after receiving ${warnCount} warnings for posting in this channel.`
      ).catch(() => null);

      if (kickNotice) {
        setTimeout(() => kickNotice.delete().catch(() => {}), 6000);
      }

      await ModLogService.logAction(guild, {
        action: 'kick_member',
        actor: client.user,
        target: message.author,
        reason: `Exceeded warning threshold (${warnCount} warnings) for posting in guarded channel #${message.channel.name}`,
        outcome: kickSuccess ? 'succeeded' : 'failed',
        source: 'ChannelGuard'
      }).catch(() => {});
    } else {
      await ModLogService.logAction(guild, {
        action: 'issue_warning',
        actor: client.user,
        target: message.author,
        reason: `Warning ${warnCount}/3: Unauthorized message in guarded channel #${message.channel.name}`,
        outcome: 'succeeded',
        source: 'ChannelGuard'
      }).catch(() => {});
    }
  }
}
