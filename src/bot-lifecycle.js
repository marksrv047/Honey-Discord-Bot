import { Logger } from './logger.js';

const logger = new Logger('BotLifecycle');

/**
 * Standard Bot Lifecycle States.
 * Honey Bot is never marked READY until every required phase succeeds.
 */
export const LifecycleState = Object.freeze({
  BOOTING: 'BOOTING',
  VALIDATING_CONFIG: 'VALIDATING_CONFIG',
  INITIALIZING_SERVICES: 'INITIALIZING_SERVICES',
  CONNECTING_DISCORD: 'CONNECTING_DISCORD',
  VERIFYING_COMMANDS: 'VERIFYING_COMMANDS',
  READY: 'READY',
  DEGRADED: 'DEGRADED',
  FAILED: 'FAILED'
});

/**
 * Subsystem Readiness States
 */
export const SubsystemHealth = Object.freeze({
  PENDING: 'PENDING',
  INITIALIZING: 'INITIALIZING',
  READY: 'READY',
  DEGRADED: 'DEGRADED',
  FAILED: 'FAILED',
  NOT_APPLICABLE: 'NOT_APPLICABLE'
});

/**
 * Lifecycle Manager for Honey Bot.
 * 
 * Enforces explicit transition order:
 * BOOTING -> VALIDATING_CONFIG -> INITIALIZING_SERVICES -> CONNECTING_DISCORD -> VERIFYING_COMMANDS -> READY
 * 
 * Prevents premature declaration of readiness before initialization is complete.
 */
export class BotLifecycleManager {
  constructor(options = {}) {
    this.state = options.initialState || LifecycleState.READY;
    this.stateHistory = [
      { state: this.state, timestamp: new Date().toISOString(), details: 'Initialized' }
    ];
    this.bootTimestamp = Date.now();
    this.readyTimestamp = this.state === LifecycleState.READY ? Date.now() : null;
    this.failedTimestamp = null;
    this.lastError = null;

    // Independent subsystem status tracking
    this.subsystems = {
      config: SubsystemHealth.PENDING,
      storage: SubsystemHealth.PENDING,
      discordGateway: SubsystemHealth.PENDING,
      commandRegistry: SubsystemHealth.PENDING,
      schedulers: SubsystemHealth.PENDING,
      musicVoice: SubsystemHealth.PENDING,
      llmProvider: SubsystemHealth.PENDING
    };

    this.onStateChange = options.onStateChange || null;
  }

  /**
   * Returns current lifecycle state.
   */
  getState() {
    return this.state;
  }

  /**
   * Returns true if application is serving commands (READY or non-critically DEGRADED).
   */
  isApplicationReady() {
    return this.state === LifecycleState.READY || this.state === LifecycleState.DEGRADED;
  }

  /**
   * Returns true only if strictly healthy with 0 degraded subsystems.
   */
  isFullyHealthy() {
    return this.state === LifecycleState.READY;
  }

  /**
   * Transitions the lifecycle to a new state with structured logging and event dispatch.
   */
  transition(newState, details = {}) {
    const previousState = this.state;
    this.state = newState;
    const timestamp = new Date().toISOString();

    const record = {
      fromState: previousState,
      toState: newState,
      timestamp,
      details
    };

    this.stateHistory.push(record);
    if (this.stateHistory.length > 50) {
      this.stateHistory.shift();
    }

    if (newState === LifecycleState.READY) {
      this.readyTimestamp = Date.now();
      logger.info(`Lifecycle transitioned: ${previousState} -> ${newState}`, details);
    } else if (newState === LifecycleState.FAILED) {
      this.failedTimestamp = Date.now();
      this.lastError = details.error || 'Unknown initialization failure';
      logger.error(`Lifecycle initialization FAILED at stage ${previousState}`, details);
    } else if (newState === LifecycleState.DEGRADED) {
      logger.warn(`Lifecycle transitioned to DEGRADED mode from ${previousState}`, details);
    } else {
      logger.info(`Lifecycle transitioned: ${previousState} -> ${newState}`, details);
    }

    if (typeof this.onStateChange === 'function') {
      try {
        this.onStateChange(record);
      } catch (err) {
        logger.warn('Error in onStateChange callback', { error: err.message });
      }
    }

    return record;
  }

  /**
   * Updates an individual subsystem health status.
   */
  updateSubsystem(subsystemName, status, details = {}) {
    if (this.subsystems[subsystemName] !== undefined) {
      this.subsystems[subsystemName] = status;
      logger.info(`Subsystem ${subsystemName} updated to ${status}`, details);
    }
  }

  /**
   * Generates a comprehensive lifecycle diagnostic report.
   */
  getReport() {
    return {
      currentState: this.state,
      isApplicationReady: this.isApplicationReady(),
      isFullyHealthy: this.isFullyHealthy(),
      uptimeSeconds: Math.floor((Date.now() - this.bootTimestamp) / 1000),
      readyDurationMs: this.readyTimestamp ? Date.now() - this.readyTimestamp : null,
      lastError: this.lastError,
      subsystems: { ...this.subsystems },
      recentTransitions: this.stateHistory.slice(-10)
    };
  }
}

// Global singleton instance for runtime access
export const globalLifecycle = new BotLifecycleManager();
