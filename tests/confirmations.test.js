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
      const confirmCustomId = payload.components[0].components[0].data.custom_id;
      return {
        awaitMessageComponent: async () => {
          return {
            customId: confirmCustomId,
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

test('Confirmations: formatActionSummary handles undefined descriptions safely', () => {
  assert.equal(
    ConfirmationManager.formatActionSummary({ action: 'update_server_description' }),
    '""'
  );
  assert.equal(
    ConfirmationManager.formatActionSummary({ action: 'create_channel' }),
    '`#unnamed` (GUILD_TEXT)'
  );
});

test('Confirmations: requestConfirmation handles undeferred interaction with reply()', async () => {
  let replyCalled = false;
  const mockInteraction = {
    id: 'int_undeferred',
    user: { id: 'user_2', username: 'UndeferredUser' },
    deferred: false,
    replied: false,
    reply: async (payload) => {
      replyCalled = true;
      const confirmCustomId = payload.components[0].components[0].data.custom_id;
      return {
        awaitMessageComponent: async () => ({
          customId: confirmCustomId,
          update: async () => {}
        })
      };
    }
  };

  const confirmed = await ConfirmationManager.requestConfirmation(mockInteraction, { actions: [] });
  assert.equal(replyCalled, true);
  assert.equal(confirmed, true);
});
test('Confirmations: formatActionTitle maps internal IDs to clean user-facing titles', () => {
  assert.equal(ConfirmationManager.formatActionTitle('kick_member'), 'Kick member');
  assert.equal(ConfirmationManager.formatActionTitle('ban_member'), 'Ban member');
  assert.equal(ConfirmationManager.formatActionTitle('timeout_member'), 'Timeout member');
  assert.equal(ConfirmationManager.formatActionTitle('delete_channel'), 'Delete channel');
  assert.equal(ConfirmationManager.formatActionTitle('delete_category'), 'Delete category');
  assert.equal(ConfirmationManager.formatActionTitle('purge_messages'), 'Purge messages');
  assert.equal(ConfirmationManager.formatActionTitle('assign_role'), 'Assign role');
  assert.equal(ConfirmationManager.formatActionTitle('remove_role'), 'Remove role');
  assert.equal(ConfirmationManager.formatActionTitle('move_channel_to_category'), 'Move channel to category');
});

test('Confirmations: formatActionSummary formats extended operations cleanly', () => {
  assert.equal(
    ConfirmationManager.formatActionSummary({ action: 'delete_category', targetCategory: 'archive' }),
    'Category `archive`'
  );
  assert.equal(
    ConfirmationManager.formatActionSummary({ action: 'purge_messages', targetChannel: 'general', count: 50 }),
    '50 messages in `general`'
  );
  assert.equal(
    ConfirmationManager.formatActionSummary({ action: 'assign_role', targetRole: 'VIP', targetMember: 'Alex' }),
    'Role `VIP` to `Alex`'
  );
  assert.equal(
    ConfirmationManager.formatActionSummary({ action: 'remove_role', targetRole: 'VIP', targetMember: 'Alex' }),
    'Role `VIP` from `Alex`'
  );
  assert.equal(
    ConfirmationManager.formatActionSummary({ action: 'unban_member', targetMember: 'user_123' }),
    'User `user_123`'
  );
});

test('Confirmations: formatActionSummary formats undo, rename, lock, and slowmode operations', () => {
  assert.equal(
    ConfirmationManager.formatActionSummary({ action: 'undo_create_channel', target: 'announcements' }),
    'Reverse create channel on `announcements`'
  );
  assert.equal(
    ConfirmationManager.formatActionSummary({ action: 'rename_channel', targetChannel: 'old-name', newName: 'new-name' }),
    'Channel `old-name` to `#new-name`'
  );
  assert.equal(
    ConfirmationManager.formatActionSummary({ action: 'lock_channel', targetChannel: 'general' }),
    'Channel `general`'
  );
  assert.equal(
    ConfirmationManager.formatActionSummary({ action: 'set_channel_slowmode', targetChannel: 'general', seconds: 15 }),
    '15s in `general`'
  );
  assert.equal(
    ConfirmationManager.formatActionSummary({ action: 'change_nickname', targetMember: 'Alex', nickname: 'Phoenix' }),
    'User `Alex` to "Phoenix"'
  );
  assert.equal(
    ConfirmationManager.formatActionSummary(null),
    ''
  );
  assert.equal(
    ConfirmationManager.formatActionTitle(null),
    'Action'
  );
});

test('Confirmations: isHighImpactAction and requiresConfirmation detect destructive plans', () => {
  assert.equal(ConfirmationManager.isHighImpactAction({ action: 'delete_channel' }), true);
  assert.equal(ConfirmationManager.isHighImpactAction({ action: 'ban_member' }), true);
  assert.equal(ConfirmationManager.isHighImpactAction({ action: 'purge_messages' }), true);
  assert.equal(ConfirmationManager.isHighImpactAction({ action: 'create_role' }), false);

  assert.equal(ConfirmationManager.requiresConfirmation({ isHighImpact: true, actions: [] }), true);
  assert.equal(ConfirmationManager.requiresConfirmation({ actions: [{ action: 'delete_role' }] }), true);
  assert.equal(ConfirmationManager.requiresConfirmation({ actions: [{ action: 'create_role' }] }), false);
  assert.equal(ConfirmationManager.requiresConfirmation(null), false);
});

test('Confirmations: requestConfirmation returns false when user clicks cancel', async () => {
  let updatedContent = '';
  const mockInteraction = {
    id: 'int_cancel',
    user: { id: 'user_cancel', username: 'CancellingUser' },
    deferred: true,
    editReply: async (payload) => {
      const cancelCustomId = payload.components[0].components[1].data.custom_id;
      return {
        awaitMessageComponent: async () => ({
          customId: cancelCustomId,
          update: async (upPayload) => {
            updatedContent = upPayload.content;
          }
        })
      };
    }
  };

  const confirmed = await ConfirmationManager.requestConfirmation(mockInteraction, {
    actions: [{ action: 'delete_channel', targetChannel: 'general' }]
  });

  assert.equal(confirmed, false);
  assert.match(updatedContent, /Operation cancelled/);
});

test('Confirmations: requestConfirmation returns false when timeout occurs', async () => {
  let timedOutContent = '';
  const mockInteraction = {
    id: 'int_timeout',
    user: { id: 'user_timeout', username: 'TimeoutUser' },
    deferred: true,
    editReply: async (payload) => {
      if (payload.components && payload.components.length > 0) {
        return {
          awaitMessageComponent: async () => {
            throw new Error('Collector timed out');
          }
        };
      }
      timedOutContent = payload.content;
    }
  };

  const confirmed = await ConfirmationManager.requestConfirmation(mockInteraction, {
    actions: [{ action: 'ban_member', targetMember: 'bad_actor' }]
  }, 100);

  assert.equal(confirmed, false);
  assert.match(timedOutContent, /Confirmation timed out/);
});

test('Confirmations: requestConfirmation safely returns false for null interaction', async () => {
  const result = await ConfirmationManager.requestConfirmation(null, { actions: [] });
  assert.equal(result, false);
});

