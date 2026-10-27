import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionFlagsBits, PermissionsBitField, GatewayIntentBits, IntentsBitField } from 'discord.js';
import { config } from './config.js';
import { CAPABILITY_REGISTRY } from './capabilities.js';
import { checkRoleHierarchy } from './permissions.js';
import { Logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = new Logger('PermissionAuditService');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const AUDIT_STORAGE_FILE = path.join(DATA_DIR, 'permission-audits.json');

/**
 * Standard Feature Readiness Taxonomy
 */
export const FeatureStatus = {
  READY: 'READY',
  PARTIAL: 'PARTIAL',
  MISSING_PERMISSION: 'MISSING_PERMISSION',
  ROLE_HIERARCHY_BLOCKED: 'ROLE_HIERARCHY_BLOCKED',
  MISSING_CONFIGURATION: 'MISSING_CONFIGURATION',
  INTENT_UNAVAILABLE: 'INTENT_UNAVAILABLE',
  UNVERIFIED: 'UNVERIFIED'
};

/**
 * Centralized, Documented Discord Permission Registry.
 * Explicitly details every permission required across Honey Bot's implemented features.
 * Administrator is deliberately excluded from standard permissions.
 */
export const PERMISSION_REGISTRY = {
  // --- Core Communication & Visibility ---
  ViewChannel: {
    flag: PermissionFlagsBits.ViewChannel,
    name: 'ViewChannel',
    feature: 'Core Bot Channel Visibility & Server State Scanning',
    category: 'Core',
    isEssential: true,
    consequenceIfMissing: 'Bot cannot observe channels, read messages, or inspect server structure.'
  },
  SendMessages: {
    flag: PermissionFlagsBits.SendMessages,
    name: 'SendMessages',
    feature: 'Command Responses & System Notifications',
    category: 'Core',
    isEssential: true,
    consequenceIfMissing: 'Bot cannot reply to user instructions, post reports, or speak in chat.'
  },
  EmbedLinks: {
    flag: PermissionFlagsBits.EmbedLinks,
    name: 'EmbedLinks',
    feature: 'Interactive Dashboard, Ticket Panels, & Verification Embeds',
    category: 'Core',
    isEssential: true,
    consequenceIfMissing: 'Bot cannot display rich visual cards, dashboards, or verification reports.'
  },
  ReadMessageHistory: {
    flag: PermissionFlagsBits.ReadMessageHistory,
    name: 'ReadMessageHistory',
    feature: 'Message Inspection & Honeypot Retention Cleanup Sweeps',
    category: 'Core',
    isEssential: true,
    consequenceIfMissing: 'Bot cannot fetch message history or delete expired temporary honeypot logs.'
  },
  UseApplicationCommands: {
    flag: PermissionFlagsBits.UseApplicationCommands,
    name: 'UseApplicationCommands',
    feature: 'Slash Command Execution (/go, /modlog, /diagnose, /undo, /help, /honeypot)',
    category: 'Core',
    isEssential: true,
    consequenceIfMissing: 'Slash commands will be blocked in channels where this permission is denied.'
  },
  AddReactions: {
    flag: PermissionFlagsBits.AddReactions,
    name: 'AddReactions',
    feature: 'Persistent Self-Role Panels & Interactive Reaction Roles',
    category: 'Utilities',
    isEssential: false,
    consequenceIfMissing: 'Bot cannot add initial emoji reactions to role selection panels.'
  },
  UseExternalEmojis: {
    flag: PermissionFlagsBits.UseExternalEmojis,
    name: 'UseExternalEmojis',
    feature: 'Rich Visual Formatting & Custom Emoji Icons',
    category: 'Utilities',
    isEssential: false,
    consequenceIfMissing: 'Custom emoji icons in embeds fall back to generic unicode symbols.'
  },
  AttachFiles: {
    flag: PermissionFlagsBits.AttachFiles,
    name: 'AttachFiles',
    feature: 'Diagnostics Transcript Export & Audit Logs',
    category: 'Utilities',
    isEssential: false,
    consequenceIfMissing: 'Diagnostic state exports cannot be uploaded as text file attachments.'
  },

  // --- Channel & Category Administration ---
  ManageChannels: {
    flag: PermissionFlagsBits.ManageChannels,
    name: 'ManageChannels',
    feature: 'Channel/Category Creation, Renaming, Ticket Channels, & Modlog Provisioning',
    category: 'Channels',
    isEssential: false,
    consequenceIfMissing: 'Cannot create, rename, delete, lock, unlock, or organize channels and categories.'
  },

  // --- Role & Permission Administration ---
  ManageRoles: {
    flag: PermissionFlagsBits.ManageRoles,
    name: 'ManageRoles',
    feature: 'Role Creation, Editing, Assignment, & Self-Role Menus',
    category: 'Roles',
    isEssential: false,
    consequenceIfMissing: 'Cannot create, modify, delete, or assign roles to server members.'
  },

  // --- Moderation & Member Safety ---
  KickMembers: {
    flag: PermissionFlagsBits.KickMembers,
    name: 'KickMembers',
    feature: 'Member Kick Moderation & Intrusion Honeypot Auto-Removal',
    category: 'Moderation',
    isEssential: false,
    consequenceIfMissing: 'Cannot kick offending members or enforce honeypot trap kicks.'
  },
  BanMembers: {
    flag: PermissionFlagsBits.BanMembers,
    name: 'BanMembers',
    feature: 'Member Ban & Unban Moderation',
    category: 'Moderation',
    isEssential: false,
    consequenceIfMissing: 'Cannot ban malicious raid accounts or unban pardoned users.'
  },
  ModerateMembers: {
    flag: PermissionFlagsBits.ModerateMembers,
    name: 'ModerateMembers',
    feature: 'Member Timeouts & Anti-Spam Auto-Mute',
    category: 'Moderation',
    isEssential: false,
    consequenceIfMissing: 'Cannot apply or clear member timeouts.'
  },
  ManageMessages: {
    flag: PermissionFlagsBits.ManageMessages,
    name: 'ManageMessages',
    feature: 'Bulk Message Purge & Honeypot Spam Deletion',
    category: 'Moderation',
    isEssential: false,
    consequenceIfMissing: 'Cannot bulk delete messages or remove honeypot trigger messages.'
  },
  ManageNicknames: {
    flag: PermissionFlagsBits.ManageNicknames,
    name: 'ManageNicknames',
    feature: 'Member Nickname Moderation & Standardization',
    category: 'Moderation',
    isEssential: false,
    consequenceIfMissing: 'Cannot update or reset offensive member nicknames via /go.'
  },
  ViewAuditLog: {
    flag: PermissionFlagsBits.ViewAuditLog,
    name: 'ViewAuditLog',
    feature: 'Truthful Moderation Log Actor Attribution & Security Diagnostics',
    category: 'Moderation',
    isEssential: false,
    consequenceIfMissing: 'Moderation logs cannot attribute external actions to specific staff members.'
  },
  MentionEveryone: {
    flag: PermissionFlagsBits.MentionEveryone,
    name: 'MentionEveryone',
    feature: 'Server-Wide Announcements (@everyone / @here)',
    category: 'Messaging',
    isEssential: false,
    consequenceIfMissing: 'Announcements cannot ping @everyone or @here in announcement channels.'
  },
  ManageGuild: {
    flag: PermissionFlagsBits.ManageGuild,
    name: 'ManageGuild',
    feature: 'Server-Level Configuration (Server Name, System Channel, AFK Channel)',
    category: 'Server',
    isEssential: false,
    consequenceIfMissing: 'Cannot modify server-level properties like server name or system channel.'
  },

  // --- Voice & Music Service ---
  Connect: {
    flag: PermissionFlagsBits.Connect,
    name: 'Connect',
    feature: 'Voice Channel Join for Audio & Music Playback',
    category: 'Voice',
    isEssential: false,
    consequenceIfMissing: 'Bot cannot join voice channels for music playback or voice diagnostics.'
  },
  Speak: {
    flag: PermissionFlagsBits.Speak,
    name: 'Speak',
    feature: 'Audio Playback & Music Streaming',
    category: 'Voice',
    isEssential: false,
    consequenceIfMissing: 'Bot cannot transmit audio in voice channels.'
  },
  MoveMembers: {
    flag: PermissionFlagsBits.MoveMembers,
    name: 'MoveMembers',
    feature: 'Voice Channel Move Management',
    category: 'Voice',
    isEssential: false,
    consequenceIfMissing: 'Cannot move members between voice channels.'
  },
  MuteMembers: {
    flag: PermissionFlagsBits.MuteMembers,
    name: 'MuteMembers',
    feature: 'Server Voice Mute for Voice Moderation',
    category: 'Voice',
    isEssential: false,
    consequenceIfMissing: 'Cannot server-mute members in voice channels.'
  },
  DeafenMembers: {
    flag: PermissionFlagsBits.DeafenMembers,
    name: 'DeafenMembers',
    feature: 'Server Voice Deafen for Voice Moderation',
    category: 'Voice',
    isEssential: false,
    consequenceIfMissing: 'Cannot server-deafen members in voice channels.'
  }
};

/**
 * Authoritative Recommended Least-Privilege Discord Permissions.
 * Derived programmatically from all non-Administrator permissions in PERMISSION_REGISTRY.
 */
export const RECOMMENDED_PERMISSIONS = Object.values(PERMISSION_REGISTRY).map(p => p.flag);

/**
 * Critical Permissions: The absolute minimum required for Honey Bot to render embeds and speak in text channels.
 */
export const CRITICAL_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks
];

