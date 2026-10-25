import test from 'node:test';
import assert from 'node:assert';
import { ExecutionContext } from '../src/execution-context.js';
import { Operations } from '../src/operations.js';
import { IntentRouter } from '../src/intent-router.js';
import { TaskBudget } from '../src/budget.js';

test('Targeted Execution: Context resolves "this channel" without searching other channels', async () => {
  const currentChannel = { id: 'ch_current_123', name: 'lobby', type: 0 };
  const mockGuild = {
    id: 'guild_123',
    name: 'Test Guild',
    premiumTier: 0,
    channels: {
      cache: new Map([
        ['ch_current_123', currentChannel],
        ['ch_other_456', { id: 'ch_other_456', name: 'general', type: 0 }]
      ]),
      fetch: async () => {
        throw new Error('fetch() should NOT be called for cached/current channel!');
      }
    }
  };

  const mockInteraction = {
    guild: mockGuild,
    channel: currentChannel,
    member: { id: 'user_1', user: { id: 'user_1', tag: 'User#0001' } },
    user: { id: 'user_1', tag: 'User#0001' }
  };

  const context = new ExecutionContext(mockInteraction);

  // Test resolving "this channel"
  const resolved = await context.resolveTarget('this channel', 'channel');
  assert.strictEqual(resolved.id, 'ch_current_123');
  assert.strictEqual(resolved.name, 'lobby');

  // Test resolving "here"
  const resolvedHere = await context.resolveTarget('here', 'channel');
  assert.strictEqual(resolvedHere.id, 'ch_current_123');
});

test('Targeted Execution: Rename current channel is idempotent and performs 0 API calls if already renamed', async () => {
  let setNameCalls = 0;
  const currentChannel = {
    id: 'ch_123',
    name: 'general-chat',
    setName: async (name) => {
      setNameCalls++;
      currentChannel.name = name;
    }
  };

  const mockContext = {
    invokingUser: { tag: 'Admin#0001' },
    resolveTarget: async () => currentChannel
  };

  // 1. Calling rename when name already matches (idempotent no-op)
  const result1 = await Operations.renameChannel({}, 'current', 'general-chat', mockContext);
  assert.strictEqual(result1.success, true);
  assert.strictEqual(result1.verified, true);
  assert.strictEqual(setNameCalls, 0, 'Should NOT call Discord setName API when name is already matching');

  // 2. Calling rename with a new name
  const result2 = await Operations.renameChannel({}, 'current', 'lounge', mockContext);
  assert.strictEqual(result2.success, true);
  assert.strictEqual(setNameCalls, 1, 'Should call setName exactly once when name changes');
  assert.strictEqual(currentChannel.name, 'lounge');
});

test('Targeted Execution: Intent router resolves routine commands via fast-path with 0 LLM calls', async () => {
  const router = new IntentRouter({
    planWithCustomPrompt: async () => {
      throw new Error('LLM should NOT be invoked for fast-path commands!');
    }
  });

  const budget = new TaskBudget();
  const mockContext = {
    getCompactContext: () => ({
      guild: { name: 'Test' },
      currentChannel: { id: '1', name: 'general' },
      invokingUser: { tag: 'Admin#0001' }
    })
  };

  // 1. Rename channel fast-path
  const r1 = await router.route('rename this channel to lounge', mockContext, budget);
  assert.strictEqual(r1.intent, 'rename_channel');
  assert.strictEqual(r1.targetRef, 'current');
  assert.strictEqual(r1.args.name, 'lounge');
  assert.strictEqual(budget.modelCalls, 0);

  // 2. Lock channel fast-path
  const r2 = await router.route('lock this channel', mockContext, budget);
  assert.strictEqual(r2.intent, 'lock_channel');
  assert.strictEqual(budget.modelCalls, 0);

  // 3. List channels fast-path
  const r3 = await router.route('show channels', mockContext, budget);
  assert.strictEqual(r3.intent, 'list_channels');
  assert.strictEqual(budget.modelCalls, 0);

  // 4. Greetings fast-path
  const r4 = await router.route('hello honey', mockContext, budget);
  assert.strictEqual(r4.intent, 'conversational');
  assert.ok(r4.conversationalResponse.includes('Honey'));
  assert.strictEqual(budget.modelCalls, 0);
});

test('Targeted Execution: Role assignment checks idempotency before calling Discord API', async () => {
  let roleAddCalls = 0;
  const mockMember = {
    user: { tag: 'Alex#1234' },
    roles: {
      cache: new Map([['role_vip_id', { id: 'role_vip_id', name: 'VIP' }]]),
      add: async () => { roleAddCalls++; }
    }
  };

  const mockRole = { id: 'role_vip_id', name: 'VIP', position: 1 };
  const mockGuild = {
    id: 'guild_1',
    members: { me: { roles: { highest: { position: 10 } } } }
  };

  const mockContext = {
    invokingUser: { tag: 'Admin#0001' },
    resolveTarget: async (ref, type) => {
      if (type === 'member') return mockMember;
      if (type === 'role') return mockRole;
      return null;
    }
  };

  // Alex already has VIP role: should be idempotent no-op (0 API calls)
  const result = await Operations.assignRole(mockGuild, 'Alex', 'VIP', mockContext);
  assert.strictEqual(result.success, true);
  assert.strictEqual(roleAddCalls, 0, 'No Discord API call should be made if member already has role');
  assert.ok(result.details.includes('already has role'));
});
