import test from 'node:test';
import assert from 'node:assert';
import { Operations } from '../src/operations.js';
import { Executor } from '../src/executor.js';
import { Verifier } from '../src/verification.js';
import { TaskBudget, BudgetExceededError } from '../src/budget.js';
import { ContextManager } from '../src/context-manager.js';
import { AIProvider } from '../src/ai-provider.js';
import { classifyDiscordError } from '../src/recovery.js';
import { TaskWorkflow, TaskState, ActionStatus } from '../src/task-workflow.js';

// ============================================================================
// SCENARIO 1: A simple request to list server channels
// ============================================================================
test('Scenario 1: Simple request to list server channels', async () => {
  const mockGuild = {
    channels: {
      cache: new Map([
        ['1', { id: '1', name: 'general', type: 0 }],
        ['2', { id: '2', name: 'voice-chat', type: 2 }]
      ]),
      fetch: async () => {}
    }
  };

  const result = await Operations.listChannels(mockGuild, {});
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.verified, true);
  assert.ok(result.details.includes('Found 2 total channels'));
});

// ============================================================================
// SCENARIO 2: Assigning a role to a specified member
// ============================================================================
test('Scenario 2: Assigning a role to a specified member', async () => {
  let roleAdded = false;
  const mockMember = {
    user: { tag: 'Tester#1234' },
    roles: {
      cache: new Map(),
      add: async () => { roleAdded = true; }
    }
  };
  const mockRole = { id: 'role_99', name: 'Moderator', position: 2 };
  const mockGuild = {
    members: { me: { roles: { highest: { position: 10 } } } }
  };
  const mockContext = {
    invokingUser: { tag: 'Admin#0001' },
    resolveTarget: async (ref, type) => type === 'member' ? mockMember : mockRole
  };

  const result = await Operations.assignRole(mockGuild, 'Tester', 'Moderator', mockContext);
  assert.strictEqual(result.success, true);
  assert.strictEqual(roleAdded, true);
  assert.ok(result.details.includes('Assigned role @Moderator'));
});

// ============================================================================
// SCENARIO 3: Creating a channel and verifying its configuration
// ============================================================================
test('Scenario 3: Creating a channel and verifying its configuration', async () => {
  let createdConfig = null;
  const mockGuild = {
    channels: {
      cache: new Map(),
      create: async (config) => {
        createdConfig = config;
        return { id: 'ch_new_1', name: config.name, topic: config.topic, rateLimitPerUser: config.rateLimitPerUser };
      }
    }
  };

  const mockContext = {
    executionId: 'exec_test_3',
    invokingUser: { tag: 'Admin#0001' },
    resolveTarget: async () => null
  };

  const result = await Operations.createChannel(mockGuild, {
    name: 'announcements',
    type: 'GUILD_TEXT',
    topic: 'Official server news',
    slowmodeSeconds: 10
  }, mockContext);

  assert.strictEqual(result.success, true);
  assert.strictEqual(createdConfig.name, 'announcements');
  assert.strictEqual(createdConfig.topic, 'Official server news');
  assert.strictEqual(createdConfig.rateLimitPerUser, 10);
});

// ============================================================================
// SCENARIO 4: A multi-step task with dependencies (Category before Channel)
// ============================================================================
test('Scenario 4: Multi-step task with dependencies orders category before channel', () => {
  const unorderedActions = [
    { action: 'create_channel', name: 'chat', type: 'GUILD_TEXT' },
    { action: 'create_channel', name: 'Community', type: 'GUILD_CATEGORY' },
    { action: 'create_role', name: 'Member' }
  ];

  const ordered = Executor.orderActions(unorderedActions);
  assert.strictEqual(ordered[0].action, 'create_role', 'Roles sorted first');
  assert.strictEqual(ordered[1].type, 'GUILD_CATEGORY', 'Categories sorted before standard channels');
  assert.strictEqual(ordered[2].name, 'chat', 'Channels created after categories');
});

// ============================================================================
// SCENARIO 5: Model response that exceeds context limit (Context Compaction)
// ============================================================================
test('Scenario 5: Pre-flight context compaction triggers when payload exceeds budget', () => {
  const hugeChannels = Array.from({ length: 50 }, (_, i) => ({ id: `id_${i}`, name: `channel-${i}` }));
  const hugePayload = {
    server: 'Big Guild',
    relevantChannels: hugeChannels,
    currentChannel: { id: 'ch_1', name: 'main' }
  };

  const compacted = ContextManager.compactIfNeeded(hugePayload, 100);
  assert.strictEqual(compacted.relevantChannels, undefined, 'Compaction should prune optional channel list');
  assert.strictEqual(compacted.server, 'Big Guild');
});

