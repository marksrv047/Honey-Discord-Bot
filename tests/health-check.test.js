import test from 'node:test';
import assert from 'node:assert/strict';
import { HealthCheckEngine, CheckStatus, Severity } from '../src/health-check.js';

test('HealthCheck: Engine executes all 6 categories non-destructively', async () => {
  const engine = new HealthCheckEngine();
  const report = await engine.runAllChecks();

  assert.ok(report.timestamp);
  assert.ok(typeof report.durationMs === 'number');
  assert.ok(['healthy', 'degraded', 'critical'].includes(report.overallStatus));

  assert.ok(report.summary.total > 15);
  assert.ok(report.summary.passed > 10);
  assert.equal(typeof report.summary.failed, 'number');

  // Verify all 6 categories are populated
  assert.ok(report.categories.application.length > 0);
  assert.ok(report.categories.code.length > 0);
  assert.ok(report.categories.dependency.length > 0);
  assert.ok(report.categories.configuration.length > 0);
  assert.ok(report.categories.security.length > 0);
  assert.ok(report.categories.discord.length > 0);
});

test('HealthCheck: Security checks verify anti-nuke, prompt injection, and HMAC token', async () => {
  const engine = new HealthCheckEngine();
  const securityChecks = await engine.checkSecurityHealth();

  const antiNuke = securityChecks.find(c => c.name.includes('Anti-Nuke'));
  assert.ok(antiNuke);
  assert.equal(antiNuke.status, CheckStatus.PASSED);

  const injection = securityChecks.find(c => c.name.includes('Prompt Injection'));
  assert.ok(injection);
  assert.equal(injection.status, CheckStatus.PASSED);

  const escalation = securityChecks.find(c => c.name.includes('Privilege Escalation'));
  assert.ok(escalation);
  assert.equal(escalation.status, CheckStatus.PASSED);

  const hmac = securityChecks.find(c => c.name.includes('Confirmation Token'));
  assert.ok(hmac);
  assert.equal(hmac.status, CheckStatus.PASSED);
});

test('HealthCheck: Code health verifies syntax across source tree without false positives', async () => {
  const engine = new HealthCheckEngine();
  const inspectedFiles = [];
  const codeChecks = await engine.checkCodeHealth(inspectedFiles);

  assert.ok(inspectedFiles.length >= 10);
  const syntaxCheck = codeChecks.find(c => c.name.includes('Syntax Verification'));
  assert.ok(syntaxCheck);
  assert.equal(syntaxCheck.status, CheckStatus.PASSED);

  const conflictCheck = codeChecks.find(c => c.name.includes('Conflict Markers'));
  assert.ok(conflictCheck);
  assert.equal(conflictCheck.status, CheckStatus.PASSED);
});

test('HealthCheck: Discord health gracefully reports when offline or in standalone mode', async () => {
  // Test with null client (standalone test environment)
  const engine = new HealthCheckEngine({ client: null });
  const discordChecks = await engine.checkDiscordIntegrationHealth();

  assert.equal(discordChecks.length, 1);
  assert.equal(discordChecks[0].status, CheckStatus.INCONCLUSIVE);
});
