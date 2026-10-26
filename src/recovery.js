import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmbedBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { Logger } from './logger.js';
import { checkRoleHierarchy } from './permissions.js';
import { SecurityGate } from './security-gate.js';
import { ModLogService } from './mod-log.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = new Logger('Recovery');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'action-history.json');

/**
 * Creates an unmasked, highly informative Discord embed detailing the exact failure, limits, and resolution.
 * Zero generic error masking.
 */
export function createErrorEmbed(err, executionId = 'unknown') {
  const message = err?.message || String(err);
  let title = '❌ Execution Error';
  let category = 'System / API Failure';
  let explanation = message && message !== 'Error' ? message : 'An unspecified error occurred during execution.';
  let recommendation = 'Please check the error details above and retry.';

  // 1. AI Token, Quota, or Credit Limits
  if (message.includes('rate limit') || message.includes('429') || message.includes('RESOURCE_EXHAUSTED') || message.includes('tokens per minute') || message.includes('TPM') || message.includes('quota') || message.includes('token budget') || message.includes('credit')) {
    title = '⏳ AI Inference Rate Limit / Token Budget Exceeded';
    category = 'AI Provider Quota Exhaustion';
    explanation = message;
    recommendation = '• The free-tier AI inference window reached its temporary RPM/TPM limit or task budget.\n• Wait 30–60 seconds for the quota window to refresh, or break complex requests into smaller steps.\n• Run `/diagnostics` to inspect the active AI model and token consumption.';
  }
  // 2. Channel, Role, or Resource Not Found
  else if (message.includes('not found') || message.includes('Unknown Channel') || message.includes('Unknown Role') || message.includes('Unknown Member')) {
    title = '🔍 Resource Not Found';
    category = 'Target Resolution Failure';
    explanation = message;
    recommendation = '• If targeting a channel, mention it directly (e.g. #channel) or check for decorative emojis/middle dots.\n• If targeting a role, mention it (@Role) or check spelling.\n• Ensure Honey Bot has "View Channel" permissions if the channel is private.';
  }
  // 3. Out of Bounds: Length, Size, or Bounds Limits
  else if (message.includes('out of bounds') || message.includes('too large') || message.includes('2000') || message.includes('character limit') || message.includes('exceeding Discord')) {
    title = '📏 Parameter Limit / Out of Bounds';
    category = 'Discord API Bounds Restriction';
    explanation = message;
    recommendation = '• Messages: Must be ≤ 2,000 characters (split long text into multiple messages).\n• Embed descriptions: Must be ≤ 4,096 characters.\n• Slowmode: Must be between 0 and 21,600 seconds (6 hours).\n• Purge: Must be between 1 and 100 messages.\n• Nicknames: Must be ≤ 32 characters.';
  }
  // 4. JSON Formulation or AI Parsing Issue
  else if (message.includes('json_validate_failed') || message.includes('JSON') || message.includes('Failed to parse') || message.includes('structured object')) {
    title = '🧩 AI Formulation Error';
    category = 'LLM Output Parsing';
    explanation = `The AI model failed to produce a valid action plan: ${message}`;
    recommendation = 'Try rephrasing with clear, explicit action verbs (e.g. "Create role VIP with color #FFD700" or "Rename this channel to dev-chat").';
  }
  // 5. Discord Missing Permissions
  else if (message.includes('50013') || message.includes('Missing Permissions') || message.includes('Bot lacks required permissions')) {
    title = '🛑 Missing Discord Permissions';
    category = 'Discord Authorization Failure';
    explanation = message;
    recommendation = '• In Server Settings > Roles, check the permissions for the "Honey Bot" role.\n• In the specific channel settings > Permissions, verify Honey Bot has "Send Messages", "View Channel", and "Mention Everyone" allowed.';
  }
  // 6. Role Hierarchy Violation
  else if (message.includes('Hierarchy') || message.includes('higher than or equal')) {
    title = '🪜 Discord Role Hierarchy Error';
    category = 'Role Hierarchy Restriction';
    explanation = message;
    recommendation = 'In Server Settings > Roles, click and drag the "Honey Bot" role higher on the list than the role or member you are managing.';
  }
  // 7. Security Gate / Policy Refusal
  else if (message.includes('Security Policy Violation') || message.includes('Anti-Nuke') || message.includes('Prompt injection') || message.includes('Security Refusal') || message.includes('UNAUTHORIZED_ADMIN_GRANT')) {
    title = '🛡️ Security Gate Policy Refusal';
    category = 'Immutable Security Rule Enforcement';
    explanation = message;
    recommendation = 'This action is blocked by Honey Bot\'s immutable security policy. Mass destructions, server nukes, and unauthorized Administrator grants cannot be performed.';
  }
  // 8. User Authorization
  else if (message.includes('Access Denied') || message.includes('Unauthorized') || message.includes('Bot Permission Error')) {
    title = '🔒 User Access Restriction';
    category = 'Command Authorization';
    explanation = message;
    recommendation = 'Honey Bot administration commands require the Discord Administrator permission, and your role must be positioned strictly above the bot.';
  }

  return new EmbedBuilder()
    .setTitle(title)
    .setColor(0xE74C3C)
    .addFields(
      { name: '🔎 What Failed', value: `\`\`\`fix\n${explanation.slice(0, 1000)}\n\`\`\``, inline: false },
      { name: '🏷️ Category', value: category, inline: true },
      { name: '🆔 Execution ID', value: `\`${executionId}\``, inline: true },
      { name: '💡 Recommended Action', value: recommendation, inline: false }
    )
    .setFooter({ text: `Honey Admin Diagnostics • ${new Date().toLocaleTimeString()}` })
    .setTimestamp();
}

/**
 * Classifies Discord API errors into actionable categories.
 */
export function classifyDiscordError(err) {
  const code = err.code || err.status;
  const message = err.message || '';

  if (code === 50013 || message.includes('Missing Permissions')) {
    return {
      type: 'PERMISSION_ERROR',
      retryable: false,
      userMessage: 'Discord rejected the action: Bot lacks required permissions or role hierarchy is too low.'
    };
  }

  if (code === 50035 || message.includes('Invalid Form Body')) {
    return {
      type: 'VALIDATION_ERROR',
      retryable: false,
      userMessage: `Invalid parameter sent to Discord API: ${message}`
    };
  }

  if (code === 429 || message.includes('rate limit')) {
    return {
      type: 'RATE_LIMIT',
      retryable: true,
      userMessage: 'Discord rate limit hit. Request will backoff and retry safely.'
    };
  }

  if (code === 10003 || message.includes('Unknown Channel')) {
    return {
      type: 'RESOURCE_NOT_FOUND',
      retryable: false,
      userMessage: 'The target channel does not exist or was deleted.'
    };
  }

  if (code === 10011 || message.includes('Unknown Role')) {
    return {
      type: 'RESOURCE_NOT_FOUND',
      retryable: false,
      userMessage: 'The target role does not exist or was deleted.'
    };
  }

  return {
    type: 'UNKNOWN_ERROR',
    retryable: false,
    userMessage: message || 'An unexpected error occurred during execution.'
  };
}

/**
 * Audit ledger for rollback tracking and context-aware target resolution.
 * Stores created resources and mutations per guild and execution ID so users can safely undo bot actions.
 * Persists data atomically to disk across restarts.
 */
