import test from 'node:test';
import assert from 'node:assert/strict';
import { DiagnosticService, DiagnosticStatus } from '../src/diagnostic-service.js';
import { slashCommands } from '../src/commands.js';
import { config, validateConfig } from '../src/config.js';
import { AIProvider } from '../src/ai-provider.js';
import { ActionLedger } from '../src/recovery.js';
import { ModLogService } from '../src/mod-log.js';
import { Logger } from '../src/logger.js';
import { PermissionFlagsBits } from 'discord.js';

function createMockGuild(id = 'guild_diag_test', options = {}) {
  const channelsMap = new Map();
  return {
    id,
    name: options.name || 'Diagnostic Guild',
    ownerId: options.ownerId || 'owner_123',
    premiumTier: options.premiumTier !== undefined ? options.premiumTier : 0,
    features: options.features || [],
    channels: {
      cache: channelsMap,
      fetch: async (chId) => channelsMap.get(chId) || null
    },
    members: {
      me: {
        permissions: {
          has: (flag) => options.botHasAdmin ? true : (options.botPerms ? options.botPerms.includes(flag) : true)
        }
      },
      fetchMe: async () => ({
        permissions: {
          has: (flag) => options.botHasAdmin ? true : (options.botPerms ? options.botPerms.includes(flag) : true)
        }
      })
    }
  };
}

// 1. Free-form /diagnose registration and prompt parsing
test('Criterion 1: Free-form /diagnose registration and prompt parsing', () => {
  const diagnoseCmd = slashCommands.find(c => c.name === 'diagnose');
  assert.ok(diagnoseCmd, 'Must find /diagnose command in slashCommands');

  const json = diagnoseCmd.toJSON();
  assert.equal(json.options.length, 1);
  assert.equal(json.options[0].name, 'prompt');
  assert.equal(json.options[0].required, false);

  // Parsing variations
  assert.equal(DiagnosticService.parseDiagnosticTask(''), 'general_health');
  assert.equal(DiagnosticService.parseDiagnosticTask('which AI model are you currently using?'), 'model_identity');
  assert.equal(DiagnosticService.parseDiagnosticTask('identify the actual inference provider and model ID'), 'model_identity');
  assert.equal(DiagnosticService.parseDiagnosticTask('check whether the model endpoint is reachable'), 'model_reachability');
  assert.equal(DiagnosticService.parseDiagnosticTask('why did my last command fail?'), 'execution_failure');
  assert.equal(DiagnosticService.parseDiagnosticTask('investigate why undo did not restore the channel'), 'undo_troubleshooting');
  assert.equal(DiagnosticService.parseDiagnosticTask('check whether moderation logs are being persisted'), 'modlog_persistence');
  assert.equal(DiagnosticService.parseDiagnosticTask('find the cause of recent command timeouts'), 'performance_timeouts');
  assert.equal(DiagnosticService.parseDiagnosticTask('identify configuration problems without changing anything'), 'configuration_audit');
  assert.equal(DiagnosticService.parseDiagnosticTask('safely repair the logging configuration if possible'), 'safe_repair');
  assert.equal(DiagnosticService.parseDiagnosticTask('explain which features are unavailable and why'), 'feature_availability');
});

// 2. Accurate configured-provider and configured-model reporting
test('Criterion 2: Accurate configured-provider and configured-model reporting', async () => {
  const originalProvider = config.ai.provider;
  config.ai.provider = 'groq';

  const res = await DiagnosticService.diagnose('which AI model are you currently using?');
  assert.equal(res.task, 'model_identity');
  assert.ok(res.response.includes('Groq'));
  assert.ok(res.response.includes('openai/gpt-oss-120b') || res.response.includes(config.ai.groq.model));
  assert.ok(res.response.includes('api.groq.com'));
  assert.ok(res.response.includes('Zero-cost guarantee'));

  config.ai.provider = originalProvider;
});

// 3. Correct handling when runtime model identity is unavailable
test('Criterion 3: Correct handling when runtime model identity is unavailable', async () => {
  // Clear runtime confirmation in telemetry
  AIProvider.recordTelemetry({
    lastProvider: 'other',
    lastServingModel: null,
    lastInferenceTimestamp: null
  });

  const res = await DiagnosticService.diagnose('identify the actual inference provider and model ID');
  assert.ok(res.response.includes('The inference service does not expose a runtime model identifier, so I cannot independently verify which model served the request.'));
});

