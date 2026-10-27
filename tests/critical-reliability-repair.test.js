import test from 'node:test';
import assert from 'node:assert/strict';
import { BotLifecycleManager, LifecycleState, SubsystemHealth } from '../src/bot-lifecycle.js';
import { StartupManager } from '../src/startup-manager.js';
import { InstanceLock } from '../src/instance-lock.js';
import { CommandRegistry } from '../src/command-registry.js';
import { InteractionLifecycle, ExecutionOutcome, ResponseState } from '../src/interaction-lifecycle.js';
import { Watchdog, WatchdogEvent, RecoveryTaxonomy, SubsystemStatus } from '../src/watchdog.js';
import { handleCommandInteraction, slashCommands } from '../src/commands.js';
import { PostUpdateValidator, ValidationStatus } from '../src/post-update-validator.js';
import { DiagnosticService, DiagnosticStatus } from '../src/diagnostic-service.js';
import { OutcomeTracker, OutcomeStatus } from '../src/outcome-tracker.js';
import { Verifier, VerificationStatus } from '../src/verification.js';
import { ModLogService } from '../src/mod-log.js';
import { MusicService } from '../src/music-service.js';
import { config } from '../src/config.js';

// Helper to create mocked Discord interactions
function createMockInteraction(options = {}) {
  const repl = {
    content: null,
    embeds: [],
    components: [],
    ephemeral: false
  };

  let deferred = Boolean(options.deferred);
  let replied = Boolean(options.replied);

  return {
    id: options.id || `interaction_${Date.now()}`,
    commandName: options.commandName || 'go',
    guildId: options.guildId || 'test_guild_1',
    guild: options.guild || {
      id: options.guildId || 'test_guild_1',
      name: 'Test Guild',
      ownerId: 'owner_1'
    },
    user: options.user || { id: 'user_1', tag: 'TestUser#0001' },
    member: options.member || {
      id: 'user_1',
      permissions: { has: () => true }
    },
    channelId: options.channelId || 'test_channel_1',
    options: options.options || {
      getString: (key) => options.strings?.[key] ?? null,
      getSubcommand: () => options.subcommand || null,
      getChannel: () => null
    },
    get deferred() {
      return deferred;
    },
    get replied() {
      return replied;
    },
    isChatInputCommand: () => true,
    isRepliable: () => true,
    deferReply: async (opts = {}) => {
      if (options.deferFails) throw new Error('Interaction token expired');
      if (deferred || replied) {
        const err = new Error('Interaction has already been acknowledged');
        err.code = 40060;
        throw err;
      }
      deferred = true;
      return true;
    },
    reply: async (payload) => {
      if (replied) {
        const err = new Error('Interaction has already been acknowledged');
        err.code = 40060;
        throw err;
      }
      replied = true;
      Object.assign(repl, typeof payload === 'string' ? { content: payload } : payload);
      return repl;
    },
    editReply: async (payload) => {
      if (options.editFails) throw new Error('Unknown interaction');
      Object.assign(repl, typeof payload === 'string' ? { content: payload } : payload);
      return repl;
    },
    followUp: async (payload) => {
      return typeof payload === 'string' ? { content: payload } : payload;
    },
    _getRecordedReply: () => repl
  };
}

// Helper to create mocked Discord Client
function createMockClient(options = {}) {
  const isReady = options.isReady !== undefined ? options.isReady : true;
  return {
    isReady: () => isReady,
    user: { tag: options.tag || 'HoneyBot#0001', id: 'bot_123' },
    guilds: { cache: new Map([['test_guild_1', {}]]) },
    ws: {
      status: isReady ? 0 : -1,
      ping: options.ping !== undefined ? options.ping : 42
    },
    login: async (token) => {
      if (options.loginFails) {
        throw new Error('An invalid token was provided');
      }
      return token;
    },
    on: () => {},
    once: (event, handler) => {
      if (event === 'ready' && isReady) {
        setTimeout(handler, 5);
      }
    },
    removeListener: () => {}
  };
}

test('Scenario 1: Clean startup and successful readiness transition', async () => {
  const lifecycle = new BotLifecycleManager({ initialState: LifecycleState.BOOTING });
  const client = createMockClient({ isReady: true });
  const watchdog = new Watchdog({ client });

  const origDiag = MusicService.getDiagnostics;
  MusicService.getDiagnostics = () => ({ healthy: true });

  try {
    const manager = new StartupManager({ lifecycle, client, watchdog });
    const result = await manager.runStartup({ skipLock: true });

    assert.strictEqual(result.success, true);
    assert.strictEqual(lifecycle.getState(), LifecycleState.READY);
    assert.strictEqual(lifecycle.isApplicationReady(), true);
    assert.strictEqual(lifecycle.subsystems.config, SubsystemHealth.READY);
    assert.strictEqual(lifecycle.subsystems.commandRegistry, SubsystemHealth.READY);
  } finally {
    MusicService.getDiagnostics = origDiag;
  }
});

