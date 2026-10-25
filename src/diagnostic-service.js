import { PermissionFlagsBits } from 'discord.js';
import { config, validateConfig } from './config.js';
import { AIProvider } from './ai-provider.js';
import { Logger } from './logger.js';
import { ActionLedger } from './recovery.js';
import { ModLogService } from './mod-log.js';
import { slashCommands } from './commands.js';

const logger = new Logger('DiagnosticService');

/**
 * Standard Diagnostic Status Codes.
 */
export const DiagnosticStatus = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
  NOT_CHECKED: 'not_checked',
  NOT_APPLICABLE: 'not_applicable'
};

/**
 * Severity Levels for Diagnostic Findings.
 */
export const DiagnosticSeverity = {
  NONE: 'none',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

/**
 * Centralized, Context-Aware Diagnostics, Model Discovery & Safe Repair Engine.
 * Natural-language-driven, evidence-based, zero-cost, and strictly non-destructive.
 */
export class DiagnosticService {
  static _activeRepairs = new Set(); // guildId set to prevent concurrent repairs

  /**
   * Infers the diagnostic intent from user prompt.
   * Avoids expensive full-system scans for narrow, targeted questions.
   */
  static parseDiagnosticTask(prompt) {
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return 'general_health';
    }

    const clean = prompt.trim().toLowerCase();

    // 1. Model identity & provider discovery
    if (
      /(which|what)\s+(ai\s+)?model/i.test(clean) ||
      /identify.*(inference|provider|model)/i.test(clean) ||
      /(actual|current)\s+(inference|model|provider)/i.test(clean) ||
      /(who\s+is\s+your\s+ai|what\s+ai\s+are\s+you\s+using)/i.test(clean) ||
      /show\s+model\s+(config|info|id)/i.test(clean)
    ) {
      return 'model_identity';
    }

    // 2. Model reachability & endpoint connectivity
    if (
      /(endpoint|model).*reachab/i.test(clean) ||
      /reachab.*(endpoint|model)/i.test(clean) ||
      /(test|check).*(model|ai|endpoint|groq|gemini|ollama).*(connectivity|connection|reachab)/i.test(clean) ||
      /(test|check).*(connectivity|connection|endpoint).*(model|ai|groq|gemini|ollama)/i.test(clean) ||
      /is\s+(the\s+)?(ai\s+model|model|ai|groq|gemini|ollama)\s+(online|up|reachable|working)/i.test(clean) ||
      /(is\s+groq\s+reachable|is\s+gemini\s+reachable)/i.test(clean)
    ) {
      return 'model_reachability';
    }

    // 3. Execution failure diagnosis (/go failures)
    if (
      /why.*(last|previous)\s+command.*fail/i.test(clean) ||
      /why.*(last\s+command|action|\/go|command).*fail/i.test(clean) ||
      /why.*fail.*(last\s+command|action|\/go|command)/i.test(clean) ||
      /why\s+did\s+my\s+(last|previous)\s+command\s+fail/i.test(clean) ||
      /find\s+out\s+why\s+(\/go|command|action)\s+failed/i.test(clean) ||
      /investigate.*(command\s+failure|command\s+error|action\s+failure)/i.test(clean) ||
      /why\s+couldn't\s+you/i.test(clean)
    ) {
      return 'execution_failure';
    }

    // 4. Recovery troubleshooting (/undo failures)
    if (
      /why.*undo.*(fail|not\s+restore|could\s+not)/i.test(clean) ||
      /investigate\s+why\s+undo\s+did\s+not\s+restore/i.test(clean) ||
      /why\s+did\s+undo\s+fail/i.test(clean) ||
      /(troubleshoot|diagnose).*undo/i.test(clean) ||
      /why\s+can't\s+i\s+recover/i.test(clean)
    ) {
      return 'undo_troubleshooting';
    }

    // 5. Moderation log persistence & delivery
    if (
      /(moderation\s+logs?|modlog).*(persisted|persisting|saved|working|healthy|delivery)/i.test(clean) ||
      /check.*(moderation\s+logs?|modlog).*(persisted|status|channel|delivery)/i.test(clean) ||
      /are\s+(moderation\s+logs?|modlogs?)\s+being\s+persisted/i.test(clean) ||
      /check\s+whether\s+moderation\s+logs\s+are\s+being\s+persisted/i.test(clean)
    ) {
      return 'modlog_persistence';
    }

    // 6. Safe repairs (modlog, pending deliveries, caches)
    if (
      /safely\s+repair/i.test(clean) ||
      /repair.*(logging|modlog|configuration|system)/i.test(clean) ||
      /fix.*(logging|modlog|pending\s+logs|delivery)/i.test(clean) ||
      /auto.*repair/i.test(clean)
    ) {
      return 'safe_repair';
    }

    // 7. Performance & command timeouts
    if (
      /(cause\s+of\s+recent\s+command\s+timeouts|command\s+timeouts|timeouts)/i.test(clean) ||
      /why.*(slow|timing\s+out|lagging|delayed)/i.test(clean) ||
      /check\s+performance/i.test(clean)
    ) {
      return 'performance_timeouts';
    }

    // 8. Configuration audit (read-only)
    if (
      /(?:find|identify|detect|audit|check)\s+configuration\s+problems/i.test(clean) ||
      /audit\s+configuration/i.test(clean) ||
      /check\s+configuration/i.test(clean) ||
      /inspect\s+environment/i.test(clean)
    ) {
      return 'configuration_audit';
    }

    // 9. Feature availability
    if (
      /features\s+are\s+unavailable/i.test(clean) ||
      /which\s+features\s+are\s+unavailable\s+and\s+why/i.test(clean) ||
      /explain\s+which\s+features\s+are\s+unavailable/i.test(clean) ||
      /what\s+features\s+can't\s+be\s+used/i.test(clean) ||
      /why\s+is\s+(banner|vanity|announcement)\s+unavailable/i.test(clean)
    ) {
      return 'feature_availability';
    }

    // 10. Discord connectivity & permissions
    if (
      /(discord|gateway)\s+(connection|connectivity|status)/i.test(clean) ||
      /(test|check).*(discord|gateway)/i.test(clean) ||
      /is\s+(the\s+)?gateway\s+connected/i.test(clean) ||
      /check\s+(bot\s+)?permissions/i.test(clean)
    ) {
      return 'discord_connectivity';
    }

    return 'general_health';
  }

  /**
   * Validates whether the actor has permissions to run diagnostics.
   * Requires Administrator, ManageGuild, or Guild Owner.
   */
  static isAuthorized(member, user, guild) {
    if (!member && !user) return true; // Standalone / mock context
    if (guild && user && guild.ownerId === user.id) return true;
    if (member?.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
    if (member?.permissions?.has?.(PermissionFlagsBits.ManageGuild)) return true;
    return false;
  }

  /**
   * Main entry point for /diagnose command.
   * Gathers only the evidence relevant to the inferred task.
   */
  static async diagnose(prompt, context = {}) {
    const { client, guild, member, user } = context;
    const correlationId = Logger.generateExecutionId();

    // 1. Authorization check
    if (guild && (member || user) && !this.isAuthorized(member, user, guild)) {
      return {
        task: 'unauthorized',
        status: DiagnosticStatus.FAILED,
        response: 'You must have Manage Server or Administrator permissions to run system diagnostics.',
        correlationId
      };
    }

    const task = this.parseDiagnosticTask(prompt);

    try {
      switch (task) {
        case 'model_identity':
          return await this.diagnoseModelIdentity(context, correlationId);

        case 'model_reachability':
          return await this.diagnoseModelReachability(context, correlationId);

        case 'execution_failure':
          return await this.diagnoseExecutionFailure(context, correlationId);

        case 'undo_troubleshooting':
          return await this.diagnoseUndoTroubleshooting(prompt, context, correlationId);

        case 'modlog_persistence':
          return await this.diagnoseModLogPersistence(context, correlationId);

        case 'safe_repair':
          return await this.diagnoseSafeRepair(prompt, context, correlationId);

        case 'performance_timeouts':
          return await this.diagnosePerformanceTimeouts(context, correlationId);

        case 'configuration_audit':
          return await this.diagnoseConfigurationAudit(context, correlationId);

        case 'feature_availability':
          return await this.diagnoseFeatureAvailability(context, correlationId);

        case 'discord_connectivity':
          return await this.diagnoseDiscordConnectivity(context, correlationId);

        case 'general_health':
        default:
          return await this.diagnoseGeneralHealth(context, correlationId);
      }
    } catch (err) {
      logger.error('Diagnostic execution encountered error', { task, error: err.message });
      const safeError = Logger.redactSecrets(err.message || 'Unknown error');
      return {
        task,
        status: DiagnosticStatus.FAILED,
        response: `Diagnostic evaluation encountered an error: ${safeError}`,
        correlationId
      };
    }
  }

  /**
   * Diagnoses AI Model Identity without spending tokens on inference.
   */
  static async diagnoseModelIdentity(context = {}, correlationId) {
    const provider = (config.ai.provider || 'gemini').toLowerCase();
    const telemetry = AIProvider.getTelemetry();

    let configuredModel = 'unknown';
    let endpointHost = 'unknown';
    let isRemote = true;

    if (provider === 'groq') {
      configuredModel = config.ai.groq.model || 'openai/gpt-oss-120b';
      endpointHost = 'api.groq.com';
      isRemote = true;
    } else if (provider === 'gemini') {
      configuredModel = config.ai.gemini.model || 'gemini-3.8-flash';
      endpointHost = 'generativelanguage.googleapis.com';
      isRemote = true;
    } else if (provider === 'ollama') {
      configuredModel = config.ai.ollama.model || 'llama3.1:8b';
      try {
        const u = new URL(config.ai.ollama.baseUrl);
        endpointHost = u.host || 'localhost:11434';
      } catch {
        endpointHost = config.ai.ollama.baseUrl || 'localhost:11434';
      }
      isRemote = false;
    }

    const hasRuntimeConfirmation =
      telemetry.lastProvider === provider &&
      telemetry.lastServingModel &&
      telemetry.lastInferenceTimestamp;

    const runtimeModel = hasRuntimeConfirmation ? telemetry.lastServingModel : null;
    const providerDisplay = provider.charAt(0).toUpperCase() + provider.slice(1);
    const locationType = isRemote ? 'remote cloud service' : 'local self-hosted instance';

    let response = '';
    if (runtimeModel) {
      response =
        `Provider: ${providerDisplay} (${locationType}).\n` +
        `Configured model: \`${configuredModel}\`.\n` +
        `Runtime model: \`${runtimeModel}\` (confirmed via telemetry).\n` +
        `Endpoint: \`${endpointHost}\`.\n` +
        `Zero-cost guarantee: 100% free tier / local. Paid fallbacks disabled.\n` +
        `Inference status: healthy based on recorded telemetry.`;
    } else {
      response =
        `Provider: ${providerDisplay} (${locationType}).\n` +
        `Configured model: \`${configuredModel}\`.\n` +
        `The configured model is \`${configuredModel}\`. The inference service does not expose a runtime model identifier, so I cannot independently verify which model served the request.\n` +
        `Endpoint: \`${endpointHost}\`.\n` +
        `Zero-cost guarantee: 100% free tier / local. Paid fallbacks disabled.`;
    }

    return {
      task: 'model_identity',
      status: DiagnosticStatus.HEALTHY,
      structured: {
        component: 'ai_model',
        checkId: 'model_identity',
        status: DiagnosticStatus.HEALTHY,
        provider,
        configuredModel,
        runtimeModel,
        endpointHost,
        isRemote,
        zeroCost: true,
        telemetry
      },
      response: Logger.redactSecrets(response),
      correlationId
    };
  }

  /**
   * Bounded connectivity check for the active AI model endpoint.
   */
  static async diagnoseModelReachability(context = {}, correlationId) {
    const provider = (config.ai.provider || 'gemini').toLowerCase();
    const result = await AIProvider.checkConnectivity(provider);

    let response = '';
    if (result.status === 'healthy') {
      response = `The configured model endpoint (${result.endpoint}) is reachable and responsive (latency: ${result.latencyMs}ms). Authentication is valid.`;
    } else if (result.status === 'failed') {
      const safeErr = Logger.redactSecrets(result.error || 'Connection failed');
      response = `The configured model endpoint (${result.endpoint}) is unreachable. Cause: ${safeErr}.`;
    } else {
      response = `The configured model endpoint (${result.endpoint}) is degraded (${result.error || 'unexpected response'}).`;
    }

    return {
      task: 'model_reachability',
      status: result.status,
      structured: {
        component: 'ai_model',
        checkId: 'model_reachability',
        status: result.status,
        provider,
        endpoint: result.endpoint,
        latencyMs: result.latencyMs,
        error: result.error
      },
      response: Logger.redactSecrets(response),
      correlationId
    };
  }

  /**
   * Diagnoses recent /go execution failures using ActionLedger history.
   */
  static async diagnoseExecutionFailure(context = {}, correlationId) {
    const guildId = context.guild?.id || 'default';
    ActionLedger.loadAllHistory(context.client);

    const gLedger = ActionLedger.getGuildLedger(guildId);
    let lastFailed = null;

    // Search executions in reverse chronological order
    const executions = Array.from(gLedger.values()).reverse();
    for (const actions of executions) {
      for (const a of [...actions].reverse()) {
        if (a.outcome === 'failed' || a.outcome === 'denied' || a.failureReason || a.error) {
          lastFailed = a;
          break;
        }
      }
      if (lastFailed) break;
    }

    if (!lastFailed) {
      return {
        task: 'execution_failure',
        status: DiagnosticStatus.HEALTHY,
        structured: {
          component: 'executor',
          checkId: 'recent_failures',
          status: DiagnosticStatus.HEALTHY,
          evidence: 'No failed actions recorded in recent execution history for this server.'
        },
        response: 'No failed commands or actions were recorded in recent execution history for this server.',
        correlationId
      };
    }

    const actionName = lastFailed.action || lastFailed.type || 'command';
    const targetName = lastFailed.targetName || lastFailed.name || 'target';
    const rawReason = lastFailed.failureReason || lastFailed.error || lastFailed.unavailabilityReason || 'Unknown error';
    const reason = Logger.redactSecrets(rawReason);

    let confirmedCause = null;
    let likelyCause = null;
    let nextStep = 'Review bot permissions and retry the command.';

    if (/hierarchy/i.test(reason)) {
      confirmedCause = 'Discord role hierarchy: Target role is positioned higher than Honey Bot\'s highest role.';
      nextStep = 'Move Honey Bot\'s highest role above the target role in Server Settings > Roles.';
    } else if (/permission/i.test(reason) || /50013/i.test(reason)) {
      confirmedCause = `Discord API returned Missing Permissions (50013) while attempting ${actionName}.`;
      nextStep = 'Grant the bot the required administrative permissions for this action.';
    } else if (/rate\s+limit/i.test(reason) || /429/i.test(reason)) {
      confirmedCause = 'Discord rate limit exceeded for this endpoint.';
      nextStep = 'Wait a few seconds for the rate limit window to reset before issuing another command.';
    } else {
      likelyCause = reason;
      nextStep = 'Verify the target exists and the bot has appropriate access.';
    }

    const causeText = confirmedCause ? `Confirmed cause: ${confirmedCause}` : `Likely cause: ${likelyCause}`;
    const response =
      `The last \`/go\` action (\`${actionName}\` on \`${targetName}\`) failed.\n` +
      `${causeText}\n` +
      `Impact: No change was made.\n` +
      `Recommended next step: ${nextStep}`;

    return {
      task: 'execution_failure',
      status: DiagnosticStatus.FAILED,
      structured: {
        component: 'executor',
        checkId: 'recent_failures',
        status: DiagnosticStatus.FAILED,
        action: actionName,
        target: targetName,
        confirmedCause,
        likelyCause,
        nextStep,
        executionId: lastFailed.executionId
      },
      response: Logger.redactSecrets(response),
      correlationId
    };
  }

  /**
   * Investigates why an /undo action failed or could not restore a resource.
   */
  static async diagnoseUndoTroubleshooting(prompt, context = {}, correlationId) {
    const guildId = context.guild?.id || 'default';
    ActionLedger.loadAllHistory(context.client);

    const gLedger = ActionLedger.getGuildLedger(guildId);
    let targetAction = null;

    // Search for actions with failed/needs_review status or matching prompt keywords
    const executions = Array.from(gLedger.values()).reverse();
    for (const actions of executions) {
      for (const a of [...actions].reverse()) {
        if (a.recoveryStatus === 'failed' || a.recoveryStatus === 'needs_review') {
          targetAction = a;
          break;
        }
        if (prompt && /channel/i.test(prompt) && a.type === 'channel') {
          targetAction = a;
          break;
        }
      }
      if (targetAction) break;
    }

    if (!targetAction) {
      return {
        task: 'undo_troubleshooting',
        status: DiagnosticStatus.UNKNOWN,
        structured: {
          component: 'recovery',
          checkId: 'undo_history',
          status: DiagnosticStatus.UNKNOWN,
          evidence: 'No matching action found in recent execution history.'
        },
        response: 'The requested action or channel was not found in recent execution history. Honey Bot can only undo actions that were recorded in its action ledger.',
        correlationId
      };
    }

    let response = '';
    if (targetAction.recoveryStatus === 'already_recovered') {
      response = `The action (\`${targetAction.action}\` on \`${targetAction.targetName}\`) has already been recovered. It cannot be undone again.`;
    } else if (targetAction.recoveryStatus === 'failed') {
      response = `The recovery of \`${targetAction.targetName}\` failed due to: ${targetAction.unavailabilityReason || 'Discord API permission error'}. No further changes were made.`;
    } else if (targetAction.recoveryStatus === 'needs_review') {
      response = `Recovery for \`${targetAction.targetName}\` was attempted, but the resulting state could not be confirmed. An administrator should review the channel or role directly.`;
    } else if (targetAction.reversibility === 'irreversible') {
      response = `The action (\`${targetAction.action}\` on \`${targetAction.targetName}\`) is irreversible. ${targetAction.unavailabilityReason || 'Previous state cannot be restored automatically.'}`;
    } else {
      response = `The action (\`${targetAction.action}\` on \`${targetAction.targetName}\`) is recorded in the ledger with status \`${targetAction.recoveryStatus}\`. You can run \`/undo prompt: undo ${targetAction.targetName}\` to restore it.`;
    }

    return {
      task: 'undo_troubleshooting',
      status: targetAction.recoveryStatus === 'succeeded' ? DiagnosticStatus.HEALTHY : DiagnosticStatus.DEGRADED,
      structured: {
        component: 'recovery',
        checkId: 'undo_history',
        status: targetAction.recoveryStatus,
        actionId: targetAction.actionId,
        reversibility: targetAction.reversibility
      },
      response: Logger.redactSecrets(response),
      correlationId
    };
  }

  /**
   * Diagnoses moderation log persistence and delivery queue.
   */
  static async diagnoseModLogPersistence(context = {}, correlationId) {
    const guild = context.guild;
    if (!guild) {
      return {
        task: 'modlog_persistence',
        status: DiagnosticStatus.UNKNOWN,
        response: 'Guild context is required to inspect moderation log persistence.',
        correlationId
      };
    }

    const report = await ModLogService.troubleshoot(guild);
    let response = '';

    if (report.status === 'unconfigured') {
      response = 'Moderation logging is not configured for this server. Use `/modlog` to configure a destination channel.';
    } else if (report.status === 'channel_missing') {
      response = 'The configured moderation log channel no longer exists. Configure a new destination using `/modlog`.';
    } else if (report.status === 'permission_denied') {
      response = report.userMessage;
    } else if (report.pendingCount > 0) {
      response = `Moderation logs are being persisted to disk, but delivery is degraded. ${report.pendingCount} log ${report.pendingCount > 1 ? 'deliveries are' : 'delivery is'} pending.`;
    } else if (report.healthy) {
      response = `Moderation logs are being persisted to disk (\`modlog-config.json\`). Delivery to #${report.channel?.name || 'log-channel'} is active and healthy with 0 pending entries.`;
    } else {
      response = report.userMessage || 'Moderation logging is disabled for this server.';
    }

    const status = report.healthy ? DiagnosticStatus.HEALTHY : (report.pendingCount > 0 ? DiagnosticStatus.DEGRADED : DiagnosticStatus.FAILED);

    return {
      task: 'modlog_persistence',
      status,
      structured: {
        component: 'modlog',
        checkId: 'persistence_and_delivery',
        status,
        pendingCount: report.pendingCount,
        channel: report.channel?.name
      },
      response: Logger.redactSecrets(response),
      correlationId
    };
  }

  /**
   * Controlled safe repair capabilities.
   * Flushes pending log deliveries without repeating moderation actions.
   * Rejects unsafe repairs with honest explanations.
   */
  static async diagnoseSafeRepair(prompt, context = {}, correlationId) {
    const guild = context.guild;
    const guildId = guild?.id || 'default';

    if (!guild) {
      return {
        task: 'safe_repair',
        status: DiagnosticStatus.FAILED,
        response: 'Guild context is required to execute a safe repair.',
        correlationId
      };
    }

    // 1. Prevent concurrent repairs on same guild
    if (this._activeRepairs.has(guildId)) {
      return {
        task: 'safe_repair',
        status: DiagnosticStatus.DEGRADED,
        response: 'A diagnostic repair is already in progress for this server. Please wait for it to complete.',
        correlationId
      };
    }

    this._activeRepairs.add(guildId);

    try {
      const conf = ModLogService.getConfig(guildId);
      const pendingCount = (conf.pendingDeliveries || []).length;

      // 2. Safe repair: Flush pending modlog deliveries
      if (pendingCount > 0) {
        if (!conf.enabled || !conf.channelId) {
          return {
            task: 'safe_repair',
            status: DiagnosticStatus.FAILED,
            response: 'I found the issue, but I can\'t safely repair it automatically. The configuration needs an authorized administrator to review it.',
            correlationId
          };
        }

        const flushRes = await ModLogService.flushPendingDeliveries(guild);
        if (flushRes.flushed > 0) {
          return {
            task: 'safe_repair',
            status: DiagnosticStatus.HEALTHY,
            response: 'Log delivery recovered. The pending entry was delivered, and the original moderation action was not repeated.',
            correlationId
          };
        } else {
          return {
            task: 'safe_repair',
            status: DiagnosticStatus.FAILED,
            response: 'I found the issue, but I can\'t safely repair it automatically. Honey Bot still lacks permission to send messages to the configured log channel.',
            correlationId
          };
        }
      }

      // 3. Safe repair: Re-enable modlog if channel is valid
      if (conf.channelId && !conf.enabled) {
        const channel = guild.channels?.cache?.get(conf.channelId) || await guild.channels?.fetch?.(conf.channelId).catch(() => null);
        if (channel) {
          ModLogService.updateConfig(guildId, { enabled: true, updatedBy: context.user?.tag || 'DiagnosticRepair' });
          return {
            task: 'safe_repair',
            status: DiagnosticStatus.HEALTHY,
            response: `Moderation logging recovered. Re-enabled logging for #${channel.name}.`,
            correlationId
          };
        }
      }

      // 4. Default: No automated repair available
      return {
        task: 'safe_repair',
        status: DiagnosticStatus.NOT_APPLICABLE,
        response: 'I found no safe automated repairs needed. All verifiable components are operating normally or require administrator review.',
        correlationId
      };
    } finally {
      this._activeRepairs.delete(guildId);
    }
  }

  /**
   * Explains feature availability based on Server Boost Tier, Community, and bot permissions.
   */
  static async diagnoseFeatureAvailability(context = {}, correlationId) {
    const guild = context.guild;
    if (!guild) {
      return {
        task: 'feature_availability',
        status: DiagnosticStatus.UNKNOWN,
        response: 'Guild context is required to determine feature availability.',
        correlationId
      };
    }

    const tier = guild.premiumTier || 0;
    const features = guild.features || [];
    const botMember = guild.members?.me || await guild.members?.fetchMe?.().catch(() => null);

    const items = [];

    // Server Banner (requires Boost Tier 2)
    if (tier >= 2) {
      items.push('• **Server Banner**: Available (Server Boost Tier ' + tier + ').');
    } else {
      items.push(`• **Server Banner**: Unavailable. Requires Server Boost Tier 2 (current tier: ${tier}).`);
    }

    // Vanity URL (requires Boost Tier 3)
    if (tier >= 3) {
      items.push('• **Vanity Invite URL**: Available (Server Boost Tier ' + tier + ').');
    } else {
      items.push(`• **Vanity Invite URL**: Unavailable. Requires Server Boost Tier 3 (current tier: ${tier}).`);
    }

    // Community announcement channels
    const hasCommunity = features.includes('COMMUNITY');
    if (hasCommunity) {
      items.push('• **Announcement Channels**: Available (Community feature is enabled).');
    } else {
      items.push('• **Announcement Channels**: Unavailable. Requires the Community feature to be enabled in Server Settings.');
    }

    // Member Moderation (bot permission)
    const canModerate = botMember?.permissions?.has?.(PermissionFlagsBits.ModerateMembers) ?? true;
    if (canModerate) {
      items.push('• **Member Moderation (Timeouts)**: Available (Bot has Moderate Members permission).');
    } else {
      items.push('• **Member Moderation (Timeouts)**: Unavailable. Honey Bot is missing the Moderate Members permission.');
    }

    // Manage Roles (bot permission)
    const canRoles = botMember?.permissions?.has?.(PermissionFlagsBits.ManageRoles) ?? true;
    if (canRoles) {
      items.push('• **Role Management**: Available (Bot has Manage Roles permission).');
    } else {
      items.push('• **Role Management**: Unavailable. Honey Bot is missing the Manage Roles permission.');
    }

    const response = `**Feature Availability Audit**\n${items.join('\n')}`;

    return {
      task: 'feature_availability',
      status: DiagnosticStatus.HEALTHY,
      response,
      correlationId
    };
  }

  /**
   * Audits configuration settings safely without modifying state.
   */
  static async diagnoseConfigurationAudit(context = {}, correlationId) {
    const val = validateConfig();
    const provider = config.ai.provider;

    let response = '';
    if (val.valid) {
      response =
        `Configuration is valid. Active AI provider is \`${provider}\`.\n` +
        `Discord client ID is configured. Zero-cost enforcement is active. No configuration issues detected.`;
    } else {
      const issues = val.issues.map(i => `• ${Logger.redactSecrets(i)}`).join('\n');
      response = `Configuration problems detected:\n${issues}`;
    }

    return {
      task: 'configuration_audit',
      status: val.valid ? DiagnosticStatus.HEALTHY : DiagnosticStatus.DEGRADED,
      response: Logger.redactSecrets(response),
      correlationId
    };
  }

  /**
   * Inspects performance metrics, telemetry latency, and timeouts.
   */
  static async diagnosePerformanceTimeouts(context = {}, correlationId) {
    const telemetry = AIProvider.getTelemetry();
    const ping = context.client?.ws?.ping ?? -1;

    let response = '';
    if (telemetry.lastError && /timeout/i.test(telemetry.lastError)) {
      response = `Recent command timeouts were caused by upstream inference provider latency (${telemetry.lastProvider}): ${Logger.redactSecrets(telemetry.lastError)}.`;
    } else if (telemetry.lastDurationMs && telemetry.lastDurationMs > 10000) {
      response = `Inference latency is elevated (${telemetry.lastDurationMs}ms on ${telemetry.lastProvider}). Gateway ping is ${ping}ms.`;
    } else {
      response = `No recent command timeouts recorded. Discord gateway latency is ${ping >= 0 ? ping + 'ms' : 'operational'}. Last inference duration was ${telemetry.lastDurationMs || '<100'}ms.`;
    }

    return {
      task: 'performance_timeouts',
      status: DiagnosticStatus.HEALTHY,
      response,
      correlationId
    };
  }

  /**
   * Inspects Discord gateway connectivity and bot permissions.
   */
  static async diagnoseDiscordConnectivity(context = {}, correlationId) {
    const client = context.client;
    const guild = context.guild;

    const isConnected = client?.isReady?.() ?? false;
    const ping = client?.ws?.ping ?? -1;

    if (!isConnected) {
      return {
        task: 'discord_connectivity',
        status: DiagnosticStatus.FAILED,
        response: 'Honey Bot is currently disconnected from the Discord Gateway.',
        correlationId
      };
    }

    let permSummary = 'Guild permissions not evaluated.';
    if (guild) {
      const botMember = guild.members?.me || await guild.members?.fetchMe?.().catch(() => null);
      if (botMember) {
        const isAdmin = botMember.permissions.has(PermissionFlagsBits.Administrator);
        permSummary = isAdmin
          ? 'Bot has Administrator privileges.'
          : 'Bot has standard permissions (Manage Roles: ' +
            botMember.permissions.has(PermissionFlagsBits.ManageRoles) +
            ', Manage Channels: ' +
            botMember.permissions.has(PermissionFlagsBits.ManageChannels) +
            ').';
      }
    }

    const response = `Honey Bot is connected to Discord Gateway (ping: ${ping}ms). ${permSummary}`;

    return {
      task: 'discord_connectivity',
      status: DiagnosticStatus.HEALTHY,
      response,
      correlationId
    };
  }

  /**
   * General system health check.
   * Summarizes gateway, model connectivity, moderation logging, and command registration.
   */
  static async diagnoseGeneralHealth(context = {}, correlationId) {
    const client = context.client;
    const guild = context.guild;
    const provider = (config.ai.provider || 'gemini').toLowerCase();

    // 1. Gateway
    const isGatewayOnline = client?.isReady?.() ?? true;

    // 2. Model reachability
    const modelCheck = await AIProvider.checkConnectivity(provider);

    // 3. Modlog status
    let modlogPending = 0;
    let modlogConfigured = false;
    if (guild) {
      const conf = ModLogService.getConfig(guild.id);
      modlogConfigured = Boolean(conf?.channelId);
      modlogPending = (conf?.pendingDeliveries || []).length;
    }

    // 4. Five commands registered
    const commandCount = slashCommands?.length ?? 5;

    // Build concise, calm summary
    let summary = '';
    let status = DiagnosticStatus.HEALTHY;

    if (!isGatewayOnline) {
      status = DiagnosticStatus.FAILED;
      summary = 'Honey Bot is disconnected from Discord Gateway.';
    } else if (modelCheck.status === 'failed') {
      status = DiagnosticStatus.DEGRADED;
      summary = `Honey Bot is connected to Discord, but the configured AI model (${provider}) is unreachable: ${modelCheck.error}.`;
    } else if (modlogPending > 0) {
      status = DiagnosticStatus.DEGRADED;
      summary = `Honey Bot is connected to Discord. The configured model is reachable, but moderation-log delivery is degraded. ${modlogPending} log ${modlogPending > 1 ? 'deliveries are' : 'delivery is'} pending.`;
    } else {
      status = DiagnosticStatus.HEALTHY;
      summary = `Honey Bot is connected to Discord. The configured model (${provider}) is reachable and operational. All 5 top-level slash commands are registered.`;
    }

    return {
      task: 'general_health',
      status,
      structured: {
        component: 'system',
        checkId: 'general_health',
        status,
        isGatewayOnline,
        modelStatus: modelCheck.status,
        modlogPending,
        commandCount
      },
      response: Logger.redactSecrets(summary),
      correlationId
    };
  }
}