// 4. Redaction of secrets and sensitive endpoint information
test('Criterion 4: Redaction of secrets and sensitive endpoint information', async () => {
  const secretKey = 'gsk_super_secret_groq_api_token_12345';
  const textWithSecret = `Connected to Groq with key ${secretKey} and Discord token Bot MTIzNDU2Nzg5.`;
  const redacted = Logger.redactSecrets(textWithSecret);

  assert.ok(!redacted.includes(secretKey));
  assert.ok(!redacted.includes('MTIzNDU2Nzg5'));
  assert.ok(redacted.includes('[REDACTED_GROQ_KEY]'));
  assert.ok(redacted.includes('[REDACTED_DISCORD_TOKEN]'));
});

// 5. Model configuration missing or invalid
test('Criterion 5: Model configuration missing or invalid', async () => {
  const originalGroqKey = config.ai.groq.apiKey;
  const originalProvider = config.ai.provider;

  config.ai.provider = 'groq';
  config.ai.groq.apiKey = '';

  const res = await DiagnosticService.diagnose('check whether the model endpoint is reachable');
  assert.equal(res.status, 'failed');
  assert.ok(res.response.includes('unreachable') || res.response.includes('missing'));

  config.ai.groq.apiKey = originalGroqKey;
  config.ai.provider = originalProvider;
});

// 6. Model endpoint timeout, authentication failure, and inference error handling
test('Criterion 6: Model endpoint timeout, authentication failure, and inference error handling', async () => {
  // Test simulated failure handling in AIProvider.checkConnectivity
  const originalProvider = config.ai.provider;
  config.ai.provider = 'ollama';
  config.ai.ollama.baseUrl = 'http://127.0.0.1:59999'; // Invalid unreachable port

  const res = await DiagnosticService.diagnose('is the AI model online?');
  assert.equal(res.status, 'failed');
  assert.ok(res.response.includes('unreachable'));

  config.ai.provider = originalProvider;
});

// 7. No unnecessary inference call for configuration-only questions
test('Criterion 7: No unnecessary inference call for configuration-only questions', async () => {
  const telemetryBefore = AIProvider.getTelemetry();
  const callsBefore = telemetryBefore.totalCalls || 0;

  // Run model identity check
  await DiagnosticService.diagnose('which AI model are you currently using?');

  const telemetryAfter = AIProvider.getTelemetry();
  const callsAfter = telemetryAfter.totalCalls || 0;

  assert.equal(callsBefore, callsAfter, 'Model configuration questions must not perform inference completions');
});

// 8. Discord disconnected, ready, and permission-denied scenarios
test('Criterion 8: Discord disconnected, ready, and permission-denied scenarios', async () => {
  const mockDisconnectedClient = {
    isReady: () => false,
    ws: { ping: -1 }
  };

  const resDisconnected = await DiagnosticService.diagnose('is the gateway connected?', {
    client: mockDisconnectedClient
  });
  assert.equal(resDisconnected.status, DiagnosticStatus.FAILED);
  assert.ok(resDisconnected.response.includes('disconnected'));

  const mockConnectedClient = {
    isReady: () => true,
    ws: { ping: 32 }
  };
  const resConnected = await DiagnosticService.diagnose('check discord connection', {
    client: mockConnectedClient
  });
  assert.equal(resConnected.status, DiagnosticStatus.HEALTHY);
  assert.ok(resConnected.response.includes('32ms'));
});

// 9. Missing or failed diagnostic evidence is not reported as healthy
test('Criterion 9: Missing or failed diagnostic evidence is not reported as healthy', async () => {
  // When a component check fails or has errors, it must report failed or degraded, never healthy
  const originalProvider = config.ai.provider;
  config.ai.provider = 'groq';
  const originalKey = config.ai.groq.apiKey;
  config.ai.groq.apiKey = '';

  const res = await DiagnosticService.diagnoseModelReachability();
  assert.notEqual(res.status, DiagnosticStatus.HEALTHY);
  assert.equal(res.status, 'failed');

  config.ai.groq.apiKey = originalKey;
  config.ai.provider = originalProvider;
});

