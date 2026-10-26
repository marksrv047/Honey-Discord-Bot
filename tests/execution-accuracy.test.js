import test from 'node:test';
import assert from 'node:assert/strict';
import { CompletenessChecker } from '../src/completeness-checker.js';
import { Operations } from '../src/operations.js';
import { Verifier, VerificationStatus } from '../src/verification.js';
import { resolveColor } from '../src/color-utils.js';
import { IntentRouter } from '../src/intent-router.js';
import { Executor } from '../src/executor.js';
import { formatSingleOutcome, formatMultiActionSummary } from '../src/format-response.js';

test('Execution Accuracy: Color normalization resolves hex, shorthand, and friendly names', () => {
  assert.strictEqual(resolveColor('dark red'), '#8B0000');
  assert.strictEqual(resolveColor('red'), '#FF0000');
  assert.strictEqual(resolveColor('blue'), '#0000FF');
  assert.strictEqual(resolveColor('#8b0000'), '#8B0000');
  assert.strictEqual(resolveColor('#fff'), '#FFFFFF');
  assert.strictEqual(resolveColor('invalid-color-xyz'), null);
});

// ============================================================================
// 1. MULTI-ACTION COMPLETENESS
// ============================================================================
test('Completeness: Multi-property role request extracts distinct operations for name and color', () => {
  const prompt = 'Rename the Moderator role to Community Moderator and change its color to dark red';
  const check = CompletenessChecker.verify(prompt, { actions: [] });

  assert.strictEqual(check.valid, true);
  assert.strictEqual(check.repairedPlan.actions.length, 2);
  assert.deepStrictEqual(check.repairedPlan.actions[0], {
    action: 'edit_role',
    targetRole: 'Moderator',
    name: 'Community Moderator',
    id: 'step_1',
    dependsOn: []
  });
  assert.deepStrictEqual(check.repairedPlan.actions[1], {
    action: 'edit_role',
    targetRole: 'Community Moderator',
    color: '#8B0000',
    id: 'step_2',
    dependsOn: []
  });
});

test('Completeness: Three-property role request extracts all three distinct operations', () => {
  const prompt = 'Rename the Helpers role to Community Team, set its color to #8B0000, and enable display separately';
  const check = CompletenessChecker.verify(prompt, { actions: [] });

  assert.strictEqual(check.valid, true);
  assert.strictEqual(check.repairedPlan.actions.length, 3);
  assert.strictEqual(check.repairedPlan.actions[0].name, 'Community Team');
  assert.strictEqual(check.repairedPlan.actions[1].color, '#8B0000');
  assert.strictEqual(check.repairedPlan.actions[2].hoist, true);
});

test('Completeness: Role edit verifies each property independently and detects partial failures', async () => {
  const mockRole = {
    id: 'role_mod_1',
    name: 'Community Moderator', // Name succeeded
    color: 0x000000,
    hexColor: '#000000', // Color failed to update
    edit: async (data) => {
      if (data.name) mockRole.name = data.name;
      // Intentionally simulate failure to update color
    }
  };

  const mockGuild = {
    roles: {
      cache: new Map([['role_mod_1', mockRole]]),
      fetch: async () => new Map([['role_mod_1', mockRole]])
    }
  };

  // Check verification of color update when live role color did not change
  const colorAction = { action: 'edit_role', targetRole: 'Community Moderator', color: '#8B0000' };
  const verif = await Verifier.verifyAction(mockGuild, colorAction, { success: true });
  assert.strictEqual(verif.verificationStatus, VerificationStatus.FAILED);
  assert.strictEqual(verif.status, 'MISMATCH');
  assert.ok(verif.details.includes('mismatch'));

  // Summary accurately flags partial failure
  const summary = formatMultiActionSummary([
    { action: 'edit_role', status: 'COMPLETED', verificationStatus: 'passed', details: 'Role renamed' },
    verif
  ]);
  assert.ok(summary.includes('Completed 1 of 2 actions'));
  assert.ok(summary.includes('failed'));
});

// ============================================================================
// 2. NICKNAME ACCURACY
// ============================================================================
test('Nickname: Resolves "my nickname" to invoking member and checks hierarchy', async () => {
  let updatedNick = null;
  const mockMember = {
    id: 'user_invoker_1',
    user: { id: 'user_invoker_1', username: 'AlexUser', tag: 'AlexUser#0001' },
    nickname: 'OldNick',
    displayName: 'OldNick',
    roles: { highest: { position: 10 } },
    setNickname: async (newNick) => {
      updatedNick = newNick;
      mockMember.nickname = newNick;
    }
  };

  const mockContext = {
    invokingUser: { id: 'user_invoker_1', tag: 'AlexUser#0001' },
    resolveTarget: async (ref) => /me|my/i.test(ref) ? mockMember : null
  };

  const res = await Operations.changeNickname({}, 'me', 'Alex', mockContext);
  assert.strictEqual(res.success, true);
  assert.strictEqual(updatedNick, 'Alex');
  assert.strictEqual(res.verified, true);
});

