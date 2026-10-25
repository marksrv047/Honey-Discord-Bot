import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDiscordError, ActionLedger } from '../src/recovery.js';

test('Recovery: classifyDiscordError correctly identifies Discord API error types', () => {
  const permError = classifyDiscordError({ code: 50013, message: 'Missing Permissions' });
  assert.equal(permError.type, 'PERMISSION_ERROR');
  assert.equal(permError.retryable, false);

  const rateLimit = classifyDiscordError({ code: 429, message: 'You are being rate limited.' });
  assert.equal(rateLimit.type, 'RATE_LIMIT');
  assert.equal(rateLimit.retryable, true);

  const missingRole = classifyDiscordError({ code: 10011, message: 'Unknown Role' });
  assert.equal(missingRole.type, 'RESOURCE_NOT_FOUND');
});

test('Recovery: ActionLedger tracks created resources and enables safe rollback', async () => {
  const executionId = 'exec_test_123';
  ActionLedger.recordCreatedResource(executionId, 'role', 'role_999', 'VIP');
  ActionLedger.recordCreatedResource(executionId, 'channel', 'ch_888', 'vip-chat');

  const created = ActionLedger.getCreatedResources(executionId);
  assert.equal(created.length, 2);
  assert.equal(created[0].name, 'VIP');
  assert.equal(created[1].name, 'vip-chat');

  // Test mock rollback
  const deletedActions = [];
  const mockGuild = {
    roles: {
      cache: new Map([
        ['role_999', { delete: async () => deletedActions.push('deleted role') }]
      ])
    },
    channels: {
      cache: new Map([
        ['ch_888', { delete: async () => deletedActions.push('deleted channel') }]
      ])
    }
  };

  const rollback = await ActionLedger.rollbackExecution(mockGuild, executionId);
  assert.equal(rollback.success, true);
  assert.equal(deletedActions.length, 2);
  assert.equal(ActionLedger.getCreatedResources(executionId).length, 0); // Ledger cleared after rollback
});