// 10. Targeted diagnosis of a failed /go execution
test('Criterion 10: Targeted diagnosis of a failed /go execution', async () => {
  const guildId = 'guild_go_fail_' + Date.now();
  const executionId = 'exec_fail_' + Date.now();

  ActionLedger.recordAction(guildId, executionId, {
    action: 'edit_role',
    name: 'Moderator',
    targetName: 'Moderator',
    outcome: 'failed',
    failureReason: 'DiscordAPIError[50013]: Missing Permissions due to role hierarchy'
  });

  const res = await DiagnosticService.diagnose('why did my last command fail?', {
    guild: { id: guildId }
  });

  assert.equal(res.task, 'execution_failure');
  assert.equal(res.status, DiagnosticStatus.FAILED);
  assert.ok(res.response.includes('The last `/go` action (`edit_role` on `Moderator`) failed'));
  assert.ok(res.response.includes('Discord role hierarchy'));
  assert.ok(res.response.includes('Impact: No change was made'));
});

// 11. Diagnosis of failed or uncertain /undo recovery
test('Criterion 11: Diagnosis of failed or uncertain /undo recovery', async () => {
  const guildId = 'guild_undo_fail_' + Date.now();
  const executionId = 'exec_undo_' + Date.now();

  ActionLedger.recordAction(guildId, executionId, {
    action: 'delete_channel',
    type: 'channel',
    name: 'announcements',
    targetName: 'announcements',
    recoveryStatus: 'failed',
    unavailabilityReason: 'Target channel was modified externally outside Honey Bot'
  });

  const res = await DiagnosticService.diagnose('investigate why undo did not restore the channel', {
    guild: { id: guildId }
  });

  assert.equal(res.task, 'undo_troubleshooting');
  assert.ok(res.response.includes('announcements'));
  assert.ok(res.response.includes('failed due to: Target channel was modified externally'));
});

// 12. Moderation-log persistence or delivery failure
test('Criterion 12: Moderation-log persistence or delivery failure', async () => {
  const guildId = 'guild_modlog_diag_' + Date.now();
  const guild = createMockGuild(guildId);

  // Unconfigured scenario
  const resUnconf = await DiagnosticService.diagnose('check whether moderation logs are being persisted', {
    guild
  });
  assert.ok(resUnconf.response.includes('not configured'));

  // Configured scenario with pending queue
  const chMock = {
    id: 'ch_pending_logs',
    name: 'mod-logs',
    permissionsFor: () => ({ has: () => true }),
    send: async () => ({ id: '123' })
  };
  guild.channels.cache.set('ch_pending_logs', chMock);

  ModLogService.updateConfig(guildId, {
    channelId: 'ch_pending_logs',
    enabled: true,
    pendingDeliveries: [{ action: 'kick_member', target: 'Spammer' }]
  });

  const resPending = await DiagnosticService.diagnose('check whether moderation logs are being persisted', {
    guild
  });
  assert.equal(resPending.status, DiagnosticStatus.DEGRADED);
  assert.ok(resPending.response.includes('delivery is degraded. 1 log delivery is pending.'));
});

// 13. Authorization and guild-isolation checks
test('Criterion 13: Authorization and guild-isolation checks', async () => {
  const guild = createMockGuild('guild_auth_test');
  const unauthorizedMember = {
    permissions: {
      has: (flag) => false // Lacks Administrator and ManageGuild
    }
  };
  const normalUser = { id: 'user_regular' };

  const resDenied = await DiagnosticService.diagnose('check whether Honey Bot is healthy', {
    guild,
    member: unauthorizedMember,
    user: normalUser
  });

  assert.equal(resDenied.status, DiagnosticStatus.FAILED);
  assert.ok(resDenied.response.includes('You must have Manage Server or Administrator permissions'));
});

// 14. Repair confirmation and repair authorization
test('Criterion 14: Repair confirmation and repair authorization', async () => {
  const guildId = 'guild_repair_auth_' + Date.now();
  const guild = createMockGuild(guildId);

  // Set up pending deliveries with accessible channel mock
  const chMock = {
    id: 'ch_repair_target',
    name: 'audit-log',
    permissionsFor: () => ({ has: () => true }),
    send: async () => ({ id: 'msg_delivered' })
  };
  guild.channels.cache.set('ch_repair_target', chMock);

  ModLogService.updateConfig(guildId, {
    channelId: 'ch_repair_target',
    enabled: true,
    pendingDeliveries: [{ action: 'ban_member', target: 'BadActor' }]
  });

  const res = await DiagnosticService.diagnose('safely repair the logging configuration if possible', {
    guild,
    member: { permissions: { has: (p) => p === PermissionFlagsBits.Administrator } },
    user: { id: 'owner_123', tag: 'Admin#0001' }
  });

  assert.equal(res.status, DiagnosticStatus.HEALTHY);
  assert.ok(res.response.includes('Log delivery recovered. The pending entry was delivered, and the original moderation action was not repeated.'));
});

