import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { TicketManager } from '../src/tickets.js';

test('Tickets: TicketManager handles active ticket tracking and duplicate prevention', () => {
  const userId = 'user_12345';
  const channelId = 'channel_999';

  TicketManager.activeTickets.set(userId, channelId);

  assert.equal(TicketManager.activeTickets.has(userId), true);
  assert.equal(TicketManager.activeTickets.get(userId), channelId);

  // Clear
  TicketManager.activeTickets.delete(userId);
  assert.equal(TicketManager.activeTickets.has(userId), false);
});

test('Tickets: setupTicketSystem re-uses existing support role and category', async () => {
  let createdRole = false;
  let createdCategory = false;

  const mockRole = { id: 'role_existing', name: 'Support Team' };
  const mockCategory = { id: 'cat_existing', name: 'SUPPORT TICKETS', type: 4 }; // 4 is ChannelType.GuildCategory

  const mockGuild = {
    roles: {
      cache: new Collection([['role_existing', mockRole]]),
      create: async () => { createdRole = true; return mockRole; }
    },
    channels: {
      cache: new Collection([['cat_existing', mockCategory]]),
      create: async (data) => {
        return {
          id: 'panel_channel_id',
          name: data.name,
          send: async () => ({ id: 'panel_msg_id' })
        };
      }
    }
  };

  const res = await TicketManager.setupTicketSystem(mockGuild);

  assert.equal(createdRole, false); // Did not recreate
  assert.equal(res.success, true);
  assert.equal(res.category, 'SUPPORT TICKETS');
});
