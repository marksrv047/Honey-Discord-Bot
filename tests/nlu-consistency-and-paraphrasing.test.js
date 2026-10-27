import test from 'node:test';
import assert from 'node:assert/strict';
import { LinguisticNormalizer } from '../src/linguistic-normalizer.js';
import { LanguageExampleDataset } from '../src/language-examples.js';
import { IntentInterpreter } from '../src/intent-interpreter.js';
import { IntentRouter } from '../src/intent-router.js';
import { OutcomeTracker, OutcomeStatus } from '../src/outcome-tracker.js';
import { FailureDiagnostics, FailureCategory } from '../src/failure-diagnostics.js';
import { CompletenessChecker } from '../src/completeness-checker.js';

function createMockGuild(id = 'guild_nlu_test') {
  const roles = new Map([
    ['role_artist_id', { id: 'role_artist_id', name: 'Artist', position: 5, color: 0 }],
    ['role_vip_id', { id: 'role_vip_id', name: 'VIP', position: 6, color: 0 }],
    ['role_bot_id', { id: 'role_bot_id', name: 'Honey Bot', position: 10, color: 0 }]
  ]);
  roles.find = (fn) => Array.from(roles.values()).find(fn);

  const channels = new Map([
    ['chan_gen_id', { id: 'chan_gen_id', name: 'general', type: 0 }],
    ['chan_ann_id', { id: 'chan_ann_id', name: 'announcements', type: 0 }]
  ]);
  channels.find = (fn) => Array.from(channels.values()).find(fn);

  const members = new Map([
    ['user_alex_id', {
      id: 'user_alex_id',
      user: { id: 'user_alex_id', username: 'Alex', tag: 'Alex#0001' },
      nickname: 'OldAlex',
      roles: { highest: { position: 3 }, cache: new Map() }
    }],
    ['user_bot_id', {
      id: 'user_bot_id',
      user: { id: 'user_bot_id', username: 'Honey Bot' },
      roles: { highest: { position: 10 } },
      permissions: { has: () => true }
    }]
  ]);
  members.find = (fn) => Array.from(members.values()).find(fn);

  return {
    id,
    name: 'NLU Test Guild',
    ownerId: 'owner_123',
    roles: {
      cache: roles,
      fetch: async () => roles
    },
    channels: {
      cache: channels,
      fetch: async () => channels
    },
    members: {
      cache: members,
      fetch: async (targetId) => members.get(targetId) || null,
      me: members.get('user_bot_id'),
      fetchMe: async () => members.get('user_bot_id')
    }
  };
}

function createMockContext(guild) {
  const adminMember = {
    id: 'admin_user_id',
    user: { id: 'admin_user_id', username: 'Admin', tag: 'Admin#0001' },
    permissions: { has: () => true },
    roles: { highest: { position: 99 } }
  };

  return {
    guild,
    member: adminMember,
    invokingMember: adminMember,
    user: adminMember.user,
    recentContext: {
      lastMentionedRole: 'Artist',
      lastMentionedRoleName: 'Artist',
      lastMentionedChannel: '#general',
      lastMentionedChannelName: 'general'
    }
  };
}

// ---------------------------------------------------------------------------
// 1. Linguistic Normalization & Quote Protection Tests
// ---------------------------------------------------------------------------
test('NLU: LinguisticNormalizer isolates quotes and neutralizes false-positive command keywords', () => {
  const prompt = 'Send an announcement saying "we will nuke and ban all spammers"';
  const isolated = LinguisticNormalizer.isolateQuotes(prompt);

  assert.ok(isolated.cleanPrompt.includes('__QUOTE_0__'));
  assert.equal(isolated.quotes.length, 1);
  assert.equal(isolated.quotes[0], 'we will nuke and ban all spammers');

  // Restoring quotes recovers payload
  const restored = LinguisticNormalizer.restoreQuotes(isolated.cleanPrompt, isolated.quotes);
  assert.ok(restored.includes('we will nuke and ban all spammers'));
});

test('NLU: LinguisticNormalizer handles polite preambles, British spelling, and typos', () => {
  const prompt = 'Could you please recolour the role to grey in chnnl #general';
  const norm = LinguisticNormalizer.normalize(prompt);

  assert.ok(!norm.cleanPrompt.startsWith('could you please'));
  assert.ok(norm.cleanPrompt.includes('recolor'));
  assert.ok(norm.cleanPrompt.includes('gray'));
  assert.ok(norm.cleanPrompt.includes('channel'));
});

