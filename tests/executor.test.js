import test from 'node:test';
import assert from 'node:assert/strict';
import { Executor } from '../src/executor.js';

test('Executor: orderActions sorts categories and roles before channels and permissions', () => {
  const unordered = [
    { action: 'set_channel_permission', targetChannel: 'staff-chat', targetRoleOrMember: 'Staff' },
    { action: 'create_channel', name: 'staff-chat', type: 'GUILD_TEXT' },
    { action: 'create_channel', name: 'STAFF ZONE', type: 'GUILD_CATEGORY' },
    { action: 'create_role', name: 'Staff' }
  ];

  const ordered = Executor.orderActions(unordered);
  const actionSequence = ordered.map(a => a.action === 'create_channel' && a.type === 'GUILD_CATEGORY' ? 'create_category' : a.action);

  // Role (p2) -> Category (p3) -> Channel (p4) -> Permissions (p6)
  assert.equal(actionSequence[0], 'create_role');
  assert.equal(actionSequence[1], 'create_category');
  assert.equal(actionSequence[2], 'create_channel');
  assert.equal(actionSequence[3], 'set_channel_permission');
});

test('Executor: executeSingleAction skips banner when server is not Boost Tier 2', async () => {
  const mockGuild = {
    premiumTier: 0, // No boosts
    features: []
  };

  const action = { action: 'update_server_banner', bannerUrl: 'https://example.com/banner.png' };
  const result = await Executor.executeSingleAction(mockGuild, action, 'exec_test', { user: { tag: 'Tester' } });

  assert.equal(result.success, true);
  assert.match(result.details, /Skipped banner/);
  assert.match(result.details, /Boost Tier 2/);
});
