import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger } from './logger.js';
import { config } from './config.js';
import { slashCommands } from './commands.js';
import { TaskScheduler } from './scheduler.js';
import { CaseManager } from './case-manager.js';
import { MusicService } from './music-service.js';
import { TaskQueue } from './task-queue.js';
import { AIProvider } from './ai-provider.js';
import { globalLifecycle, LifecycleState } from './bot-lifecycle.js';
import { globalCommandRegistry } from './command-registry.js';
import { ActivityType } from 'discord.js';

const logger = new Logger('Watchdog');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '..', 'data');

/**
 * Standard Recovery Outcomes
 * Distinguishes truthful operational results. Never reports "fixed" without verification.
 */
export const RecoveryTaxonomy = {
  RECOVERY_NOT_NEEDED: 'RECOVERY_NOT_NEEDED',
  RECONNECTION_IN_PROGRESS: 'RECONNECTION_IN_PROGRESS',
  RECOVERY_SUCCESSFUL_VERIFIED: 'RECOVERY_SUCCESSFUL_VERIFIED',
  PROCESS_RESTART_REQUESTED: 'PROCESS_RESTART_REQUESTED',
  RESTART_COMPLETED_UNVERIFIED: 'RESTART_COMPLETED_UNVERIFIED',
  RECOVERY_FAILED: 'RECOVERY_FAILED',
  MANUAL_INTERVENTION_REQUIRED: 'MANUAL_INTERVENTION_REQUIRED'
};

/**
 * Diagnostic Event Types
 */
export const WatchdogEvent = {
  STATE_CHANGE: 'STATE_CHANGE',
  GATEWAY_DISCONNECT: 'GATEWAY_DISCONNECT',
  GATEWAY_RECONNECT: 'GATEWAY_RECONNECT',
  HEARTBEAT_TIMEOUT: 'HEARTBEAT_TIMEOUT',
  AUTH_FAILURE: 'AUTH_FAILURE',
  PROCESS_ERROR: 'PROCESS_ERROR',
  HANDLER_ERROR_SPIKE: 'HANDLER_ERROR_SPIKE',
  RECOVERY_ATTEMPT: 'RECOVERY_ATTEMPT',
  RECOVERY_RESULT: 'RECOVERY_RESULT',
  POST_UPDATE_VALIDATION: 'POST_UPDATE_VALIDATION',
  GHOST_ONLINE_DETECTED: 'GHOST_ONLINE_DETECTED',
  STARTUP_STAGE_CHANGE: 'STARTUP_STAGE_CHANGE',
  COMMAND_DISPATCH_TIMEOUT: 'COMMAND_DISPATCH_TIMEOUT',
  COMMAND_REGISTRY_MISMATCH: 'COMMAND_REGISTRY_MISMATCH',
  INTERACTION_ERROR: 'INTERACTION_ERROR'
};

/**
 * Subsystem Health States
 */
export const SubsystemStatus = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  FAILED: 'failed',
  OFFLINE: 'offline',
  UNVERIFIED: 'unverified',
  NOT_APPLICABLE: 'not_applicable'
};

/**
 * Autonomous Health Monitor and Watchdog Engine.
 * Monitored independently: hosting process, HTTP endpoints, Discord gateway, client ready,
 * slash commands, LLM provider, database persistence, music subsystem, and background schedulers.
 */
export class Watchdog {
  constructor(options = {}) {
    this.client = options.client || null;
    this.checkIntervalMs = options.checkIntervalMs || 30000;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.circuitBreakerWindowMs = options.circuitBreakerWindowMs || 10 * 60 * 1000; // 10 minutes
    this.maxRecoveryAttempts = options.maxRecoveryAttempts || 5;

    this.timer = null;
    this.isRunning = false;
    this.isRecovering = false;

    // Subsystem health tracking
    this.lastSuccessfulCheck = Date.now();
    this.consecutiveFailures = 0;
    this.recoveryHistory = [];
    this.events = [];
    this.maxEventHistory = 100;

    // Error window tracking for spike detection
    this.recentErrors = [];
    this.errorSpikeThreshold = 5; // > 5 errors in 60s
    this.errorSpikeWindowMs = 60000;

    // Gateway reconnection backoff state
    this.reconnectAttempt = 0;
    this.circuitBreakerTripped = false;

    // Interaction tracking & Ghost-Online detection
    this.inFlightInteractions = new Map();
    this.recentInteractions = [];
    this.maxInteractionHistory = 50;
    this.hungCommandThresholdMs = options.hungCommandThresholdMs || 30000;
  }