test('Nickname: Handles explicit nickname removal/reset as null', async () => {
  let clearedNick = 'NOT_SET';
  const mockMember = {
    id: 'user_sarah_1',
    user: { id: 'user_sarah_1', username: 'SarahGlobal', tag: 'Sarah#0001' },
    nickname: 'SarahServer',
    displayName: 'SarahServer',
    setNickname: async (val) => {
      clearedNick = val;
      mockMember.nickname = val;
    }
  };

  const mockContext = {
    invokingUser: { id: 'admin_1', tag: 'Admin#0001' },
    resolveTarget: async () => mockMember
  };

  const res = await Operations.changeNickname({}, 'Sarah', null, mockContext);
  assert.strictEqual(res.success, true);
  assert.strictEqual(clearedNick, null);
  assert.ok(res.details.includes('reverted to username'));

  const formatted = formatSingleOutcome('change_nickname', res, { targetMember: 'Sarah', nickname: null });
  assert.ok(formatted.includes('Removed server nickname'));
});

test('Nickname: Rejects ambiguous member resolution with concise clarification', async () => {
  const mockContext = {
    invokingUser: { id: 'admin_1' },
    resolveTarget: async () => ({
      isAmbiguous: true,
      clarificationQuestion: 'Multiple members match "Alex". Did you mean Alex#1234 or Alex#5678?'
    })
  };

  const res = await Operations.changeNickname({}, 'Alex', 'Lex', mockContext);
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.isAmbiguous, true);
  assert.ok(res.error.includes('Multiple members match'));
});

// ============================================================================
// 3. MESSAGE SEARCH ACCURACY (READ-ONLY, NO MUTATIONS)
// ============================================================================
test('Message Search: Searches by author and content without mutating messages', async () => {
  let bulkDeleteCalled = false;
  const mockMessages = [
    { id: 'm1', content: 'hello world', author: { id: 'user_1', tag: 'User1#0001' } },
    { id: 'm2', content: 'test message', author: { id: 'user_2', tag: 'User2#0001' } },
    { id: 'm3', content: 'another hello', author: { id: 'user_1', tag: 'User1#0001' } }
  ];

  const mockChannel = {
    id: 'ch_general',
    name: 'general',
    messages: {
      fetch: async () => new Map(mockMessages.map(m => [m.id, m]))
    },
    bulkDelete: async () => {
      bulkDeleteCalled = true;
    }
  };

  const mockContext = {
    resolveTarget: async () => mockChannel
  };

  // Search by author User1
  const res = await Operations.searchMessages({}, 'general', { authorId: 'user_1', contains: 'hello' }, mockContext);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.matchCount, 2);
  assert.strictEqual(bulkDeleteCalled, false, 'Search must NEVER mutate or delete messages');
  assert.strictEqual(res.matches.length, 2);
});

test('Search vs Mutate: CompletenessChecker neutralizes deletion in search-only prompt', () => {
  const prompt = 'Find messages containing password in #general';
  const planWithAccidentalPurge = {
    actions: [
      { action: 'purge_messages', targetChannel: 'general', count: 10 }
    ]
  };

  const check = CompletenessChecker.verify(prompt, planWithAccidentalPurge);
  assert.strictEqual(check.valid, true);
  // Must have stripped purge_messages and added search_messages
  assert.strictEqual(check.repairedPlan.actions.some(a => a.action === 'purge_messages'), false);
  assert.strictEqual(check.repairedPlan.actions.some(a => a.action === 'search_messages'), true);
});

// ============================================================================
// 4. DELETION SCOPE SAFETY & AUTHOR FILTER PRESERVATION
// ============================================================================
test('Deletion Safety: "Delete my messages" strictly filters by invoking author ID', async () => {
  const invokerId = 'user_invoker_123';
  let deletedMessages = null;

  const candidateMessages = [
    { id: 'm1', content: 'msg 1', author: { id: invokerId }, createdTimestamp: Date.now() - 1000 },
    { id: 'm2', content: 'other msg', author: { id: 'other_user_456' }, createdTimestamp: Date.now() - 2000 },
    { id: 'm3', content: 'msg 3', author: { id: invokerId }, createdTimestamp: Date.now() - 3000 },
    { id: 'm4', content: 'another other msg', author: { id: 'third_user_789' }, createdTimestamp: Date.now() - 4000 }
  ];

  const mockChannel = {
    id: 'ch_general',
    name: 'general',
    messages: {
      fetch: async () => new Map(candidateMessages.map(m => [m.id, m]))
    },
    bulkDelete: async (msgs) => {
      deletedMessages = msgs;
      return new Map(msgs.map(m => [m.id, m]));
    }
  };

  const mockContext = {
    invokingUser: { id: invokerId, tag: 'Invoker#0001' },
    resolveTarget: async () => mockChannel
  };

  const res = await Operations.purgeMessages({}, 'general', { author: 'me', count: 10 }, mockContext);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.deletedCount, 2);
  // Ensure ONLY invoker messages were passed to bulkDelete
  assert.strictEqual(deletedMessages.length, 2);
  assert.strictEqual(deletedMessages.every(m => m.author.id === invokerId), true);
  assert.strictEqual(deletedMessages.some(m => m.author.id === 'other_user_456'), false);
});