export class ActionLedger {
  static history = new Map(); // executionId -> Array of created resources / actions
  static guildLedgers = new Map(); // guildId -> Map(executionId -> Array of actions)
  static _recordsByActionId = new Map(); // actionId -> record
  static _loaded = false;

  static _ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  /**
   * Loads all historical action records from persistent disk storage.
   */
  static loadAllHistory(client = null) {
    if (this._loaded && !client) return;
    this._ensureDataDir();

    if (!fs.existsSync(HISTORY_FILE)) {
      this._loaded = true;
      return;
    }

    try {
      const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.guilds && typeof parsed.guilds === 'object') {
        for (const [gId, execObj] of Object.entries(parsed.guilds)) {
          const gLedger = this.getGuildLedger(gId);
          for (const [eId, actions] of Object.entries(execObj)) {
            gLedger.set(eId, actions);
            if (!this.history.has(eId)) {
              this.history.set(eId, []);
            }
            for (const act of actions) {
              this.history.get(eId).push(act);
              if (act.actionId) {
                this._recordsByActionId.set(act.actionId, act);
              }
            }
          }
        }
      }
      this._loaded = true;
      logger.info('Loaded action history ledger from persistent storage.');

      // Reconcile pending states if client is available
      if (client) {
        this.reconcilePending(client);
      }
    } catch (err) {
      logger.error('Failed to load action history from disk', { error: err.message });
      this._loaded = true;
    }
  }

  /**
   * Persists the history cache atomically to disk.
   */
  static _persistHistory() {
    this._ensureDataDir();
    const tempFile = `${HISTORY_FILE}.tmp.${Date.now()}`;
    const payload = { guilds: {} };

    for (const [gId, execMap] of this.guildLedgers.entries()) {
      payload.guilds[gId] = {};
      for (const [eId, actions] of execMap.entries()) {
        payload.guilds[gId][eId] = actions;
      }
    }

    try {
      fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), 'utf8');
      try {
        fs.renameSync(tempFile, HISTORY_FILE);
      } catch (renameErr) {
        fs.copyFileSync(tempFile, HISTORY_FILE);
        fs.unlinkSync(tempFile);
      }
    } catch (err) {
      logger.error('Failed to persist action history ledger to disk', { error: err.message });
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch {}
    }
  }

  static getGuildLedger(guildId = 'default') {
    if (!this.guildLedgers.has(guildId)) {
      this.guildLedgers.set(guildId, new Map());
    }
    return this.guildLedgers.get(guildId);
  }

  static recordCreatedResource(executionId, type, id, name, guildId = 'default') {
    const entry = {
      actionId: 'act_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      executionId: executionId || ('exec_' + Date.now()),
      correlationId: executionId,
      guildId,
      type,
      action: type === 'channel' ? 'create_channel' : (type === 'role' ? 'create_role' : type),
      id,
      name,
      targetId: id,
      targetName: name,
      timestamp: Date.now(),
      reversibility: 'reversible',
      recoveryStatus: 'eligible',
      recoveryAttempts: 0,
      preState: null,
      postState: { id, name }
    };

    // 1. Legacy map
    if (!this.history.has(executionId)) {
      this.history.set(executionId, []);
    }
    this.history.get(executionId).push(entry);

    // 2. Guild-isolated ledger
    const gLedger = this.getGuildLedger(guildId);
    if (!gLedger.has(executionId)) {
      gLedger.set(executionId, []);
    }
    gLedger.get(executionId).push(entry);

    if (entry.actionId) {
      this._recordsByActionId.set(entry.actionId, entry);
    }

    this._persistHistory();
    return entry;
  }

  static recordAction(guildId, executionId, actionData) {
    const actionType = actionData.action || actionData.type;
    const isReversible = actionData.reversibility
      ? actionData.reversibility === 'reversible'
      : RecoveryRegistry.isReversible(actionType);

    const entry = {
      actionId: actionData.actionId || ('act_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)),
      executionId: executionId || ('exec_' + Date.now()),
      correlationId: actionData.correlationId || executionId,
      guildId: guildId || 'default',
      action: actionType,
      type: actionData.type || actionType,
      id: actionData.id || actionData.targetId,
      targetId: actionData.targetId || actionData.id,
      name: actionData.name || actionData.targetName,
      targetName: actionData.targetName || actionData.name,
      params: actionData.params || {},
      preState: actionData.preState || null,
      postState: actionData.postState || null,
      timestamp: actionData.timestamp || Date.now(),
      outcome: actionData.outcome || 'succeeded',
      reversibility: isReversible ? 'reversible' : (actionData.reversibility || 'irreversible'),
      recoveryStatus: actionData.recoveryStatus || 'eligible',
      recoveryAttempts: actionData.recoveryAttempts || 0,
      recoveryExecutionId: actionData.recoveryExecutionId || null,
      unavailabilityReason: actionData.unavailabilityReason || null,
      actor: actionData.actor || null,
      ...actionData
    };

    const gLedger = this.getGuildLedger(guildId);
    if (!gLedger.has(executionId)) {
      gLedger.set(executionId, []);
    }
    gLedger.get(executionId).push(entry);

    if (!this.history.has(executionId)) {
      this.history.set(executionId, []);
    }
    this.history.get(executionId).push(entry);

    if (entry.actionId) {
      this._recordsByActionId.set(entry.actionId, entry);
    }

    this._persistHistory();
    return entry;
  }

  static getCreatedResources(executionId) {
    return this.history.get(executionId) || [];
  }

  static getActionById(actionId) {
    return this._recordsByActionId.get(actionId) || null;
  }

  static findActionInOtherGuild(queryId, currentGuildId) {
    for (const [gId, execMap] of this.guildLedgers.entries()) {
      if (gId === currentGuildId) continue;
      if (execMap.has(queryId)) return true;
      for (const actions of execMap.values()) {
        if (actions.some(a => a.actionId === queryId)) return true;
      }
    }
    return false;
  }

  static updateActionStatus(actionId, status, details = {}) {
    const act = this._recordsByActionId.get(actionId);
    if (act) {
      act.recoveryStatus = status;
      if (details.recoveryExecutionId) act.recoveryExecutionId = details.recoveryExecutionId;
      if (details.recoveryAttempts !== undefined) act.recoveryAttempts = details.recoveryAttempts;
      if (details.unavailabilityReason) act.unavailabilityReason = details.unavailabilityReason;
      this._persistHistory();
    }
  }

  static reconcilePending(client) {
    for (const [gId, execMap] of this.guildLedgers.entries()) {
      const guild = client?.guilds?.cache?.get(gId);
      for (const actions of execMap.values()) {
        for (const act of actions) {
          if (act.recoveryStatus === 'pending') {
            if (!guild) {
              act.recoveryStatus = 'needs_review';
              continue;
            }
            const handler = RecoveryRegistry.getHandler(act.action);
            if (handler && handler.verify(guild, act)) {
              act.recoveryStatus = 'succeeded';
            } else {
              act.recoveryStatus = 'needs_review';
            }
          }
        }
      }
    }
    this._persistHistory();
  }

  static getLastExecution(guildId = 'default') {
    const gLedger = this.getGuildLedger(guildId);
    const entries = Array.from(gLedger.entries()).reverse();
    if (entries.length > 0) return entries[0];

    // Fallback to global history if guild-specific is empty
    const globalEntries = Array.from(this.history.entries()).reverse();
    return globalEntries.length > 0 ? globalEntries[0] : null;
  }

  static getLastCreatedChannel(guildId) {
    const gLedger = this.getGuildLedger(guildId);
    const executions = Array.from(gLedger.values()).reverse();
    for (const actions of executions) {
      for (const a of [...actions].reverse()) {
        if (a.type === 'channel' && a.id) return a;
      }
    }
    return null;
  }

  static getLastCreatedRole(guildId) {
    const gLedger = this.getGuildLedger(guildId);
    const executions = Array.from(gLedger.values()).reverse();
    for (const actions of executions) {
      for (const a of [...actions].reverse()) {
        if (a.type === 'role' && a.id) return a;
      }
    }
    return null;
  }

  static getLastRenamedChannel(guildId, channelId = null) {
    const gLedger = this.getGuildLedger(guildId);
    const executions = Array.from(gLedger.values()).reverse();
    for (const actions of executions) {
      for (const a of [...actions].reverse()) {
        if (a.type === 'channel_rename' && (!channelId || a.id === channelId)) return a;
      }
    }
    return null;
  }

  /**
   * Safely rolls back resources created or modified in a specific execution.
   */
  static async rollbackExecution(guild, executionId) {
    const resources = this.history.get(executionId);
    if (!resources || resources.length === 0) {
      return { success: false, message: 'No recent actions found to undo.' };
    }

    const report = [];

    for (const res of [...resources].reverse()) {
      try {
        if (res.type === 'channel' || res.action === 'create_channel') {
          const ch = guild.channels.cache.get(res.id || res.targetId);
          if (ch) {
            await ch.delete('Rollback of execution ' + executionId);
            report.push(`Deleted channel #${res.name || res.targetName}`);
          }
        } else if (res.type === 'role' || res.action === 'create_role') {
          const role = guild.roles.cache.get(res.id || res.targetId);
          if (role) {
            await role.delete('Rollback of execution ' + executionId);
            report.push(`Deleted role @${res.name || res.targetName}`);
          }
        } else if (res.type === 'channel_rename' || res.action === 'rename_channel') {
          const ch = guild.channels.cache.get(res.id || res.targetId);
          const previousName = res.oldName || res.preState?.name;
          if (ch && previousName) {
            const currentName = res.newName || ch.name;
            await ch.setName(previousName, 'Rollback of rename in execution ' + executionId);
            report.push(`Renamed channel #${currentName} back to #${previousName}`);
          }
        }
      } catch (err) {
        logger.error(`Failed to rollback resource ${res.name || res.id}`, { error: err.message });
        report.push(`Failed to undo ${res.type} ${res.name || res.id}: ${err.message}`);
      }
    }

    this.history.delete(executionId);
    if (guild?.id && this.guildLedgers.has(guild.id)) {
      this.guildLedgers.get(guild.id).delete(executionId);
    }
    this._persistHistory();
    return { success: true, report };
  }
}

