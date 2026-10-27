import { Logger } from './logger.js';
import { globalLifecycle, LifecycleState, SubsystemHealth } from './bot-lifecycle.js';
import { InstanceLock } from './instance-lock.js';
import { validateConfig, config } from './config.js';
import { globalCommandRegistry } from './command-registry.js';
import { TaskQueue } from './task-queue.js';
import { ActionLedger } from './recovery.js';
import { CaseManager } from './case-manager.js';
import { TaskScheduler } from './scheduler.js';
import { MusicService } from './music-service.js';
import { defaultPendingTaskManager } from './pending-task-manager.js';
import { defaultConversationMemoryManager } from './conversation-memory.js';
import { Events, ActivityType } from 'discord.js';

const logger = new Logger('StartupManager');

/**
 * Startup Manager for Honey Bot.
 * 
 * Executes an atomic, reliable, sequential startup lifecycle:
 * BOOTING -> VALIDATING_CONFIG -> INITIALIZING_SERVICES -> CONNECTING_DISCORD -> VERIFYING_COMMANDS -> READY
 * 
 * Guarantees that Honey Bot is never declared READY or marked online before
 * required initialization finishes successfully.
 */
export class StartupManager {
  constructor(options = {}) {
    this.lifecycle = options.lifecycle || globalLifecycle;
    this.client = options.client || null;
    this.watchdog = options.watchdog || null;
  }

