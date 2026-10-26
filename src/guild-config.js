import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = new Logger('GuildConfigService');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'guild-configs.json');

export class ConcurrencyConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConcurrencyConflictError';
  }
}

/**
 * Standard Capability Groups mapping broad category names to concrete action IDs.
 */
export const CAPABILITY_GROUPS = {
  moderation: [
    'timeout_member',
    'remove_timeout',
    'kick_member',
    'ban_member',
    'unban_member',
    'softban_member',
    'issue_warning',
    'inspect_warnings',
    'clear_warnings',
    'inspect_member_moderation'
  ],
  roles: [
    'create_role',
    'edit_role',
    'delete_role',
    'assign_role',
    'remove_role'
  ],
  channels: [
    'create_channel',
    'rename_channel',
    'delete_channel',
    'edit_channel_topic',
    'set_channel_slowmode',
    'lock_channel',
    'unlock_channel',
    'move_channel'
  ],
  permissions: [
    'set_user_channel_permission',
    'inspect_user_permissions'
  ],
  voice: [
    'voice_mute',
    'voice_unmute',
    'voice_deafen',
    'voice_undeafen',
    'voice_move',
    'voice_disconnect'
  ],
  warnings: [
    'issue_warning',
    'inspect_warnings',
    'clear_warnings'
  ],
  inspection: [
    'lookup_member',
    'inspect_member',
    'inspect_members',
    'inspect_nickname',
    'inspect_user_permissions',
    'inspect_member_moderation',
    'inspect_warnings',
    'inspect_guild_policy'
  ],
  messaging: [
    'send_message',
    'send_announcement',
    'pin_message',
    'unpin_message',
    'purge_messages',
    'search_messages'
  ],
  policy: [
    'configure_guild_policy',
    'inspect_guild_policy',
    'test_guild_policy',
    'reset_guild_policy'
  ],
  undo: [
    'execute_undo'
  ],
  diagnostics: [
    'inspect_diagnostics'
  ]
};

/**
 * Normalizes user-specified capability terms into authoritative action or group strings.
 */
export function normalizeCapabilities(inputList) {
  if (!Array.isArray(inputList)) return [];
  const normalized = new Set();

  for (const raw of inputList) {
    if (!raw || typeof raw !== 'string') continue;
    const clean = raw.trim().toLowerCase().replace(/[-_\s]+/g, '_');

    if (clean === '*' || clean === 'all' || clean === 'full') {
      normalized.add('*');
    } else if (clean === 'moderation' || clean === 'mod') {
      normalized.add('moderation');
    } else if (clean === 'ban' || clean === 'bans' || clean === 'banning' || clean === 'ban_member' || clean === 'ban_members') {
      normalized.add('ban_member');
      normalized.add('unban_member');
    } else if (clean === 'kick' || clean === 'kicks' || clean === 'kicking' || clean === 'kick_member' || clean === 'kick_members') {
      normalized.add('kick_member');
    } else if (clean === 'timeout' || clean === 'timeouts' || clean === 'mute' || clean === 'timeout_member' || clean === 'timeout_members') {
      normalized.add('timeout_member');
      normalized.add('remove_timeout');
    } else if (clean === 'warn' || clean === 'warning' || clean === 'warnings') {
      normalized.add('issue_warning');
      normalized.add('inspect_warnings');
      normalized.add('clear_warnings');
    } else if (clean === 'roles' || clean === 'role' || clean === 'role_management') {
      normalized.add('roles');
    } else if (clean === 'channels' || clean === 'channel' || clean === 'channel_management') {
      normalized.add('channels');
    } else if (clean === 'permissions' || clean === 'permission' || clean === 'channel_permissions') {
      normalized.add('permissions');
    } else if (clean === 'voice' || clean === 'voice_moderation') {
      normalized.add('voice');
    } else if (clean === 'inspection' || clean === 'inspect' || clean === 'view' || clean === 'read_only' || clean === 'inspect_member' || clean === 'inspect_members') {
      normalized.add('inspection');
    } else if (clean === 'messaging' || clean === 'messages' || clean === 'announcements') {
      normalized.add('messaging');
    } else if (clean === 'policy' || clean === 'policy_management' || clean === 'access_rules') {
      normalized.add('policy');
    } else {
      normalized.add(clean);
    }
  }

  return Array.from(normalized);
}

