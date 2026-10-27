import test from 'node:test';
import assert from 'node:assert/strict';
import { Watchdog, RecoveryTaxonomy, WatchdogEvent, SubsystemStatus } from '../src/watchdog.js';
import { TaskScheduler } from '../src/scheduler.js';
import { CaseManager } from '../src/case-manager.js';

test('Watchdog: Evaluates process and system readiness independently', () => {
  // Offline client instance
  const mockClientOffline = {
    isReady: () => false,
    ws: { status: -1, ping: -1 },
    user: null,
    guilds: { cache: new Map() }
  };

  const watchdog = new Watchdog({ client: mockClientOffline, checkIntervalMs: 60000 });

  // Process is alive, but Discord is offline
  assert.equal(watchdog.isProcessAlive(), true);
  assert.equal(watchdog.isDiscordReady(), false);
  // System readiness must be false when Discord is offline
  assert.equal(watchdog.isSystemReady(), false);

  // Online client instance
  const mockClientOnline = {
    isReady: () => true,
    ws: { status: 0, ping: 42 },
    user: { tag: 'HoneyBot#0001', id: '123456789' },
    guilds: { cache: new Map([['g1', {}]]) }
  };

  const watchdogOnline = new Watchdog({ client: mockClientOnline });
  assert.equal(watchdogOnline.isProcessAlive(), true);
  assert.equal(watchdogOnline.isDiscordReady(), true);
  assert.equal(watchdogOnline.isSystemReady(), true);
});

test('Watchdog: Generates detailed health report tracking all 10 subsystems independently without leaking secrets', () => {
  const mockClient = {
    isReady: () => true,
    ws: { status: 0, ping: 35 },
    user: { tag: 'Honey#1234', id: '987654321' },
    guilds: { cache: new Map([['guild_a', {}]]) }
  };

  const watchdog = new Watchdog({ client: mockClient });
  const health = watchdog.getDetailedHealth();

  assert.ok(health.timestamp);
  assert.equal(health.overallReady, true);

  const sub = health.subsystems;
  assert.ok(sub.process);
  assert.equal(sub.process.status, SubsystemStatus.HEALTHY);
  assert.ok(typeof sub.process.pid === 'number');
  assert.ok(typeof sub.process.uptimeSeconds === 'number');

  assert.ok(sub.httpEndpoint);
  assert.equal(sub.httpEndpoint.status, SubsystemStatus.HEALTHY);

  assert.ok(sub.discordGateway);
  assert.equal(sub.discordGateway.status, SubsystemStatus.HEALTHY);
  assert.equal(sub.discordGateway.wsPingMs, 35);

  assert.ok(sub.discordClient);
  assert.equal(sub.discordClient.isReady, true);
  assert.equal(sub.discordClient.authenticatedTag, 'Honey#1234');
  assert.equal(sub.discordClient.guildCount, 1);

  assert.ok(sub.slashCommands);
  assert.equal(sub.slashCommands.registeredCount, 6);

  assert.ok(sub.llmProvider);
  assert.ok(sub.persistence);
  assert.equal(sub.persistence.status, SubsystemStatus.HEALTHY);

  assert.ok(sub.musicVoice);
  assert.ok(sub.backgroundTasks);
  assert.ok(sub.watchdog);
  assert.equal(sub.watchdog.circuitBreakerTripped, false);

  // Verify zero tokens or keys exposed in health JSON
  const jsonStr = JSON.stringify(health);
  assert.equal(jsonStr.includes('Bot '), false);
  assert.equal(jsonStr.includes('token:'), false);
  assert.equal(jsonStr.includes('AIza'), false);
});

test('Watchdog: Records diagnostic events and enforces circular buffer capacity', () => {
  const watchdog = new Watchdog({ maxRecoveryAttempts: 3 });

  // Record 110 events
  for (let i = 0; i < 110; i++) {
    watchdog.recordEvent(WatchdogEvent.STATE_CHANGE, 'info', { index: i });
  }

  const events = watchdog.getEvents(200);
  // Max event history is 100
  assert.equal(events.length, 100);
  assert.equal(events[0].details.index, 109);
  assert.equal(events[99].details.index, 10);
});

test('Watchdog: Detects error rate spikes within configured window', () => {
  const watchdog = new Watchdog();
  assert.equal(watchdog.events.length, 0);

  // Trigger 5 errors
  for (let i = 0; i < 5; i++) {
    watchdog.trackError({ context: 'slash_command', error: 'Database busy' });
  }

  // An error spike event should have been recorded
  const spikeEvents = watchdog.events.filter(e => e.type === WatchdogEvent.HANDLER_ERROR_SPIKE);
  assert.ok(spikeEvents.length >= 1);
  assert.equal(spikeEvents[0].severity, 'warn');
});

test('Watchdog: Enforces circuit breaker on repeated recovery attempts', async () => {
  const watchdog = new Watchdog({
    maxRecoveryAttempts: 2,
    circuitBreakerWindowMs: 60000
  });

  // Attempt 1
  const r1 = await watchdog.attemptLayeredRecovery('schedulers');
  assert.equal(r1.outcome, RecoveryTaxonomy.RECOVERY_SUCCESSFUL_VERIFIED);

  // Attempt 2
  const r2 = await watchdog.attemptLayeredRecovery('schedulers');
  assert.equal(r2.outcome, RecoveryTaxonomy.RECOVERY_SUCCESSFUL_VERIFIED);

  // Attempt 3 -> Exceeds maxRecoveryAttempts (2)
  const r3 = await watchdog.attemptLayeredRecovery('schedulers');
  assert.equal(r3.outcome, RecoveryTaxonomy.MANUAL_INTERVENTION_REQUIRED);
  assert.equal(watchdog.circuitBreakerTripped, true);

  // Clean up background timers
  TaskScheduler.stopScheduler();
  CaseManager.stopScheduler();
});

test('Watchdog: Verifies actual Discord functionality with structured checks', async () => {
  const mockClient = {
    isReady: () => true,
    user: { tag: 'Honey#0001' },
    guilds: { cache: new Map() }
  };

  const watchdog = new Watchdog({ client: mockClient });
  const verification = await watchdog.verifyDiscordFunctionality();

  assert.equal(verification.verified, true);
  assert.equal(verification.status, 'healthy');
  assert.equal(verification.checks.processAlive, true);
  assert.equal(verification.checks.clientReady, true);
  assert.equal(verification.checks.identityAuthenticated, true);
  assert.equal(verification.checks.handlersAvailable, true);
  assert.equal(verification.checks.persistenceHealthy, true);
});