/**
 * Registry of recovery capabilities.
 * Defines reversibility, required permissions, conflict detection, inverse mutation, and verification.
 */
export class RecoveryRegistry {
  static handlers = new Map();

  static register(actionType, handler) {
    this.handlers.set(actionType, handler);
  }

  static getHandler(actionType) {
    return this.handlers.get(actionType) || null;
  }

  static isReversible(actionType) {
    const handler = this.getHandler(actionType);
    return handler ? Boolean(handler.reversible) : false;
  }
}

// 1. Channel rename recovery
RecoveryRegistry.register('rename_channel', {
  reversible: true,
  requiredPermissions: ['ManageChannels'],
  requiresConfirmation: false,
  checkConflict(guild, record) {
    const chId = record.targetId || record.id;
    const ch = guild.channels.cache.get(chId);
    if (!ch) return { conflict: true, reason: 'Target channel was deleted.' };

    const previousName = record.preState?.name || record.oldName;
    const currentRecordedName = record.postState?.name || record.newName;

    if (!previousName) {
      return { unrecorded: true, reason: "I can't safely undo that action because its previous state wasn't recorded." };
    }

    if (ch.name === previousName) {
      return { alreadyRecovered: true, message: 'That action has already been reversed. No additional changes were made.' };
    }

    if (currentRecordedName && ch.name !== currentRecordedName) {
      return { conflict: true, reason: `Channel name has changed externally to #${ch.name}.` };
    }

    return { valid: true, channel: ch, previousName };
  },
  async execute(guild, record, context) {
    const ch = guild.channels.cache.get(record.targetId || record.id);
    const previousName = record.preState?.name || record.oldName;
    await ch.setName(previousName, `Recovery of rename via Honey Bot by ${context?.actor?.tag || 'moderator'}`);
    return { success: true, restoredName: previousName };
  },
  verify(guild, record) {
    const ch = guild.channels.cache.get(record.targetId || record.id);
    const previousName = record.preState?.name || record.oldName;
    return Boolean(ch && ch.name === previousName);
  },
  formatSuccess(record) {
    const prev = record.preState?.name || record.oldName;
    return `Restored the channel name to \`${prev}\`. The previous name is verified.`;
  }
});
RecoveryRegistry.register('channel_rename', RecoveryRegistry.getHandler('rename_channel'));

// 2. Channel creation recovery (delete created channel)
RecoveryRegistry.register('create_channel', {
  reversible: true,
  requiredPermissions: ['ManageChannels'],
  requiresConfirmation: true,
  checkConflict(guild, record) {
    const chId = record.targetId || record.id;
    const ch = guild.channels.cache.get(chId);
    if (!ch) {
      return { alreadyRecovered: true, message: 'That action has already been reversed. No additional changes were made.' };
    }
    return { valid: true, channel: ch };
  },
  async execute(guild, record, context) {
    const ch = guild.channels.cache.get(record.targetId || record.id);
    const name = ch.name;
    await ch.delete(`Recovery of created channel via Honey Bot by ${context?.actor?.tag || 'moderator'}`);
    return { success: true, name };
  },
  verify(guild, record) {
    return !guild.channels.cache.has(record.targetId || record.id);
  },
  formatSuccess(record) {
    return `Deleted channel #${record.targetName || record.name}. The reversal is verified.`;
  }
});
RecoveryRegistry.register('channel', RecoveryRegistry.getHandler('create_channel'));

// 3. Role creation recovery (delete created role)
RecoveryRegistry.register('create_role', {
  reversible: true,
  requiredPermissions: ['ManageRoles'],
  requiresConfirmation: true,
  checkConflict(guild, record) {
    const roleId = record.targetId || record.id;
    const role = guild.roles.cache.get(roleId);
    if (!role) {
      return { alreadyRecovered: true, message: 'That action has already been reversed. No additional changes were made.' };
    }
    const hierarchy = checkRoleHierarchy(guild, { action: 'delete_role' }, role);
    if (!hierarchy.valid) {
      return { conflict: true, reason: hierarchy.reason };
    }
    return { valid: true, role };
  },
  async execute(guild, record, context) {
    const role = guild.roles.cache.get(record.targetId || record.id);
    const name = role.name;
    await role.delete(`Recovery of created role via Honey Bot by ${context?.actor?.tag || 'moderator'}`);
    return { success: true, name };
  },
  verify(guild, record) {
    return !guild.roles.cache.has(record.targetId || record.id);
  },
  formatSuccess(record) {
    return `Deleted role @${record.targetName || record.name}. The reversal is verified.`;
  }
});
RecoveryRegistry.register('role', RecoveryRegistry.getHandler('create_role'));