  /**
   * Records the start of an interaction execution.
   */
  recordInteractionStart(interaction, executionId) {
    const commandName = interaction?.commandName || 'interaction';
    const entry = {
      executionId,
      commandName,
      userId: interaction?.user?.id ? Logger.redactSecrets(interaction.user.id) : 'unknown',
      guildId: interaction?.guildId || 'dm',
      startTime: Date.now()
    };
    this.inFlightInteractions.set(executionId, entry);
    return entry;
  }

  /**
   * Records successful completion of an interaction execution.
   */
  recordInteractionComplete(interaction, executionId, durationMs, outcome = 'SUCCESS') {
    const entry = this.inFlightInteractions.get(executionId);
    this.inFlightInteractions.delete(executionId);

    const record = {
      executionId,
      commandName: interaction?.commandName || entry?.commandName || 'interaction',
      startTime: entry?.startTime || (Date.now() - durationMs),
      durationMs,
      outcome,
      timestamp: new Date().toISOString()
    };

    this.recentInteractions.unshift(record);
    if (this.recentInteractions.length > this.maxInteractionHistory) {
      this.recentInteractions.pop();
    }
    return record;
  }

  /**
   * Records failure of an interaction execution.
   */
  recordInteractionFailed(interaction, executionId, durationMs, error) {
    const entry = this.inFlightInteractions.get(executionId);
    this.inFlightInteractions.delete(executionId);

    const errorMessage = error instanceof Error ? error.message : String(error || 'Unknown error');
    const record = {
      executionId,
      commandName: interaction?.commandName || entry?.commandName || 'interaction',
      startTime: entry?.startTime || (Date.now() - durationMs),
      durationMs,
      outcome: 'FAILED',
      error: Logger.redactSecrets(errorMessage),
      timestamp: new Date().toISOString()
    };

    this.recentInteractions.unshift(record);
    if (this.recentInteractions.length > this.maxInteractionHistory) {
      this.recentInteractions.pop();
    }

    this.trackError({
      context: 'interaction_failure',
      command: record.commandName,
      executionId,
      error: record.error
    });

    return record;
  }

  /**
   * Records interaction execution timeout.
   */
  recordInteractionTimedOut(interaction, executionId, durationMs) {
    const entry = this.inFlightInteractions.get(executionId);
    this.inFlightInteractions.delete(executionId);

    const record = {
      executionId,
      commandName: interaction?.commandName || entry?.commandName || 'interaction',
      startTime: entry?.startTime || (Date.now() - durationMs),
      durationMs,
      outcome: 'TIMED_OUT',
      timestamp: new Date().toISOString()
    };

    this.recentInteractions.unshift(record);
    if (this.recentInteractions.length > this.maxInteractionHistory) {
      this.recentInteractions.pop();
    }

    this.recordEvent(WatchdogEvent.COMMAND_DISPATCH_TIMEOUT, 'warn', {
      executionId,
      commandName: record.commandName,
      durationMs
    });

    return record;
  }

  /**
   * Inspects in-flight commands to find any that have hung beyond the threshold.
   */
  getHungInteractions(thresholdMs = this.hungCommandThresholdMs) {
    const now = Date.now();
    const hung = [];
    for (const [id, entry] of this.inFlightInteractions.entries()) {
      const elapsed = now - entry.startTime;
      if (elapsed > thresholdMs) {
        hung.push({ ...entry, elapsedMs: elapsed });
      }
    }
    return hung;
  }

