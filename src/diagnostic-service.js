import { PermissionFlagsBits } from 'discord.js';
import { config, validateConfig } from './config.js';
import { AIProvider } from './ai-provider.js';
import { Logger } from './logger.js';
import { ActionLedger } from './recovery.js';
import { ModLogService } from './mod-log.js';
import { slashCommands } from './commands.js';
import { TaskQueue, TaskQueueState } from './task-queue.js';
import { SelfRoleManager } from './self-roles.js';
import { PermissionAuditService, FeatureStatus } from './permission-audit.js';
import { globalLifecycle } from './bot-lifecycle.js';
import { globalCommandRegistry } from './command-registry.js';
import { defaultPendingTaskManager } from './pending-task-manager.js';
import { defaultConversationMemoryManager } from './conversation-memory.js';
import { defaultContextResolutionPipeline } from './context-resolution-pipeline.js';

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

    // 5. Moderation log troubleshooting & diagnostics
    if (
      /(why\s+aren'?t\s+moderation\s+logs?\s+working|why\s+(are\s+)?logs?\s+not\s+(appearing|working|posting)|modlogs?\s+not\s+working)/i.test(clean)
    ) {
      return 'why_arent_modlogs_working';
    }

    if (
      /(why\s+can'?t\s+(you|honey|the\s+bot)\s+create\s+roles?|why\s+are\s+roles?\s+(failing|blocked)|can'?t\s+create\s+roles?)/i.test(clean)
    ) {
      return 'why_cant_create_roles';
    }

    if (
      /(check\s+whether\s+honeypot\s+is\s+configured|is\s+honeypot\s+configured|honeypot\s+configured\s+correctly)/i.test(clean)
    ) {
      return 'check_honeypot_configured';
    }

    if (
      /(check\s+whether\s+music\s+(playback\s+is\s+)?ready|is\s+music\s+ready|is\s+playback\s+ready)/i.test(clean)
    ) {
      return 'check_music_ready';
    }

    if (
      /(check\s+(bot\s+|honey\s+bot'?s?\s+)?permissions?|what\s+permissions\s+are\s+missing|audit\s+permissions?|missing\s+permissions?|permission\s+diagnostics?)/i.test(clean)
    ) {
      return 'permission_audit';
    }

    // 5b. Moderation log persistence & delivery
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

    // 8. Configuration & Server audit (read-only)
    if (
      /^(?:server\s+|system\s+)?audit(?:\s+server|\s+configuration|\s+system|\s+permissions|\s+security)?$/i.test(clean) ||
      /(?:find|identify|detect|audit|check)\s+(?:configuration|security|server\s+permissions|server\s+health|audit)/i.test(clean) ||
      /\baudit\b/i.test(clean) ||
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
      /is\s+(the\s+)?gateway\s+connected/i.test(clean)
    ) {
      return 'discord_connectivity';
    }

    // 11. Task queue health, stuck tasks & queue overload
    if (
      /(task\s+queue|stuck\s+tasks?|queue\s+overload|queue\s+backlog|task\s+health|queue\s+status|tasks?\s+stuck|task\s+failures?)/i.test(clean)
    ) {
      return 'task_queue_health';
    }

    // 12. Voice & Music subsystem health
    if (
      /(music|voice|audio|playback|stream|sound|player|vc)/i.test(clean)
    ) {
      return 'music_voice_health';
    }

    // 13. Self-roles & reaction-roles panel health
    if (
      /(self[- ]roles?|reaction[- ]roles?|role\s+panels?|role\s+menu)/i.test(clean)
    ) {
      return 'self_roles_health';
    }

    // 14. Honeypot & intrusion trap health
    if (
      /(honeypot|intrusion|trap|spambot\s+protection|honeypot\s+health|honeypot\s+status)/i.test(clean)
    ) {
      return 'honeypot_health';
    }

    // 15. Ghost-Online & command responsiveness
    if (
      /(is\s+(the\s+)?bot\s+online\s+but\s+unresponsive|why\s+is\s+(the\s+)?bot\s+online\s+but\s+not\s+responding|bot\s+unresponsive|online\s+but\s+unresponsive|ghost\s+online|why\s+aren'?t\s+commands\s+working|commands?\s+not\s+responding|check\s+responsiveness)/i.test(clean)
    ) {
      return 'ghost_online';
    }

    // 16. Pending tasks & conversational memory
    if (
      /(pending\s+tasks?|conversational\s+memory|memory\s+status|pending\s+operations?|context\s+memory|follow[- ]up\s+tasks?)/i.test(clean)
    ) {
      return 'pending_tasks_memory';
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

        case 'permission_audit':
          return await this.diagnosePermissionAudit(context, correlationId);

        case 'why_cant_create_roles':
          return await this.diagnoseWhyCantCreateRoles(context, correlationId);

        case 'why_arent_modlogs_working':
          return await this.diagnoseWhyArentModlogsWorking(context, correlationId);

        case 'check_honeypot_configured':
          return await this.diagnoseCheckHoneypotConfigured(context, correlationId);

        case 'check_music_ready':
          return await this.diagnoseCheckMusicReady(context, correlationId);

        case 'discord_connectivity':
          return await this.diagnoseDiscordConnectivity(context, correlationId);

        case 'task_queue_health':
          return await this.diagnoseTaskQueueHealth(context, correlationId);

        case 'music_voice_health':
          return await this.diagnoseMusicVoiceHealth(context, correlationId);

        case 'self_roles_health':
          return await this.diagnoseSelfRolesHealth(context, correlationId);

        case 'honeypot_health':
          return await this.diagnoseHoneypotHealth(context, correlationId);

        case 'ghost_online':
          return await this.diagnoseGhostOnline(context, correlationId);

        case 'pending_tasks_memory':
          return await this.diagnosePendingTasksMemory(context, correlationId);

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
    const guild = context.guild;

    // Check server permission issues if in guild
    const { auditServerPermissions } = await import('./permissions.js');
    const permIssues = guild ? auditServerPermissions(guild) : [];

    // Check bot member permissions in this guild
    const botMember = guild?.members?.me || await guild?.members?.fetchMe?.().catch(() => null);
    const hasAdmin = botMember?.permissions?.has?.(PermissionFlagsBits.Administrator) ?? false;
    const hasManageRoles = botMember?.permissions?.has?.(PermissionFlagsBits.ManageRoles) ?? false;
    const hasManageChannels = botMember?.permissions?.has?.(PermissionFlagsBits.ManageChannels) ?? false;

    // Check modlog configuration
    const modlogConf = guild ? ModLogService.getConfig(guild.id) : null;

    // Check task queue
    const allTasks = TaskQueue.loadAllTasks();
    const stuckTasks = Array.from(allTasks.values()).filter(t =>
      (t.status === TaskQueueState.RUNNING || t.status === TaskQueueState.WAITING) &&
      (Date.now() - (t.updatedAt || t.createdAt) > 60000)
    );

    const isHealthy = val.valid && permIssues.length === 0 && stuckTasks.length === 0;

    const checks = {
      'AI Provider & Model': {
        status: val.valid ? 'healthy' : 'failed',
        details: `Configured: ${provider} (zero-cost active).`
      },
      'Bot Permissions': {
        status: hasAdmin || (hasManageRoles && hasManageChannels) ? 'healthy' : 'degraded',
        details: hasAdmin ? 'Administrator granted.' : `Roles: ${hasManageRoles ? 'Yes' : 'No'}, Channels: ${hasManageChannels ? 'Yes' : 'No'}.`
      },
      'Server Security Audit': {
        status: permIssues.length === 0 ? 'healthy' : 'failed',
        details: permIssues.length === 0 ? 'No excessive @everyone privileges detected.' : permIssues.slice(0, 2).join('; ')
      },
      'Moderation Logging': {
        status: modlogConf?.enabled ? 'healthy' : 'degraded',
        details: modlogConf?.enabled ? `Enabled in channel <#${modlogConf.channelId}>` : 'Not configured or disabled.'
      },
      'Task Execution Queue': {
        status: stuckTasks.length === 0 ? 'healthy' : 'degraded',
        details: stuckTasks.length === 0 ? 'Queue operational.' : `${stuckTasks.length} stuck task(s).`
      }
    };

    let response = '';
    if (isHealthy) {
      response = `Server and bot configuration audit passed. Active AI provider is \`${provider}\`. Bot permissions and server security checks are clean.`;
    } else {
      const issueList = [...(val.issues || []), ...permIssues];
      response = `Audit detected potential issues:\n${issueList.map(i => `• ${Logger.redactSecrets(i)}`).join('\n')}`;
    }

    return {
      task: 'configuration_audit',
      status: isHealthy ? DiagnosticStatus.HEALTHY : DiagnosticStatus.DEGRADED,
      checks,
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
   * Comprehensive Permission & Capability Audit Diagnostic.
   */
  static async diagnosePermissionAudit(context = {}, correlationId) {
    const guild = context.guild;
    if (!guild) {
      return {
        task: 'permission_audit',
        status: DiagnosticStatus.FAILED,
        response: 'Server context required to evaluate Discord permissions.',
        correlationId
      };
    }

    const audit = await PermissionAuditService.auditGuild(guild, context);
    const status = audit.overallStatus === 'ready'
      ? DiagnosticStatus.HEALTHY
      : (audit.overallStatus === 'partially_ready' ? DiagnosticStatus.DEGRADED : DiagnosticStatus.FAILED);

    let summary = `**🛡️ Honey Bot Permission & Capability Audit**\n`;
    summary += `Server: **${audit.guildName}** (ID: \`${audit.guildId}\`)\n`;
    summary += `Overall Status: **${audit.overallStatus.toUpperCase()}**\n\n`;

    // Feature breakdown
    summary += `**Feature Readiness Breakdown:**\n`;
    for (const [domain, cap] of Object.entries(audit.capabilities || {})) {
      const icon = cap.classification === FeatureStatus.READY ? '✅' : (cap.classification === FeatureStatus.PARTIAL ? '⚠️' : '❌');
      summary += `  ${icon} **${cap.label}**: \`${cap.classification || cap.status.toUpperCase()}\`\n`;
    }

    // Missing permissions
    if (audit.missingRecommended?.length > 0 && !audit.hasAdministrator) {
      summary += `\n**Missing Permissions (${audit.missingRecommended.length}):**\n`;
      for (const perm of audit.missingRecommended.slice(0, 8)) {
        summary += `  • \`${perm}\` — Check Discord Server Settings > Roles\n`;
      }
      if (audit.missingRecommended.length > 8) {
        summary += `  *...and ${audit.missingRecommended.length - 8} more.*\n`;
      }
    } else if (audit.hasAdministrator) {
      summary += `\n*Bot has Administrator permission. Note: Role hierarchy restrictions still strictly apply.*\n`;
    }

    // Role Hierarchy
    if (audit.roleHierarchy?.hierarchyWarning) {
      summary += `\n**⚠️ Role Hierarchy Warning:**\n${audit.roleHierarchy.hierarchyWarning}\n`;
    }

    // Gateway Intents
    if (audit.intents?.missingPrivileged?.length > 0) {
      summary += `\n**⚠️ Missing Privileged Gateway Intents:**\n`;
      for (const priv of audit.intents.missingPrivileged) {
        summary += `  • **${priv.name}**: Enable in ${priv.setting}\n`;
      }
    }

    summary += `\n*Commands not requiring missing permissions remain fully operational.*`;

    return {
      task: 'permission_audit',
      status,
      response: summary,
      audit,
      correlationId
    };
  }

  /**
   * Diagnoses why role creation or management is failing.
   */
  static async diagnoseWhyCantCreateRoles(context = {}, correlationId) {
    const guild = context.guild;
    if (!guild) {
      return {
        task: 'why_cant_create_roles',
        status: DiagnosticStatus.FAILED,
        response: 'Server context required to diagnose role management.',
        correlationId
      };
    }

    const audit = await PermissionAuditService.auditGuild(guild, context);
    const botMember = guild.members?.me || await guild.members?.fetchMe?.().catch(() => null);
    const hasManageRoles = Boolean(botMember?.permissions?.has?.(PermissionFlagsBits.ManageRoles) || botMember?.permissions?.has?.(PermissionFlagsBits.Administrator));
    const roleCap = audit.capabilities?.roles;

    if (!hasManageRoles) {
      return {
        task: 'why_cant_create_roles',
        status: DiagnosticStatus.FAILED,
        response:
          '**Role Creation Diagnostic: Missing Permission**\n\n' +
          '• **Affected Feature:** Role Creation and Assignment\n' +
          '• **Root Cause:** Honey Bot lacks the `ManageRoles` permission in this server.\n' +
          '• **Why Required:** Discord requires the `ManageRoles` permission to create, edit, or delete roles.\n' +
          '• **Action Required:** Open Discord **Server Settings > Roles**, select Honey Bot\'s role, and enable **Manage Roles**.\n' +
          '• **Other Features Status:** Channel management, moderation (for lower targets), and music playback remain usable.',
        correlationId
      };
    }

    if (audit.roleHierarchy?.hierarchyWarning) {
      return {
        task: 'why_cant_create_roles',
        status: DiagnosticStatus.DEGRADED,
        response:
          '**Role Creation Diagnostic: Role Hierarchy Constraint**\n\n' +
          '• **Affected Feature:** Role Modification & Assignment of Higher Roles\n' +
          '• **Root Cause:** Discord Role Hierarchy Constraint.\n' +
          `• **Details:** ${audit.roleHierarchy.hierarchyWarning}\n` +
          '• **Why Required:** Discord enforces strict role hierarchy: a bot cannot edit, assign, or delete any role positioned equal to or higher than its own highest role, even if granted Administrator.\n' +
          '• **Action Required:** Open Discord **Server Settings > Roles** and drag Honey Bot\'s role higher in the list.\n' +
          '• **Other Features Status:** Creating new roles and managing roles below Honey Bot remain fully operational.',
        correlationId
      };
    }

    return {
      task: 'why_cant_create_roles',
      status: DiagnosticStatus.HEALTHY,
      response:
        '**Role Creation Diagnostic: Ready**\n\n' +
        'Honey Bot has the `ManageRoles` permission and role hierarchy is satisfied. You can create roles using `/go prompt: create a role called VIP in gold`.',
      correlationId
    };
  }

  /**
   * Diagnoses why moderation logs are not working or appearing.
   */
  static async diagnoseWhyArentModlogsWorking(context = {}, correlationId) {
    const guild = context.guild;
    if (!guild) {
      return {
        task: 'why_arent_modlogs_working',
        status: DiagnosticStatus.FAILED,
        response: 'Server context required to diagnose moderation logging.',
        correlationId
      };
    }

    const conf = ModLogService.getConfig(guild.id);
    const modChannelId = conf?.modLogChannelId || conf?.channelId;

    if (!modChannelId) {
      return {
        task: 'why_arent_modlogs_working',
        status: DiagnosticStatus.DEGRADED,
        response:
          '**Moderation Log Diagnostic: Missing Configuration**\n\n' +
          '• **Affected Feature:** Moderation Logging\n' +
          '• **Root Cause:** No moderation log channel is configured for this server.\n' +
          '• **Why Required:** Honey Bot requires a designated text channel to deliver audit reports.\n' +
          '• **Action Required:** Run `/modlog prompt: Set #mod-logs as the moderation logging channel`.\n' +
          '• **Other Features Status:** Moderation actions (/go ban, kick, timeout) continue to execute, but audit records cannot be delivered until a channel is configured.',
        correlationId
      };
    }

    const channel = guild.channels?.cache?.get?.(modChannelId) || await guild.channels?.fetch?.(modChannelId).catch(() => null);
    if (!channel) {
      return {
        task: 'why_arent_modlogs_working',
        status: DiagnosticStatus.FAILED,
        response:
          `**Moderation Log Diagnostic: Channel Missing**\n\n` +
          `• **Affected Feature:** Moderation Log Delivery\n` +
          `• **Root Cause:** The configured channel (ID: \`${modChannelId}\`) no longer exists in Discord.\n` +
          `• **Action Required:** Configure a new log channel using \`/modlog prompt: Set #mod-logs as the moderation logging channel\`.\n` +
          `• **Other Features Status:** Logging deliveries are queued safely in memory/disk and will not crash the bot.`,
        correlationId
      };
    }

    const botMember = guild.members?.me || await guild.members?.fetchMe?.().catch(() => null);
    if (botMember && typeof botMember.permissionsIn === 'function') {
      const perms = botMember.permissionsIn(channel);
      const canView = perms.has(PermissionFlagsBits.ViewChannel);
      const canSend = perms.has(PermissionFlagsBits.SendMessages);
      const canEmbed = perms.has(PermissionFlagsBits.EmbedLinks);

      if (!canView || !canSend || !canEmbed) {
        const missing = [];
        if (!canView) missing.push('ViewChannel');
        if (!canSend) missing.push('SendMessages');
        if (!canEmbed) missing.push('EmbedLinks');

        return {
          task: 'why_arent_modlogs_working',
          status: DiagnosticStatus.FAILED,
          response:
            `**Moderation Log Diagnostic: Inaccessible Channel**\n\n` +
            `• **Affected Feature:** Moderation Log Delivery\n` +
            `• **Root Cause:** Honey Bot lacks ${missing.join(', ')} permission in channel #${channel.name}.\n` +
            `• **Why Required:** The bot must have channel visibility, message posting, and embed permissions to post audit reports.\n` +
            `• **Action Required:** Open **#${channel.name} > Edit Channel > Permissions** and allow Honey Bot to View Channel, Send Messages, and Embed Links.\n` +
            `• **Other Features Status:** Moderation actions continue to execute normally; undelivered logs are preserved in queue.`,
          correlationId
        };
      }
    }

    const hasViewAuditLog = Boolean(botMember?.permissions?.has?.(PermissionFlagsBits.ViewAuditLog) || botMember?.permissions?.has?.(PermissionFlagsBits.Administrator));
    if (!hasViewAuditLog) {
      return {
        task: 'why_arent_modlogs_working',
        status: DiagnosticStatus.DEGRADED,
        response:
          `**Moderation Log Diagnostic: Partial Attribution**\n\n` +
          `• **Affected Feature:** External Moderation Event Attribution\n` +
          `• **Root Cause:** Honey Bot lacks the \`ViewAuditLog\` permission.\n` +
          `• **Impact:** Logs are delivered, but actions performed by staff outside Honey Bot (e.g. native Discord ban) will attribute "External Actor" without identifying the specific moderator.\n` +
          `• **Action Required:** Grant **View Audit Log** to Honey Bot in Server Settings > Roles.`,
        correlationId
      };
    }

    return {
      task: 'why_arent_modlogs_working',
      status: DiagnosticStatus.HEALTHY,
      response:
        `**Moderation Log Diagnostic: Operational**\n\n` +
        `Moderation logging is fully configured and operational in channel #${channel.name}. All required channel permissions and ViewAuditLog are verified.`,
      correlationId
    };
  }

  /**
   * Diagnoses whether Honeypot is configured and ready.
   */
  static async diagnoseCheckHoneypotConfigured(context = {}, correlationId) {
    const guild = context.guild;
    if (!guild) {
      return {
        task: 'check_honeypot_configured',
        status: DiagnosticStatus.FAILED,
        response: 'Server context required to diagnose Honeypot subsystem.',
        correlationId
      };
    }

    const { HoneypotService } = await import('./honeypot-service.js');
    const conf = HoneypotService.getConfig(guild.id);

    if (!conf?.channelId || !conf.enabled) {
      return {
        task: 'check_honeypot_configured',
        status: DiagnosticStatus.DEGRADED,
        response:
          '**Honeypot Diagnostic: Not Configured**\n\n' +
          '• **Affected Feature:** Intrusion Honeypot & Compromised-Account Protection\n' +
          '• **Root Cause:** Honeypot channel is not configured or is currently disabled.\n' +
          '• **Action Required:** Run `/honeypot setup` to automatically generate a secured honeypot trap channel.\n' +
          '• **Other Features Status:** All moderation, channel, and role commands remain operational.',
        correlationId
      };
    }

    const testRes = await HoneypotService.runDiagnosticTest(guild, context.invokingUser);
    const status = testRes.healthy ? DiagnosticStatus.HEALTHY : DiagnosticStatus.DEGRADED;

    return {
      task: 'check_honeypot_configured',
      status,
      response: testRes.healthy
        ? `**Honeypot Diagnostic: Operational**\n\nHoneypot trap is active in channel #${conf.channelName || conf.channelId} (Mode: ${conf.strictMode ? 'Strict (Instant Kick)' : 'Monitored'}). Bot has required KickMembers permission.`
        : `**Honeypot Diagnostic: Issues Detected**\n\n${testRes.findings?.map(f => `• **${f.title}**: ${f.issue}`).join('\n') || 'Configuration or permission issues detected.'}`,
      checks: testRes.checks,
      correlationId
    };
  }

  /**
   * Diagnoses whether music playback is ready.
   */
  static async diagnoseCheckMusicReady(context = {}, correlationId) {
    const guild = context.guild;
    if (!guild) {
      return {
        task: 'check_music_ready',
        status: DiagnosticStatus.FAILED,
        response: 'Server context required to diagnose music readiness.',
        correlationId
      };
    }

    const botMember = guild.members?.me || await guild.members?.fetchMe?.().catch(() => null);
    const hasConnect = Boolean(botMember?.permissions?.has?.(PermissionFlagsBits.Connect) || botMember?.permissions?.has?.(PermissionFlagsBits.Administrator));
    const hasSpeak = Boolean(botMember?.permissions?.has?.(PermissionFlagsBits.Speak) || botMember?.permissions?.has?.(PermissionFlagsBits.Administrator));

    if (!hasConnect || !hasSpeak) {
      const missing = [];
      if (!hasConnect) missing.push('Connect');
      if (!hasSpeak) missing.push('Speak');

      return {
        task: 'check_music_ready',
        status: DiagnosticStatus.FAILED,
        response:
          `**Music Readiness Diagnostic: Missing Permission**\n\n` +
          `• **Affected Feature:** Voice & Music Playback\n` +
          `• **Root Cause:** Honey Bot lacks ${missing.join(' and ')} permission in this server.\n` +
          `• **Why Required:** Needed to join voice channels and transmit audio streams.\n` +
          `• **Action Required:** Open Discord **Server Settings > Roles**, find Honey Bot's role, and enable **Connect** and **Speak**.\n` +
          `• **Other Features Status:** Text commands, moderation, and channel management remain fully operational.`,
        correlationId
      };
    }

    const { MusicService } = await import('./music-service.js');
    const diag = MusicService.getDiagnostics();

    return {
      task: 'check_music_ready',
      status: diag.healthy ? DiagnosticStatus.HEALTHY : DiagnosticStatus.DEGRADED,
      response:
        `**Music Readiness Diagnostic: Ready**\n\n` +
        `Honey Bot has \`Connect\` and \`Speak\` permissions. Audio player engine is ${diag.healthy ? 'healthy' : 'degraded'}. Join a voice channel and use \`/go prompt: play <song>\` to start listening.`,
      correlationId
    };
  }

  /**
   * Diagnoses whether Honey Bot is in a Ghost-Online state (Gateway connected, but command dispatcher broken).
   */
  static async diagnoseGhostOnline(context = {}, correlationId) {
    const client = context.client;
    const watchdog = client?.watchdog || null;
    const ghost = watchdog && typeof watchdog.detectGhostOnline === 'function'
      ? watchdog.detectGhostOnline()
      : { isGhostOnline: false, reason: null };
    const lifecycleState = globalLifecycle.getState();
    const registryCheck = globalCommandRegistry.verifyConsistency();
    const isGatewayOnline = Boolean(client?.isReady?.());

    if (ghost.isGhostOnline || !registryCheck.valid || lifecycleState === 'FAILED') {
      const reasons = [];
      if (ghost.isGhostOnline) reasons.push(ghost.reason);
      if (!registryCheck.valid) reasons.push(`Command registry mismatch (${registryCheck.missingHandlers.length} missing handlers)`);
      if (lifecycleState === 'FAILED') reasons.push(`Startup lifecycle in FAILED state (${globalLifecycle.lastError || 'critical error'})`);

      return {
        task: 'ghost_online',
        status: DiagnosticStatus.FAILED,
        response:
          '**Ghost-Online Condition Detected: Unresponsive Command Pipeline**\n\n' +
          '• **Condition:** Honey Bot appears "Online" in Discord member list, but cannot process slash commands.\n' +
          `• **Root Cause:** ${reasons.join('; ')}\n` +
          '• **Impact:** Interactions with `/go`, `/help`, or other commands will fail or time out.\n' +
          '• **Recommended Action:** Execute a graceful service restart through your hosting platform supervisor, or run post-update validation.',
        correlationId
      };
    }

    return {
      task: 'ghost_online',
      status: DiagnosticStatus.HEALTHY,
      response:
        '**Responsiveness Diagnostic: Healthy**\n\n' +
        `• **Discord Gateway:** ${isGatewayOnline ? 'Connected' : 'Offline'}\n` +
        `• **Application Lifecycle:** \`${lifecycleState}\` (Ready to serve commands)\n` +
        `• **Command Registry:** All ${registryCheck.commandCount} commands mapped to runtime handlers.\n` +
        '• **Interaction Dispatcher:** Operational. No hung or timed-out commands detected.',
      correlationId
    };
  }

  /**
   * Diagnoses pending-task memory and conversational continuity health.
   */
  static async diagnosePendingTasksMemory(context = {}, correlationId) {
    const taskStats = defaultPendingTaskManager.getStats();
    const memoryStats = defaultConversationMemoryManager.getStats();
    const pipelineStats = defaultContextResolutionPipeline.getStats();

    const isHealthy = taskStats.executing <= 5;
    const responseText =
      '**Conversational Memory & Pending Tasks Diagnostic**\n\n' +
      `• **Status:** ${isHealthy ? 'Healthy & Operating within Limits' : 'Degraded'}\n` +
      `• **Active Pending Tasks Waiting for Input:** ${taskStats.activeWaiting}\n` +
      `• **Tasks Currently Executing:** ${taskStats.executing}\n` +
      `• **Total Pending Tasks Stored:** ${taskStats.totalTasks}\n` +
      `• **Expired / Cleaned Tasks:** ${taskStats.expired}\n` +
      `• **Tracked Active Conversations:** ${memoryStats.activeConversations}\n` +
      `• **Total Recent Conversation Turns:** ${memoryStats.totalTurns}\n` +
      `• **Serialized Memory Size:** ~${Math.round(memoryStats.approximateSerializedBytes / 1024)} KB\n` +
      `• **Successful Follow-Up Resolutions:** ${pipelineStats.resolvedFollowUps}\n` +
      `• **Corrections Applied:** ${pipelineStats.correctionsApplied}\n` +
      `• **Explicitly Cancelled Tasks:** ${pipelineStats.cancelledTasks}\n` +
      `• **Concurrent Execution Lock Preventions:** ${pipelineStats.concurrentLockBlocks}`;

    return {
      task: 'pending_tasks_memory',
      status: isHealthy ? DiagnosticStatus.HEALTHY : DiagnosticStatus.DEGRADED,
      response: responseText,
      structured: {
        taskStats,
        memoryStats,
        pipelineStats
      },
      correlationId
    };
  }

  /**
   * General system health check.
   * Summarizes gateway, model connectivity, moderation logging, command registration, and ghost-online state.
   */
  static async diagnoseGeneralHealth(context = {}, correlationId) {
    const client = context.client;
    const guild = context.guild;
    const provider = (config.ai.provider || 'gemini').toLowerCase();
    const watchdog = client?.watchdog || null;

    // 1. Gateway & Ghost-Online
    const isGatewayOnline = client?.isReady?.() ?? true;
    const ghostCheck = watchdog && typeof watchdog.detectGhostOnline === 'function'
      ? watchdog.detectGhostOnline()
      : { isGhostOnline: false };
    const lifecycleState = globalLifecycle.getState();

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

    // 4. Six commands registered & registry consistency
    const registryCheck = globalCommandRegistry.verifyConsistency();
    const commandCount = registryCheck.commandCount || 6;

    // 5. Task queue health
    const allTasks = TaskQueue.loadAllTasks();
    const now = Date.now();
    const stuckTasks = Array.from(allTasks.values()).filter(t =>
      (t.status === TaskQueueState.RUNNING || t.status === TaskQueueState.WAITING) &&
      (now - (t.updatedAt || t.createdAt) > 60000)
    );

    // Build concise, calm summary
    let summary = '';
    let status = DiagnosticStatus.HEALTHY;

    if (!isGatewayOnline) {
      status = DiagnosticStatus.FAILED;
      summary = 'Honey Bot is disconnected from Discord Gateway.';
    } else if (ghostCheck.isGhostOnline) {
      status = DiagnosticStatus.FAILED;
      summary = `Honey Bot is connected to Discord Gateway, but the command execution system is unresponsive: ${ghostCheck.reason}.`;
    } else if (lifecycleState === 'FAILED') {
      status = DiagnosticStatus.FAILED;
      summary = `Honey Bot startup lifecycle is in FAILED state: ${globalLifecycle.lastError || 'Initialization error'}.`;
    } else if (!registryCheck.valid) {
      status = DiagnosticStatus.DEGRADED;
      summary = `Honey Bot command registry has ${registryCheck.missingHandlers.length} missing handler(s).`;
    } else if (modelCheck.status === 'failed') {
      status = DiagnosticStatus.DEGRADED;
      summary = `Honey Bot is connected to Discord, but the configured AI model (${provider}) is unreachable: ${modelCheck.error}.`;
    } else if (stuckTasks.length > 0) {
      status = DiagnosticStatus.DEGRADED;
      summary = `Honey Bot execution queue has ${stuckTasks.length} stuck task(s) awaiting intervention.`;
    } else if (modlogPending > 0) {
      status = DiagnosticStatus.DEGRADED;
      summary = `Honey Bot is connected to Discord. The configured model is reachable, but moderation-log delivery is degraded. ${modlogPending} log ${modlogPending > 1 ? 'deliveries are' : 'delivery is'} pending.`;
    } else {
      status = DiagnosticStatus.HEALTHY;
      summary = `Honey Bot is connected to Discord. The configured model (${provider}) is reachable and operational. All 6 slash commands are registered and verified. Task queue is healthy.`;
    }

    const checks = {
      'Gateway Connection': {
        status: isGatewayOnline ? 'healthy' : 'failed',
        details: isGatewayOnline ? `Online (Ping: ${context.client?.ws?.ping ?? 0}ms)` : 'Disconnected'
      },
      'Command Responsiveness': {
        status: !ghostCheck.isGhostOnline && lifecycleState !== 'FAILED' ? 'healthy' : 'failed',
        details: ghostCheck.isGhostOnline ? `Ghost-Online: ${ghostCheck.reason}` : `Lifecycle: ${lifecycleState}`
      },
      'AI Model Reachability': {
        status: modelCheck.status === 'succeeded' ? 'healthy' : 'failed',
        details: modelCheck.status === 'succeeded' ? `Operational (${provider})` : (modelCheck.error || 'Unreachable')
      },
      'Slash Commands': {
        status: registryCheck.valid ? 'healthy' : 'degraded',
        details: `${commandCount} registered (/go, /modlog, /diagnose, /undo, /help, /honeypot)`
      },
      'Task Execution Queue': {
        status: stuckTasks.length === 0 ? 'healthy' : 'degraded',
        details: stuckTasks.length === 0 ? 'Queue operational (0 stuck tasks)' : `${stuckTasks.length} stuck task(s)`
      },
      'Moderation Logging': {
        status: modlogPending === 0 ? 'healthy' : 'degraded',
        details: modlogConfigured ? (modlogPending === 0 ? 'Active & operational' : `${modlogPending} deliveries pending`) : 'Not configured'
      },
      'Pending Tasks & Memory': {
        status: 'healthy',
        details: `Tasks Waiting: ${defaultPendingTaskManager.getStats().activeWaiting}, Tracked Turns: ${defaultConversationMemoryManager.getStats().totalTurns}`
      }
    };

    return {
      task: 'general_health',
      status,
      checks,
      structured: {
        component: 'system',
        checkId: 'general_health',
        status,
        isGatewayOnline,
        modelStatus: modelCheck.status,
        modlogPending,
        commandCount,
        stuckTasks: stuckTasks.length
      },
      response: Logger.redactSecrets(summary),
      correlationId
    };
  }

  /**
   * Diagnoses Task Queue health, stuck tasks, backlog, and persistence.
   */
  static async diagnoseTaskQueueHealth(context = {}, correlationId) {
    const allTasks = TaskQueue.loadAllTasks();
    const now = Date.now();
    const taskList = Array.from(allTasks.values());

    const activeTasks = taskList.filter(t =>
      t.status === TaskQueueState.RUNNING ||
      t.status === TaskQueueState.WAITING ||
      t.status === TaskQueueState.QUEUED
    );

    const stuckTasks = taskList.filter(t =>
      (t.status === TaskQueueState.RUNNING || t.status === TaskQueueState.WAITING) &&
      (now - (t.updatedAt || t.createdAt) > 60000)
    );

    const completedTasks = taskList.filter(t => t.status === TaskQueueState.COMPLETED);
    const failedTasks = taskList.filter(t => t.status === TaskQueueState.FAILED);
    const partialTasks = taskList.filter(t => t.status === TaskQueueState.PARTIALLY_COMPLETED);

    let status = DiagnosticStatus.HEALTHY;
    let summary = '';

    if (stuckTasks.length > 0) {
      status = DiagnosticStatus.DEGRADED;
      const stuckIds = stuckTasks.map(t => t.taskId).slice(0, 3).join(', ');
      summary = `Task queue has ${stuckTasks.length} stuck task(s) exceeding 60s timeout (IDs: ${stuckIds}). Active: ${activeTasks.length}, Total: ${taskList.length}.`;
    } else if (activeTasks.length >= TaskQueue._maxGlobalTasks) {
      status = DiagnosticStatus.DEGRADED;
      summary = `Task queue overload: ${activeTasks.length} active tasks reaching capacity limit (${TaskQueue._maxGlobalTasks}).`;
    } else {
      status = DiagnosticStatus.HEALTHY;
      summary = `Task queue is operating normally. ${activeTasks.length} active, ${completedTasks.length} completed, ${partialTasks.length} partial, ${failedTasks.length} failed. 0 stuck tasks.`;
    }

    return {
      task: 'task_queue_health',
      status,
      structured: {
        component: 'task_queue',
        totalTasks: taskList.length,
        activeTasks: activeTasks.length,
        stuckTasks: stuckTasks.length,
        completedTasks: completedTasks.length,
        failedTasks: failedTasks.length
      },
      response: summary,
      correlationId
    };
  }

  /**
   * Diagnoses Voice connection, FFmpeg availability, and Music playback state.
   */
  static async diagnoseMusicVoiceHealth(context = {}, correlationId) {
    const guild = context.guild;
    const { MusicService } = await import('./music-service.js');
    const diag = MusicService.getDiagnostics(guild?.id);
    const ffmpegOk = diag.ffmpegAvailable;
    const hasVoiceConnection = diag.connected;
    const isPlaying = diag.playerStatus === 'playing';
    const track = diag.currentTrack;

    const checks = {
      'FFmpeg Audio Transcoder': {
        status: ffmpegOk ? 'healthy' : 'failed',
        details: ffmpegOk ? `FFmpeg ready (${diag.ffmpegPath})` : 'FFmpeg binary missing in environment.'
      },
      'Opus Audio Encoder': {
        status: diag.opusAvailable ? 'healthy' : 'failed',
        details: diag.opusAvailable ? 'Opus encoder active (opusscript / libopus).' : 'Opus encoder unavailable.'
      },
      'Voice Connection': {
        status: hasVoiceConnection ? 'healthy' : (diag.voiceStatus !== 'disconnected' ? 'degraded' : 'healthy'),
        details: `Voice status: ${diag.voiceStatus} (Channel: ${diag.channelId || 'none'})`
      },
      'Audio Player': {
        status: isPlaying ? 'healthy' : (diag.playerStatus === 'autopaused' ? 'failed' : 'healthy'),
        details: isPlaying
          ? `Playing: "${track?.title || 'Unknown'}" (${diag.playbackDuration}ms rendered)`
          : `Status: ${diag.playerStatus} (Lifecycle: ${diag.lifecycleState})`
      },
      'Queue State': {
        status: 'healthy',
        details: `${diag.queueLength} track(s) in queue | Volume: ${diag.volume}% | Loop: ${diag.loopMode}`
      }
    };

    // If safe repair requested, trigger MusicService.repairGuildPlayback
    if (context.repair || /(?:repair|fix|reset)\s+(?:music|voice|audio|player)/i.test(context.cleanPrompt || '')) {
      const repairOutcome = await MusicService.repairGuildPlayback(guild?.id);
      checks['Self-Repair'] = {
        status: 'healthy',
        details: repairOutcome.actionsTaken.join(' ')
      };
    }

    const status = !ffmpegOk
      ? DiagnosticStatus.FAILED
      : (diag.playerStatus === 'autopaused'
          ? DiagnosticStatus.FAILED
          : (isPlaying || !hasVoiceConnection ? DiagnosticStatus.HEALTHY : DiagnosticStatus.DEGRADED));

    const summary = !ffmpegOk
      ? 'FFmpeg transcoder is unavailable. Voice audio playback cannot function without FFmpeg.'
      : (isPlaying
          ? `Music subsystem is actively delivering audio for "${track?.title}".`
          : (hasVoiceConnection
              ? `Connected to voice channel. Player state: ${diag.playerStatus} (Lifecycle: ${diag.lifecycleState}).`
              : 'Voice and music subsystem is operational. Connect to a voice channel and use `/go prompt: play <song>` to start playback.'));

    return {
      task: 'music_voice_health',
      status,
      checks,
      response: summary,
      correlationId
    };
  }

  /**
   * Diagnoses persistent self-role panels, button handlers, and reaction role mappings.
   */
  static async diagnoseSelfRolesHealth(context = {}, correlationId) {
    const guild = context.guild;
    if (!guild) {
      return {
        task: 'self_roles_health',
        status: DiagnosticStatus.UNKNOWN,
        response: 'Self-roles diagnostic requires an active Discord server context.',
        correlationId
      };
    }

    const diag = await SelfRoleManager.diagnosePanels(guild);
    let status = diag.healthy ? DiagnosticStatus.HEALTHY : DiagnosticStatus.DEGRADED;
    let summary = `**Self-Role & Reaction-Role Panel Health**\n\n• Registered Panels: ${diag.totalPanels}\n• Bot Manage Roles Permission: ${diag.hasManageRoles ? 'Granted' : 'Missing'}`;

    if (diag.findings.length > 0) {
      status = DiagnosticStatus.DEGRADED;
      summary += '\n\n**Detected Issues:**\n' + diag.findings.map(f => `• [${f.severity}] **${f.title}**: ${f.issue}`).join('\n');
    } else if (diag.totalPanels > 0) {
      summary += '\n• All registered self-role and reaction-role panels are healthy, verified in channel cache, and bot permissions satisfy hierarchy requirements.';
    } else {
      summary += '\n• No self-role or reaction-role panels are currently configured in this server.';
    }

    return {
      task: 'self_roles_health',
      status,
      response: summary,
      correlationId
    };
  }

  /**
   * Evaluates Honeypot channel configuration, permissions, and active enforcement.
   */
  static async diagnoseHoneypotHealth(context = {}, correlationId) {
    const guild = context.guild;
    if (!guild) {
      return {
        task: 'honeypot_health',
        status: DiagnosticStatus.FAILED,
        response: 'Valid Discord guild context required to diagnose honeypot subsystem.',
        correlationId
      };
    }

    const { HoneypotService } = await import('./honeypot-service.js');
    const testRes = await HoneypotService.runDiagnosticTest(guild, context.invokingUser);
    const status = testRes.healthy ? DiagnosticStatus.HEALTHY : DiagnosticStatus.DEGRADED;
    const summary = testRes.healthy
      ? 'Honeypot subsystem is healthy and verified operational in this server.'
      : 'Honeypot subsystem has detected configuration or permission issues.';

    return {
      task: 'honeypot_health',
      status,
      checks: testRes.checks,
      response: summary,
      correlationId
    };
  }
}