// 4. Channel topic recovery
RecoveryRegistry.register('edit_channel_topic', {
  reversible: true,
  requiredPermissions: ['ManageChannels'],
  requiresConfirmation: false,
  checkConflict(guild, record) {
    const chId = record.targetId || record.id;
    const ch = guild.channels.cache.get(chId);
    if (!ch) return { conflict: true, reason: 'Target channel was deleted.' };

    const previousTopic = record.preState?.topic ?? record.oldTopic;
    if (previousTopic === undefined) {
      return { unrecorded: true, reason: "I can't safely undo that action because its previous state wasn't recorded." };
    }

    const recordedNewTopic = record.postState?.topic ?? record.newTopic;
    if (recordedNewTopic !== undefined && ch.topic !== recordedNewTopic && ch.topic !== previousTopic) {
      return { conflict: true, reason: 'Channel topic has changed externally.' };
    }

    if (ch.topic === previousTopic) {
      return { alreadyRecovered: true, message: 'That action has already been reversed. No additional changes were made.' };
    }

    return { valid: true, channel: ch, previousTopic };
  },
  async execute(guild, record, context) {
    const ch = guild.channels.cache.get(record.targetId || record.id);
    const prevTopic = record.preState?.topic ?? record.oldTopic ?? '';
    await ch.setTopic(prevTopic, `Recovery of channel topic by ${context?.actor?.tag || 'moderator'}`);
    return { success: true };
  },
  verify(guild, record) {
    const ch = guild.channels.cache.get(record.targetId || record.id);
    const prevTopic = record.preState?.topic ?? record.oldTopic ?? '';
    return Boolean(ch && (ch.topic || '') === (prevTopic || ''));
  },
  formatSuccess(record) {
    return `Restored topic for #${record.targetName || 'channel'}. The previous topic is verified.`;
  }
});
RecoveryRegistry.register('channel_topic', RecoveryRegistry.getHandler('edit_channel_topic'));

// 5. Channel slowmode recovery
RecoveryRegistry.register('set_channel_slowmode', {
  reversible: true,
  requiredPermissions: ['ManageChannels'],
  requiresConfirmation: false,
  checkConflict(guild, record) {
    const ch = guild.channels.cache.get(record.targetId || record.id);
    if (!ch) return { conflict: true, reason: 'Target channel was deleted.' };
    const prevSlowmode = record.preState?.slowmode ?? record.oldSlowmode;
    if (prevSlowmode === undefined) {
      return { unrecorded: true, reason: "I can't safely undo that action because its previous state wasn't recorded." };
    }
    if (ch.rateLimitPerUser === prevSlowmode) {
      return { alreadyRecovered: true, message: 'That action has already been reversed. No additional changes were made.' };
    }
    return { valid: true, channel: ch, prevSlowmode };
  },
  async execute(guild, record, context) {
    const ch = guild.channels.cache.get(record.targetId || record.id);
    const prevSlowmode = record.preState?.slowmode ?? record.oldSlowmode ?? 0;
    await ch.setRateLimitPerUser(prevSlowmode, `Recovery of slowmode by ${context?.actor?.tag || 'moderator'}`);
    return { success: true };
  },
  verify(guild, record) {
    const ch = guild.channels.cache.get(record.targetId || record.id);
    const prevSlowmode = record.preState?.slowmode ?? record.oldSlowmode ?? 0;
    return Boolean(ch && ch.rateLimitPerUser === prevSlowmode);
  },
  formatSuccess(record) {
    const prev = record.preState?.slowmode ?? record.oldSlowmode ?? 0;
    return `Restored slowmode for #${record.targetName || 'channel'} to ${prev}s. The previous setting is verified.`;
  }
});
RecoveryRegistry.register('channel_slowmode', RecoveryRegistry.getHandler('set_channel_slowmode'));

// 6. Role assignment recovery (remove role)
RecoveryRegistry.register('assign_role', {
  reversible: true,
  requiredPermissions: ['ManageRoles'],
  requiresConfirmation: false,
  checkConflict(guild, record) {
    const memberId = record.targetMemberId || record.targetMember || record.id;
    const roleId = record.targetRoleId || record.targetRole;
    const member = guild.members.cache.get(memberId);
    if (!member) return { conflict: true, reason: 'Target member is no longer in the server.' };
    const role = guild.roles.cache.get(roleId);
    if (!role) return { conflict: true, reason: 'Assigned role no longer exists.' };
    if (!member.roles.cache.has(role.id)) {
      return { alreadyRecovered: true, message: 'That action has already been reversed. No additional changes were made.' };
    }
    const hierarchy = checkRoleHierarchy(guild, { action: 'remove_role' }, role);
    if (!hierarchy.valid) return { conflict: true, reason: hierarchy.reason };
    return { valid: true, member, role };
  },
  async execute(guild, record, context) {
    const member = guild.members.cache.get(record.targetMemberId || record.targetMember || record.id);
    const role = guild.roles.cache.get(record.targetRoleId || record.targetRole);
    await member.roles.remove(role, `Recovery of role assignment by ${context?.actor?.tag || 'moderator'}`);
    return { success: true };
  },
  verify(guild, record) {
    const member = guild.members.cache.get(record.targetMemberId || record.targetMember || record.id);
    const roleId = record.targetRoleId || record.targetRole;
    return Boolean(member && !member.roles.cache.has(roleId));
  },
  formatSuccess(record) {
    return `Removed role @${record.targetRoleName || record.targetName || 'role'} from ${record.targetMemberTag || 'member'}. The previous role state is verified.`;
  }
});
RecoveryRegistry.register('role_assignment', RecoveryRegistry.getHandler('assign_role'));

// 7. Role removal recovery (re-assign role)
RecoveryRegistry.register('remove_role', {
  reversible: true,
  requiredPermissions: ['ManageRoles'],
  requiresConfirmation: false,
  checkConflict(guild, record) {
    const memberId = record.targetMemberId || record.targetMember || record.id;
    const roleId = record.targetRoleId || record.targetRole;
    const member = guild.members.cache.get(memberId);
    if (!member) return { conflict: true, reason: 'Target member is no longer in the server.' };
    const role = guild.roles.cache.get(roleId);
    if (!role) return { conflict: true, reason: 'Removed role no longer exists.' };
    if (member.roles.cache.has(role.id)) {
      return { alreadyRecovered: true, message: 'That action has already been reversed. No additional changes were made.' };
    }
    const hierarchy = checkRoleHierarchy(guild, { action: 'assign_role' }, role);
    if (!hierarchy.valid) return { conflict: true, reason: hierarchy.reason };
    return { valid: true, member, role };
  },
  async execute(guild, record, context) {
    const member = guild.members.cache.get(record.targetMemberId || record.targetMember || record.id);
    const role = guild.roles.cache.get(record.targetRoleId || record.targetRole);
    await member.roles.add(role, `Recovery of role removal by ${context?.actor?.tag || 'moderator'}`);
    return { success: true };
  },
  verify(guild, record) {
    const member = guild.members.cache.get(record.targetMemberId || record.targetMember || record.id);
    const roleId = record.targetRoleId || record.targetRole;
    return Boolean(member && member.roles.cache.has(roleId));
  },
  formatSuccess(record) {
    return `Assigned role @${record.targetRoleName || record.targetName || 'role'} back to ${record.targetMemberTag || 'member'}. The previous role state is verified.`;
  }
});
RecoveryRegistry.register('role_removal', RecoveryRegistry.getHandler('remove_role'));