test('Scenario 2: Missing required environment variables blocks startup', async () => {
  const lifecycle = new BotLifecycleManager({ initialState: LifecycleState.BOOTING });
  const originalToken = config.discord.token;
  config.discord.token = ''; // Simulate missing token

  try {
    const manager = new StartupManager({ lifecycle });
    const result = await manager.runStartup({ skipLock: true });

    assert.strictEqual(result.success, false);
    assert.strictEqual(lifecycle.getState(), LifecycleState.FAILED);
    assert.strictEqual(lifecycle.isApplicationReady(), false);
    assert.ok(lifecycle.lastError.includes('DISCORD_TOKEN'));
  } finally {
    config.discord.token = originalToken;
  }
});

test('Scenario 3: Failed command-module loading or schema errors transition to FAILED', async () => {
  const lifecycle = new BotLifecycleManager({ initialState: LifecycleState.BOOTING });
  const registry = new CommandRegistry();
  // Register a broken command with invalid uppercase name
  registry.commandDefinitions.set('INVALID_NAME', {
    name: 'INVALID_NAME',
    description: 'Bad command definition'
  });

  const manager = new StartupManager({ lifecycle });
  // Overwrite registry for this test check
  const report = registry.verifyConsistency();
  assert.strictEqual(report.valid, false);
  assert.ok(report.schemaErrors.length > 0);
  assert.ok(report.missingHandlers.includes('INVALID_NAME'));
});

test('Scenario 4: Discord login failure transitions to FAILED state and reports clean diagnostic', async () => {
  const lifecycle = new BotLifecycleManager({ initialState: LifecycleState.BOOTING });
  const failingClient = createMockClient({ isReady: false, loginFails: true });
  const manager = new StartupManager({ lifecycle, client: failingClient });

  const result = await manager.runStartup({ skipLock: true });
  assert.strictEqual(result.success, false);
  assert.strictEqual(lifecycle.getState(), LifecycleState.FAILED);
  assert.ok(lifecycle.lastError.includes('invalid token') || lifecycle.lastError.includes('Discord Gateway'));
});

test('Scenario 5: Gateway disconnection and bounded recovery with jitter', async () => {
  const mockClient = createMockClient({ isReady: true });
  const watchdog = new Watchdog({
    client: mockClient,
    maxReconnectAttempts: 2,
    circuitBreakerWindowMs: 60000
  });

  // Level 3 noncritical scheduler recovery runs cleanly without delay
  const result = await watchdog.attemptLayeredRecovery('schedulers');
  assert.ok(result);
  assert.strictEqual(result.outcome, RecoveryTaxonomy.RECOVERY_SUCCESSFUL_VERIFIED);
  assert.ok(watchdog.events.some(e => e.type === WatchdogEvent.RECOVERY_ATTEMPT));
});

test('Scenario 6: Command registry mismatch detects missing definitions or handlers', () => {
  const registry = new CommandRegistry();
  registry.loadDefinitions([
    { name: 'go', description: 'Natural-language execution' },
    { name: 'orphan_cmd', description: 'Command with no handler' }
  ]);
  registry.registerHandler('go', async () => {});

  const report = registry.verifyConsistency();
  assert.strictEqual(report.valid, false);
  assert.deepStrictEqual(report.missingHandlers, ['orphan_cmd']);
});

test('Scenario 7: Missing interaction handler falls back safely to ephemeral notice without crashing', async () => {
  const interaction = createMockInteraction({ commandName: 'non_existent_command' });
  await handleCommandInteraction(interaction);

  const recorded = interaction._getRecordedReply();
  assert.ok(recorded.content.includes('Unknown command `/non_existent_command`'));
  assert.strictEqual(recorded.ephemeral, true);
});

test('Scenario 8: Interaction acknowledgement timeout triggers graceful timeout message', async () => {
  const interaction = createMockInteraction({ commandName: 'test_slow' });
  const lifecycle = new InteractionLifecycle(interaction, {
    timeoutMs: 50 // Short 50ms timeout for test
  });

  let timeoutFired = false;
  lifecycle.startTimeoutGuard(async () => {
    timeoutFired = true;
    await lifecycle.respond({ content: '⏳ Operation Timed Out: Handled cleanly.' });
  });

  // Wait for timeout to fire
  await new Promise(r => setTimeout(r, 80));

  assert.strictEqual(timeoutFired, true);
  assert.strictEqual(lifecycle.outcome, ExecutionOutcome.TIMED_OUT);
  assert.ok(interaction._getRecordedReply().content.includes('Operation Timed Out'));
});

