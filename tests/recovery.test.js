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

test('Recovery: createErrorEmbed generates specific unmasked diagnostic fields', async () => {
  const { createErrorEmbed } = await import('../src/recovery.js');

  // 1. Resource Not Found
  const notFoundEmbed = createErrorEmbed(new Error('Announcement channel "announce" not found in this server.'), 'exec_101');
  assert.equal(notFoundEmbed.data.title, '🔍 Resource Not Found');
  const whatFailedField = notFoundEmbed.data.fields.find(f => f.name.includes('What Failed'));
  assert.match(whatFailedField.value, /Announcement channel "announce" not found/);
  assert.equal(notFoundEmbed.data.fields.find(f => f.name.includes('Category')).value, 'Target Resolution Failure');

  // 2. Out of Bounds
  const outOfBoundsEmbed = createErrorEmbed(new Error('Message length out of bounds: Content is 2450 characters, exceeding Discord\'s 2,000 character limit.'), 'exec_102');
  assert.equal(outOfBoundsEmbed.data.title, '📏 Parameter Limit / Out of Bounds');
  assert.match(outOfBoundsEmbed.data.fields.find(f => f.name.includes('What Failed')).value, /2450 characters/);
  assert.equal(outOfBoundsEmbed.data.fields.find(f => f.name.includes('Category')).value, 'Discord API Bounds Restriction');

  // 3. AI Token Rate Limit
  const tokenEmbed = createErrorEmbed(new Error('429 rate limit exceeded for tokens per minute (TPM)'), 'exec_103');
  assert.equal(tokenEmbed.data.title, '⏳ AI Inference Rate Limit / Token Budget Exceeded');
  assert.equal(tokenEmbed.data.fields.find(f => f.name.includes('Category')).value, 'AI Provider Quota Exhaustion');
});

