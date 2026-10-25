import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { Verifier } from '../src/verification.js';

test('Verification: verifyAction reports MISMATCH when actual guild state does not match', async () => {
  const mockGuild = {
    fetch: async () => {},
    name: 'Old Server Name'
  };

  const actionObj = { action: 'update_server_name', name: 'New Server Name' };
  const executionResult = { success: true };

  const check = await Verifier.verifyAction(mockGuild, actionObj, executionResult);
  assert.equal(check.status, 'MISMATCH');
  assert.equal(check.verified, false);
});

test('Verification: verifyAction confirms role existence in guild cache', async () => {
  const mockGuild = {
    roles: {
      fetch: async () => {},
      cache: new Collection([
        ['r1', { name: 'VIP', id: 'r1' }]
      ])
    }
  };

  const actionObj = { action: 'create_role', name: 'VIP' };
  const executionResult = { success: true };

  const check = await Verifier.verifyAction(mockGuild, actionObj, executionResult);
  assert.equal(check.status, 'COMPLETED');
  assert.equal(check.verified, true);
});

test('Verification: generateReportEmbed creates formatted Discord Embed with audit trail', () => {
  const mockPlan = {
    thoughtProcess: 'Setup complete moderation and ticket architecture'
  };

  const mockResults = [
    { action: 'create_role', status: 'COMPLETED', verified: true, details: 'Role @Mod created' },
    { action: 'create_channel', status: 'COMPLETED', verified: true, details: 'Channel #mod-log created' }
  ];

  const embed = Verifier.generateReportEmbed(mockPlan, mockResults, 'exec_abc123');
  assert.equal(embed.data.title.includes('Completed & Verified'), true);
  assert.equal(embed.data.fields.length >= 1, true);
});