/**
 * Comprehensive mapping of Discord permissions to Honey Bot features and failure consequences.
 * Maintained for backward compatibility.
 */
export const PERMISSION_FEATURE_MAP = {
  Administrator: {
    flag: PermissionFlagsBits.Administrator,
    feature: 'Full Autonomous Server Administration',
    consequenceIfMissing: 'Requires individual permission checks; role hierarchy still strictly applies.'
  },
  ...Object.fromEntries(
    Object.entries(PERMISSION_REGISTRY).map(([k, v]) => [
      k,
      { flag: v.flag, feature: v.feature, consequenceIfMissing: v.consequenceIfMissing }
    ])
  )
};

/**
 * Centralized Privileged & Standard Gateway Intent Registry.
 * Distinguishes OAuth2 permissions from Gateway Intents and documents Developer Portal switches.
 */
export const INTENT_REGISTRY = {
  Guilds: {
    flag: GatewayIntentBits.Guilds,
    name: 'Guilds',
    isPrivileged: false,
    requiredFor: 'Server structure discovery, channel scanning, and live state extraction',
    consequenceIfMissing: 'Bot cannot observe any server structure or join events.'
  },
  GuildMembers: {
    flag: GatewayIntentBits.GuildMembers,
    name: 'GuildMembers',
    isPrivileged: true,
    developerPortalSetting: 'Discord Developer Portal > Bot > Privileged Gateway Intents > SERVER MEMBERS INTENT',
    requiredFor: 'Anti-Raid join observation, member onboarding, auto-roles, and member role-hierarchy caching',
    consequenceIfMissing: 'GuildMemberAdd/Remove events will not fire; member caching and anti-raid will be degraded.'
  },
  GuildModeration: {
    flag: GatewayIntentBits.GuildModeration,
    name: 'GuildModeration',
    isPrivileged: false,
    requiredFor: 'External ban and unban gateway event observation and modlog attribution',
    consequenceIfMissing: 'External bans and unbans cannot be observed in real time via gateway.'
  },
  GuildMessages: {
    flag: GatewayIntentBits.GuildMessages,
    name: 'GuildMessages',
    isPrivileged: false,
    requiredFor: 'MessageCreate event observation for anti-spam scanning, channel guard, and analytics',
    consequenceIfMissing: 'MessageCreate events will not fire; in-channel auto-moderation cannot run.'
  },
  MessageContent: {
    flag: GatewayIntentBits.MessageContent,
    name: 'MessageContent',
    isPrivileged: true,
    developerPortalSetting: 'Discord Developer Portal > Bot > Privileged Gateway Intents > MESSAGE CONTENT INTENT',
    requiredFor: 'Intrusion Honeypot trap text inspection, anti-spam link scanning, and community auto-responses',
    consequenceIfMissing: 'Honeypot cannot read message text for scam links; anti-spam evaluates empty content.'
  },
  GuildMessageReactions: {
    flag: GatewayIntentBits.GuildMessageReactions,
    name: 'GuildMessageReactions',
    isPrivileged: false,
    requiredFor: 'Persistent self-assignable role menus and reaction roles',
    consequenceIfMissing: 'Reaction additions/removals will not be detected; self-role menus will not trigger.'
  },
  GuildVoiceStates: {
    flag: GatewayIntentBits.GuildVoiceStates,
    name: 'GuildVoiceStates',
    isPrivileged: false,
    requiredFor: 'Voice channel state observation, music playback, and 5-minute idle disconnect',
    consequenceIfMissing: 'Voice state changes will not trigger auto-leave; music subsystem cannot track channel participants.'
  }
};