test('Deletion Safety: Enforces Discord 14-day limit and reports skipped messages accurately', async () => {
  const authorId = 'target_author';
  let deletedMessages = null;
  const now = Date.now();
  const fifteenDaysAgo = now - (15 * 24 * 60 * 60 * 1000);
  const oneDayAgo = now - (1 * 24 * 60 * 60 * 1000);

  const candidateMessages = [
    { id: 'm_recent', content: 'recent', author: { id: authorId }, createdTimestamp: oneDayAgo },
    { id: 'm_old', content: 'old message', author: { id: authorId }, createdTimestamp: fifteenDaysAgo }
  ];

  const mockChannel = {
    id: 'ch_general',
    name: 'general',
    messages: {
      fetch: async () => new Map(candidateMessages.map(m => [m.id, m]))
    },
    bulkDelete: async (msgs) => {
      deletedMessages = msgs;
      return new Map(msgs.map(m => [m.id, m]));
    }
  };

  const mockContext = {
    invokingUser: { id: 'admin_1' },
    resolveTarget: async (ref, type) => {
      if (type === 'channel') return mockChannel;
      if (type === 'member') return { id: authorId };
      return null;
    }
  };

  const res = await Operations.purgeMessages({}, 'general', { author: authorId, count: 10 }, mockContext);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.deletedCount, 1);
  assert.strictEqual(res.skippedCount, 1);
  assert.strictEqual(deletedMessages.length, 1);
  assert.strictEqual(deletedMessages[0].id, 'm_recent');
  assert.ok(res.details.includes('1 older than 14 days skipped'));
});

test('Deletion Safety: Refuses execution when author cannot be resolved (never broadens to all messages)', async () => {
  let bulkDeleteCalled = false;
  const mockChannel = {
    id: 'ch_general',
    name: 'general',
    messages: {
      fetch: async () => new Map()
    },
    bulkDelete: async () => {
      bulkDeleteCalled = true;
    }
  };

  const mockContext = {
    invokingUser: { id: 'admin_1' },
    resolveTarget: async (ref, type) => {
      if (type === 'channel') return mockChannel;
      if (type === 'member') return null; // Author could not be resolved!
      return null;
    }
  };

  const res = await Operations.purgeMessages({}, 'general', { author: 'NonExistentGhostUser', count: 10 }, mockContext);
  assert.strictEqual(res.success, false);
  assert.ok(res.error.includes('Target author "NonExistentGhostUser" could not be resolved'));
  assert.strictEqual(bulkDeleteCalled, false, 'Must NEVER fall back to deleting all messages when author filter fails');
});

// ============================================================================
// 5. PROMPT AND PLAN INTEGRITY & NEGATIVE CONSTRAINTS
// ============================================================================
test('Plan Integrity: Rejects plans violating negative constraints', () => {
  const prompt = 'Clean up old channels but do not touch #announcements';
  const plan = {
    actions: [
      { action: 'delete_channel', targetChannel: 'announcements' }
    ]
  };

  const check = CompletenessChecker.verify(prompt, plan);
  assert.strictEqual(check.valid, false);
  assert.ok(check.errors[0].includes('Negative constraint violation'));
});

test('Plan Integrity: Fast-path routes multi-property role request into distinct operations', async () => {
  const router = new IntentRouter();
  const prompt = 'Rename the Moderator role to Community Moderator and change its color to dark red';
  const routed = await router.route(prompt, {});

  assert.strictEqual(routed.intent, 'complex_plan');
  assert.strictEqual(routed.multiActions.length, 2);
  assert.strictEqual(routed.multiActions[0].action, 'edit_role');
  assert.strictEqual(routed.multiActions[0].name, 'Community Moderator');
  assert.strictEqual(routed.multiActions[1].action, 'edit_role');
  assert.strictEqual(routed.multiActions[1].color, '#8B0000');
});