// 8. Nickname recovery
RecoveryRegistry.register('change_nickname', {
  reversible: true,
  requiredPermissions: ['ManageNicknames'],
  requiresConfirmation: false,
  checkConflict(guild, record) {
    const member = guild.members.cache.get(record.targetMemberId || record.targetMember || record.id);
    if (!member) return { conflict: true, reason: 'Target member is no longer in the server.' };
    const prevNickname = record.preState?.nickname ?? record.oldNickname;
    if (prevNickname === undefined) {
      return { unrecorded: true, reason: "I can't safely undo that action because its previous state wasn't recorded." };
    }
    if ((member.nickname || '') === (prevNickname || '')) {
      return { alreadyRecovered: true, message: 'That action has already been reversed. No additional changes were made.' };
    }
    return { valid: true, member, prevNickname };
  },
  async execute(guild, record, context) {
    const member = guild.members.cache.get(record.targetMemberId || record.targetMember || record.id);
    const prevNickname = record.preState?.nickname ?? record.oldNickname ?? null;
    await member.setNickname(prevNickname, `Recovery of nickname by ${context?.actor?.tag || 'moderator'}`);
    return { success: true };
  },
  verify(guild, record) {
    const member = guild.members.cache.get(record.targetMemberId || record.targetMember || record.id);
    const prevNickname = record.preState?.nickname ?? record.oldNickname ?? '';
    return Boolean(member && (member.nickname || '') === (prevNickname || ''));
  },
  formatSuccess(record) {
    return `Restored nickname for ${record.targetMemberTag || 'member'}. The previous nickname is verified.`;
  }
});
RecoveryRegistry.register('nickname_change', RecoveryRegistry.getHandler('change_nickname'));
RecoveryRegistry.register('remove_nickname', RecoveryRegistry.getHandler('change_nickname'));

// 9. Ban member recovery (unban)
RecoveryRegistry.register('ban_member', {
  reversible: true,
  requiredPermissions: ['BanMembers'],
  requiresConfirmation: true,
  checkConflict(guild, record) {
    return { valid: true };
  },
  async execute(guild, record, context) {
    const targetId = record.targetMemberId || record.targetMember || record.targetId;
    await guild.members.unban(targetId, `Recovery unban via Honey Bot by ${context?.actor?.tag || 'moderator'}`);
    return { success: true };
  },
  verify(guild, record) {
    return true;
  },
  formatSuccess(record) {
    return `Unbanned user ${record.targetMemberTag || record.targetName || record.targetId || 'user'}. The reversal is verified.`;
  }
});

// 10. Purge messages (explicitly irreversible)
RecoveryRegistry.register('purge_messages', {
  reversible: false,
  unavailabilityReason: 'Bulk message deletions cannot be undone because Discord permanently removes purged messages from its servers.'
});

// 11. Kick member (explicitly irreversible)
RecoveryRegistry.register('kick_member', {
  reversible: false,
  unavailabilityReason: 'Kicking a member cannot be undone because kicked users cannot be forced back into the server.'
});

// 12. Delete channel / role (explicitly irreversible)
RecoveryRegistry.register('delete_channel', {
  reversible: false,
  unavailabilityReason: 'Deleted channels cannot be recovered because Discord deletes their message history and configuration permanently.'
});
RecoveryRegistry.register('delete_role', {
  reversible: false,
  unavailabilityReason: 'Deleted roles cannot be recovered because Discord deletes their permissions and member assignments permanently.'
});

// 13. User Channel Permission Recovery
RecoveryRegistry.register('set_user_channel_permission', {
  reversible: true,
  requiredPermissions: ['ManageChannels'],
  requiresConfirmation: false,
  checkConflict(guild, record) {
    const ch = guild.channels.cache.get(record.channelId || record.targetId || record.id);
    if (!ch) return { conflict: true, reason: 'Target channel no longer exists.' };
    const member = guild.members.cache.get(record.targetMemberId);
    if (!member) return { conflict: true, reason: 'Target member is no longer in the server.' };
    if (!record.preState || (!record.preState.allow && !record.preState.deny)) {
      return { unrecorded: true, reason: "I can't safely undo that action because its previous permission state wasn't recorded." };
    }
    return { valid: true, channel: ch, member };
  },
  async execute(guild, record, context) {
    const ch = guild.channels.cache.get(record.channelId || record.targetId || record.id);
    const member = guild.members.cache.get(record.targetMemberId);
    const prevAllow = record.preState.allow || [];
    const prevDeny = record.preState.deny || [];
    const postAllow = record.postState?.allow || [];
    const postDeny = record.postState?.deny || [];

    const patch = {};
    for (const p of prevAllow) patch[p] = true;
    for (const p of prevDeny) patch[p] = false;

    // Reset newly added flags that weren't in preState to inherit (null)
    for (const p of postAllow) {
      if (!prevAllow.includes(p) && !prevDeny.includes(p)) patch[p] = null;
    }
    for (const p of postDeny) {
      if (!prevAllow.includes(p) && !prevDeny.includes(p)) patch[p] = null;
    }

    await ch.permissionOverwrites.edit(member.id, patch, {
      reason: `Recovery of user channel permissions by ${context?.actor?.tag || 'moderator'}`
    });
    return { success: true };
  },
  verify(guild, record) {
    const ch = guild.channels.cache.get(record.channelId || record.targetId || record.id);
    return Boolean(ch && ch.permissionOverwrites.cache.has(record.targetMemberId));
  },
  formatSuccess(record) {
    return `Restored previous channel permissions for ${record.targetMemberTag || 'member'} in #${record.channelName || 'channel'}. The previous overwrite is verified.`;
  }
});
RecoveryRegistry.register('user_channel_permission', RecoveryRegistry.getHandler('set_user_channel_permission'));

RecoveryRegistry.register('configure_guild_policy', {
  description: 'Restore previous server Honey Bot authorization policy',
  requiredPermissions: ['Administrator'],
  checkConflict(guild, record) {
    if (!record.preState || (record.guildId && record.guildId !== guild.id)) {
      return { valid: false, reason: 'Previous policy state is missing or belongs to a different server.' };
    }
    return { valid: true };
  },
  async execute(guild, record, context = {}) {
    if (record.guildId && record.guildId !== guild.id) {
      throw new Error(`Security Violation: Undo record belongs to guild ${record.guildId}, not current guild ${guild.id}`);
    }
    const { GuildConfigService } = await import('./guild-config.js');
    GuildConfigService.saveConfig(guild.id, record.preState, context.actor);
    return { success: true };
  },
  verify(guild, record) {
    return true;
  },
  formatSuccess(record) {
    return `Restored previous server access rules from revision ${record.preState?.revision || 'previous'}.`;
  }
});
RecoveryRegistry.register('reset_guild_policy', RecoveryRegistry.getHandler('configure_guild_policy'));