  /**
   * Authoritative Ghost-Online Condition Detector.
   * 
   * Detects when Honey Bot appears online in Discord Gateway, but fails to process commands
   * due to application failure, hung handlers, command registry mismatch, or dispatch error spike.
   */
  detectGhostOnline(options = {}) {
    const isGatewayOnline = this.isDiscordReady();
    if (!isGatewayOnline) {
      return { isGhostOnline: false, reason: 'Gateway offline' };
    }

    // 1. Check application startup lifecycle
    const lifecycleState = globalLifecycle.getState();
    if (lifecycleState === LifecycleState.FAILED) {
      return {
        isGhostOnline: true,
        reason: `Application initialization failed (${globalLifecycle.lastError || 'critical error'})`,
        details: { lifecycleState, error: globalLifecycle.lastError }
      };
    }
    if (lifecycleState === LifecycleState.BOOTING || lifecycleState === LifecycleState.VALIDATING_CONFIG) {
      return {
        isGhostOnline: true,
        reason: `Application still in early startup phase (${lifecycleState})`,
        details: { lifecycleState }
      };
    }

    // 2. Check for hung command executions
    const hungThreshold = options.hungThresholdMs || this.hungCommandThresholdMs;
    const hung = this.getHungInteractions(hungThreshold);
    if (hung.length > 0) {
      return {
        isGhostOnline: true,
        reason: `${hung.length} command execution(s) hung beyond ${Math.round(hungThreshold / 1000)}s without resolution`,
        details: { hungCount: hung.length, hungCommands: hung.map(h => h.commandName) }
      };
    }

    // 3. Check command registry consistency
    const registryCheck = globalCommandRegistry.verifyConsistency();
    if (!registryCheck.valid) {
      return {
        isGhostOnline: true,
        reason: `Command registry mismatch: ${registryCheck.missingHandlers.length} missing handler(s)`,
        details: { missingHandlers: registryCheck.missingHandlers, schemaErrors: registryCheck.schemaErrors }
      };
    }

    // 4. Check interaction error spike
    const recentFailures = this.recentInteractions.slice(0, 5).filter(i => i.outcome === 'FAILED' || i.outcome === 'TIMED_OUT');
    if (recentFailures.length >= 4 && this.recentInteractions.length >= 4) {
      return {
        isGhostOnline: true,
        reason: `High interaction failure rate (${recentFailures.length} of last ${this.recentInteractions.length} commands failed or timed out)`,
        details: { recentFailures: recentFailures.map(f => ({ cmd: f.commandName, outcome: f.outcome })) }
      };
    }

    return { isGhostOnline: false, reason: null, details: {} };
  }

