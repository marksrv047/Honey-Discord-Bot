import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { IntentRouter } from '../src/intent-router.js';
import { ExecutionContext } from '../src/execution-context.js';
import { ActionLedger } from '../src/recovery.js';
import { Executor } from '../src/executor.js';
import { formatSingleOutcome, formatMultiActionSummary } from '../src/format-response.js';

function createMockGuild(id = 'guild_go_test') {
  const currentChannel = {
    id: 'ch_current_999',
    name: 'general',
    type: ChannelType.GuildText,
    topic: 'Old topic',
    setName: async (n) => { currentChannel.name = n; },
    setTopic: async (t) => { currentChannel.topic = t; },
    permissionOverwrites: {
      edit: async () => {}
    }
  };

  const staffRole = {
    id: 'role_staff_111',
    name: 'Staff',
    position: 10
  };

  const modRole = {
    id: 'role_mod_222',
    name: 'Moderator',
    position: 20
  };

  const channelMap = new Map([
    [currentChannel.id, currentChannel],
    ['ch_announcements', { id: 'ch_announcements', name: 'announcements', type: ChannelType.GuildText }]
  ]);

  const roleMap = new Map([
    [staffRole.id, staffRole],
    [modRole.id, modRole]
  ]);

  const membersMap = new Map();

  return {
    id,
    name: 'Go Engine Test Guild',
    channels: {
      cache: channelMap,
      fetch: async (id) => channelMap.get(id) || null,
      create: async (opts) => {
        const newCh = { id: `ch_${Date.now()}`, name: opts.name, type: opts.type || ChannelType.GuildText };
        channelMap.set(newCh.id, newCh);
        return newCh;
      }
    },
    roles: {
      cache: roleMap,
      fetch: async (id) => roleMap.get(id) || null,
      everyone: { id: 'role_everyone' }
    },
    members: {
      cache: membersMap,
      fetch: async (queryOrId) => {
        if (typeof queryOrId === 'string') return membersMap.get(queryOrId) || null;
        if (queryOrId?.query) {
          const q = queryOrId.query.toLowerCase();
          return Array.from(membersMap.values()).filter(m => m.user.username.toLowerCase().includes(q));
        }
        return [];
      },
      me: { id: 'bot_honey', roles: { highest: { position: 100 } } }
    },
    currentChannel
  };
}

test('Go Engine: Interprets natural-language intent variations via fast-paths', async () => {
  const router = new IntentRouter();
  const mockGuild = createMockGuild();
  const mockContext = new ExecutionContext({
    guild: mockGuild,
    channel: mockGuild.currentChannel,
    member: { user: { id: 'u1', tag: 'admin' }, permissions: { has: () => true } },
    user: { id: 'u1', tag: 'admin' }
  });

  // 1. Rename channel
  const r1 = await router.route('Rename this channel to general-chat.', mockContext);
  assert.equal(r1.intent, 'rename_channel');
  assert.equal(r1.args.name, 'general-chat');

  // 2. Give role
  const r2 = await router.route('Give Alex the moderator role', mockContext);
  assert.equal(r2.intent, 'assign_role');
  assert.equal(r2.args.role, 'moderator');
  assert.equal(r2.targetRef, 'Alex');

  // 3. Remove timeout
  const r3 = await router.route('Remove the timeout from Sam.', mockContext);
  assert.equal(r3.intent, 'remove_timeout');
  assert.equal(r3.targetRef, 'Sam');

  // 4. Create private channel
  const r4 = await router.route('Create a private channel for the staff team', mockContext);
  assert.equal(r4.intent, 'create_channel');
  assert.equal(r4.args.isPrivate, true);

  // 5. Post announcement
  const r5 = await router.route('Post an announcement in #announcements: Welcome everyone!', mockContext);
  assert.equal(r5.intent, 'send_announcement');
  assert.ok(r5.args.message.includes('Welcome everyone'));

  // 6. Delete messages
  const r6 = await router.route('Delete the last five messages from this channel', mockContext);
  assert.equal(r6.intent, 'purge_messages');
  assert.equal(r6.args.count, 5);

  // 7. Set channel topic
  const r7 = await router.route('Set the topic of this channel to server updates', mockContext);
  assert.equal(r7.intent, 'edit_channel_topic');
  assert.equal(r7.args.topic, 'server updates');

  // 8. Ban member with reason
  const r8 = await router.route('Ban Alex for repeated harassment', mockContext);
  assert.equal(r8.intent, 'ban_member');
  assert.equal(r8.targetRef, 'Alex');
  assert.equal(r8.args.reason, 'repeated harassment');

  // 9. Revert rename
  const r9 = await router.route("Change that channel's name back to announcements", mockContext);
  assert.equal(r9.intent, 'rename_channel');
  assert.equal(r9.args.name, 'announcements');
});