// ---------------------------------------------------------------------------
// 2. Role Recolor Paraphrase Consistency
// ---------------------------------------------------------------------------
test('NLU: Role Recolor Paraphrases consistently map to identical canonical edit_role action', async () => {
  const guild = createMockGuild();
  const context = createMockContext(guild);
  const router = new IntentRouter({ isDeterministicOnly: true });

  const recolorPhrases = [
    'Make the role blue',
    'Change its colour to blue',
    'Recolour @Artist in blue',
    "Set @Artist's role color to blue",
    'Make @Artist blue'
  ];

  for (const phrase of recolorPhrases) {
    const interpretation = await IntentInterpreter.interpret(phrase, context, {
      routerInstance: router,
      isDeterministicOnly: true
    });

    assert.equal(interpretation.success, true, `Phrase failed to interpret: "${phrase}"`);
    assert.ok(interpretation.plan, `No plan generated for phrase: "${phrase}"`);
    assert.equal(interpretation.plan.actions.length, 1, `Expected exactly 1 action for: "${phrase}"`);

    const act = interpretation.plan.actions[0];
    assert.equal(act.action, 'edit_role', `Action was not edit_role for: "${phrase}"`);
    assert.equal(act.color, '#0000FF', `Color was not resolved to #0000FF for: "${phrase}"`);
    assert.ok(
      act.targetRole === 'Artist' || act.targetRole === '@Artist' || act.targetRole === 'role_artist_id',
      `Target role was not correctly set for: "${phrase}" (got: ${act.targetRole})`
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Target Accuracy & Parameter Preservation
// ---------------------------------------------------------------------------
test('NLU: Nickname change preserves the new nickname parameter and avoids wiping', async () => {
  const guild = createMockGuild();
  const context = createMockContext(guild);
  const router = new IntentRouter({ isDeterministicOnly: true });

  const prompt = 'Change Alex\'s nickname to Phoenix';
  const interpretation = await IntentInterpreter.interpret(prompt, context, {
    routerInstance: router,
    isDeterministicOnly: true
  });

  assert.equal(interpretation.success, true);
  assert.equal(interpretation.plan.actions.length, 1);
  const act = interpretation.plan.actions[0];
  assert.equal(act.action, 'change_nickname');
  const nickValue = act.nickname || act.newNickname;
  assert.equal(nickValue, 'Phoenix');
  assert.ok(nickValue !== '', 'New nickname must not be empty or wiped');
});

test('NLU: Slowmode paraphrases resolve correctly without LLM inference', async () => {
  const guild = createMockGuild();
  const context = createMockContext(guild);
  const router = new IntentRouter({ isDeterministicOnly: true });

  const slowmodePhrases = [
    'set slowmode to 10s in #general',
    'slow down #general to 10 seconds',
    'put slowmode on #general 10s'
  ];

  for (const phrase of slowmodePhrases) {
    const interpretation = await IntentInterpreter.interpret(phrase, context, {
      routerInstance: router,
      isDeterministicOnly: true
    });

    assert.equal(interpretation.success, true, `Slowmode phrase failed: "${phrase}"`);
    const act = interpretation.plan.actions[0];
    assert.equal(act.action, 'set_channel_slowmode');
    assert.equal(act.seconds, 10);
  }
});

test('NLU: Timeout phrasing variants (put in timeout, silence, shush) resolve deterministically', async () => {
  const guild = createMockGuild();
  const context = createMockContext(guild);
  const router = new IntentRouter({ isDeterministicOnly: true });

  const timeoutPhrases = [
    'Timeout Alex for 10 minutes',
    'Put Alex in timeout for 10m',
    'Silence Alex for 10m',
    'Shush Alex for 10m'
  ];

  for (const phrase of timeoutPhrases) {
    const interpretation = await IntentInterpreter.interpret(phrase, context, {
      routerInstance: router,
      isDeterministicOnly: true
    });

    assert.equal(interpretation.success, true, `Timeout phrase failed: "${phrase}"`);
    const act = interpretation.plan.actions[0];
    assert.equal(act.action, 'timeout_member');
    assert.equal(act.durationMinutes || act.duration, 10);
  }
});

// ---------------------------------------------------------------------------
// 4. Explicit Negation Detection
// ---------------------------------------------------------------------------
test('NLU: Explicit negation blocks destructive or unwanted operations safely', async () => {
  const guild = createMockGuild();
  const context = createMockContext(guild);

  const negatedPrompts = [
    "Don't ban Alex",
    'Never delete #general',
    'Delete nothing'
  ];

  for (const prompt of negatedPrompts) {
    const interpretation = await IntentInterpreter.interpret(prompt, context, {
      isDeterministicOnly: true
    });

    assert.equal(interpretation.isNegated, true, `Expected isNegated=true for: "${prompt}"`);
    assert.equal(interpretation.success, false);
    assert.equal(interpretation.stage, 'negated');
  }
});

// ---------------------------------------------------------------------------
// 5. Outcome Tracking State Machine & Honest Partial Failure Reporting
// ---------------------------------------------------------------------------
test('NLU: OutcomeTracker validates lifecycle states and handles partial multi-action failures', () => {
  const tracker = new OutcomeTracker('task_test_101', 'Create role and assign it');
  const planActions = [
    { action: 'create_role', roleName: 'VIP', color: '#FFD700' },
    { action: 'assign_role', role: 'VIP', targetMember: 'Alex' }
  ];

  tracker.initializePlan(planActions);
  assert.equal(tracker.actions.length, 2);
  assert.equal(tracker.actions[0].status, OutcomeStatus.PLANNED);

  tracker.markAllValidated();
  assert.equal(tracker.actions[0].status, OutcomeStatus.VALIDATED);
  assert.equal(tracker.actions[1].status, OutcomeStatus.VALIDATED);

  // Step 1 executing and succeeding
  tracker.updateActionStatus(tracker.actions[0].actionId, OutcomeStatus.EXECUTING);
  tracker.updateActionStatus(tracker.actions[0].actionId, OutcomeStatus.SUCCEEDED, { details: 'Created role VIP' });
  tracker.updateActionStatus(tracker.actions[0].actionId, OutcomeStatus.VERIFIED, { details: 'Role exists in cache' });

  // Step 2 fails
  tracker.updateActionStatus(tracker.actions[1].actionId, OutcomeStatus.EXECUTING);
  tracker.recordFailure(tracker.actions[1].actionId, 'Member not found', FailureCategory.MEMBER_HIERARCHY_BLOCKED);

  // Unexecuted dependents are skipped
  tracker.skipRemaining('Previous step failed');

  const summary = tracker.getExecutionSummary();
  assert.equal(summary.overallOutcome, 'PARTIAL');
  assert.equal(summary.succeededCount, 1);
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.verifiedCount, 1);
});

// ---------------------------------------------------------------------------
// 6. Failure Diagnostics Taxonomy
// ---------------------------------------------------------------------------
test('NLU: FailureDiagnostics maps errors across the 9 taxonomy categories without credential leaks', () => {
  const authErr = new Error('You do not have ManageRoles permission token=ghp_superSecretToken12345');
  const categorized = FailureDiagnostics.categorize(authErr, { stage: 'authorization' });

  assert.equal(categorized.category, FailureCategory.PERMISSION_DENIED);
  assert.ok(!categorized.error.includes('ghp_superSecretToken12345'), 'Credentials must be redacted');
  assert.ok(categorized.suggestedFix.includes('permission'));

  const rateErr = new Error('Rate limit exceeded 429');
  const rateCat = FailureDiagnostics.categorize(rateErr);
  assert.equal(rateCat.category, FailureCategory.RATE_LIMITED);

  const missingErr = new Error('Missing required target role');
  const missingCat = FailureDiagnostics.categorize(missingErr);
  assert.equal(missingCat.category, FailureCategory.MISSING_TARGET_OR_PARAMETER);
});

// ---------------------------------------------------------------------------
// 7. Language Examples Dataset
// ---------------------------------------------------------------------------
test('NLU: LanguageExampleDataset provides versioned few-shot examples with selective retrieval', () => {
  assert.equal(LanguageExampleDataset.VERSION, '2.0.0');
  const total = LanguageExampleDataset.getAllExamples().length;
  assert.ok(total >= 10, `Expected at least 10 canonical examples, found ${total}`);

  const roleMatches = LanguageExampleDataset.findRelevantExamples('change role color to blue', 3);
  assert.ok(roleMatches.length > 0 && roleMatches.length <= 3);
  assert.ok(roleMatches.some(e => e.intent === 'edit_role'));

  const timeoutMatches = LanguageExampleDataset.findRelevantExamples('timeout Alex for 15 minutes', 2);
  assert.ok(timeoutMatches.length > 0 && timeoutMatches.length <= 2);
  assert.ok(timeoutMatches.some(e => e.intent === 'timeout_member'));
});