  /**
   * Executes the full atomic startup pipeline.
   * 
   * @param {object} options
   * @param {boolean} options.skipLock If true, skips single-instance PID check (useful for testing).
   * @param {boolean} options.forceLock If true, overwrites any existing PID lock.
   */
  async runStartup(options = {}) {
    const startTime = Date.now();
    logger.info('Beginning Honey Bot atomic startup sequence...');

    // Stage 1: BOOTING & Single-Instance Lock
    try {
      this.lifecycle.transition(LifecycleState.BOOTING, { pid: process.pid });

      if (!options.skipLock) {
        const lock = InstanceLock.acquire({ force: options.forceLock });
        if (!lock.acquired) {
          const errMsg = `Duplicate instance detected (Existing PID: ${lock.existingPid}). Startup aborted to prevent gateway routing conflicts.`;
          logger.error(errMsg);
          this.lifecycle.transition(LifecycleState.FAILED, { error: errMsg });
          return { success: false, state: LifecycleState.FAILED, error: errMsg };
        }
      }
    } catch (err) {
      const errMsg = `Failed in BOOTING phase: ${err.message}`;
      logger.error(errMsg);
      this.lifecycle.transition(LifecycleState.FAILED, { error: errMsg });
      return { success: false, state: LifecycleState.FAILED, error: errMsg };
    }

    // Stage 2: VALIDATING_CONFIG
    try {
      this.lifecycle.transition(LifecycleState.VALIDATING_CONFIG);
      const validation = validateConfig();

      if (!validation.valid) {
        const errMsg = `Configuration validation failed: ${validation.issues.join('; ')}`;
        logger.error(errMsg);
        this.lifecycle.updateSubsystem('config', SubsystemHealth.FAILED, { issues: validation.issues });
        this.lifecycle.transition(LifecycleState.FAILED, { error: errMsg });
        return { success: false, state: LifecycleState.FAILED, error: errMsg };
      }

      if (!config.discord.token || typeof config.discord.token !== 'string' || !config.discord.token.trim()) {
        const errMsg = 'DISCORD_TOKEN environment variable is missing or empty.';
        logger.error(errMsg);
        this.lifecycle.updateSubsystem('config', SubsystemHealth.FAILED, { error: errMsg });
        this.lifecycle.transition(LifecycleState.FAILED, { error: errMsg });
        return { success: false, state: LifecycleState.FAILED, error: errMsg };
      }

      this.lifecycle.updateSubsystem('config', SubsystemHealth.READY);
    } catch (err) {
      const errMsg = `Configuration validation exception: ${err.message}`;
      logger.error(errMsg);
      this.lifecycle.transition(LifecycleState.FAILED, { error: errMsg });
      return { success: false, state: LifecycleState.FAILED, error: errMsg };
    }

    // Stage 3: INITIALIZING_SERVICES
    let hasDegradedService = false;
    try {
      this.lifecycle.transition(LifecycleState.INITIALIZING_SERVICES);

      // Persistence & Task Queue Reconciliation
      try {
        defaultPendingTaskManager.loadAllTasks();
        defaultPendingTaskManager.startScheduler();
        defaultConversationMemoryManager.startScheduler();

        if (this.client) {
          ActionLedger.loadAllHistory(this.client);
          await TaskQueue.reconcileOnStartup(this.client);
        }
        this.lifecycle.updateSubsystem('storage', SubsystemHealth.READY);
      } catch (storeErr) {
        logger.warn('Storage or task queue initialization issue', { error: storeErr.message });
        this.lifecycle.updateSubsystem('storage', SubsystemHealth.DEGRADED, { error: storeErr.message });
        hasDegradedService = true;
      }

      // Background Schedulers
      try {
        if (this.client) {
          CaseManager.startScheduler(this.client);
          TaskScheduler.startScheduler(this.client);
        }
        this.lifecycle.updateSubsystem('schedulers', SubsystemHealth.READY);
      } catch (schedErr) {
        logger.warn('Background scheduler initialization issue', { error: schedErr.message });
        this.lifecycle.updateSubsystem('schedulers', SubsystemHealth.DEGRADED, { error: schedErr.message });
        hasDegradedService = true;
      }

      // Music Engine
      try {
        const diag = MusicService.getDiagnostics();
        this.lifecycle.updateSubsystem('musicVoice', diag.healthy ? SubsystemHealth.READY : SubsystemHealth.DEGRADED);
        if (!diag.healthy) hasDegradedService = true;
      } catch {
        this.lifecycle.updateSubsystem('musicVoice', SubsystemHealth.DEGRADED);
        hasDegradedService = true;
      }
    } catch (err) {
      const errMsg = `Failed in INITIALIZING_SERVICES phase: ${err.message}`;
      logger.error(errMsg);
      this.lifecycle.transition(LifecycleState.FAILED, { error: errMsg });
      return { success: false, state: LifecycleState.FAILED, error: errMsg };
    }

    // Stage 4: CONNECTING_DISCORD
    if (this.client) {
      try {
        this.lifecycle.transition(LifecycleState.CONNECTING_DISCORD);
        if (!this.client.isReady()) {
          const readyPromise = new Promise((resolve, reject) => {
            const onReady = () => {
              cleanup();
              resolve();
            };
            const onError = (err) => {
              cleanup();
              reject(err);
            };
            const cleanup = () => {
              this.client.removeListener(Events.ClientReady, onReady);
              this.client.removeListener(Events.Error, onError);
            };

            this.client.once(Events.ClientReady, onReady);
            this.client.once(Events.Error, onError);
          });

          await this.client.login(config.discord.token.trim());
          await readyPromise;
        }

        this.lifecycle.updateSubsystem('discordGateway', SubsystemHealth.READY, {
          tag: this.client.user?.tag,
          guilds: this.client.guilds?.cache?.size || 0
        });
      } catch (err) {
        const errMsg = `Discord Gateway connection failed: ${err.message}`;
        logger.error(errMsg);
        this.lifecycle.updateSubsystem('discordGateway', SubsystemHealth.FAILED, { error: err.message });
        this.lifecycle.transition(LifecycleState.FAILED, { error: errMsg });
        return { success: false, state: LifecycleState.FAILED, error: errMsg };
      }
    }

    // Stage 5: VERIFYING_COMMANDS
    try {
      this.lifecycle.transition(LifecycleState.VERIFYING_COMMANDS);
      const registryCheck = globalCommandRegistry.verifyConsistency();

      if (!registryCheck.valid) {
        const errMsg = `Command verification failed: ${registryCheck.missingHandlers.length} missing handler(s), ${registryCheck.schemaErrors.length} schema error(s)`;
        logger.error(errMsg, { missing: registryCheck.missingHandlers, errors: registryCheck.schemaErrors });
        this.lifecycle.updateSubsystem('commandRegistry', SubsystemHealth.FAILED, {
          missing: registryCheck.missingHandlers,
          errors: registryCheck.schemaErrors
        });
        this.lifecycle.transition(LifecycleState.FAILED, { error: errMsg });
        return { success: false, state: LifecycleState.FAILED, error: errMsg };
      }

      this.lifecycle.updateSubsystem('commandRegistry', SubsystemHealth.READY, {
        commandCount: registryCheck.commandCount,
        commands: registryCheck.definitions
      });
    } catch (err) {
      const errMsg = `Failed in VERIFYING_COMMANDS phase: ${err.message}`;
      logger.error(errMsg);
      this.lifecycle.transition(LifecycleState.FAILED, { error: errMsg });
      return { success: false, state: LifecycleState.FAILED, error: errMsg };
    }

    // Stage 6: READY or DEGRADED
    const finalState = hasDegradedService ? LifecycleState.DEGRADED : LifecycleState.READY;
    this.lifecycle.transition(finalState, {
      durationMs: Date.now() - startTime,
      hasDegradedService
    });

    // Set custom activity once everything is verified
    if (this.client?.user && typeof this.client.user.setPresence === 'function') {
      try {
        this.client.user.setPresence({
          activities: [{ name: '/go <instruction>', type: ActivityType.Playing }],
          status: 'online'
        });
      } catch {}
    }

    logger.info(`✅ Honey Bot startup complete in ${Date.now() - startTime}ms. Status: ${finalState}`);
    return { success: true, state: finalState, durationMs: Date.now() - startTime };
  }
}