test('Go Engine: Multi-step request planning resolves composite actions', async () => {
  const router = new IntentRouter();
  const mockGuild = createMockGuild();
  const mockContext = new ExecutionContext({
    guild: mockGuild,
    channel: mockGuild.currentChannel,
    member: { user: { id: 'u1' } },
    user: { id: 'u1' }
  });

  // 1. Rename and topic
  const r1 = await router.route('Rename this channel to lounge and update its topic to Chat and hangout', mockContext);
  assert.ok(r1.multiActions);
  assert.equal(r1.multiActions.length, 2);
  assert.equal(r1.multiActions[0].action, 'rename_channel');
  assert.equal(r1.multiActions[1].action, 'edit_channel');

  // 2. Private staff channel with role and topic
  const r2 = await router.route('Create a private staff channel, give the Staff role access, and set its topic to Staff discussion', mockContext);
  assert.ok(r2.multiActions);
  assert.equal(r2.multiActions.length, 3);
  assert.equal(r2.multiActions[0].action, 'create_channel');
  assert.equal(r2.multiActions[1].action, 'set_channel_permission');
  assert.equal(r2.multiActions[2].action, 'edit_channel');
});

test('Go Engine: Detects member target ambiguity and asks concise clarification question', async () => {
  const mockGuild = createMockGuild();

  // Add 2 members named Alex
  mockGuild.members.cache.set('alex_1', {
    id: 'alex_1',
    user: { username: 'alex_smith' },
    displayName: 'Alex',
    roles: { cache: new Set() }
  });

  mockGuild.members.cache.set('alex_2', {
    id: 'alex_2',
    user: { username: 'alex_jones' },
    displayName: 'Alex',
    roles: { cache: new Set() }
  });

  const context = new ExecutionContext({
    guild: mockGuild,
    channel: mockGuild.currentChannel,
    member: { user: { id: 'u1' } },
    user: { id: 'u1' }
  });

  const resolved = await context.resolveTarget('Alex', 'member');
  assert.equal(resolved.isAmbiguous, true);
  assert.equal(resolved.candidateCount, 2);
  assert.ok(resolved.clarificationQuestion.includes('I found 2 members named Alex. Which one did you mean?'));
});

test('Go Engine: Context-aware target resolution handles "this channel" and "the channel we just created"', async () => {
  const mockGuild = createMockGuild('guild_context_test');
  const executionId = 'exec_ctx_99';

  // Record a created channel in ActionLedger
  ActionLedger.recordCreatedResource(executionId, 'channel', 'ch_announcements', 'announcements', mockGuild.id);

  const context = new ExecutionContext({
    guild: mockGuild,
    channel: mockGuild.currentChannel,
    member: { user: { id: 'u1' } },
    user: { id: 'u1' }
  });

  // 1. "this channel" resolves to current interaction channel
  const chCurrent = await context.resolveTarget('this channel', 'channel');
  assert.equal(chCurrent.id, mockGuild.currentChannel.id);

  // 2. "the channel we just created" resolves to the channel in ActionLedger
  const chCreated = await context.resolveTarget('the channel we just created', 'channel');
  assert.equal(chCreated.id, 'ch_announcements');
});

test('Go Engine: Multi-step execution skips dependent steps if prerequisite creation fails', async () => {
  const mockGuild = createMockGuild('guild_dep_test');
  const plan = {
    thoughtProcess: 'Create channel and configure permissions',
    actions: [
      { action: 'create_channel', name: 'failing-channel' },
      { action: 'set_channel_permission', targetChannel: 'failing-channel', targetRoleOrMember: 'Staff' }
    ]
  };

  // Mock create_channel throwing a Discord API permission failure
  mockGuild.channels.create = async () => {
    throw new Error('Missing Permissions (50013)');
  };

  const results = await Executor.executePlan(mockGuild, plan, 'exec_dep_test', {
    user: { tag: 'admin' },
    roles: { highest: { position: 100 } },
    permissions: { has: () => true }
  });

  assert.equal(results.length, 2);
  assert.equal(results[0].status, 'FAILED');
  assert.equal(results[1].status, 'SKIPPED');
  assert.ok(results[1].details.includes('Prerequisite target "failing-channel" failed'));

  const summary = formatMultiActionSummary(results);
  assert.ok(summary.includes('Completed 0 of 2 actions'));
});

test('Go Engine: ActionLedger rollback successfully restores channel renames', async () => {
  const mockGuild = createMockGuild('guild_rollback_test');
  const executionId = 'exec_rollback_rename';

  // Rename current channel from "general" to "lounge"
  mockGuild.currentChannel.name = 'lounge';

  ActionLedger.recordAction(mockGuild.id, executionId, {
    type: 'channel_rename',
    id: mockGuild.currentChannel.id,
    oldName: 'general',
    newName: 'lounge'
  });

  const rollback = await ActionLedger.rollbackExecution(mockGuild, executionId);
  assert.equal(rollback.success, true);
  assert.equal(mockGuild.currentChannel.name, 'general');
  assert.ok(rollback.report[0].includes('Renamed channel #lounge back to #general'));
});

test('Go Engine: Outcome formatters generate calm, single-sentence responses', () => {
  const renameOutcome = formatSingleOutcome('rename_channel', { success: true }, { targetRef: '#general', name: 'general-chat' });
  assert.equal(renameOutcome, 'Renamed #general to #general-chat.');

  const topicOutcome = formatSingleOutcome('edit_channel_topic', { success: true }, { targetRef: '#general', topic: 'server updates' });
  assert.equal(topicOutcome, 'Set topic of #general to "server updates".');

  const untimeoutOutcome = formatSingleOutcome('remove_timeout', { success: true }, { targetMember: 'Sam' });
  assert.equal(untimeoutOutcome, 'Removed timeout from @Sam.');
});
