import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfirmationManager } from '../src/confirmations.js';

test('Confirmations: formatActionSummary formats all key actions cleanly', () => {
  assert.equal(
    ConfirmationManager.formatActionSummary({ action: 'update_server_name', name: 'Elite Community' }),
    'to "Elite Community"'
  );

  assert.equal(
    ConfirmationManager.formatActionSummary({ action: 'create_role', name: 'VIP', color: '#FFD700' }),
    '`VIP` (#FFD700)'
  );

  assert.equal(
    ConfirmationManager.formatActionSummary({ action: 'create_channel', name: 'announcements', type: 'GUILD_ANNOUNCEMENT' }),
    '`#announcements` (GUILD_ANNOUNCEMENT)'
  );

  assert.equal(
    ConfirmationManager.formatActionSummary({ action: 'timeout_member', targetMember: 'user99', durationMinutes: 10 }),
    'User `user99` for 10m'
  );
});

test('Confirmations: requestConfirmation safely prepares truncated description without exceeding 4096 chars', async () => {
  // Generate a mock plan with 50 actions to test truncation safety
  const mockActions = Array.from({ length: 50 }, (_, i) => ({
    action: 'create_role',
    name: `Role_${i}_SuperLongDescriptionTextToSimulateLargePayload`,
    color: '#000000'
  }));

  const mockPlan = {
    thoughtProcess: 'Massive infrastructure deployment test',
    actions: mockActions
  };

  let capturedEmbed = null;

  const mockInteraction = {
    id: 'int_123456789',
    user: { id: 'user_1', username: 'TestUser' },
    editReply: async (payload) => {
      capturedEmbed = payload.embeds[0];
      return {
        awaitMessageComponent: async () => {
          return {
            customId: 'confirm_int_123456789',
            update: async () => {}
          };
        }
      };
    }
  };

  const confirmed = await ConfirmationManager.requestConfirmation(mockInteraction, mockPlan);
  assert.equal(confirmed, true);
  assert.ok(capturedEmbed);

  // Assert Discord embed description is well within the 4096 limit
  assert.ok(capturedEmbed.data.description.length <= 4096);
  assert.match(capturedEmbed.data.description, /additional action/);
});