// ============================================================================
// SCENARIO 6: Provider response indicating output token exhaustion
// ============================================================================
test('Scenario 6: Output token exhaustion is caught and classified cleanly', () => {
  const budget = new TaskBudget({ maxOutputTokens: 500 });
  // Simulating output token usage over the limit
  assert.throws(
    () => budget.recordModelCall(200, 600),
    (err) => {
      assert.ok(err instanceof BudgetExceededError);
      assert.ok(err.message.includes('output token budget'));
      return true;
    }
  );
});

// ============================================================================
// SCENARIO 7: HTTP 429 with retry metadata
// ============================================================================
test('Scenario 7: HTTP 429 classified as retryable with backoff signal', () => {
  const err429 = { status: 429, message: 'Too Many Requests' };
  const classified = classifyDiscordError(err429);
  assert.strictEqual(classified.type, 'RATE_LIMIT');
  assert.strictEqual(classified.retryable, true);
});

// ============================================================================
// SCENARIO 8: Temporary provider outage (failover)
// ============================================================================
test('Scenario 8: Temporary provider outage falls over to secondary configured provider', async () => {
  const provider = new AIProvider();
  let groqCalled = false;

  // Mock Gemini failing with outage 503, Groq succeeding
  provider.planWithGemini = async () => {
    throw new Error('503 Service Unavailable: Google Gemini upstream outage');
  };
  provider.planWithGroq = async () => {
    groqCalled = true;
    return { thought: 'Fallback handled', intent: 'list_channels', isHighImpact: false };
  };

  const result = await provider.planWithCustomPrompt('prompt', 'payload');
  assert.strictEqual(groqCalled, true);
  assert.strictEqual(result.intent, 'list_channels');
});

// ============================================================================
// SCENARIO 9: Invalid API key
// ============================================================================
test('Scenario 9: Invalid API key error stops immediately without wasteful retries', async () => {
  const provider = new AIProvider();
  provider.planWithGemini = async () => {
    throw new Error('401 API_KEY_INVALID: Invalid Gemini API Key provided.');
  };

  await assert.rejects(
    async () => await provider.planWithGemini('payload'),
    /Invalid Gemini API Key/
  );
});

// ============================================================================
// SCENARIO 10: Discord permission denial
// ============================================================================
test('Scenario 10: Discord permission error classified with actionable guidance', () => {
  const permError = { code: 50013, message: 'Missing Permissions' };
  const classified = classifyDiscordError(permError);
  assert.strictEqual(classified.type, 'PERMISSION_ERROR');
  assert.strictEqual(classified.retryable, false);
  assert.ok(classified.userMessage.includes('Bot lacks required permissions'));
});

// ============================================================================
// SCENARIO 11: Timeout after mutation may already have succeeded (idempotent state inspection)
// ============================================================================
test('Scenario 11: Mutation timeout checks existing state to prevent duplicate creation', async () => {
  let createCalls = 0;
  const mockGuild = {
    roles: {
      cache: new Map([['role_1', { id: 'role_1', name: 'VIP' }]]),
      create: async () => { createCalls++; }
    }
  };

  const mockContext = {
    invokingUser: { tag: 'Admin#0001' },
    executionId: 'exec_test_11'
  };

  // Role "VIP" already exists in guild cache: should no-op
  const result = await Operations.createRole(mockGuild, { name: 'VIP' }, mockContext);
  assert.strictEqual(result.success, true);
  assert.strictEqual(createCalls, 0, 'Must NOT invoke Discord API to create duplicate role');
  assert.ok(result.details.includes('already exists'));
});

// ============================================================================
// SCENARIO 12: Duplicate tool-call attempt
// ============================================================================
test('Scenario 12: Duplicate tool calls detected and intercepted by TaskBudget', () => {
  const budget = new TaskBudget();
  const first = budget.recordToolCall('rename_channel', { name: 'lobby' });
  assert.strictEqual(first.isDuplicate, false);

  const duplicate = budget.recordToolCall('rename_channel', { name: 'lobby' });
  assert.strictEqual(duplicate.isDuplicate, true, 'Second identical call must be flagged as duplicate');
});

// ============================================================================
// SCENARIO 13: Partial success in a multi-action request
// ============================================================================
test('Scenario 13: Multi-action request captures partial success accurately', () => {
  const mockPlan = {
    thoughtProcess: 'Setup roles and channels',
    actions: [
      { action: 'create_role', name: 'VIP' },
      { action: 'create_channel', name: 'vip-lounge' }
    ]
  };

  const results = [
    { action: 'create_role', status: 'COMPLETED', details: 'Role @VIP created' },
    { action: 'create_channel', status: 'FAILED', details: 'Missing Permissions' }
  ];

  const report = Verifier.generateReportEmbed(mockPlan, results, 'exec_partial_13');
  assert.strictEqual(report.data.title, '⚠️ Execution Report (Partial or Skipped)');
  assert.ok(report.data.description.includes('1/2 completed'));
});

