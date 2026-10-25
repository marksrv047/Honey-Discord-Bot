import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatSingleOutcome,
  formatConfirmationQuestion,
  formatMultiActionSummary,
  formatAuditSummary,
  formatRefinedResponse,
  cleanText
} from '../src/format-response.js';

test('Premium UX: Formats calm, single-sentence outcomes for core administrative actions', () => {
  // 1. Channel renamed
  const renameMsg = formatSingleOutcome('rename_channel', { success: true }, {
    targetRef: 'general',
    name: 'general-chat'
  });
  assert.equal(renameMsg, 'Renamed #general to #general-chat.');

  // 2. Announcement posted
  const announceMsg = formatSingleOutcome('send_announcement', { success: true }, {
    targetRef: 'announcements'
  });
  assert.equal(announceMsg, 'Announcement posted in #announcements.');

  // 3. Role assigned
  const roleMsg = formatSingleOutcome('assign_role', { success: true }, {
    targetRole: 'Member',
    targetMember: 'Alex'
  });
  assert.equal(roleMsg, 'Assigned the Member role to @Alex.');

  // 4. Member kicked
  const kickMsg = formatSingleOutcome('kick_member', { success: true }, {
    targetMember: 'Alex'
  });
  assert.equal(kickMsg, 'Kicked @Alex from the server.');
});

test('Premium UX: Formats calm, actionable failure and inconclusive responses', () => {
  // Missing permissions failure
  const failMsg = formatSingleOutcome('rename_channel', {
    success: false,
    error: '50013 Missing Permissions: Bot lacks required permission MANAGE_CHANNELS'
  });
  assert.equal(failMsg, "Couldn't complete the action. The bot is missing the required permission.");

  // Role hierarchy restriction failure
  const hierarchyMsg = formatSingleOutcome('assign_role', {
    success: false,
    error: 'Discord Role Hierarchy Error: Bot role position is not high enough'
  });
  assert.equal(hierarchyMsg, "Couldn't complete the action because of role hierarchy restrictions.");

  // Inconclusive verification
  const inconclusiveMsg = formatSingleOutcome('send_message', {
    success: true,
    verificationStatus: 'inconclusive'
  });
  assert.equal(inconclusiveMsg, "The change was submitted, but I couldn't verify the final state.");
});

test('Premium UX: Confirmation questions are concise, direct, and emoji-free', () => {
  assert.equal(formatConfirmationQuestion('ban_member', '@Alex'), 'Confirm ban of @Alex?');
  assert.equal(formatConfirmationQuestion('kick_member', 'Alex'), 'Confirm kick of @Alex?');
  assert.equal(formatConfirmationQuestion('delete_channel', '#general'), 'Confirm deletion of #general?');
});

test('Premium UX: Multi-action summary accurately reflects partial completion without clutter', () => {
  const mixedResults = [
    { action: 'create_channel', status: 'COMPLETED', details: 'Created channel' },
    { action: 'create_role', status: 'COMPLETED', details: 'Created role' },
    { action: 'assign_role', status: 'FAILED', details: 'role hierarchy restrictions' }
  ];

  const summary = formatMultiActionSummary(mixedResults);
  assert.ok(summary.includes('Completed 2 of 3 actions'));
  assert.ok(summary.includes('failed'));
});

test('Premium UX: Audit summary conveys overall findings in one clear sentence', () => {
  const mockReport = {
    summary: {
      passed: 42,
      failed: 2,
      inconclusive: 1,
      skipped: 0
    }
  };

  const auditSummary = formatAuditSummary(mockReport);
  assert.equal(auditSummary, 'Audit complete. 42 checks passed, 2 issues found, and 1 could not run.');
});

test('Premium UX: Default responses contain zero emojis', () => {
  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E0}-\u{1F1FF}🍯🐝🎉✨🚀🔥]/u;

  const responses = [
    formatSingleOutcome('rename_channel', { success: true }, { targetRef: 'general', name: 'general-chat' }),
    formatSingleOutcome('send_announcement', { success: true }, { targetRef: 'announcements' }),
    formatSingleOutcome('assign_role', { success: true }, { targetRole: 'Member', targetMember: 'Alex' }),
    formatSingleOutcome('kick_member', { success: true }, { targetMember: 'Alex' }),
    formatConfirmationQuestion('ban_member', 'Alex'),
    formatAuditSummary({ summary: { passed: 42, failed: 2, inconclusive: 1, skipped: 0 } })
  ];

  for (const resp of responses) {
    assert.equal(emojiRegex.test(resp), false, `Response contained forbidden emoji: "${resp}"`);
  }
});

test('Premium UX: formatRefinedResponse properly sequences bullets, replaces @Role, and strips cheesy persona', () => {
  const cheesyHorizontalInput = '🐝 Buzz buzz! Happy to help—here are some role ideas for Elsewhere ˎˊ-:\n• @Admin – server managers • @Moderator – chat moderators • @Artist – creators • @Gamer – gaming fans. Mix and match to fit your vibe!';

  const refined = formatRefinedResponse(cheesyHorizontalInput);

  // Must not contain bee buzz or persona
  assert.equal(/buzz/i.test(refined), false);
  assert.equal(/happy to help/i.test(refined), false);
  assert.equal(/mix and match/i.test(refined), false);
  assert.equal(/🐝/.test(refined), false);

  // Must have bullets on separate lines
  assert.ok(refined.includes('\n• **Admin** – server managers'));
  assert.ok(refined.includes('\n• **Moderator** – chat moderators'));
  assert.ok(refined.includes('\n• **Artist** – creators'));
  assert.ok(refined.includes('\n• **Gamer** – gaming fans'));

  // Header should be clean without decorative tails and capitalized
  assert.ok(refined.startsWith('Here are some role ideas for Elsewhere:'));
});