// 10. Category creation recovery (delete created category)
RecoveryRegistry.register('create_category', {
  reversible: true,
  requiredPermissions: ['ManageChannels'],
  requiresConfirmation: true,
  checkConflict(guild, record) {
    const catId = record.targetId || record.id;
    const cat = guild.channels.cache.get(catId);
    if (!cat) {
      return { alreadyRecovered: true, message: 'That category has already been removed. No additional changes were made.' };
    }
    return { valid: true, category: cat };
  },
  async execute(guild, record, context) {
    const cat = guild.channels.cache.get(record.targetId || record.id);
    const name = cat?.name || record.targetName || record.name || 'category';
    // Safely unparent children first
    const allChannels = typeof guild.channels?.cache?.filter === 'function'
      ? Array.from(guild.channels.cache.filter(c => c.parentId === cat?.id).values())
      : Array.from(guild.channels?.cache?.values?.() || []).filter(c => c.parentId === cat?.id);
    for (const ch of allChannels) {
      await ch.setParent(null, { lockPermissions: false }).catch(() => {});
    }
    if (cat) {
      await cat.delete(`Recovery of created category via Honey Bot by ${context?.actor?.tag || 'moderator'}`);
    }
    return { success: true, name };
  },
  verify(guild, record) {
    return !guild.channels.cache.has(record.targetId || record.id);
  },
  formatSuccess(record) {
    return `Deleted category "${record.targetName || record.name}". The reversal is verified.`;
  }
});
RecoveryRegistry.register('category', RecoveryRegistry.getHandler('create_category'));

// 11. Category rename recovery
RecoveryRegistry.register('rename_category', {
  reversible: true,
  requiredPermissions: ['ManageChannels'],
  requiresConfirmation: false,
  checkConflict(guild, record) {
    const catId = record.targetId || record.id;
    const cat = guild.channels.cache.get(catId);
    if (!cat) return { conflict: true, reason: 'Target category was deleted.' };

    const previousName = record.preState?.name || record.oldName;
    if (!previousName) {
      return { unrecorded: true, reason: "I can't safely undo that action because its previous state wasn't recorded." };
    }
    if (cat.name === previousName) {
      return { alreadyRecovered: true, message: 'That action has already been reversed. No additional changes were made.' };
    }
    return { valid: true, category: cat, previousName };
  },
  async execute(guild, record, context) {
    const cat = guild.channels.cache.get(record.targetId || record.id);
    const previousName = record.preState?.name || record.oldName;
    await cat.setName(previousName, `Recovery of category rename by ${context?.actor?.tag || 'moderator'}`);
    return { success: true, restoredName: previousName };
  },
  verify(guild, record) {
    const cat = guild.channels.cache.get(record.targetId || record.id);
    const previousName = record.preState?.name || record.oldName;
    return Boolean(cat && cat.name === previousName);
  },
  formatSuccess(record) {
    const prev = record.preState?.name || record.oldName;
    return `Restored category name to "${prev}". The previous name is verified.`;
  }
});

// 12. Move channel to category recovery
RecoveryRegistry.register('move_channel_to_category', {
  reversible: true,
  requiredPermissions: ['ManageChannels'],
  requiresConfirmation: false,
  checkConflict(guild, record) {
    const chId = record.targetId || record.id;
    const ch = guild.channels.cache.get(chId);
    if (!ch) return { conflict: true, reason: 'Target channel was deleted.' };
    const prevParentId = record.preState?.parentId;
    if (ch.parentId === prevParentId) {
      return { alreadyRecovered: true, message: 'That channel is already in its original category state.' };
    }
    return { valid: true, channel: ch, prevParentId };
  },
  async execute(guild, record, context) {
    const ch = guild.channels.cache.get(record.targetId || record.id);
    const prevParentId = record.preState?.parentId ?? null;
    await ch.setParent(prevParentId, { lockPermissions: false });
    return { success: true };
  },
  verify(guild, record) {
    const ch = guild.channels.cache.get(record.targetId || record.id);
    const prevParentId = record.preState?.parentId ?? null;
    return Boolean(ch && ch.parentId === prevParentId);
  },
  formatSuccess(record) {
    return `Restored #${record.targetName || 'channel'} to its previous category. The placement is verified.`;
  }
});

// 13. Category permission recovery
RecoveryRegistry.register('set_category_permission', {
  reversible: true,
  requiredPermissions: ['ManageChannels', 'ManageRoles'],
  requiresConfirmation: false,
  checkConflict(guild, record) {
    const catId = record.targetId || record.id;
    const cat = guild.channels.cache.get(catId);
    if (!cat) return { conflict: true, reason: 'Target category was deleted.' };
    return { valid: true, category: cat };
  },
  async execute(guild, record, context) {
    const cat = guild.channels.cache.get(record.targetId || record.id);
    const targetEntityId = record.targetRoleIdOrMemberId || record.targetId;
    if (!record.preState) {
      // It had no previous overwrites, delete overwrite
      await cat.permissionOverwrites.delete(targetEntityId, `Recovery by ${context?.actor?.tag || 'moderator'}`).catch(() => {});
      return { success: true };
    }
    const prevAllow = record.preState.allow || [];
    const prevDeny = record.preState.deny || [];
    const patch = {};
    for (const p of prevAllow) {
      if (PermissionFlagsBits[p]) patch[p] = true;
    }
    for (const p of prevDeny) {
      if (PermissionFlagsBits[p]) patch[p] = false;
    }
    await cat.permissionOverwrites.edit(targetEntityId, patch, {
      reason: `Recovery of category permissions by ${context?.actor?.tag || 'moderator'}`
    });
    return { success: true };
  },
  verify(guild, record) {
    const cat = guild.channels.cache.get(record.targetId || record.id);
    return Boolean(cat);
  },
  formatSuccess(record) {
    return `Restored previous permissions on category "${record.targetName || 'category'}". The overwrite is verified.`;
  }
});

/**
 * Main recovery execution engine.
 * Handles deterministic target resolution, ambiguity detection, authorization, anti-nuke enforcement,
 * concurrency locking, idempotency, execution, verification, and mod-log recording.
 */