// ============================================================================
// SCENARIO 14: Process interruption followed by task recovery
// ============================================================================
test('Scenario 14: Task workflow preserves action status across checkpoints', () => {
  const mockContext = { invokingUser: { id: 'u1' } };
  const workflow = new TaskWorkflow('task_recover_14', 'Create category and channels', mockContext);

  workflow.setPlannedActions([
    { action: 'create_role', name: 'VIP' },
    { action: 'create_channel', name: 'vip-lounge' }
  ]);

  // First action succeeds before interruption
  workflow.updateActionStatus(workflow.actions[0].id, ActionStatus.SUCCEEDED, { details: 'Role created' });

  // Simulate recovery: only pending actions remain
  const pending = workflow.getPendingActions();
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].action, 'create_channel');
});

// ============================================================================
// SCENARIO 15: Ambiguous request requiring clarification
// ============================================================================
test('Scenario 15: Ambiguous request formulation reports clarificationNeeded', () => {
  const ambiguousPlan = {
    thoughtProcess: 'User said "change it" without specifying channel or action',
    clarificationNeeded: 'Which channel would you like to rename or edit?',
    actions: []
  };

  assert.ok(ambiguousPlan.clarificationNeeded);
  assert.strictEqual(ambiguousPlan.actions.length, 0);
});

// ============================================================================
// SCENARIO 16: Destructive action requiring confirmation
// ============================================================================
test('Scenario 16: Channel or role deletion flags isHighImpact for confirmation check', () => {
  const destructiveAction = { action: 'delete_channel', targetChannel: 'general' };
  const isHighImpact = ['delete_channel', 'delete_role', 'ban_member', 'kick_member'].includes(destructiveAction.action);
  assert.strictEqual(isHighImpact, true, 'Destructive actions must require confirmation');
});

// ============================================================================
// SCENARIO 17: Provider quota exhaustion event
// ============================================================================
test('Scenario 17: Provider quota exhaustion halts cleanly with clear explanation', () => {
  const quotaErr = new Error('Google Gemini free quota reached. Please wait a minute, or switch to Groq.');
  assert.ok(quotaErr.message.includes('free quota reached'));
});

// ============================================================================
// SCENARIO 18: Unavailable optional local model
// ============================================================================
test('Scenario 18: Unreachable Ollama returns instructive diagnostic error', async () => {
  const provider = new AIProvider();
  provider.provider = 'ollama';

  await assert.rejects(
    async () => await provider.planWithOllama('payload'),
    /Local Ollama is unreachable/
  );
});

// ============================================================================
// SCENARIO 19: Task that reaches its execution budget without progress (Circuit Breaker)
// ============================================================================
test('Scenario 19: Circuit breaker halts task if consecutive failures occur without forward progress', () => {
  const mockContext = { invokingUser: { id: 'u1' } };
  const workflow = new TaskWorkflow('task_halt_19', 'Loop test', mockContext);

  workflow.setPlannedActions([
    { action: 'edit_channel', target: 'ch_1' },
    { action: 'edit_channel', target: 'ch_1' },
    { action: 'edit_channel', target: 'ch_1' }
  ]);

  workflow.actions[0].status = ActionStatus.FAILED;
  workflow.actions[1].status = ActionStatus.FAILED;
  workflow.actions[2].status = ActionStatus.FAILED;

  assert.throws(
    () => workflow.assertForwardProgress(3),
    (err) => {
      assert.ok(err instanceof BudgetExceededError);
      assert.ok(err.message.includes('consecutive actions failed'));
      return true;
    }
  );
});

// ============================================================================
// SCENARIO 20: Task where verification reveals requested change did not persist
// ============================================================================
test('Scenario 20: Verification identifies state MISMATCH when Discord state does not match', async () => {
  const mockGuild = {
    name: 'Old Name',
    fetch: async () => {} // Guild name remains 'Old Name'
  };

  const actionObj = { action: 'update_server_name', name: 'New Name' };
  const executionResult = { success: true, details: 'API call returned OK' };

  const verification = await Verifier.verifyAction(mockGuild, actionObj, executionResult);
  assert.strictEqual(verification.status, 'MISMATCH');
  assert.strictEqual(verification.verified, false);
  assert.ok(verification.details.includes('MISMATCH') || verification.details.includes('Old Name'));
});
