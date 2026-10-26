/**
 * tests/category-multi-channels.test.js
 * Verification suite for creating a category & simultaneously adding multiple channels under it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';

import { IntentRouter } from '../src/intent-router.js';
import { CompletenessChecker } from '../src/completeness-checker.js';
import { Executor } from '../src/executor.js';
import { TaskQueue, TaskQueueState, TaskActionStatus } from '../src/task-queue.js';
import { ActionLedger } from '../src/recovery.js';

function createMockGuild(guildId = '111122223333444455') {
  const channels = new Map();
  channels.filter = (fn) => {
    const res = new Map();
    for (const [k, v] of channels.entries()) {
      if (fn(v, k)) res.set(k, v);
    }
    return res;
  };
  channels.find = (fn) => {
    for (const [k, v] of channels.entries()) {
      if (fn(v, k)) return v;
    }
    return null;
  };

  const roles = new Map();
  roles.filter = (fn) => {
    const res = new Map();
    for (const [k, v] of roles.entries()) {
      if (fn(v, k)) res.set(k, v);
    }
    return res;
  };
  roles.find = (fn) => {
    for (const [k, v] of roles.entries()) {
      if (fn(v, k)) return v;
    }
    return null;
  };

  const everyoneRole = {
    id: guildId,
    name: '@everyone',
    permissions: { has: () => true }
  };
  roles.set(guildId, everyoneRole);

  const mockGuild = {
    id: guildId,
    name: `Test Guild ${guildId}`,
    client: { user: { id: 'bot-123', tag: 'HoneyBot#0001' } },
    channels: {
      cache: channels,
      fetch: async () => channels,
      create: async ({ name, type, parent, permissionOverwrites }) => {
        const id = `ch-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const channel = {
          id,
          name,
          type,
          guildId,
          parentId: parent ?? null,
          parent: parent ? channels.get(parent) ?? null : null,
          permissionOverwrites: {
            cache: new Map(),
            edit: async () => channel
          },
          delete: async () => {
            channels.delete(id);
            return channel;
          }
        };
        channels.set(id, channel);
        return channel;
      }
    },
    roles: {
      cache: roles,
      fetch: async () => roles
    },
    members: {
      me: {
        id: 'bot-123',
        permissions: { has: () => true }
      }
    }
  };

  return mockGuild;
}

test('Category & Multi-Channels: Abstract request requests clarification', async () => {
  const router = new IntentRouter({ isDeterministicOnly: true });
  const res = await router.route('Create a category & simultaneously add multiple channels under that specific category when asked to do so.');
  assert.ok(res.clarificationNeeded, 'Should request clarification when category and channel names are omitted');
  assert.match(res.clarificationNeeded, /specify the name of the category/i);
});

test('Category & Multi-Channels: Routes "Create a category Community and simultaneously add multiple channels under that specific category: general, memes, voice"', async () => {
  const router = new IntentRouter({ isDeterministicOnly: true });
  const res = await router.route('Create a category Community and simultaneously add multiple channels under that specific category: general, memes, voice');
  
  assert.ok(res.multiActions, 'Should return multiActions');
  assert.equal(res.multiActions.length, 4, 'Should contain create_category + 3 create_channel actions');
  
  const [catAction, ch1, ch2, ch3] = res.multiActions;
  assert.equal(catAction.action, 'create_category');
  assert.equal(catAction.name, 'Community');

  assert.equal(ch1.action, 'create_channel');
  assert.equal(ch1.name, 'general');
  assert.equal(ch1.category, 'Community');
  assert.equal(ch1.type, 'GUILD_TEXT');

  assert.equal(ch2.action, 'create_channel');
  assert.equal(ch2.name, 'memes');
  assert.equal(ch2.category, 'Community');

  assert.equal(ch3.action, 'create_channel');
  assert.equal(ch3.name, 'voice');
  assert.equal(ch3.category, 'Community');
  assert.equal(ch3.type, 'GUILD_VOICE');
});

test('Category & Multi-Channels: Routes "Create a category Staff and add channels mod-chat, mod-logs, announcements under that category"', async () => {
  const router = new IntentRouter({ isDeterministicOnly: true });
  const res = await router.route('Create a category Staff and add channels mod-chat, mod-logs, announcements under that category');
  
  assert.ok(res.multiActions);
  assert.equal(res.multiActions.length, 4);
  assert.equal(res.multiActions[0].action, 'create_category');
  assert.equal(res.multiActions[0].name, 'Staff');
  assert.equal(res.multiActions[1].name, 'mod-chat');
  assert.equal(res.multiActions[1].category, 'Staff');
  assert.equal(res.multiActions[2].name, 'mod-logs');
  assert.equal(res.multiActions[2].category, 'Staff');
  assert.equal(res.multiActions[3].name, 'announcements');
  assert.equal(res.multiActions[3].category, 'Staff');
});

test('Category & Multi-Channels: Routes private category with channels', async () => {
  const router = new IntentRouter({ isDeterministicOnly: true });
  const res = await router.route('Create a private category VIP with channels lounge and perks');
  
  assert.ok(res.multiActions);
  assert.equal(res.multiActions.length, 3);
  assert.equal(res.multiActions[0].action, 'create_category');
  assert.equal(res.multiActions[0].name, 'VIP');
  assert.equal(res.multiActions[0].isPrivate, true);
  assert.equal(res.multiActions[1].name, 'lounge');
  assert.equal(res.multiActions[1].isPrivate, true);
  assert.equal(res.multiActions[1].category, 'VIP');
  assert.equal(res.multiActions[2].name, 'perks');
  assert.equal(res.multiActions[2].isPrivate, true);
  assert.equal(res.multiActions[2].category, 'VIP');
});

test('Category & Multi-Channels: CompletenessChecker ensures category and channels are fully present and linked', () => {
  const prompt = 'Create a category Projects and simultaneously add frontend, backend, devops channels under it';
  const initialPlan = {
    thoughtProcess: 'Create projects',
    actions: []
  };

  const checkResult = CompletenessChecker.verify(prompt, initialPlan);
  assert.ok(checkResult.valid);
  const actions = checkResult.repairedPlan.actions;
  assert.equal(actions.length, 4);
  assert.equal(actions[0].action, 'create_category');
  assert.equal(actions[0].name, 'Projects');
  assert.equal(actions[1].action, 'create_channel');
  assert.equal(actions[1].name, 'frontend');
  assert.equal(actions[1].category, 'Projects');
  assert.equal(actions[2].name, 'backend');
  assert.equal(actions[3].name, 'devops');

  // Verify DAG dependencies
  const catId = actions[0].id;
  assert.ok(actions[1].dependsOn.includes(catId), 'frontend channel should depend on category creation');
  assert.ok(actions[2].dependsOn.includes(catId), 'backend channel should depend on category creation');
  assert.ok(actions[3].dependsOn.includes(catId), 'devops channel should depend on category creation');
});

test('Category & Multi-Channels: Executor.orderActions places create_category before create_channel', () => {
  const actions = [
    { action: 'create_channel', name: 'general', category: 'Community' },
    { action: 'create_category', name: 'Community' },
    { action: 'create_channel', name: 'memes', category: 'Community' }
  ];

  const ordered = Executor.orderActions(actions);
  assert.equal(ordered[0].action, 'create_category', 'Category must be ordered first');
  assert.equal(ordered[1].action, 'create_channel');
  assert.equal(ordered[2].action, 'create_channel');
});

test('Category & Multi-Channels: End-to-end execution creates category and assigns parentId to all child channels', async () => {
  const guild = createMockGuild('guild_cat_multi_test');
  const executionId = `exec_${Date.now()}`;

  const plan = {
    thoughtProcess: 'Create Support category and channels',
    actions: [
      { id: 'step_1', action: 'create_category', name: 'Support', isPrivate: false },
      { id: 'step_2', action: 'create_channel', name: 'ticket-desk', category: 'Support', type: 'GUILD_TEXT', dependsOn: ['step_1'] },
      { id: 'step_3', action: 'create_channel', name: 'faq', category: 'Support', type: 'GUILD_TEXT', dependsOn: ['step_1'] },
      { id: 'step_4', action: 'create_channel', name: 'voice-help', category: 'Support', type: 'GUILD_VOICE', dependsOn: ['step_1'] }
    ]
  };

  const task = TaskQueue.createTask({
    guildId: guild.id,
    userId: 'user_admin',
    userPrompt: 'Create a category Support with channels ticket-desk, faq, voice-help',
    plan,
    actions: plan.actions,
    correlationId: executionId
  });

  const executedTask = await TaskQueue.executeTask(task.taskId, {
    guild,
    member: { user: { id: 'user_admin', tag: 'Admin#0001' }, permissions: { has: () => true } },
    executor: Executor
  });

  assert.equal(executedTask.status, TaskQueueState.COMPLETED);
  assert.equal(executedTask.actions.length, 4);
  assert.ok(executedTask.actions.every(a => a.status === TaskActionStatus.SUCCEEDED));

  // Verify created channels in guild
  const allChannels = Array.from(guild.channels.cache.values());
  const createdCat = allChannels.find(c => c.type === ChannelType.GuildCategory && c.name === 'Support');
  assert.ok(createdCat, 'Support category must be created in guild');

  const ticketCh = allChannels.find(c => c.name === 'ticket-desk');
  assert.ok(ticketCh, 'ticket-desk channel must exist');
  assert.equal(ticketCh.parentId, createdCat.id, 'ticket-desk parentId must match Support category id');

  const faqCh = allChannels.find(c => c.name === 'faq');
  assert.ok(faqCh, 'faq channel must exist');
  assert.equal(faqCh.parentId, createdCat.id, 'faq parentId must match Support category id');

  const voiceCh = allChannels.find(c => c.name === 'voice-help');
  assert.ok(voiceCh, 'voice-help channel must exist');
  assert.equal(voiceCh.parentId, createdCat.id, 'voice-help parentId must match Support category id');
  assert.equal(voiceCh.type, ChannelType.GuildVoice);
});
