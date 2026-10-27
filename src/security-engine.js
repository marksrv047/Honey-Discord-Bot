import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionFlagsBits, ChannelType } from 'discord.js';
import { Logger } from './logger.js';
import { ModLogService } from './mod-log.js';
import { CaseManager } from './case-manager.js';
import { WarningManager } from './warnings.js';
import { ActionRegistry, FunctionalCategory } from './action-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = new Logger('SecurityEngine');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const SECURITY_CONFIG_FILE = path.join(DATA_DIR, 'security-policies.json');

/**
 * SecurityEngine
 * Comprehensive anti-spam, anti-raid, emergency lockdown, and safety policy engine.
 */
export class SecurityEngine {
  static _configs = new Map(); // guildId -> SecurityPolicy
  static _isLoaded = false;
  static _storagePath = SECURITY_CONFIG_FILE;

  // Bounded rolling memory states (auto-cleared)
  static _userMessageTimestamps = new Map(); // `${guildId}:${userId}` -> Array<number>
  static _userRecentContents = new Map();    // `${guildId}:${userId}` -> Array<{ text: string, time: number }>
  static _guildJoinTimestamps = new Map();   // guildId -> Array<number>
  static _lockdownOverwrites = new Map();    // guildId -> Map(channelId -> originalOverwrite)
  static _safeModeActive = new Map();        // guildId -> boolean

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
        logger.error('Failed to create data directory for security engine', { error: err.message });
      }
    }
  }

  static getDefaultPolicy() {
    return {
      antiSpam: {
        enabled: true,
        maxMessagesPerWindow: 5,
        windowSeconds: 4,
        maxDuplicates: 3,
        duplicateWindowSeconds: 12,
        maxMentions: 5,
        blockDiscordInvites: true,
        allowedInviteGuilds: [],
        prohibitedKeywords: [],
        action: 'timeout', // 'delete' | 'warn' | 'timeout' | 'kick'
        timeoutMinutes: 10,
        exemptRoles: [],
        exemptChannels: []
      },
      antiRaid: {
        enabled: true,
        maxJoinsPerWindow: 6,
        joinWindowSeconds: 15,
        autoLockdown: true,
        notifyChannelId: null,
        quarantineRoleId: null
      },
      safeMode: false
    };
  }

  static loadAll() {
    if (this._isLoaded) return;
    this._ensureDataDir();

    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const parsed = JSON.parse(raw);
        this._configs.clear();
        for (const [guildId, conf] of Object.entries(parsed)) {
          this._configs.set(guildId, {
            ...this.getDefaultPolicy(),
            ...conf,
            antiSpam: { ...this.getDefaultPolicy().antiSpam, ...(conf.antiSpam || {}) },
            antiRaid: { ...this.getDefaultPolicy().antiRaid, ...(conf.antiRaid || {}) }
          });
        }
      }
      this._isLoaded = true;
    } catch (err) {
      logger.error('Failed to load security policies from disk', { error: err.message });
      this._isLoaded = true;
    }
  }

  static saveAll() {
    this._ensureDataDir();
    try {
      const serializable = {};
      for (const [guildId, conf] of this._configs.entries()) {
        serializable[guildId] = conf;
      }
      const tmpFile = `${this.storagePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpFile, JSON.stringify(serializable, null, 2), 'utf8');
      fs.renameSync(tmpFile, this.storagePath);
    } catch (err) {
      logger.error('Failed to save security policies to disk', { error: err.message });
    }
  }

  static getPolicy(guildId) {
    this.loadAll();
    return this._configs.get(guildId) || this.getDefaultPolicy();
  }

  static updatePolicy(guildId, update) {
    this.loadAll();
    const current = this.getPolicy(guildId);
    const updated = {
      ...current,
      ...update,
      antiSpam: { ...current.antiSpam, ...(update.antiSpam || {}) },
      antiRaid: { ...current.antiRaid, ...(update.antiRaid || {}) }
    };
    this._configs.set(guildId, updated);
    this.saveAll();
    return updated;
  }

  /**
   * Evaluates an incoming message for spam patterns.
   * Returns: { isViolation: boolean, reason: string | null, actionTaken: string | null }
   */
  static async evaluateMessage(message, client) {
    if (!message || !message.guild || message.author?.bot) {
      return { isViolation: false };
    }

    const guildId = message.guild.id;
    const policy = this.getPolicy(guildId);
    if (!policy.antiSpam?.enabled) {
      return { isViolation: false };
    }

    const member = message.member;
    const authorId = message.author.id;
    const channelId = message.channel.id;

    // Check Exemptions
    if (member?.permissions?.has(PermissionFlagsBits.Administrator) ||
        member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
      return { isViolation: false };
    }

    if (policy.antiSpam.exemptChannels?.includes(channelId)) {
      return { isViolation: false };
    }

    if (policy.antiSpam.exemptRoles?.some(rId => member?.roles?.cache?.has(rId))) {
      return { isViolation: false };
    }

    const now = Date.now();
    const userKey = `${guildId}:${authorId}`;
    const cleanContent = message.content || '';

    let violationReason = null;

    // 1. Check Prohibited Keywords
    if (policy.antiSpam.prohibitedKeywords?.length > 0) {
      for (const kw of policy.antiSpam.prohibitedKeywords) {
        if (cleanContent.toLowerCase().includes(String(kw).toLowerCase())) {
          violationReason = `Message contained prohibited keyword: "${kw}"`;
          break;
        }
      }
    }

    // 2. Check Discord Invites
    if (!violationReason && policy.antiSpam.blockDiscordInvites) {
      const inviteRegex = /(?:https?:\/\/)?(?:www\.)?(?:discord\.(?:gg|io|me|li)|discord(?:app)?\.com\/invite)\/([a-zA-Z0-9-]+)/gi;
      let match;
      while ((match = inviteRegex.exec(cleanContent)) !== null) {
        const inviteCode = match[1];
        if (!policy.antiSpam.allowedInviteGuilds?.includes(inviteCode)) {
          violationReason = 'Unauthorized Discord server invitation link detected';
          break;
        }
      }
    }

    // 3. Check Mention Spam
    if (!violationReason && policy.antiSpam.maxMentions > 0) {
      const userMentions = message.mentions?.users?.size || 0;
      const roleMentions = message.mentions?.roles?.size || 0;
      const everyoneMention = message.mentions?.everyone ? 1 : 0;
      const totalMentions = userMentions + roleMentions + everyoneMention;

      if (totalMentions > policy.antiSpam.maxMentions) {
        violationReason = `Mention spam (${totalMentions} mentions exceeds limit of ${policy.antiSpam.maxMentions})`;
      }
    }

    // 4. Check Message Bursts
    if (!violationReason) {
      const burstWindowMs = (policy.antiSpam.windowSeconds || 4) * 1000;
      const timestamps = (this._userMessageTimestamps.get(userKey) || []).filter(t => now - t <= burstWindowMs);
      timestamps.push(now);
      this._userMessageTimestamps.set(userKey, timestamps);

      if (timestamps.length > policy.antiSpam.maxMessagesPerWindow) {
        violationReason = `Rapid message burst (${timestamps.length} messages in ${policy.antiSpam.windowSeconds}s)`;
      }
    }

    // 5. Check Repeated Duplicate Messages
    if (!violationReason && cleanContent.trim().length >= 3) {
      const dupWindowMs = (policy.antiSpam.duplicateWindowSeconds || 12) * 1000;
      let recent = (this._userRecentContents.get(userKey) || []).filter(item => now - item.time <= dupWindowMs);
      const normalized = cleanContent.trim().toLowerCase();
      recent.push({ text: normalized, time: now });
      this._userRecentContents.set(userKey, recent);

      const matchingDups = recent.filter(item => item.text === normalized);
      if (matchingDups.length >= policy.antiSpam.maxDuplicates) {
        violationReason = `Repeated duplicate message spam (${matchingDups.length} identical messages)`;
      }
    }

    if (!violationReason) {
      return { isViolation: false };
    }

    // Execute Configured Enforcement Action
    let actionTaken = 'deleted';
    try {
      // 1. Delete the spam message
      if (message.deletable) {
        await message.delete().catch(() => {});
      }

      // 2. Action escalation
      const action = policy.antiSpam.action || 'timeout';
      if (action === 'warn') {
        WarningManager.addWarning(guildId, authorId, `Anti-Spam: ${violationReason}`, client?.user?.tag || 'Honey Security');
        actionTaken = 'warned';
      } else if (action === 'timeout') {
        const timeoutMs = (policy.antiSpam.timeoutMinutes || 10) * 60 * 1000;
        if (member && member.moderatable) {
          await member.timeout(timeoutMs, `Anti-Spam automated enforcement: ${violationReason}`);
          actionTaken = `timed_out_${policy.antiSpam.timeoutMinutes}m`;
        }
      } else if (action === 'kick') {
        if (member && member.kickable) {
          await member.kick(`Anti-Spam automated enforcement: ${violationReason}`);
          actionTaken = 'kicked';
        }
      }

      // 3. Record official moderation case
      const modCase = CaseManager.createCase(guildId, {
        action: actionTaken.startsWith('timed_out') ? 'timeout' : (actionTaken === 'kicked' ? 'kick' : 'warn'),
        target: message.author,
        moderator: client?.user || { id: 'honey_security', tag: 'Honey Security Engine' },
        reason: `[Auto-Spam] ${violationReason}`,
        durationMinutes: actionTaken.startsWith('timed_out') ? policy.antiSpam.timeoutMinutes : null,
        evidence: cleanContent.slice(0, 500),
        source: 'automated_security'
      });

      // 4. Centralized ModLog dispatch
      await ModLogService.logAction(message.guild, {
        action: actionTaken.startsWith('timed_out') ? 'timeout_member' : (actionTaken === 'kicked' ? 'kick_member' : 'warn_member'),
        actor: client?.user || { id: 'honey_security', tag: 'Honey Security Engine' },
        target: message.author,
        reason: `[${modCase.caseId}] Anti-Spam: ${violationReason}`,
        duration: actionTaken.startsWith('timed_out') ? `${policy.antiSpam.timeoutMinutes}m` : null,
        outcome: 'succeeded',
        source: 'automated_security'
      }).catch(() => {});

      logger.warn(`Anti-Spam triggered for user ${authorId} in guild ${guildId}: ${violationReason} -> ${actionTaken}`);
      return { isViolation: true, reason: violationReason, actionTaken, caseId: modCase.caseId };
    } catch (err) {
      logger.error('Failed to execute anti-spam action', { error: err.message });
      return { isViolation: true, reason: violationReason, actionTaken: 'failed', error: err.message };
    }
  }

  /**
   * Tracks member joins and detects potential join raids.
   */
  static async handleMemberJoin(member, client) {
    if (!member || !member.guild) return { isRaid: false };

    const guild = member.guild;
    const guildId = guild.id;
    const policy = this.getPolicy(guildId);

    if (!policy.antiRaid?.enabled) return { isRaid: false };

    const now = Date.now();
    const windowMs = (policy.antiRaid.joinWindowSeconds || 15) * 1000;
    const timestamps = (this._guildJoinTimestamps.get(guildId) || []).filter(t => now - t <= windowMs);
    timestamps.push(now);
    this._guildJoinTimestamps.set(guildId, timestamps);

    if (timestamps.length >= policy.antiRaid.maxJoinsPerWindow) {
      logger.error(`🚨 Anti-Raid detected abnormal join velocity in ${guild.name} (${timestamps.length} joins in ${policy.antiRaid.joinWindowSeconds}s)`);

      let lockdownResult = null;
      if (policy.antiRaid.autoLockdown) {
        lockdownResult = await this.enableLockdown(guild, 'Anti-Raid automated emergency lockdown');
      }

      // Log to mod-log
      await ModLogService.logAction(guild, {
        action: 'lockdown_server',
        actor: client?.user || { id: 'honey_security', tag: 'Honey Security' },
        target: guild.name,
        reason: `Abnormal join velocity detected: ${timestamps.length} accounts joined within ${policy.antiRaid.joinWindowSeconds} seconds`,
        outcome: 'succeeded',
        source: 'automated_security'
      }).catch(() => {});

      return {
        isRaid: true,
        joinCount: timestamps.length,
        lockdownActive: Boolean(lockdownResult?.success)
      };
    }

    return { isRaid: false, joinCount: timestamps.length };
  }

  /**
   * Enables emergency server lockdown by denying SendMessages for @everyone on public text channels.
   * Stores previous permissions to allow safe, clean restoration.
   */
  static async enableLockdown(guild, reason = 'Emergency lockdown initiated') {
    if (!guild) return { success: false, error: 'No guild provided' };
    const guildId = guild.id;

    if (this._lockdownOverwrites.has(guildId)) {
      return { success: true, message: 'Server is already locked down' };
    }

    const overwritesMap = new Map();
    const everyoneRole = guild.roles.everyone;
    const channels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText || c.type === 0);

    let lockedCount = 0;
    for (const [chId, channel] of channels.entries()) {
      try {
        const currentOverwrite = channel.permissionOverwrites.cache.get(everyoneRole.id);
        overwritesMap.set(chId, currentOverwrite ? {
          allow: currentOverwrite.allow.bitfield,
          deny: currentOverwrite.deny.bitfield
        } : null);

        await channel.permissionOverwrites.edit(everyoneRole, {
          SendMessages: false,
          AddReactions: false
        }, { reason });

        lockedCount++;
      } catch (err) {
        logger.warn(`Could not lock channel ${channel.name}: ${err.message}`);
      }
    }

    this._lockdownOverwrites.set(guildId, overwritesMap);
    logger.info(`Lockdown enabled for ${guild.name} across ${lockedCount} channels`);
    return { success: true, channelsLocked: lockedCount };
  }

  /**
   * Lifts an active lockdown, restoring previous permissions.
   */
  static async liftLockdown(guild, reason = 'Emergency lockdown lifted') {
    if (!guild) return { success: false, error: 'No guild provided' };
    const guildId = guild.id;

    const previousOverwrites = this._lockdownOverwrites.get(guildId);
    if (!previousOverwrites) {
      return { success: false, error: 'Server is not currently in lockdown' };
    }

    const everyoneRole = guild.roles.everyone;
    let unlockedCount = 0;

    for (const [chId, prev] of previousOverwrites.entries()) {
      try {
        const channel = guild.channels.cache.get(chId);
        if (channel) {
          if (prev) {
            await channel.permissionOverwrites.edit(everyoneRole, {
              SendMessages: null, // Reset lockdown denial
              AddReactions: null
            }, { reason });
          } else {
            await channel.permissionOverwrites.delete(everyoneRole, reason);
          }
          unlockedCount++;
        }
      } catch (err) {
        logger.warn(`Could not unlock channel ${chId}: ${err.message}`);
      }
    }

    this._lockdownOverwrites.delete(guildId);
    logger.info(`Lockdown lifted for ${guild.name} across ${unlockedCount} channels`);
    return { success: true, channelsUnlocked: unlockedCount };
  }

  static isLockdownActive(guildId) {
    return this._lockdownOverwrites.has(guildId);
  }

  static isSafeModeActive(guildId) {
    return Boolean(this._safeModeActive.get(guildId));
  }

  static setSafeMode(guildId, active) {
    this._safeModeActive.set(guildId, Boolean(active));
    return Boolean(active);
  }

  /**
   * Inspects native Discord safety features (AutoMod, Verification, MFA, etc.)
   */
  static async inspectNativeSafety(guild) {
    if (!guild) return null;

    const verificationLevels = ['NONE', 'LOW (Verified Email)', 'MEDIUM (Registered > 5m)', 'HIGH (Member > 10m)', 'VERY_HIGH (Verified Phone)'];
    const nsfwLevels = ['DEFAULT', 'EXPLICIT', 'SAFE', 'AGE_RESTRICTED'];

    let autoModCount = 0;
    try {
      if (guild.autoModerationRules && guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) {
        const rules = await guild.autoModerationRules.fetch().catch(() => null);
        autoModCount = rules?.size || 0;
      }
    } catch {
      // ignore
    }

    return {
      verificationLevel: verificationLevels[guild.verificationLevel] || `Level ${guild.verificationLevel}`,
      mfaLevel: guild.mfaLevel === 1 ? 'ELEVATED (2FA Required for Mods)' : 'NONE',
      nsfwLevel: nsfwLevels[guild.nsfwLevel] || 'DEFAULT',
      nativeAutoModRulesCount: autoModCount,
      hasWidgetEnabled: Boolean(guild.widgetEnabled),
      recommendations: [
        guild.verificationLevel < 2 ? 'Consider increasing server Verification Level to MEDIUM to thwart automated burner account raids.' : 'Verification level is well configured.',
        guild.mfaLevel === 0 ? 'Enable 2FA Requirement for Moderation in Discord Server Settings for administrator defense.' : '2FA requirement for moderators is active.'
      ]
    };
  }
}