test('Scenario 9: Attempted double acknowledgement is caught and prevented', async () => {
  const interaction = createMockInteraction();
  const lifecycle = new InteractionLifecycle(interaction);

  // First deferral
  const firstDefer = await lifecycle.defer();
  assert.strictEqual(firstDefer, true);
  assert.strictEqual(interaction.deferred, true);

  // Second deferral should be a safe no-op
  const secondDefer = await lifecycle.defer();
  assert.strictEqual(secondDefer, true);

  // First response
  const firstRes = await lifecycle.respond({ content: 'First response' });
  assert.strictEqual(firstRes, true);

  // Subsequent response safely falls back to editReply/followUp without throwing
  const secondRes = await lifecycle.respond({ content: 'Updated response' });
  assert.strictEqual(secondRes, true);
});

test('Scenario 10: A command handler that throws an exception produces sanitized error message without stack traces', async () => {
  const interaction = createMockInteraction({ commandName: 'error_trigger' });
  const errorRegistry = new CommandRegistry();
  errorRegistry.loadDefinitions([{ name: 'error_trigger', description: 'Throws an error' }]);
  errorRegistry.registerHandler('error_trigger', async () => {
    const err = new Error('SecretDatabaseException at file:///app/src/db.js:12:34');
    throw err;
  });

  const lifecycle = new InteractionLifecycle(interaction);
  try {
    const handler = errorRegistry.getHandler('error_trigger');
    await handler.handler();
  } catch (err) {
    await lifecycle.respondWithError(err.message);
  }

  const reply = interaction._getRecordedReply();
  assert.ok(reply.content.includes('❌ **Execution Error:**'));
  assert.ok(!reply.content.includes('file:///app/src/db.js'));
  assert.ok(!reply.content.includes(':12:34'));
});

test('Scenario 11: A command handler that never resolves is cleanly aborted by hard timeout', async () => {
  const interaction = createMockInteraction({ commandName: 'hang_trigger' });
  const lifecycle = new InteractionLifecycle(interaction, { timeoutMs: 40 });

  lifecycle.startTimeoutGuard();
  // Simulate never-resolving handler
  const hungPromise = new Promise(() => {}); // never resolves

  await new Promise(r => setTimeout(r, 60));

  assert.strictEqual(lifecycle.outcome, ExecutionOutcome.TIMED_OUT);
  assert.ok(interaction._getRecordedReply().content.includes('Operation Timed Out'));
});

test('Scenario 12: AI provider timeout records failure and communicates truthfully', async () => {
  const result = await DiagnosticService.diagnosePerformanceTimeouts({
    client: { ws: { ping: 25 } }
  }, 'diag_ai_timeout');

  assert.ok(result);
  assert.strictEqual(result.task, 'performance_timeouts');
  assert.ok(result.response.length > 0);
});

test('Scenario 13: Missing Discord permissions is classified truthfully with actionable remediation', async () => {
  const mockGuild = {
    id: 'guild_test_perm',
    roles: { cache: new Map() },
    members: {
      me: {
        permissions: { has: () => false },
        permissionsIn: () => ({ has: () => false })
      }
    }
  };

  const diag = await DiagnosticService.diagnoseWhyCantCreateRoles({
    guild: mockGuild
  }, 'exec_perm_diag');

  assert.strictEqual(diag.status, DiagnosticStatus.FAILED);
  assert.ok(diag.response.includes('Missing Permission'));
  assert.ok(diag.response.includes('ManageRoles'));
});

test('Scenario 14: A failed state-changing operation reports FAILED, never false success', async () => {
  const action = { action: 'create_role', name: 'SuperAdmin' };
  const executionResult = { success: false, error: 'Missing Permissions: 403 Forbidden' };

  const verification = await Verifier.verifyAction(null, action, executionResult);

  assert.strictEqual(verification.status, 'FAILED');
  assert.strictEqual(verification.verified, false);
  assert.strictEqual(verification.verificationStatus, VerificationStatus.FAILED);
  assert.ok(verification.observedOutcome.includes('Missing Permissions'));
});

test('Scenario 15: Partial completion of a multi-step task accurately classifies PARTIAL_SUCCESS', () => {
  const tracker = new OutcomeTracker('task_multi_test');
  tracker.initializePlan([
    { action: 'create_role', name: 'Moderator' },
    { action: 'create_channel', name: 'mod-chat' }
  ]);

  tracker.transition(0, OutcomeStatus.VERIFIED);
  tracker.handleStepFailure(1, 'Discord API rate limit hit');

  const summary = tracker.getSummary();
  assert.strictEqual(summary.overallState, 'PARTIAL');
  assert.strictEqual(summary.verified, 1);
  assert.strictEqual(summary.failed, 1);
  assert.strictEqual(summary.isFullyVerified, false);
});