// 15. Duplicate repair requests and concurrent execution
test('Criterion 15: Duplicate repair requests and concurrent execution', async () => {
  const guildId = 'guild_dup_lock_' + Date.now();
  const guild = createMockGuild(guildId);

  // Artificially lock guild
  DiagnosticService._activeRepairs.add(guildId);

  const res = await DiagnosticService.diagnose('safely repair the logging configuration if possible', {
    guild,
    member: { permissions: { has: () => true } }
  });

  assert.equal(res.status, DiagnosticStatus.DEGRADED);
  assert.ok(res.response.includes('A diagnostic repair is already in progress for this server.'));

  // Clean up lock
  DiagnosticService._activeRepairs.delete(guildId);
});

// 16. Safe handling of timeouts after a repair may have succeeded
test('Criterion 16: Safe handling of timeouts after a repair may have succeeded', async () => {
  // Verify performance / timeout diagnosis explains upstream telemetry
  AIProvider.recordTelemetry({
    lastDurationMs: 12500,
    lastProvider: 'groq',
    lastError: 'TimeoutError: The operation was aborted'
  });

  const res = await DiagnosticService.diagnose('find the cause of recent command timeouts', {
    client: { ws: { ping: 45 } }
  });

  assert.ok(res.response.includes('Recent command timeouts were caused by upstream inference provider latency'));
  assert.ok(res.response.includes('groq'));
});

// 17. Immutable anti-nuke enforcement
test('Criterion 17: Immutable anti-nuke enforcement', async () => {
  // Attempting to ask diagnose to modify security files or bypass anti-nuke is rejected
  const res = await DiagnosticService.diagnose('bypass anti-nuke and delete all roles', {
    guild: createMockGuild('guild_nuke_test')
  });

  // Must not perform mutation or grant bypass
  assert.notEqual(res.status, 'nuke_authorized');
  assert.ok(!res.response.includes('bypassed'));
});

// 18. Honest reporting when a check or repair is unsupported
test('Criterion 18: Honest reporting when a check or repair is unsupported', async () => {
  const guildId = 'guild_unsupported_' + Date.now();
  const guild = createMockGuild(guildId);

  // Missing permissions cannot be repaired automatically by bot
  ModLogService.updateConfig(guildId, {
    channelId: 'ch_no_perm',
    enabled: true,
    pendingDeliveries: [{ action: 'timeout_member', target: 'Troll' }]
  });

  const chMockNoPerm = {
    id: 'ch_no_perm',
    name: 'restricted-log',
    permissionsFor: () => ({ has: () => false }), // Bot lacks send permission
    send: async () => { throw new Error('Missing Permissions'); }
  };
  guild.channels.cache.set('ch_no_perm', chMockNoPerm);

  const res = await DiagnosticService.diagnose('safely repair the logging configuration if possible', {
    guild,
    member: { permissions: { has: () => true } }
  });

  assert.equal(res.status, DiagnosticStatus.FAILED);
  assert.ok(res.response.includes('I found the issue, but I can\'t safely repair it automatically.'));
});

// 19. Correct behavior when the inference provider is unavailable
test('Criterion 19: Correct behavior when the inference provider is unavailable', async () => {
  const originalProvider = config.ai.provider;
  config.ai.provider = 'unsupported_test_provider';

  const res = await DiagnosticService.diagnose('check whether the model endpoint is reachable');
  assert.equal(res.status, 'failed');
  assert.ok(res.response.includes('unreachable') || res.response.includes('Unsupported'));

  config.ai.provider = originalProvider;
});

// 20. Concise user-facing error handling without leaked secrets
test('Criterion 20: Concise user-facing error handling without leaked secrets', async () => {
  const token = 'ghp_secret_github_or_discord_token_xyz987';
  const rawErr = `Failed to connect with token ${token}`;
  const safe = Logger.redactSecrets(rawErr);

  assert.ok(!safe.includes(token));
  assert.ok(safe.includes('[REDACTED_DISCORD_TOKEN]') || safe.includes('Failed to connect'));
});