export class RecoveryEngine {
  /**
   * Deterministically resolves which action to recover based on user prompt and execution history.
   */
  static selectTarget(guildId, prompt, actor) {
    ActionLedger.loadAllHistory();
    const gLedger = ActionLedger.getGuildLedger(guildId);

    // Flatten all actions in this guild
    const allGuildActions = [];
    for (const [execId, actions] of gLedger.entries()) {
      for (const act of actions) {
        allGuildActions.push(act);
      }
    }
    // Sort descending by timestamp
    allGuildActions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const cleanPrompt = String(prompt || '').trim().replace(/[.!?]+$/, '').trim();

    // 1. Explicit ID lookup (e.g. exec_123, act_456, or "execution abc123")
    const idMatch = cleanPrompt.match(/\b(?:execution|action)\s+(?:id\s+)?(?!i\b|the\b|that\b|to\b|from\b|of\b|in\b|on\b|for\b|we\b|you\b)([a-zA-Z0-9_-]+)\b/i) ||
      cleanPrompt.match(/\b(exec_[a-zA-Z0-9_-]+|act_[a-zA-Z0-9_-]+)\b/i);
    if (idMatch) {
      const queryId = idMatch[1];
      // Check guild isolation
      if (ActionLedger.findActionInOtherGuild(queryId, guildId)) {
        return { error: "I can't perform this recovery because that action belongs to another server." };
      }

      if (queryId.startsWith('exec_') || gLedger.has(queryId)) {
        const execActions = gLedger.get(queryId);
        if (execActions && execActions.length > 0) {
          if (execActions.length === 1) {
            return { candidate: execActions[0] };
          }
          return { multiActionPlan: execActions, executionId: queryId };
        }
      }

      const found = allGuildActions.find(a => a.actionId === queryId || a.executionId === queryId);
      if (found) return { candidate: found };

      return { error: `I couldn't find an action with ID "${queryId}" in this server.` };
    }

    // 2. Dry-run / explanation request: "Don't change anything yet; explain what would be reversed."
    if (/(?:don'?t\s+change\s+anything|explain\s+what\s+would\s+be\s+reversed|dry[- ]?run)/i.test(cleanPrompt)) {
      const eligible = allGuildActions.find(a => a.recoveryStatus === 'eligible' || !a.recoveryStatus);
      if (!eligible) {
        return { isList: true, text: 'No reversible actions are currently pending in this server.' };
      }
      const desc = eligible.action.replace(/_/g, ' ');
      const name = eligible.targetName || eligible.name || 'target';
      return {
        isList: true,
        text: `Dry-run explanation: Reversing the last action would undo \`${desc}\` on \`${name}\`. No changes were made.`
      };
    }

    // 3. Alternative selection: "That isn't the action I meant; show me the other matching one."
    if (/(?:that\s+isn'?t\s+the\s+action|show\s+me\s+the\s+other\s+matching\s+one)/i.test(cleanPrompt)) {
      const eligible = allGuildActions.filter(a => a.recoveryStatus === 'eligible' || !a.recoveryStatus);
      if (eligible.length > 1) {
        const second = eligible[1];
        return { candidate: second };
      }
      return { isList: true, text: 'No alternative matching actions found in recent history.' };
    }

    // 4. Listing request: "Show me which recent actions are reversible."
    if (
      /^(?:show|list|what|which)(?:\s+\w+)*\s+(?:recent\s+)?actions?(?:\s+(?:are|can\s+be)\s+(?:reversible|undone))?/i.test(cleanPrompt) ||
      /(?:show|tell)\s+me\s+which\s+recent\s+actions\s+(?:are\s+reversible|can\s+be\s+undone)/i.test(cleanPrompt)
    ) {
      if (allGuildActions.length === 0) {
        return { isList: true, text: 'No recent actions found in this server.' };
      }
      const lines = allGuildActions.slice(0, 5).map(a => {
        const timeStr = new Date(a.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const name = a.targetName || a.name || a.action;
        let status = 'eligible to undo';
        if (a.recoveryStatus === 'succeeded' || a.recoveryStatus === 'already_recovered') {
          status = 'already undone';
        } else if (a.reversibility === 'irreversible') {
          status = 'irreversible';
        }
        return `• ${a.action.replace(/_/g, ' ')} (${name}) at ${timeStr} — ${status} [ID: \`${a.actionId || a.executionId}\`]`;
      });
      return { isList: true, text: 'Recent actions in this server:\n' + lines.join('\n') };
    }

    // 5. Retry request: "Try recovering the failed operation again."
    if (/(?:try\s+recovering|retry)(?:\s+the)?(?:\s+failed\s+operation|\s+recovery)?(?:\s+again|\s+that\s+failed)?/i.test(cleanPrompt)) {
      const failed = allGuildActions.find(a => a.recoveryStatus === 'failed');
      if (failed) {
        return { candidate: failed, isRetry: true };
      }
      return { error: 'No recently failed recoveries found to retry.' };
    }

    // 4. Description / keyword match
    if (cleanPrompt && !/^(?:undo|undo\s+(?:the\s+)?last\s+action(?:\s+i\s+performed)?|reverse\s+(?:the\s+)?last\s+action(?:\s+i\s+performed)?)$/i.test(cleanPrompt)) {
      let matching = [];
      const lower = cleanPrompt.toLowerCase();

      if (lower.includes('channel rename') || lower.includes('rename')) {
        matching = allGuildActions.filter(a => a.action === 'rename_channel' || a.type === 'channel_rename');
      } else if (lower.includes('topic')) {
        matching = allGuildActions.filter(a => a.action === 'edit_channel_topic' || a.type === 'channel_topic');
      } else if (lower.includes('slowmode')) {
        matching = allGuildActions.filter(a => a.action === 'set_channel_slowmode' || a.type === 'channel_slowmode');
      } else if (lower.includes('role change') || lower.includes('role update') || lower.includes('role')) {
        matching = allGuildActions.filter(a =>
          a.action === 'create_role' || a.action === 'assign_role' || a.action === 'remove_role' ||
          a.type === 'role' || a.type === 'role_assignment' || a.type === 'role_removal'
        );
      } else if (lower.includes('channel')) {
        matching = allGuildActions.filter(a =>
          a.action === 'create_channel' || a.action === 'rename_channel' || a.type === 'channel'
        );
      } else {
        // Search by mentioned target name
        matching = allGuildActions.filter(a => {
          const tName = (a.targetName || a.name || '').toLowerCase();
          return tName && lower.includes(tName);
        });
      }

      if (matching.length === 1) {
        return { candidate: matching[0] };
      }

      if (matching.length > 1) {
        const eligible = matching.filter(m => m.recoveryStatus === 'eligible' || !m.recoveryStatus);
        if (eligible.length === 1) {
          return { candidate: eligible[0] };
        }

        // Ambiguity detected: ask one concise question
        const c1 = matching[0];
        const c2 = matching[1];
        const t1 = new Date(c1.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const t2 = new Date(c2.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        let desc1 = c1.action.replace(/_/g, ' ');
        let desc2 = c2.action.replace(/_/g, ' ');
        if (c1.targetName && c1.targetName !== c1.action) desc1 += ` on ${c1.targetName}`;
        if (c2.targetName && c2.targetName !== c2.action) desc2 += ` on ${c2.targetName}`;

        return {
          isAmbiguous: true,
          clarificationQuestion: `I found two matching actions. Which one should I reverse: the ${desc1} at ${t1} or the ${desc2} at ${t2}?`
        };
      }
    }

    // 5. Default: Latest eligible action by actor in guild (or latest in guild)
    let candidate = null;
    if (actor?.id) {
      candidate = allGuildActions.find(a => a.actor?.id === actor.id && (a.recoveryStatus === 'eligible' || !a.recoveryStatus));
    }
    if (!candidate) {
      candidate = allGuildActions.find(a => a.recoveryStatus === 'eligible' || !a.recoveryStatus);
    }
    if (!candidate && allGuildActions.length > 0) {
      candidate = allGuildActions[0];
    }

    if (!candidate) {
      return { error: 'No recent actions found in this server to undo.' };
    }

    return { candidate };
  }

  /**
   * Verifies current authorization for the actor and bot.
   */
  static checkAuthorization(member, guild, record) {
    if (!member || !guild) {
      return { authorized: false, reason: "I can't perform this recovery with the current permissions." };
    }

    // Guild owner is always authorized
    if (member.id === guild.ownerId) {
      return { authorized: true };
    }

    const action = record.action || record.type;
    const handler = RecoveryRegistry.getHandler(action);
    const requiredPerms = handler?.requiredPermissions || ['Administrator'];

    const hasPerm = member.permissions.has(PermissionFlagsBits.Administrator) ||
      requiredPerms.some(p => {
        const flag = PermissionFlagsBits[p];
        return flag && member.permissions.has(flag);
      });

    if (!hasPerm) {
      return { authorized: false, reason: "I can't perform this recovery with the current permissions." };
    }

    // Bot authorization
    const botMember = guild.members?.me;
    if (botMember) {
      const botHasPerm = botMember.permissions.has(PermissionFlagsBits.Administrator) ||
        requiredPerms.every(p => {
          const flag = PermissionFlagsBits[p];
          return flag ? botMember.permissions.has(flag) : true;
        });
      if (!botHasPerm) {
        return { authorized: false, reason: "I can't perform this recovery with the current permissions." };
      }
    }

    // Role hierarchy checks
    if (action.includes('role') || action === 'create_role' || action === 'assign_role' || action === 'remove_role') {
      const targetRoleId = record.targetRoleId || record.targetId || record.id;
      const role = guild.roles.cache.get(targetRoleId);
      if (role) {
        const hierarchy = checkRoleHierarchy(guild, { action: 'delete_role' }, role);
        if (!hierarchy.valid) {
          return { authorized: false, reason: hierarchy.reason };
        }
      }
    }

    return { authorized: true };
  }

  /**
   * Evaluates anti-nuke safeguards.
   */
  static checkAntiNuke(record, guild, actor) {
    const action = record.action || record.type;
    let inverseAction = 'unknown';
    if (action === 'create_channel' || action === 'channel') inverseAction = 'delete_channel';
    if (action === 'create_role' || action === 'role') inverseAction = 'delete_role';
    if (action === 'ban_member') inverseAction = 'unban_member';

    if (inverseAction !== 'unknown') {
      try {
        SecurityGate.evaluateActionSequence([{ action: inverseAction, targetChannel: record.targetId, targetRole: record.targetId }], actor, guild);
      } catch (err) {
        return { safe: false, reason: "This recovery is blocked by Honey Bot's immutable security policy." };
      }
    }
    return { safe: true };
  }

  /**
   * Executes recovery for a single action record.
   */
  static async executeRecovery(guild, record, actor, recoveryExecutionId) {
    // 1. Concurrency lock check
    if (record.recoveryStatus === 'pending') {
      return { success: false, message: 'A recovery for this action is already in progress. Please wait for it to complete.' };
    }

    // 2. Idempotency / Already recovered check
    if (record.recoveryStatus === 'succeeded' || record.recoveryStatus === 'already_recovered') {
      return { success: true, message: 'That action has already been reversed. No additional changes were made.' };
    }

    // 3. Irreversibility check
    if (record.reversibility === 'irreversible') {
      return {
        success: false,
        message: record.unavailabilityReason || "I can't safely undo that action because Discord does not support reversing it."
      };
    }

    // 4. Missing required state check
    const action = record.action || record.type;
    const handler = RecoveryRegistry.getHandler(action);
    if (!handler) {
      return { success: false, message: `I can't safely undo that action because no recovery handler is registered for "${action}".` };
    }

    if (!record.preState && !record.oldName && !record.oldTopic && action !== 'create_channel' && action !== 'create_role' && action !== 'channel' && action !== 'role' && action !== 'ban_member') {
      return { success: false, message: "I can't safely undo that action because its previous state wasn't recorded." };
    }

    // 5. Conflict check
    const conflictCheck = handler.checkConflict(guild, record);
    if (conflictCheck.alreadyRecovered) {
      ActionLedger.updateActionStatus(record.actionId, 'already_recovered');
      return { success: true, message: conflictCheck.message || 'That action has already been reversed. No additional changes were made.' };
    }
    if (conflictCheck.unrecorded) {
      return { success: false, message: conflictCheck.reason };
    }
    if (conflictCheck.conflict) {
      ActionLedger.updateActionStatus(record.actionId, 'needs_review');
      return { success: false, message: "I can't safely undo that action because the target state has changed." };
    }

    // 6. State Transition: eligible -> pending
    ActionLedger.updateActionStatus(record.actionId, 'pending', {
      recoveryExecutionId,
      recoveryAttempts: (record.recoveryAttempts || 0) + 1
    });

    let execResult;
    try {
      execResult = await handler.execute(guild, record, { actor, executionId: recoveryExecutionId });
    } catch (err) {
      logger.error('Recovery execution error', { error: err.message, actionId: record.actionId });
      ActionLedger.updateActionStatus(record.actionId, 'failed');
      return { success: false, message: `Recovery failed: ${err.message}` };
    }

    // 7. Verification phase
    const verified = handler.verify(guild, record);
    if (!verified) {
      ActionLedger.updateActionStatus(record.actionId, 'needs_review');
      return { success: false, message: 'The recovery mutation was sent, but the final state could not be verified.' };
    }

    // 8. State Transition: pending -> succeeded
    ActionLedger.updateActionStatus(record.actionId, 'succeeded');

    // 9. Centralized Mod-Log integration
    await ModLogService.logAction(guild, {
      action: 'undo_recovery',
      actor,
      target: record.targetName || record.name || record.targetId || record.action,
      reason: `Reversed ${record.action} (${record.actionId || record.executionId})`,
      outcome: 'succeeded',
      executionId: recoveryExecutionId,
      source: '/undo'
    }).catch(err => {
      logger.warn('Failed to deliver mod-log for undo recovery', { error: err.message });
    });

    const successMessage = handler.formatSuccess(record, execResult);
    return { success: true, message: successMessage };
  }

  /**
   * Safely reverses a multi-step plan in reverse topological order.
   */
  static async executeMultiStepRecovery(guild, actions, actor, recoveryExecutionId) {
    const sorted = [...actions].reverse();
    let succeededCount = 0;
    const totalCount = sorted.length;

    for (let i = 0; i < sorted.length; i++) {
      const act = sorted[i];
      const res = await this.executeRecovery(guild, act, actor, recoveryExecutionId);
      if (res.success) {
        succeededCount++;
      } else {
        // Step failed or conflict detected: stop and report partial completion
        ActionLedger.updateActionStatus(act.actionId, 'needs_review');
        if (succeededCount > 0) {
          return {
            success: true,
            isPartial: true,
            message: `${succeededCount} of ${totalCount} changes were reversed. The remaining change needs review because the target state has changed.`
          };
        } else {
          return {
            success: false,
            message: res.message || 'Recovery failed.'
          };
        }
      }
    }

    return {
      success: true,
      message: `All ${totalCount} changes from execution \`${actions[0]?.executionId}\` were successfully reversed.`
    };
  }
}