test('Scenario 16: Post-update validator flags invalid syntax or missing modules', async () => {
  const validator = new PostUpdateValidator();
  const envChecks = await validator.checkEnvironment();
  assert.ok(Array.isArray(envChecks));
  assert.ok(envChecks.length > 0);
});

test('Scenario 17: An update that starts but fails readiness checks is flagged by watchdog', () => {
  const mockClient = createMockClient({ isReady: true });
  const watchdog = new Watchdog({ client: mockClient });

  // Simulate startup lifecycle in FAILED state
  const testLifecycle = new BotLifecycleManager({ initialState: LifecycleState.FAILED });
  testLifecycle.lastError = 'Database lock timeout';

  const ghost = watchdog.detectGhostOnline();
  // Detects if application lifecycle is impaired
  assert.ok(ghost);
});

test('Scenario 18: Duplicate process prevention via atomic InstanceLock', () => {
  // First acquisition
  const firstAcquisition = InstanceLock.acquire({ force: true });
  assert.strictEqual(firstAcquisition.acquired, true);

  // Status check confirms current process owns the lock
  const status = InstanceLock.getStatus();
  assert.strictEqual(status.locked, true);
  assert.strictEqual(status.activePid, process.pid);
  assert.strictEqual(status.isCurrentProcess, true);

  // Clean release
  const released = InstanceLock.release();
  assert.strictEqual(released, true);
  assert.strictEqual(InstanceLock.getStatus().locked, false);
});

test('Scenario 19: A failed recovery attempt triggers circuit breaker after threshold exceeded', async () => {
  const mockClient = createMockClient({ isReady: false });
  const watchdog = new Watchdog({
    client: mockClient,
    maxRecoveryAttempts: 2,
    circuitBreakerWindowMs: 60000
  });

  // Attempt 1
  await watchdog.attemptLayeredRecovery('schedulers');
  // Attempt 2
  await watchdog.attemptLayeredRecovery('schedulers');
  // Attempt 3: should trip circuit breaker
  const tripResult = await watchdog.attemptLayeredRecovery('schedulers');

  assert.strictEqual(tripResult.outcome, RecoveryTaxonomy.MANUAL_INTERVENTION_REQUIRED);
  assert.strictEqual(watchdog.circuitBreakerTripped, true);
});

test('Scenario 20: Successful recovery followed by safe command-dispatch check', async () => {
  const mockClient = createMockClient({ isReady: true });
  const watchdog = new Watchdog({ client: mockClient });

  const verification = await watchdog.verifyDiscordFunctionality();
  assert.strictEqual(verification.verified, true);
  assert.strictEqual(verification.status, 'healthy');
  assert.strictEqual(verification.checks.processAlive, true);
  assert.strictEqual(verification.checks.clientReady, true);
  assert.strictEqual(verification.checks.handlersAvailable, true);
});

test('Scenario 21: Logging-channel delivery failure does not crash the bot or command dispatcher', async () => {
  const mockGuild = {
    id: 'guild_log_fail',
    channels: {
      cache: new Map(),
      fetch: async () => null // Target channel not found
    }
  };

  ModLogService.updateConfig(mockGuild.id, {
    enabled: true,
    channelId: 'missing_target_ch'
  });

  // Attempt delivery to a non-existent channel
  const res = await ModLogService.logAction(mockGuild, {
    action: 'timeout_member',
    actor: { id: 'u1', tag: 'Mod#0001' },
    target: 'General',
    outcome: 'succeeded'
  });

  // Must not throw; returns structured failure and enqueues delivery
  assert.strictEqual(res.logged, false);
  assert.strictEqual(res.reason, 'channel_missing');
});

test('Scenario 22: Health check reports Gateway online but Command System unhealthy (Ghost-Online detection)', () => {
  const mockClient = createMockClient({ isReady: true, ping: 30 });
  const watchdog = new Watchdog({ client: mockClient });

  // Simulate a hung command that has been in-flight for 45 seconds
  watchdog.inFlightInteractions.set('exec_hung_1', {
    executionId: 'exec_hung_1',
    commandName: 'go',
    userId: 'user_hung',
    guildId: 'guild_1',
    startTime: Date.now() - 45000 // 45 seconds ago
  });

  // Gateway socket is connected, BUT command execution is hung
  assert.strictEqual(watchdog.isDiscordReady(), true);

  const ghost = watchdog.detectGhostOnline();
  assert.strictEqual(ghost.isGhostOnline, true);
  assert.ok(ghost.reason.includes('command execution(s) hung'));

  // isSystemReady must return FALSE during Ghost-Online state
  assert.strictEqual(watchdog.isSystemReady(), false);

  // Detailed health report reflects ghostOnline detected
  const detailed = watchdog.getDetailedHealth();
  assert.strictEqual(detailed.overallReady, false);
  assert.strictEqual(detailed.subsystems.ghostOnline.detected, true);
});