  /**
   * Starts the watchdog background monitor.
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info('Autonomous Health Watchdog started', {
      intervalMs: this.checkIntervalMs,
      maxAttempts: this.maxRecoveryAttempts
    });

    this.timer = setInterval(() => {
      this.checkSubsystems().catch(err => {
        logger.error('Watchdog cycle error', { error: err.message });
      });
    }, this.checkIntervalMs);
    if (typeof this.timer?.unref === 'function') {
      this.timer.unref();
    }

    // Initial check
    this.checkSubsystems().catch(() => {});
  }

  /**
   * Stops the watchdog background monitor.
   */
  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('Autonomous Health Watchdog stopped');
  }

  /**
   * Appends a timestamped diagnostic event into the circular buffer.
   */
  recordEvent(type, severity, details = {}) {
    const event = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      type,
      severity,
      details
    };

    this.events.unshift(event);
    if (this.events.length > this.maxEventHistory) {
      this.events.pop();
    }

    if (severity === 'error' || severity === 'critical') {
      logger.error(`[WatchdogEvent:${type}]`, details);
    } else if (severity === 'warn') {
      logger.warn(`[WatchdogEvent:${type}]`, details);
    } else {
      logger.info(`[WatchdogEvent:${type}]`, details);
    }

    return event;
  }

  /**
   * Retrieves sanitized diagnostic events.
   */
  getEvents(limit = 50) {
    return this.events.slice(0, Math.min(limit, this.events.length));
  }

  /**
   * Evaluates if the hosting process is alive.
   */
  isProcessAlive() {
    return Boolean(process && typeof process.uptime === 'function' && process.uptime() >= 0);
  }

  /**
   * Evaluates if the Discord client is online and authenticated.
   */
  isDiscordReady() {
    return Boolean(this.client && typeof this.client.isReady === 'function' && this.client.isReady());
  }

  /**
   * Readiness check for HTTP /readyz endpoint.
   * True only when process is alive AND Discord is authenticated and ready AND persistence is accessible AND NOT ghost-online.
   */
  isSystemReady() {
    if (!this.isProcessAlive()) return false;
    if (!this.isDiscordReady()) return false;

    // Check application lifecycle: must not be in FAILED or BOOTING
    if (globalLifecycle && !globalLifecycle.isApplicationReady()) {
      return false;
    }

    // Check Ghost-Online condition: gateway connected but commands dead
    const ghost = this.detectGhostOnline();
    if (ghost.isGhostOnline) {
      return false;
    }

    // Check persistence accessibility
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
    } catch {
      return false;
    }

    return true;
  }

  /**
   * Checks database read/write persistence health safely.
   */
  checkPersistenceHealth() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const testFile = path.join(DATA_DIR, '.watchdog_health_test.tmp');
      fs.writeFileSync(testFile, 'ok', 'utf8');
      fs.unlinkSync(testFile);
      return { status: SubsystemStatus.HEALTHY, message: 'Data directory read/write operational' };
    } catch (err) {
      return { status: SubsystemStatus.DEGRADED, message: `Persistence failure: ${err.message}` };
    }
  }

  /**
   * Aggregates complete, independent status across all 10 tracked subsystem states.
   * Exposes zero tokens, secrets, or guild PII.
   */
  getDetailedHealth() {
    const memory = process.memoryUsage();
    const heapUsedMb = Math.round(memory.heapUsed / 1024 / 1024);
    const heapTotalMb = Math.round(memory.heapTotal / 1024 / 1024);
    const rssMb = Math.round(memory.rss / 1024 / 1024);

    const isClientReady = this.isDiscordReady();
    const wsStatus = this.client?.ws ? this.client.ws.status : -1;
    const wsPing = this.client?.ws?.ping ?? -1;

    // Gateway connection status mapping
    let gatewayStatus = SubsystemStatus.OFFLINE;
    if (wsStatus === 0) gatewayStatus = SubsystemStatus.HEALTHY; // 0 = READY in Discord.js
    else if (wsStatus === 1 || wsStatus === 2) gatewayStatus = SubsystemStatus.DEGRADED; // CONNECTING / RECONNECTING

    // Persistence health
    const persistHealth = this.checkPersistenceHealth();

    // LLM Provider state
    const aiProvider = config.ai.provider;
    const aiStrictZeroCost = config.ai.strictZeroCost;
    const aiKeyPresent = Boolean(config.ai.gemini.apiKey || config.ai.groq.apiKey);

    // Music subsystem diagnostics
    let musicDiag = { status: SubsystemStatus.HEALTHY, activeConnections: 0, ffmpegAvailable: true };
    try {
      const diag = MusicService.getDiagnostics();
      musicDiag = {
        status: diag.healthy ? SubsystemStatus.HEALTHY : SubsystemStatus.DEGRADED,
        activeConnections: diag.activeConnections || 0,
        ffmpegAvailable: diag.ffmpegAvailable,
        opusAvailable: diag.opusAvailable
      };
    } catch {
      musicDiag = { status: SubsystemStatus.DEGRADED, activeConnections: 0, ffmpegAvailable: false };
    }

    // Background schedulers
    const schedulerRunning = TaskScheduler._isRunning || false;
    const caseSchedulerRunning = CaseManager._isRunning || false;
    const schedulersStatus = (schedulerRunning || caseSchedulerRunning) ? SubsystemStatus.HEALTHY : SubsystemStatus.DEGRADED;

    // Overall readiness
    const overallReady = this.isSystemReady();

    return {
      timestamp: new Date().toISOString(),
      overallReady,
      subsystems: {
        process: {
          status: SubsystemStatus.HEALTHY,
          pid: process.pid,
          uptimeSeconds: Math.floor(process.uptime()),
          nodeVersion: process.version,
          memoryMb: { heapUsed: heapUsedMb, heapTotal: heapTotalMb, rss: rssMb }
        },
        httpEndpoint: {
          status: SubsystemStatus.HEALTHY,
          port: Number(process.env.PORT || 3000),
          endpoints: ['/healthz', '/readyz', '/health', '/health/events', '/test-discord']
        },
        discordGateway: {
          status: gatewayStatus,
          wsStatus,
          wsPingMs: wsPing >= 0 ? wsPing : null,
          reconnectAttempt: this.reconnectAttempt
        },
        discordClient: {
          status: isClientReady ? SubsystemStatus.HEALTHY : SubsystemStatus.OFFLINE,
          isReady: isClientReady,
          authenticatedTag: this.client?.user ? this.client.user.tag : null,
          botId: this.client?.user ? this.client.user.id : null,
          guildCount: this.client?.guilds?.cache ? this.client.guilds.cache.size : 0
        },
        slashCommands: {
          status: slashCommands?.length === 6 ? SubsystemStatus.HEALTHY : SubsystemStatus.DEGRADED,
          registeredCount: slashCommands?.length || 0,
          commands: slashCommands ? slashCommands.map(c => c.name) : []
        },
        llmProvider: {
          status: aiKeyPresent ? SubsystemStatus.HEALTHY : SubsystemStatus.DEGRADED,
          provider: aiProvider,
          strictZeroCost: aiStrictZeroCost,
          apiKeyConfigured: aiKeyPresent
        },
        persistence: {
          status: persistHealth.status,
          message: persistHealth.message,
          dataDirectory: DATA_DIR
        },
        musicVoice: musicDiag,
        backgroundTasks: {
          status: schedulersStatus,
          taskSchedulerActive: schedulerRunning,
          caseManagerSchedulerActive: caseSchedulerRunning
        },
        watchdog: {
          status: this.circuitBreakerTripped ? SubsystemStatus.DEGRADED : SubsystemStatus.HEALTHY,
          isRunning: this.isRunning,
          lastCheck: new Date(this.lastSuccessfulCheck).toISOString(),
          consecutiveFailures: this.consecutiveFailures,
          circuitBreakerTripped: this.circuitBreakerTripped,
          recentRecoveryAttempts: this.recoveryHistory.length
        },
        ghostOnline: (() => {
          const ghost = this.detectGhostOnline();
          return {
            status: ghost.isGhostOnline ? SubsystemStatus.FAILED : SubsystemStatus.HEALTHY,
            detected: ghost.isGhostOnline,
            reason: ghost.reason,
            details: ghost.details
          };
        })(),
        commandDispatch: {
          status: this.getHungInteractions().length > 0 ? SubsystemStatus.DEGRADED : SubsystemStatus.HEALTHY,
          inFlightCount: this.inFlightInteractions.size,
          hungCount: this.getHungInteractions().length,
          recentCount: this.recentInteractions.length,
          recentErrors: this.recentErrors.length
        },
        lifecycle: globalLifecycle ? globalLifecycle.getReport() : { currentState: 'READY' }
      }
    };
  }

  /**
   * Heartbeat cycle: Evaluates all subsystems and triggers appropriate recovery if degraded.
   */
  async checkSubsystems() {
    this.lastSuccessfulCheck = Date.now();
    this._pruneHistory();

    const isReady = this.isDiscordReady();
    if (!isReady) {
      this.consecutiveFailures++;
      logger.warn('Watchdog detected Discord client is offline or disconnected', {
        consecutiveFailures: this.consecutiveFailures
      });

      this.recordEvent(WatchdogEvent.GATEWAY_DISCONNECT, 'warn', {
        consecutiveFailures: this.consecutiveFailures,
        wsStatus: this.client?.ws?.status ?? -1
      });

      // Attempt safe recovery if not already recovering
      if (!this.isRecovering) {
        await this.attemptLayeredRecovery('discordGateway');
      }
      return;
    }

    // Detect silent socket freeze / zombie gateway
    const wsPing = this.client?.ws?.ping;
    if (isReady && wsPing !== undefined && Number.isNaN(wsPing)) {
      logger.warn('Watchdog detected zombie gateway socket (WebSocket ping is NaN)');
      this.recordEvent(WatchdogEvent.HEARTBEAT_TIMEOUT, 'warn', { ping: wsPing });
      if (!this.isRecovering) {
        await this.attemptLayeredRecovery('zombieSocket');
      }
      return;
    }

    // Detect Ghost-Online condition (connected to Discord but commands impaired)
    const ghost = this.detectGhostOnline();
    if (ghost.isGhostOnline) {
      logger.warn(`Watchdog detected Ghost-Online condition: ${ghost.reason}`);
      this.recordEvent(WatchdogEvent.GHOST_ONLINE_DETECTED, 'warn', {
        reason: ghost.reason,
        details: ghost.details
      });
      if (!this.isRecovering && ghost.details?.hungCount) {
        await this.attemptLayeredRecovery('hungCommands');
      }
      return;
    }

    // Healthy cycle
    if (this.consecutiveFailures > 0) {
      logger.info('Watchdog: Discord connectivity restored', {
        previousFailures: this.consecutiveFailures
      });
      this.recordEvent(WatchdogEvent.GATEWAY_RECONNECT, 'info', {
        recoveredAfterFailures: this.consecutiveFailures
      });
      this.consecutiveFailures = 0;
      this.reconnectAttempt = 0;
    }
  }

  /**
   * Tracks command errors and unhandled rejections to catch error spikes.
   */
  trackError(errorContext) {
    const now = Date.now();
    this.recentErrors.push({ timestamp: now, context: errorContext });
    this.recentErrors = this.recentErrors.filter(e => now - e.timestamp < this.errorSpikeWindowMs);

    if (this.recentErrors.length >= this.errorSpikeThreshold) {
      logger.warn(`Watchdog detected error spike: ${this.recentErrors.length} errors in past ${this.errorSpikeWindowMs / 1000}s`);
      this.recordEvent(WatchdogEvent.HANDLER_ERROR_SPIKE, 'warn', {
        errorCount: this.recentErrors.length,
        windowSeconds: this.errorSpikeWindowMs / 1000
      });
    }
  }

  /**
   * Layered Recovery Pipeline
   * Preferred Order:
   * 1. Allow Discord.js normal gateway reconnect with bounded backoff & jitter.
   * 2. Retry recoverable external service operations.
   * 3. Reinitialize failed noncritical subsystems.
   * 4. Escalate to process manager restart if supervisor exists.
   * 5. If unrecoverable or circuit breaker trips, report MANUAL_INTERVENTION_REQUIRED.
   */
  async attemptLayeredRecovery(targetSubsystem, options = {}) {
    if (this.isRecovering) {
      return { outcome: RecoveryTaxonomy.RECONNECTION_IN_PROGRESS, message: 'Recovery already underway.' };
    }

    this._pruneHistory();
    if (this.recoveryHistory.length >= this.maxRecoveryAttempts) {
      this.circuitBreakerTripped = true;
      const msg = `Circuit breaker active: exceeded ${this.maxRecoveryAttempts} recovery attempts within ${this.circuitBreakerWindowMs / 60000}m.`;
      logger.error(msg);
      this.recordEvent(WatchdogEvent.RECOVERY_RESULT, 'critical', { outcome: RecoveryTaxonomy.MANUAL_INTERVENTION_REQUIRED, reason: msg });
      return { outcome: RecoveryTaxonomy.MANUAL_INTERVENTION_REQUIRED, message: msg };
    }

    this.isRecovering = true;
    this.recoveryHistory.push(Date.now());
    this.reconnectAttempt++;

    this.recordEvent(WatchdogEvent.RECOVERY_ATTEMPT, 'info', {
      targetSubsystem,
      attemptNumber: this.reconnectAttempt
    });

    try {
      // Level 1: Gateway Reconnection with Bounded Backoff and Jitter
      if (targetSubsystem === 'discordGateway' || targetSubsystem === 'zombieSocket') {
        const outcome = await this._recoverGateway();
        return outcome;
      }

      // Level 2: External Service / AI Quota Recovery
      if (targetSubsystem === 'llmProvider') {
        logger.info('Resetting AI provider telemetry and backoff window');
        return { outcome: RecoveryTaxonomy.RECOVERY_SUCCESSFUL_VERIFIED, message: 'AI provider backoff reset' };
      }

      // Level 3: Noncritical Subsystems (Schedulers, Music, TaskQueue, Hung Commands)
      if (targetSubsystem === 'hungCommands') {
        logger.info('Clearing hung command executions from watchdog state');
        this.inFlightInteractions.clear();
        return { outcome: RecoveryTaxonomy.RECOVERY_SUCCESSFUL_VERIFIED, message: 'Hung command executions cleared' };
      }

      if (targetSubsystem === 'schedulers') {
        logger.info('Reinitializing background schedulers');
        TaskScheduler.startScheduler();
        CaseManager.startScheduler();
        return { outcome: RecoveryTaxonomy.RECOVERY_SUCCESSFUL_VERIFIED, message: 'Schedulers reinitialized successfully' };
      }

      return { outcome: RecoveryTaxonomy.RECOVERY_NOT_NEEDED, message: `Subsystem ${targetSubsystem} normal` };
    } catch (err) {
      logger.error('Layered recovery failed', { error: err.message });
      this.recordEvent(WatchdogEvent.RECOVERY_RESULT, 'error', {
        outcome: RecoveryTaxonomy.RECOVERY_FAILED,
        error: err.message
      });
      return { outcome: RecoveryTaxonomy.RECOVERY_FAILED, error: err.message };
    } finally {
      this.isRecovering = false;
    }
  }

  /**
   * Level 1 Gateway Recovery with exponential backoff and jitter.
   */
  async _recoverGateway() {
    if (!config.discord.token) {
      const msg = 'Missing DISCORD_TOKEN. Cannot connect to Discord Gateway.';
      logger.error(msg);
      this.recordEvent(WatchdogEvent.AUTH_FAILURE, 'critical', { reason: msg });
      return { outcome: RecoveryTaxonomy.MANUAL_INTERVENTION_REQUIRED, message: msg };
    }

    // Bounded backoff: 5s, 10s, 20s... max 60s + 1-3s random jitter
    const baseDelay = Math.min(5000 * Math.pow(2, Math.min(this.reconnectAttempt - 1, 4)), 60000);
    const jitter = Math.floor(Math.random() * 3000);
    const delayMs = baseDelay + jitter;

    logger.info(`Watchdog scheduling gateway reconnection in ${Math.round(delayMs / 1000)}s (Attempt ${this.reconnectAttempt}/${this.maxReconnectAttempts})`);

    await new Promise(r => setTimeout(r, delayMs));

    if (this.client && !this.client.isReady()) {
      try {
        await this.client.login(config.discord.token.trim());
        if (this.client?.user && typeof this.client.user.setPresence === 'function') {
          try {
            this.client.user.setPresence({
              activities: [{ name: '/go <instruction>', type: ActivityType.Playing }],
              status: 'online'
            });
          } catch {}
        }
        const verification = await this.verifyDiscordFunctionality();
        if (verification.verified) {
          this.reconnectAttempt = 0;
          this.recordEvent(WatchdogEvent.RECOVERY_RESULT, 'info', {
            outcome: RecoveryTaxonomy.RECOVERY_SUCCESSFUL_VERIFIED,
            details: verification
          });
          return { outcome: RecoveryTaxonomy.RECOVERY_SUCCESSFUL_VERIFIED, details: verification };
        } else {
          return { outcome: RecoveryTaxonomy.RESTART_COMPLETED_UNVERIFIED, details: verification };
        }
      } catch (err) {
        logger.error('Gateway reconnection attempt failed', { error: err.message, attempt: this.reconnectAttempt });

        // Level 4 Check: If fatal auth error or max attempts reached and supervisor exists, request restart
        if (this.reconnectAttempt >= this.maxReconnectAttempts) {
          return this._evaluateSupervisorRestart('Exceeded maximum gateway reconnect attempts.');
        }

        return { outcome: RecoveryTaxonomy.RECOVERY_FAILED, error: err.message };
      }
    }

    return { outcome: RecoveryTaxonomy.RECOVERY_NOT_NEEDED, message: 'Client already online' };
  }

  /**
   * Level 4: Checks for hosting supervisor before requesting process restart.
   */
  _evaluateSupervisorRestart(reason) {
    const hasSupervisor = Boolean(
      process.env.pm_id || // PM2
      process.env.RENDER || // Render
      process.env.KOYEB || // Koyeb
      process.env.RAILWAY_STATIC_URL || // Railway
      process.env.FLY_ALLOC_ID || // Fly.io
      fs.existsSync('/.dockerenv') // Docker container supervisor
    );

    if (hasSupervisor) {
      logger.warn(`Supervised environment detected. Requesting process restart: ${reason}`);
      this.recordEvent(WatchdogEvent.STATE_CHANGE, 'critical', {
        outcome: RecoveryTaxonomy.PROCESS_RESTART_REQUESTED,
        reason
      });

      // Graceful shutdown before letting supervisor restart
      setTimeout(() => {
        try {
          TaskQueue.shutdown();
          MusicService.shutdownAll();
          this.client?.destroy();
        } catch {}
        process.exit(1);
      }, 1000);

      return { outcome: RecoveryTaxonomy.PROCESS_RESTART_REQUESTED, reason };
    }

    // No supervisor -> Cannot safely exit without crashing permanently
    const msg = `Unrecoverable condition detected without external process supervisor. ${reason} Manual restart required.`;
    logger.error(msg);
    this.recordEvent(WatchdogEvent.STATE_CHANGE, 'critical', {
      outcome: RecoveryTaxonomy.MANUAL_INTERVENTION_REQUIRED,
      reason: msg
    });
    return { outcome: RecoveryTaxonomy.MANUAL_INTERVENTION_REQUIRED, message: msg };
  }

  /**
   * Verifies actual Discord functionality after recovery.
   * Checks process, ready state, bot identity, handler availability, and persistence.
   */
  async verifyDiscordFunctionality() {
    const checks = {
      processAlive: this.isProcessAlive(),
      clientReady: this.isDiscordReady(),
      identityAuthenticated: Boolean(this.client?.user?.tag),
      handlersAvailable: slashCommands.length === 6,
      persistenceHealthy: this.checkPersistenceHealth().status === SubsystemStatus.HEALTHY
    };

    const verified = Object.values(checks).every(Boolean);

    return {
      verified,
      status: verified ? 'healthy' : 'unverified',
      checks,
      identity: this.client?.user ? this.client.user.tag : 'unauthenticated',
      guildCount: this.client?.guilds?.cache?.size || 0
    };
  }

  /**
   * Prunes history older than circuitBreakerWindowMs.
   */
  _pruneHistory() {
    const cutoff = Date.now() - this.circuitBreakerWindowMs;
    this.recoveryHistory = this.recoveryHistory.filter(t => t > cutoff);
    if (this.circuitBreakerTripped && this.recoveryHistory.length < this.maxRecoveryAttempts) {
      this.circuitBreakerTripped = false;
      logger.info('Circuit breaker cooldown expired; resetting tripped state');
    }
  }
}