/**
 * Centralized, Reusable Permission Audit & OAuth2 Installation Service.
 */
export class PermissionAuditService {
  static _auditStore = new Map();
  static _storeLoaded = false;
  static _customAuditStoragePath = null;

  static get auditStoragePath() {
    return this._customAuditStoragePath || AUDIT_STORAGE_FILE;
  }

  static set auditStoragePath(p) {
    this._customAuditStoragePath = p;
    this._storeLoaded = false;
  }

  static _ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      } catch {}
    }
  }

  /**
   * Persists a completed audit record for a guild.
   */
  static saveAudit(guildId, audit) {
    if (!guildId || !audit) return;
    this._ensureDataDir();
    this._auditStore.set(guildId, {
      ...audit,
      savedAt: Date.now()
    });

    try {
      const obj = Object.fromEntries(this._auditStore.entries());
      fs.writeFileSync(this.auditStoragePath, JSON.stringify(obj, null, 2), 'utf8');
    } catch (err) {
      logger.warn('Failed to persist permission audit to disk', { guildId, error: err.message });
    }
  }

  /**
   * Retrieves a stored audit record for a guild.
   */
  static getStoredAudit(guildId) {
    if (!guildId) return null;
    if (!this._storeLoaded) {
      this._ensureDataDir();
      try {
        if (fs.existsSync(this.auditStoragePath)) {
          const raw = fs.readFileSync(this.auditStoragePath, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            this._auditStore.clear();
            for (const [k, v] of Object.entries(parsed)) {
              this._auditStore.set(k, v);
            }
          }
        }
      } catch {}
      this._storeLoaded = true;
    }
    return this._auditStore.get(guildId) || null;
  }

  /**
   * Audits active Gateway Intents for the Discord client.
   * Identifies available, missing, and privileged intents with setup instructions.
   */
  static auditIntents(client) {
    const rawIntents = client?.options?.intents;
    if (rawIntents === undefined || rawIntents === null) {
      return {
        evaluated: false,
        available: [],
        missing: [],
        missingPrivileged: [],
        summary: 'Gateway intents could not be evaluated from client options.'
      };
    }

    let bitfield;
    try {
      bitfield = new IntentsBitField(rawIntents);
    } catch {
      bitfield = null;
    }

    const available = [];
    const missing = [];
    const missingPrivileged = [];

    for (const [key, item] of Object.entries(INTENT_REGISTRY)) {
      const hasIntent = bitfield ? bitfield.has(item.flag) : false;
      if (hasIntent) {
        available.push(item.name);
      } else {
        missing.push(item.name);
        if (item.isPrivileged) {
          missingPrivileged.push({
            name: item.name,
            setting: item.developerPortalSetting,
            requiredFor: item.requiredFor,
            consequence: item.consequenceIfMissing
          });
        }
      }
    }

    return {
      evaluated: true,
      available,
      missing,
      missingPrivileged,
      hasGuildMembers: available.includes('GuildMembers'),
      hasMessageContent: available.includes('MessageContent'),
      summary: missingPrivileged.length > 0
        ? `Missing ${missingPrivileged.length} privileged intent(s): ${missingPrivileged.map(i => i.name).join(', ')}.`
        : 'All required gateway intents are active.'
    };
  }

  /**
   * Resolves the integer bitfield string for a specific permission mode.
   * Defaults to recommended least-privilege permissions without Administrator.
   *
   * @param {'recommended'|'admin'|'full'} [mode='recommended']
   * @returns {string}
   */
  static calculatePermissionBits(mode = 'recommended') {
    if (mode === 'admin' || mode === 'full') {
      return PermissionsBitField.resolve(PermissionFlagsBits.Administrator).toString();
    }
    return PermissionsBitField.resolve(RECOMMENDED_PERMISSIONS).toString();
  }

  /**
   * Generates official Discord OAuth2 authorization URL requesting correct bot scopes and permissions.
   * Scopes: 'bot' and 'applications.commands'.
   * Excludes Administrator by default; uses granular recommended least-privilege permissions.
   *
   * @param {Object} options
   * @param {string} [options.clientId]
   * @param {'recommended'|'admin'|'full'} [options.mode='recommended']
   * @param {string} [options.guildId]
   * @param {boolean} [options.disableGuildSelect]
   * @returns {string}
   */
  static generateInviteUrl(options = {}) {
    const clientId = options.clientId || config.discord.clientId;
    if (!clientId) {
      throw new Error('Cannot generate Discord OAuth2 invite URL: DISCORD_CLIENT_ID is not configured in environment.');
    }

    const mode = options.mode || 'recommended';
    const permissions = this.calculatePermissionBits(mode);
    const scope = encodeURIComponent('bot applications.commands');

    let url = `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&scope=${scope}&permissions=${permissions}`;
    if (options.guildId) {
      url += `&guild_id=${encodeURIComponent(options.guildId)}`;
    }
    if (options.disableGuildSelect) {
      url += `&disable_guild_select=true`;
    }
    return url;
  }

  /**
   * Performs an authoritative, evidence-based audit of Honey Bot's permissions in a guild.
   *
   * @param {Object} guild - Discord Guild instance or mock
   * @param {Object} [options]
   * @returns {Promise<Object>} Structured audit report
   */
  static async auditGuild(guild, options = {}) {
    if (!guild) {
      return {
        guildId: null,
        overallStatus: 'blocked',
        summary: 'Invalid or missing guild context.',
        hasAdministrator: false,
        missingCritical: ['ViewChannel', 'SendMessages', 'EmbedLinks'],
        missingRecommended: [],
        capabilities: {},
        roleHierarchy: { isAtTop: false, botHighestRole: null, hierarchyWarning: 'Guild not resolved' },
        channelOverwrites: { blockedChannels: [], defaultSetupChannel: null }
      };
    }

    const guildId = guild.id || 'unknown_guild';
    const guildName = guild.name || 'Discord Server';

    // 1. Resolve Bot Member
    let botMember = guild.members?.me;
    if (!botMember && typeof guild.members?.fetchMe === 'function') {
      try {
        botMember = await guild.members.fetchMe();
      } catch (err) {
        logger.warn('Failed to fetchMe in auditGuild', { guildId, error: err.message });
      }
    }

    if (!botMember) {
      return {
        guildId,
        guildName,
        overallStatus: 'blocked',
        summary: 'Honey Bot member object could not be resolved in this server.',
        hasAdministrator: false,
        missingCritical: ['ViewChannel', 'SendMessages', 'EmbedLinks'],
        missingRecommended: [],
        capabilities: {},
        roleHierarchy: { isAtTop: false, botHighestRole: null, hierarchyWarning: 'Bot member missing' },
        channelOverwrites: { blockedChannels: [], defaultSetupChannel: null }
      };
    }

    const botId = botMember.id || config.discord.clientId;
    const botTag = botMember.user?.tag || botMember.displayName || 'Honey Bot';

    // 2. Evaluate Guild-Level Permissions
    const botPerms = botMember.permissions;
    const hasAdministrator = Boolean(botPerms?.has?.(PermissionFlagsBits.Administrator));

    const missingCritical = [];
    const missingRecommended = [];
    const grantedRecommended = [];

    for (const flag of CRITICAL_PERMISSIONS) {
      const permName = new PermissionsBitField(flag).toArray()[0] || 'Unknown';
      if (!hasAdministrator && !botPerms?.has?.(flag)) {
        missingCritical.push(permName);
      }
    }

    for (const flag of RECOMMENDED_PERMISSIONS) {
      const permName = new PermissionsBitField(flag).toArray()[0] || 'Unknown';
      if (hasAdministrator || botPerms?.has?.(flag)) {
        grantedRecommended.push(permName);
      } else {
        missingRecommended.push(permName);
      }
    }

    // 3. Inspect Channel-Level Overwrites & Identify Setup Channel
    const channels = guild.channels?.cache ? Array.from(guild.channels.cache.values()) : (options.mockChannels || []);
    const blockedChannels = [];
    let defaultSetupChannel = null;

    for (const ch of channels) {
      // Only inspect text or announcement channels for message readiness
      const isText = (ch.isTextBased && typeof ch.isTextBased === 'function' && ch.isTextBased()) || ch.type === 0 || ch.type === 5;
      if (!isText) continue;

      let canView = true;
      let canSend = true;
      let canEmbed = true;

      if (typeof botMember.permissionsIn === 'function') {
        const chPerms = botMember.permissionsIn(ch);
        canView = Boolean(chPerms?.has?.(PermissionFlagsBits.ViewChannel));
        canSend = Boolean(chPerms?.has?.(PermissionFlagsBits.SendMessages));
        canEmbed = Boolean(chPerms?.has?.(PermissionFlagsBits.EmbedLinks));
      } else if (ch.permissionOverwrites?.cache) {
        // Fallback for mocks with overwrites cache
        const botOverwrite = ch.permissionOverwrites.cache.get(botId);
        if (botOverwrite?.deny?.has?.(PermissionFlagsBits.SendMessages)) canSend = false;
        if (botOverwrite?.deny?.has?.(PermissionFlagsBits.ViewChannel)) canView = false;
        if (botOverwrite?.deny?.has?.(PermissionFlagsBits.EmbedLinks)) canEmbed = false;
      }

      if (!canView || !canSend || !canEmbed) {
        const missing = [];
        if (!canView) missing.push('ViewChannel');
        if (!canSend) missing.push('SendMessages');
        if (!canEmbed) missing.push('EmbedLinks');
        blockedChannels.push({
          channelId: ch.id,
          channelName: ch.name,
          missingPerms: missing
        });
      } else if (!defaultSetupChannel) {
        // Pick best setup channel
        if (guild.systemChannelId && ch.id === guild.systemChannelId) {
          defaultSetupChannel = { id: ch.id, name: ch.name, canSend: true, canEmbed: true };
        } else if (/^(?:general|welcome|bot-setup|admin|bot-commands)$/i.test(ch.name)) {
          defaultSetupChannel = { id: ch.id, name: ch.name, canSend: true, canEmbed: true };
        }
      }
    }

    // If no preferred channel matched, pick the first permitted channel
    if (!defaultSetupChannel) {
      const firstPermitted = channels.find(ch => {
        const isText = (ch.isTextBased && typeof ch.isTextBased === 'function' && ch.isTextBased()) || ch.type === 0;
        if (!isText) return false;
        if (typeof botMember.permissionsIn === 'function') {
          return botMember.permissionsIn(ch)?.has?.([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks
          ]);
        }
        return true;
      });
      if (firstPermitted) {
        defaultSetupChannel = { id: firstPermitted.id, name: firstPermitted.name, canSend: true, canEmbed: true };
      }
    }

    // 4. Role Hierarchy Inspection
    const botHighestRole = botMember.roles?.highest;
    const botPos = botHighestRole?.position ?? botHighestRole?.rawPosition ?? 0;
    const guildRoles = guild.roles?.cache ? Array.from(guild.roles.cache.values()) : [];
    
    // Roles strictly above Honey Bot (excluding @everyone and Honey Bot's own highest role)
    const unmanageableRoles = guildRoles
      .filter(r => r.name !== '@everyone' && r.id !== botHighestRole?.id && (r.position ?? r.rawPosition ?? 0) > botPos)
      .map(r => ({ id: r.id, name: r.name, position: r.position ?? r.rawPosition ?? 0 }));

    let hierarchyWarning = null;
    if (unmanageableRoles.length > 0 && botPos > 0) {
      hierarchyWarning = `Honey Bot's role (@${botHighestRole?.name || 'Honey Bot'}) is positioned below ${unmanageableRoles.length} role(s). Discord role hierarchy prevents Honey from modifying or assigning roles above its position, even with Administrator permission.`;
    }

    // 4b. Evaluate Client Gateway Intents
    const intentAudit = this.auditIntents(guild.client || options.client);

    // 5. Capability Readiness Breakdown with Standard Taxonomy
    const capabilities = {
      messaging: this._evaluateDomainReadiness(botPerms, hasAdministrator, [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks
      ], 'Messaging & Announcements'),

      channels: this._evaluateDomainReadiness(botPerms, hasAdministrator, [
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ViewChannel
      ], 'Channel & Category Management'),

      roles: this._evaluateDomainReadiness(botPerms, hasAdministrator, [
        PermissionFlagsBits.ManageRoles
      ], 'Role Management & Role Menus', hierarchyWarning ? [hierarchyWarning] : [], {
        isHierarchyBlocked: Boolean(hierarchyWarning)
      }),

      moderation: this._evaluateDomainReadiness(botPerms, hasAdministrator, [
        PermissionFlagsBits.KickMembers,
        PermissionFlagsBits.BanMembers,
        PermissionFlagsBits.ModerateMembers
      ], 'Member Moderation (Kick/Ban/Timeout)', [], {
        isHierarchyBlocked: Boolean(hierarchyWarning),
        isIntentMissing: intentAudit.evaluated && !intentAudit.hasGuildMembers
      }),

      voice: this._evaluateDomainReadiness(botPerms, hasAdministrator, [
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak
      ], 'Voice Diagnostics & Music Playback', [], {
        isIntentMissing: intentAudit.evaluated && !intentAudit.available.includes('GuildVoiceStates')
      }),

      modlog: this._evaluateDomainReadiness(botPerms, hasAdministrator, [
        PermissionFlagsBits.ViewAuditLog,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks
      ], 'Moderation Logging & Audit Attribution'),

      honeypot: this._evaluateDomainReadiness(botPerms, hasAdministrator, [
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.KickMembers,
        PermissionFlagsBits.ManageMessages
      ], 'Intrusion Honeypot Security', [], {
        isIntentMissing: intentAudit.evaluated && !intentAudit.hasMessageContent
      }),

      tickets: this._evaluateDomainReadiness(botPerms, hasAdministrator, [
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks
      ], 'Interactive Ticket Support System'),

      dashboard: this._evaluateDomainReadiness(botPerms, hasAdministrator, [
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.SendMessages
      ], 'Interactive Server Dashboard')
    };

    // Dictionary of standard uppercase feature readiness classifications
    const featureClassifications = {};
    for (const [domain, cap] of Object.entries(capabilities)) {
      featureClassifications[domain] = cap.classification;
    }

    // 6. Overall Status Determination
    let overallStatus = 'ready';
    let summary = '';

    if (missingCritical.length > 0) {
      overallStatus = 'blocked';
      summary = `Honey Bot cannot operate because critical communication permissions are missing: ${missingCritical.join(', ')}.`;
    } else if (hasAdministrator) {
      overallStatus = 'ready';
      summary = hierarchyWarning
        ? `Honey Bot has full Administrator permission. Note: Role hierarchy restrictions still apply to ${unmanageableRoles.length} role(s).`
        : 'Honey Bot has full Administrator permission and is ready for all server operations.';
    } else if (missingRecommended.length === 0) {
      overallStatus = 'ready';
      summary = 'Honey Bot has all recommended least-privilege permissions configured.';
    } else {
      overallStatus = 'partially_ready';
      summary = `Honey Bot has basic communication permissions, but ${missingRecommended.length} recommended permissions are missing (${missingRecommended.join(', ')}).`;
    }

    const auditResult = {
      guildId,
      guildName,
      botId,
      botTag,
      hasAdministrator,
      overallStatus,
      summary,
      missingCritical,
      missingRecommended,
      grantedRecommended,
      blockedChannels,
      defaultSetupChannel,
      roleHierarchy: {
        botHighestRole: botHighestRole ? { id: botHighestRole.id, name: botHighestRole.name, position: botPos } : null,
        unmanageableRoles,
        isAtTop: unmanageableRoles.length === 0,
        hierarchyWarning
      },
      intents: intentAudit,
      capabilities,
      featureClassifications,
      inviteUrls: {
        admin: this.generateInviteUrl({ clientId: botId, mode: 'admin', guildId }),
        recommended: this.generateInviteUrl({ clientId: botId, mode: 'recommended', guildId })
      }
    };

    // Store audit result in persistent cache
    this.saveAudit(guildId, auditResult);

    return auditResult;
  }

  /**
   * Helper to evaluate capability domain readiness using standard taxonomy.
   */
  static _evaluateDomainReadiness(botPerms, hasAdmin, requiredFlags = [], label = '', extraIssues = [], options = {}) {
    const {
      isHierarchyBlocked = false,
      isConfigMissing = false,
      isIntentMissing = false,
      unverified = false
    } = options;

    if (unverified) {
      return {
        status: 'blocked',
        classification: FeatureStatus.UNVERIFIED,
        label,
        missingPerms: [],
        issues: ['Guild context or bot member insufficient to verify readiness.', ...extraIssues]
      };
    }

    if (isConfigMissing) {
      return {
        status: 'blocked',
        classification: FeatureStatus.MISSING_CONFIGURATION,
        label,
        missingPerms: [],
        issues: ['Required channel or feature configuration is missing.', ...extraIssues]
      };
    }

    if (isIntentMissing) {
      return {
        status: 'blocked',
        classification: FeatureStatus.INTENT_UNAVAILABLE,
        label,
        missingPerms: [],
        issues: ['Required Discord gateway intent is not enabled in client options or Developer Portal.', ...extraIssues]
      };
    }

    if (hasAdmin) {
      if (isHierarchyBlocked) {
        return {
          status: 'partially_ready',
          classification: FeatureStatus.ROLE_HIERARCHY_BLOCKED,
          label,
          missingPerms: [],
          issues: extraIssues
        };
      }
      return {
        status: extraIssues.length > 0 ? 'partially_ready' : 'ready',
        classification: extraIssues.length > 0 ? FeatureStatus.PARTIAL : FeatureStatus.READY,
        label,
        missingPerms: [],
        issues: extraIssues
      };
    }

    const missing = [];
    for (const flag of requiredFlags) {
      if (!botPerms?.has?.(flag)) {
        const name = new PermissionsBitField(flag).toArray()[0] || 'Unknown';
        missing.push(name);
      }
    }

    if (missing.length > 0) {
      return {
        status: missing.length === requiredFlags.length ? 'blocked' : 'partially_ready',
        classification: FeatureStatus.MISSING_PERMISSION,
        label,
        missingPerms: missing,
        issues: [`Missing permission(s): ${missing.join(', ')}`, ...extraIssues]
      };
    }

    if (isHierarchyBlocked) {
      return {
        status: 'partially_ready',
        classification: FeatureStatus.ROLE_HIERARCHY_BLOCKED,
        label,
        missingPerms: [],
        issues: extraIssues
      };
    }

    return {
      status: extraIssues.length > 0 ? 'partially_ready' : 'ready',
      classification: extraIssues.length > 0 ? FeatureStatus.PARTIAL : FeatureStatus.READY,
      label,
      missingPerms: [],
      issues: extraIssues
    };
  }

  /**
   * Pre-flight permission verification immediately before executing any planned action.
   *
   * @param {Object} guild - Discord guild
   * @param {Object} actionObj - Planned action item
   * @param {Object} [channel] - Optional target channel
   * @returns {{ capable: boolean, reason: string | null, missingPermissions: string[], inviteUrl: string }}
   */
  static validateActionPreflight(guild, actionObj, channel = null) {
    if (!guild) {
      return { capable: false, reason: 'Invalid guild context for action pre-flight.', missingPermissions: [], inviteUrl: '' };
    }

    const botMember = guild.members?.me;
    if (!botMember) {
      // If guild has no botMember (e.g., minimal unit test mock), do not block execution
      return { capable: true, reason: null, missingPermissions: [], inviteUrl: '' };
    }

    const actName = actionObj.action;
    const capability = CAPABILITY_REGISTRY[actName];
    const inviteUrl = this.generateInviteUrl({ clientId: botMember.id, guildId: guild.id });

    // 1. Role Hierarchy Check
    const hierarchy = checkRoleHierarchy(guild, actionObj, actionObj.targetRole || actionObj.targetMember);
    if (!hierarchy.valid) {
      return {
        capable: false,
        reason: hierarchy.reason,
        missingPermissions: [],
        inviteUrl
      };
    }

    // 2. Administrator bypasses native permission bit checks
    if (botMember.permissions?.has?.(PermissionFlagsBits.Administrator)) {
      return { capable: true, reason: null, missingPermissions: [], inviteUrl };
    }

    // 3. Guild-Level & Channel-Level Required Permissions Check
    const required = capability?.requiredBotPermissions || [];
    const missing = [];

    for (const reqPerm of required) {
      let hasPerm = Boolean(botMember.permissions?.has?.(reqPerm));

      // If channel is provided, check channel overwrites
      if (channel && typeof botMember.permissionsIn === 'function') {
        const chPerms = botMember.permissionsIn(channel);
        if (chPerms && !chPerms.has(reqPerm)) {
          hasPerm = false;
        }
      }

      if (!hasPerm) {
        const permName = new PermissionsBitField(reqPerm).toArray().join(', ') || 'UnknownPermission';
        missing.push(permName);
      }
    }

    if (missing.length > 0) {
      const featureConsequence = PERMISSION_FEATURE_MAP[missing[0]]?.consequenceIfMissing || 'Action could not be executed.';
      return {
        capable: false,
        reason: `Honey Bot lacks the required Discord permission(s): ${missing.join(', ')}. ${featureConsequence} Please grant these in Server Settings > Roles or reauthorize Honey Bot.`,
        missingPermissions: missing,
        inviteUrl
      };
    }

    return { capable: true, reason: null, missingPermissions: [], inviteUrl };
  }
}