/**
 * Expands a list of capability tokens (which may include category names like 'moderation' or '*')
 * into a Set of individual action identifiers.
 */
export function expandCapabilities(capList) {
  const result = new Set();
  if (!Array.isArray(capList)) return result;

  for (const cap of capList) {
    if (cap === '*') {
      for (const actions of Object.values(CAPABILITY_GROUPS)) {
        for (const act of actions) {
          if (!CAPABILITY_GROUPS.policy.includes(act)) {
            result.add(act);
          }
        }
      }
    } else if (CAPABILITY_GROUPS[cap]) {
      for (const act of CAPABILITY_GROUPS[cap]) {
        result.add(act);
      }
    } else {
      result.add(cap);
    }
  }

  return result;
}

/**
 * Multi-Server Isolated Guild Configuration Service.
 * Ensures strict tenant boundaries per Discord guild ID.
 */
export class GuildConfigService {
  static _configs = new Map(); // guildId -> GuildConfig
  static _isLoaded = false;
  static _customStoragePath = null;

  static get cache() {
    return this._configs;
  }

  static get storagePath() {
    return this._customStoragePath || CONFIG_FILE;
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
   * Initializes or loads guild configurations from persistent storage.
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
          for (const [guildId, conf] of Object.entries(parsed)) {
            const valid = this.validateSchema(conf);
            if (valid) {
              this._configs.set(guildId, valid);
            } else {
              logger.warn(`Skipping invalid config schema for guild ${guildId}`);
            }
          }
        }
      }
      this._isLoaded = true;
    } catch (err) {
      logger.error('Failed to load guild configurations from disk', { error: err.message });
      this._configs.clear();
      this._isLoaded = true;
    }
    return this._configs;
  }

  /**
   * Generates a safe, unconfigured default configuration for a guild.
   */
  static getDefaultConfig(guildId) {
    if (!guildId || typeof guildId !== 'string') {
      throw new Error('Valid Discord guildId string is required to generate default config');
    }

    const now = new Date().toISOString();
    return {
      guildId,
      schemaVersion: 1,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      authorizationPolicy: {
        operatorRoles: {},     // roleId -> { roleId, roleName, capabilities: [], denyCapabilities: [] }
        operatorMembers: {},   // memberId -> { memberId, memberTag, capabilities: [], denyCapabilities: [] }
        policyAdmins: {
          roles: [],           // role IDs authorized to change bot access rules
          members: []          // member IDs authorized to change bot access rules
        },
        adminOnlyPolicyChanges: true,
        defaultDeny: true
      },
      featureSettings: {
        musicEnabled: true,
        moderationEnabled: true,
        loggingEnabled: true
      },
      moderationSettings: {
        defaultTimeoutMinutes: 10,
        warningThreshold: 3
      },
      approvalSettings: {
        requireConfirmationFor: [
          'ban_member',
          'kick_member',
          'delete_channel',
          'delete_role',
          'configure_guild_policy',
          'reset_guild_policy'
        ]
      },
      auditMetadata: {
        history: [
          {
            revision: 1,
            timestamp: now,
            guildId,
            actorId: 'system',
            actorTag: 'Honey Bot System',
            action: 'bootstrap_default',
            changes: 'Initialized default server isolation configuration'
          }
        ]
      }
    };
  }

  /**
   * Validates configuration schema conformance and migrates older schemas.
   */
  static validateSchema(conf) {
    if (!conf || typeof conf !== 'object') return null;
    if (typeof conf.guildId !== 'string' || !conf.guildId) return null;

    const schemaVersion = typeof conf.schemaVersion === 'number' ? Math.max(conf.schemaVersion, 1) : 1;
    const revision = typeof conf.revision === 'number' ? conf.revision : 1;

    const migrated = {
      guildId: conf.guildId,
      schemaVersion,
      revision,
      createdAt: conf.createdAt || new Date().toISOString(),
      updatedAt: conf.updatedAt || new Date().toISOString(),
      authorizationPolicy: conf.authorizationPolicy || {
        operatorRoles: {},
        operatorMembers: {},
        policyAdmins: { roles: [], members: [] },
        adminOnlyPolicyChanges: true,
        defaultDeny: true
      },
      featureSettings: conf.featureSettings || {
        musicEnabled: true,
        moderationEnabled: true,
        loggingEnabled: true
      },
      moderationSettings: conf.moderationSettings || {
        defaultTimeoutMinutes: 10,
        warningThreshold: 3
      },
      approvalSettings: conf.approvalSettings || {
        requireConfirmationFor: [
          'ban_member',
          'kick_member',
          'delete_channel',
          'delete_role',
          'configure_guild_policy',
          'reset_guild_policy'
        ]
      },
      auditMetadata: conf.auditMetadata || {
        history: []
      }
    };

    if (Array.isArray(migrated.auditMetadata)) {
      migrated.auditMetadata = { history: migrated.auditMetadata };
    } else if (!migrated.auditMetadata.history) {
      migrated.auditMetadata.history = [];
    }

    return migrated;
  }

  /**
   * Retrieves configuration for the given guild ID.
   * Scoped strictly to the authoritative guildId.
   */
  static getConfig(guildId) {
    if (!guildId || typeof guildId !== 'string') {
      throw new Error('Guild ID must be a non-empty string');
    }
    this.loadAllConfigs();

    let conf = this._configs.get(guildId);
    if (!conf) {
      conf = this.getDefaultConfig(guildId);
      this._configs.set(guildId, conf);
      this._persistAll();
    }

    // Always return a deep clone to prevent unintended in-memory mutation
    return JSON.parse(JSON.stringify(conf));
  }

  /**
   * Persists all guild configs atomically to disk.
   */
  static _persistAll() {
    this._ensureDataDir();
    const serializable = {};
    for (const [gId, conf] of this._configs.entries()) {
      serializable[gId] = conf;
    }

    const filePath = this.storagePath;
    const tmpFile = `${filePath}.tmp.${Date.now()}_${Math.random().toString(36).substring(7)}`;
    fs.writeFileSync(tmpFile, JSON.stringify(serializable, null, 2), 'utf8');
    fs.renameSync(tmpFile, filePath);
  }

  /**
   * Saves updated configuration for a specific guild.
   * Enforces guildId matching, schema validation, optimistic concurrency, and revision increments.
   */
  static saveConfig(guildId, updatedConfig, arg3 = null, arg4 = null) {
    if (!guildId || typeof guildId !== 'string') {
      throw new Error('Valid guildId is required to save configuration');
    }

    let actor = null;
    let expectedRevision = null;
    if (typeof arg3 === 'number') {
      expectedRevision = arg3;
      actor = arg4;
    } else {
      actor = arg3;
      expectedRevision = arg4;
    }

    this.loadAllConfigs();
    const current = this._configs.get(guildId) || this.getDefaultConfig(guildId);

    // Optimistic Concurrency Control
    if (expectedRevision !== null && expectedRevision !== undefined) {
      if (current.revision !== expectedRevision) {
        throw new ConcurrencyConflictError(
          `Configuration conflict: Expected revision ${expectedRevision}, but server configuration is at revision ${current.revision}. Please refresh and re-apply.`
        );
      }
    }

    if (updatedConfig.guildId && updatedConfig.guildId !== guildId) {
      throw new Error(`Cross-guild configuration leak prevented: Target ${guildId} does not match payload ${updatedConfig.guildId}`);
    }

    const nextRevision = (current.revision || 0) + 1;
    const now = new Date().toISOString();

    const actorId = actor?.id || 'unknown';
    const actorTag = actor?.tag || actor?.username || 'Administrator';

    const historyList = Array.isArray(current.auditMetadata?.history)
      ? [...current.auditMetadata.history]
      : (Array.isArray(current.auditMetadata) ? [...current.auditMetadata] : []);

    const auditEntry = {
      revision: nextRevision,
      timestamp: now,
      guildId,
      actorId,
      actorTag,
      action: updatedConfig._auditAction || 'update_policy',
      changes: updatedConfig._auditChanges || 'Updated guild policy settings'
    };

    delete updatedConfig._auditAction;
    delete updatedConfig._auditChanges;

    const merged = this.validateSchema({
      ...current,
      ...updatedConfig,
      guildId,
      revision: nextRevision,
      updatedAt: now,
      auditMetadata: {
        history: [auditEntry, ...historyList.slice(0, 49)]
      }
    });

    if (!merged) {
      throw new Error('Proposed configuration violates schema validation rules');
    }

    this._configs.set(guildId, merged);
    this._persistAll();
    logger.info(`Saved configuration for guild ${guildId}`, { revision: nextRevision, actor: actorTag });

    return JSON.parse(JSON.stringify(merged));
  }

  /**
   * Resets configuration for a guild to clean bootstrap defaults.
   */
  static resetConfig(guildId, actor = null) {
    this.loadAllConfigs();
    const fresh = this.getDefaultConfig(guildId);
    fresh._auditAction = 'reset_defaults';
    fresh._auditChanges = 'Reset server Honey Bot access configuration to defaults';
    return this.saveConfig(guildId, fresh, actor);
  }

  /**
   * Invalidates cached configuration for ONLY the specified guild, or all guilds if null.
   */
  static invalidateCache(guildId = null) {
    if (guildId) {
      this._configs.delete(guildId);
      logger.info(`Invalidated configuration cache for guild ${guildId}`);
    } else {
      this._configs.clear();
      this._isLoaded = false;
      logger.info('Invalidated all configuration cache');
    }
  }

  /**
   * Authorizes or updates a role in a guild's operator policy.
   */
  static authorizeRole(guildId, { roleId, roleName, capabilities = [], denyCapabilities = [] }, actor = null) {
    const config = this.getConfig(guildId);
    const policy = config.authorizationPolicy;

    const currentRole = policy.operatorRoles[roleId] || { roleId, roleName, capabilities: [], denyCapabilities: [] };
    const mergedCaps = Array.from(new Set([...currentRole.capabilities, ...normalizeCapabilities(capabilities)]));
    const mergedDeny = Array.from(new Set([...currentRole.denyCapabilities, ...normalizeCapabilities(denyCapabilities)]));

    // Remove any capabilities from allow list if they are in deny list
    const finalCaps = mergedCaps.filter(c => !mergedDeny.includes(c));

    policy.operatorRoles[roleId] = {
      roleId,
      roleName: roleName || currentRole.roleName || 'Role',
      capabilities: finalCaps,
      denyCapabilities: mergedDeny
    };

    config._auditAction = 'authorize_role';
    config._auditChanges = `Authorized role @${roleName || roleId} with capabilities: ${finalCaps.join(', ') || 'none'}`;
    return this.saveConfig(guildId, config, actor);
  }

  /**
   * Revokes all Honey Bot authorization for a role in a guild.
   */
  static revokeRole(guildId, roleId, actor = null) {
    const config = this.getConfig(guildId);
    const policy = config.authorizationPolicy;

    if (!policy.operatorRoles[roleId]) {
      return config; // No-op
    }

    const roleName = policy.operatorRoles[roleId].roleName || roleId;
    delete policy.operatorRoles[roleId];

    // Also remove from policyAdmins if present
    policy.policyAdmins.roles = (policy.policyAdmins.roles || []).filter(id => id !== roleId);

    config._auditAction = 'revoke_role';
    config._auditChanges = `Revoked Honey Bot authorization for role @${roleName}`;
    return this.saveConfig(guildId, config, actor);
  }

  /**
   * Removes specific capabilities from an authorized role in a guild.
   */
  static removeRoleCapability(guildId, roleId, capabilitiesToRemove = [], actor = null) {
    const config = this.getConfig(guildId);
    const policy = config.authorizationPolicy;

    if (!policy.operatorRoles[roleId]) {
      return config;
    }

    const toRemove = normalizeCapabilities(capabilitiesToRemove);
    const current = policy.operatorRoles[roleId];
    current.capabilities = current.capabilities.filter(c => !toRemove.includes(c));

    config._auditAction = 'modify_role_capabilities';
    config._auditChanges = `Removed capabilities (${toRemove.join(', ')}) from role @${current.roleName || roleId}`;
    return this.saveConfig(guildId, config, actor);
  }

  /**
   * Authorizes or updates a member-specific exception in a guild.
   */
  static authorizeMember(guildId, { memberId, memberTag, capabilities = [], denyCapabilities = [] }, actor = null) {
    const config = this.getConfig(guildId);
    const policy = config.authorizationPolicy;

    const currentMember = policy.operatorMembers[memberId] || { memberId, memberTag, capabilities: [], denyCapabilities: [] };
    const mergedCaps = Array.from(new Set([...currentMember.capabilities, ...normalizeCapabilities(capabilities)]));
    const mergedDeny = Array.from(new Set([...currentMember.denyCapabilities, ...normalizeCapabilities(denyCapabilities)]));
    const finalCaps = mergedCaps.filter(c => !mergedDeny.includes(c));

    policy.operatorMembers[memberId] = {
      memberId,
      memberTag: memberTag || currentMember.memberTag || 'Member',
      capabilities: finalCaps,
      denyCapabilities: mergedDeny
    };

    config._auditAction = 'authorize_member';
    config._auditChanges = `Configured member exception for ${memberTag || memberId} with capabilities: ${finalCaps.join(', ') || 'none'}`;
    return this.saveConfig(guildId, config, actor);
  }

  /**
   * Revokes a member-specific exception in a guild.
   */
  static revokeMember(guildId, memberId, actor = null) {
    const config = this.getConfig(guildId);
    const policy = config.authorizationPolicy;

    if (!policy.operatorMembers[memberId]) {
      return config;
    }

    const tag = policy.operatorMembers[memberId].memberTag || memberId;
    delete policy.operatorMembers[memberId];
    policy.policyAdmins.members = (policy.policyAdmins.members || []).filter(id => id !== memberId);

    config._auditAction = 'revoke_member';
    config._auditChanges = `Revoked member exception for ${tag}`;
    return this.saveConfig(guildId, config, actor);
  }

  /**
   * Configures policy administrators for a guild.
   */
  static setPolicyAdmins(guildId, { roles = [], members = [] }, actor = null) {
    const config = this.getConfig(guildId);
    const policy = config.authorizationPolicy;

    policy.policyAdmins = {
      roles: Array.from(new Set(roles)),
      members: Array.from(new Set(members))
    };

    config._auditAction = 'set_policy_admins';
    config._auditChanges = `Configured policy administrators: ${roles.length} roles, ${members.length} members`;
    return this.saveConfig(guildId, config, actor);
  }

  /**
   * Sets whether only native Discord Administrators can change Honey Bot access rules.
   */
  static setAdminOnlyPolicyChanges(guildId, adminOnly, actor = null) {
    const config = this.getConfig(guildId);
    config.authorizationPolicy.adminOnlyPolicyChanges = Boolean(adminOnly);
    config._auditAction = 'set_admin_only_policy_changes';
    config._auditChanges = `Set admin-only policy changes to: ${Boolean(adminOnly)}`;
    return this.saveConfig(guildId, config, actor);
  }
}
