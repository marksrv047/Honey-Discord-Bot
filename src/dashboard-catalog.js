import { GuildConfigService } from './guild-config.js';
import { ModLogService } from './mod-log.js';

/**
 * Authoritative Server Settings & Capability Catalog.
 * Each entry strictly documents:
 * - id: Stable setting identifier
 * - name: Human-readable name
 * - description: Detailed description
 * - category: Category grouping ('features', 'moderation', 'policy', 'modlog', 'security', 'honeypot')
 * - defaultValue: Default value when undefined
 * - supportedValues: Validation rules or acceptable options
 * - isEditable: Whether authorized users can modify this
 * - requiredAuth: Required role or Discord permission ('Administrator' | 'ManageGuild' | 'PolicyAdmin')
 * - requiresConfirmation: Whether changing this triggers a confirmation prompt
 * - sideEffects: Description of operational side effects
 * - persistenceBehavior: How and where this is stored
 * - isImplemented: Whether this is currently active in runtime
 * - limitations: Any Discord API or architectural limits
 */
export const SETTINGS_CATALOG = [
  // =========================================================================
  // 1. FEATURE TOGGLES
  // =========================================================================
  {
    id: 'features.moderationEnabled',
    name: 'Moderation Subsystem',
    description: 'Enables or disables timeout, warning, kick, and ban enforcement commands.',
    category: 'features',
    defaultValue: true,
    supportedValues: 'boolean (true | false)',
    isEditable: true,
    requiredAuth: 'Administrator',
    requiresConfirmation: true,
    sideEffects: 'Disables all automated and manual moderation enforcement when false.',
    persistenceBehavior: 'Persisted in guild-configs.json under featureSettings.moderationEnabled',
    isImplemented: true,
    limitations: 'Disabling moderation does not prevent Discord native server moderation.',
    getValue: (guildId) => {
      const conf = GuildConfigService.getConfig(guildId);
      return conf.featureSettings?.moderationEnabled ?? true;
    },
    setValue: (guildId, value, actor) => {
      const current = GuildConfigService.getConfig(guildId);
      return GuildConfigService.saveConfig(guildId, {
        ...current,
        featureSettings: {
          ...current.featureSettings,
          moderationEnabled: Boolean(value)
        },
        _auditAction: 'toggle_feature_moderation',
        _auditChanges: `Moderation feature ${Boolean(value) ? 'enabled' : 'disabled'}`
      }, actor);
    }
  },
  {
    id: 'features.musicEnabled',
    name: 'Music & Voice Subsystem',
    description: 'Enables or disables voice channel connections and audio playback.',
    category: 'features',
    defaultValue: true,
    supportedValues: 'boolean (true | false)',
    isEditable: true,
    requiredAuth: 'Administrator',
    requiresConfirmation: false,
    sideEffects: 'Immediately terminates active voice connections if set to false.',
    persistenceBehavior: 'Persisted in guild-configs.json under featureSettings.musicEnabled',
    isImplemented: true,
    limitations: 'Requires bot Connect and Speak permissions in voice channels.',
    getValue: (guildId) => {
      const conf = GuildConfigService.getConfig(guildId);
      return conf.featureSettings?.musicEnabled ?? true;
    },
    setValue: (guildId, value, actor) => {
      const current = GuildConfigService.getConfig(guildId);
      return GuildConfigService.saveConfig(guildId, {
        ...current,
        featureSettings: {
          ...current.featureSettings,
          musicEnabled: Boolean(value)
        },
        _auditAction: 'toggle_feature_music',
        _auditChanges: `Music & voice feature ${Boolean(value) ? 'enabled' : 'disabled'}`
      }, actor);
    }
  },
  {
    id: 'features.loggingEnabled',
    name: 'Audit Logging Subsystem',
    description: 'Enables or disables dispatching audit events to the configured modlog channel.',
    category: 'features',
    defaultValue: true,
    supportedValues: 'boolean (true | false)',
    isEditable: true,
    requiredAuth: 'Administrator',
    requiresConfirmation: false,
    sideEffects: 'Suppresses live log messages in Discord; internal ledger remains recorded.',
    persistenceBehavior: 'Persisted in guild-configs.json under featureSettings.loggingEnabled',
    isImplemented: true,
    limitations: 'Channel destination must still be valid when re-enabled.',
    getValue: (guildId) => {
      const conf = GuildConfigService.getConfig(guildId);
      return conf.featureSettings?.loggingEnabled ?? true;
    },
    setValue: (guildId, value, actor) => {
      const current = GuildConfigService.getConfig(guildId);
      return GuildConfigService.saveConfig(guildId, {
        ...current,
        featureSettings: {
          ...current.featureSettings,
          loggingEnabled: Boolean(value)
        },
        _auditAction: 'toggle_feature_logging',
        _auditChanges: `Audit logging feature ${Boolean(value) ? 'enabled' : 'disabled'}`
      }, actor);
    }
  },

  // =========================================================================
  // 2. MODERATION POLICIES
  // =========================================================================
  {
    id: 'moderation.defaultTimeoutMinutes',
    name: 'Default Timeout Duration',
    description: 'Standard timeout length in minutes applied when an instruction does not specify duration.',
    category: 'moderation',
    defaultValue: 10,
    supportedValues: 'Integer between 1 and 40320 (up to 28 days)',
    isEditable: true,
    requiredAuth: 'ManageGuild',
    requiresConfirmation: false,
    sideEffects: 'Applies to all subsequent timeout actions without explicit time specifiers.',
    persistenceBehavior: 'Persisted in guild-configs.json under moderationSettings.defaultTimeoutMinutes',
    isImplemented: true,
    limitations: 'Discord API caps maximum single timeout at 28 days (40320 minutes).',
    getValue: (guildId) => {
      const conf = GuildConfigService.getConfig(guildId);
      return conf.moderationSettings?.defaultTimeoutMinutes ?? 10;
    },
    setValue: (guildId, value, actor) => {
      const minutes = parseInt(value, 10);
      if (isNaN(minutes) || minutes < 1 || minutes > 40320) {
        throw new Error('Default timeout duration must be an integer between 1 and 40320 minutes.');
      }
      const current = GuildConfigService.getConfig(guildId);
      return GuildConfigService.saveConfig(guildId, {
        ...current,
        moderationSettings: {
          ...current.moderationSettings,
          defaultTimeoutMinutes: minutes
        },
        _auditAction: 'update_timeout_duration',
        _auditChanges: `Changed default timeout to ${minutes} minutes`
      }, actor);
    }
  },
  {
    id: 'moderation.warningThreshold',
    name: 'Warning Escalation Threshold',
    description: 'Number of recorded warnings before automated escalation or review is flagged.',
    category: 'moderation',
    defaultValue: 3,
    supportedValues: 'Integer between 1 and 20',
    isEditable: true,
    requiredAuth: 'ManageGuild',
    requiresConfirmation: false,
    sideEffects: 'Triggers notice on member lookup when warnings equal or exceed this threshold.',
    persistenceBehavior: 'Persisted in guild-configs.json under moderationSettings.warningThreshold',
    isImplemented: true,
    limitations: 'Does not trigger automatic bans unless explicitly authorized by server policy.',
    getValue: (guildId) => {
      const conf = GuildConfigService.getConfig(guildId);
      return conf.moderationSettings?.warningThreshold ?? 3;
    },
    setValue: (guildId, value, actor) => {
      const threshold = parseInt(value, 10);
      if (isNaN(threshold) || threshold < 1 || threshold > 20) {
        throw new Error('Warning threshold must be an integer between 1 and 20.');
      }
      const current = GuildConfigService.getConfig(guildId);
      return GuildConfigService.saveConfig(guildId, {
        ...current,
        moderationSettings: {
          ...current.moderationSettings,
          warningThreshold: threshold
        },
        _auditAction: 'update_warning_threshold',
        _auditChanges: `Changed warning threshold to ${threshold}`
      }, actor);
    }
  },
  {
    id: 'moderation.requireKickConfirmation',
    name: 'Kick Member Confirmation',
    description: 'Requires explicit interactive button confirmation before executing any member kick.',
    category: 'moderation',
    defaultValue: true,
    supportedValues: 'boolean (true | false)',
    isEditable: true,
    requiredAuth: 'Administrator',
    requiresConfirmation: false,
    sideEffects: 'Prevents one-shot accidental kick executions.',
    persistenceBehavior: 'Persisted in guild-configs.json under approvalSettings.requireConfirmationFor',
    isImplemented: true,
    limitations: 'Always required if the actor is not a server administrator.',
    getValue: (guildId) => {
      const conf = GuildConfigService.getConfig(guildId);
      const list = conf.approvalSettings?.requireConfirmationFor || [];
      return list.includes('kick_member');
    },
    setValue: (guildId, value, actor) => {
      const current = GuildConfigService.getConfig(guildId);
      const list = new Set(current.approvalSettings?.requireConfirmationFor || []);
      if (value) list.add('kick_member');
      else list.delete('kick_member');
      return GuildConfigService.saveConfig(guildId, {
        ...current,
        approvalSettings: {
          ...current.approvalSettings,
          requireConfirmationFor: Array.from(list)
        },
        _auditAction: 'update_approval_kick',
        _auditChanges: `${value ? 'Enabled' : 'Disabled'} kick confirmation requirement`
      }, actor);
    }
  },
  {
    id: 'moderation.requireBanConfirmation',
    name: 'Ban Member Confirmation',
    description: 'Requires explicit interactive button confirmation before executing any member ban.',
    category: 'moderation',
    defaultValue: true,
    supportedValues: 'boolean (true | false)',
    isEditable: true,
    requiredAuth: 'Administrator',
    requiresConfirmation: false,
    sideEffects: 'Prevents one-shot accidental ban executions.',
    persistenceBehavior: 'Persisted in guild-configs.json under approvalSettings.requireConfirmationFor',
    isImplemented: true,
    limitations: 'Immutable security policy requires confirmation for mass bans.',
    getValue: (guildId) => {
      const conf = GuildConfigService.getConfig(guildId);
      const list = conf.approvalSettings?.requireConfirmationFor || [];
      return list.includes('ban_member');
    },
    setValue: (guildId, value, actor) => {
      const current = GuildConfigService.getConfig(guildId);
      const list = new Set(current.approvalSettings?.requireConfirmationFor || []);
      if (value) list.add('ban_member');
      else list.delete('ban_member');
      return GuildConfigService.saveConfig(guildId, {
        ...current,
        approvalSettings: {
          ...current.approvalSettings,
          requireConfirmationFor: Array.from(list)
        },
        _auditAction: 'update_approval_ban',
        _auditChanges: `${value ? 'Enabled' : 'Disabled'} ban confirmation requirement`
      }, actor);
    }
  },

  // =========================================================================
  // 3. ROLES & BOT ACCESS POLICY
  // =========================================================================
  {
    id: 'policy.adminOnlyPolicyChanges',
    name: 'Administrator-Only Policy Changes',
    description: 'Restricts editing bot operator roles, capability assignments, and dashboard settings to server Administrators.',
    category: 'policy',
    defaultValue: true,
    supportedValues: 'boolean (true | false)',
    isEditable: true,
    requiredAuth: 'Administrator',
    requiresConfirmation: true,
    sideEffects: 'When true, non-admin members cannot alter bot permissions even if assigned an operator role.',
    persistenceBehavior: 'Persisted in guild-configs.json under authorizationPolicy.adminOnlyPolicyChanges',
    isImplemented: true,
    limitations: 'Server owner and Administrator permissions always supersede this toggle.',
    getValue: (guildId) => {
      const conf = GuildConfigService.getConfig(guildId);
      return conf.authorizationPolicy?.adminOnlyPolicyChanges ?? true;
    },
    setValue: (guildId, value, actor) => {
      const current = GuildConfigService.getConfig(guildId);
      return GuildConfigService.saveConfig(guildId, {
        ...current,
        authorizationPolicy: {
          ...current.authorizationPolicy,
          adminOnlyPolicyChanges: Boolean(value)
        },
        _auditAction: 'update_admin_only_policy',
        _auditChanges: `${value ? 'Restricted' : 'Relaxed'} policy changes to Administrators only`
      }, actor);
    }
  },
  {
    id: 'policy.defaultDeny',
    name: 'Default Deny Access Policy',
    description: 'Denies all administrative and destructive actions unless explicitly granted to an operator role.',
    category: 'policy',
    defaultValue: true,
    supportedValues: 'boolean (true | false)',
    isEditable: true,
    requiredAuth: 'Administrator',
    requiresConfirmation: true,
    sideEffects: 'When true, regular members without operator roles cannot execute any /go mutations.',
    persistenceBehavior: 'Persisted in guild-configs.json under authorizationPolicy.defaultDeny',
    isImplemented: true,
    limitations: 'Discord native Administrator permission always bypasses default deny.',
    getValue: (guildId) => {
      const conf = GuildConfigService.getConfig(guildId);
      return conf.authorizationPolicy?.defaultDeny ?? true;
    },
    setValue: (guildId, value, actor) => {
      const current = GuildConfigService.getConfig(guildId);
      return GuildConfigService.saveConfig(guildId, {
        ...current,
        authorizationPolicy: {
          ...current.authorizationPolicy,
          defaultDeny: Boolean(value)
        },
        _auditAction: 'update_default_deny',
        _auditChanges: `${value ? 'Enabled' : 'Disabled'} default-deny authorization policy`
      }, actor);
    }
  },

  // =========================================================================
  // 4. MODLOGGING CONFIGURATION
  // =========================================================================
  {
    id: 'modlog.channelId',
    name: 'Modlog Destination Channel',
    description: 'Authoritative Discord channel receiving structured moderation and server audit log embeds.',
    category: 'modlog',
    defaultValue: null,
    supportedValues: 'Discord Text or Announcement Channel ID within this guild',
    isEditable: true,
    requiredAuth: 'Administrator',
    requiresConfirmation: false,
    sideEffects: 'Redirects all audit embeds to the selected channel.',
    persistenceBehavior: 'Persisted in modlog-config.json under channelId',
    isImplemented: true,
    limitations: 'Bot must possess ViewChannel, SendMessages, and EmbedLinks in the designated channel.',
    getValue: (guildId) => {
      const conf = ModLogService.getConfig(guildId);
      return conf?.channelId || null;
    },
    setValue: async (guild, channelId, actor) => {
      const setRes = await ModLogService.setLogChannel(guild, channelId, actor?.tag || actor?.id || 'Dashboard');
      if (!setRes.success) {
        throw new Error(setRes.error || 'Failed to update modlog channel.');
      }
      return setRes.config;
    }
  },
  {
    id: 'modlog.enabled',
    name: 'Modlog Active Status',
    description: 'Whether moderation and administration audit logs are actively delivered to the channel.',
    category: 'modlog',
    defaultValue: false,
    supportedValues: 'boolean (true | false)',
    isEditable: true,
    requiredAuth: 'Administrator',
    requiresConfirmation: false,
    sideEffects: 'Halts live channel dispatches when disabled while retaining historical records.',
    persistenceBehavior: 'Persisted in modlog-config.json under enabled',
    isImplemented: true,
    limitations: 'Cannot be enabled if no channel is configured or channel permissions are missing.',
    getValue: (guildId) => {
      const conf = ModLogService.getConfig(guildId);
      return conf?.enabled ?? false;
    },
    setValue: async (guild, value, actor) => {
      if (value) {
        const enRes = await ModLogService.enableLogging(guild, actor?.tag || actor?.id || 'Dashboard');
        if (!enRes.success) throw new Error(enRes.error);
        return enRes.config;
      } else {
        const disRes = ModLogService.disableLogging(guild.id, actor?.tag || actor?.id || 'Dashboard');
        return disRes.config;
      }
    }
  },

  // =========================================================================
  // 5. SECURITY & HONEYPOT (ACCURATE RUNTIME DISCLOSURE)
  // =========================================================================
  {
    id: 'security.antiNukeProtection',
    name: 'Anti-Nuke Protection Barrier',
    description: 'Hardcoded safeguard preventing bulk mass-deletion of channels, roles, or unauthorized mass bans.',
    category: 'security',
    defaultValue: 'ACTIVE',
    supportedValues: 'Hardcoded immutable safety gate',
    isEditable: false,
    requiredAuth: 'None (Immutable)',
    requiresConfirmation: false,
    sideEffects: 'Automatically denies prompts attempting to nuke or delete more than threshold server assets.',
    persistenceBehavior: 'Embedded in security-gate.js; cannot be bypassed by any guild setting.',
    isImplemented: true,
    limitations: 'Permanently enforced in application source code for server safety.',
    getValue: () => 'ENFORCED (Immutable)',
    setValue: () => {
      throw new Error('Anti-nuke protections are immutable and cannot be disabled.');
    }
  },
  {
    id: 'honeypot.enabled',
    name: 'Honeypot Trap Monitoring',
    description: 'Automated monitoring of a decoy hidden channel to detect malicious bot scanners and token scrapers.',
    category: 'honeypot',
    defaultValue: 'UNAVAILABLE',
    supportedValues: 'None (Not implemented in current bot version)',
    isEditable: false,
    requiredAuth: 'None',
    requiresConfirmation: false,
    sideEffects: 'None. Notice: honeypot trigger is an investigation trigger, never proof of compromise.',
    persistenceBehavior: 'Not stored; feature subsystem is currently unavailable.',
    isImplemented: false,
    limitations: 'Honeypot security subsystem is not implemented in this bot release.',
    getValue: () => 'Not Implemented',
    setValue: () => {
      throw new Error('Honeypot feature is not implemented in this bot version.');
    }
  }
];

/**
 * Returns all settings belonging to a specific category.
 */
export function getSettingsByCategory(category) {
  return SETTINGS_CATALOG.filter(s => s.category === category);
}

/**
 * Returns a setting definition by stable setting ID.
 */
export function getSettingById(settingId) {
  return SETTINGS_CATALOG.find(s => s.id === settingId) || null;
}
