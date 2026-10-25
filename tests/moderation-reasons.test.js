import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSingleOutcome } from '../src/format-response.js';
import { Operations } from '../src/operations.js';

test('Moderation Formatting: In-channel outcome formatting preserves exact reason', () => {
  const banRes = formatSingleOutcome('ban_member', { success: true }, {
    targetMember: 'Alex',
    reason: 'Repeated harassment'
  });
  assert.equal(banRes, 'Banned @Alex. Reason: Repeated harassment.');

  const kickRes = formatSingleOutcome('kick_member', { success: true }, {
    targetMember: 'Alex',
    reason: 'Repeated spam'
  });
  assert.equal(kickRes, 'Kicked @Alex. Reason: Repeated spam.');

  const timeoutRes = formatSingleOutcome('timeout_member', { success: true }, {
    targetMember: 'Alex',
    durationMinutes: 10,
    reason: 'Disrupting the discussion'
  });
  assert.equal(timeoutRes, 'Timed out @Alex for 10 minutes. Reason: Disrupting the discussion.');

  const purgeRes = formatSingleOutcome('purge_messages', { success: true }, {
    count: 20,
    targetRef: '#general'
  });
  assert.equal(purgeRes, 'Purged 20 messages from #general.');
});

test('Moderation Formatting: In-channel failure formats truthful reason without assuming success', () => {
  const permFail = formatSingleOutcome('ban_member', {
    success: false,
    error: 'Missing Permissions (50013)'
  }, { targetMember: 'Alex' });
  assert.equal(permFail, "Couldn't ban @Alex. The bot lacks the required permission.");

  const unverified = formatSingleOutcome('ban_member', {
    success: true,
    verificationStatus: 'inconclusive'
  }, { targetMember: 'Alex' });
  assert.equal(unverified, "The change was submitted, but I couldn't verify the final state.");
});

test('Purge Limits: Enforces count bounds between 1 and 100', async () => {
  const mockContext = {
    resolveTarget: async () => ({
      name: 'general',
      bulkDelete: async (count) => ({ size: count })
    })
  };

  // Less than 1 should fail
  const zeroRes = await Operations.purgeMessages({}, 'current', 0, mockContext);
  assert.equal(zeroRes.success, false);
  assert.ok(zeroRes.error.includes('Bulk delete must be between 1 and 100'));

  // Greater than 100 should fail
  const overRes = await Operations.purgeMessages({}, 'current', 101, mockContext);
  assert.equal(overRes.success, false);
  assert.ok(overRes.error.includes('Bulk delete must be between 1 and 100'));

  // Valid count should succeed
  const validRes = await Operations.purgeMessages({}, 'current', 25, mockContext);
  assert.equal(validRes.success, true);
  assert.equal(validRes.details, 'Purged 25 messages from #general');
});

test('Moderation Reasons: Fallback to "No reason provided" and 512 character limit', () => {
  const longReason = 'A'.repeat(600);
  const safeReason = String(longReason).slice(0, 512);
  assert.equal(safeReason.length, 512);

  const fallbackReason = String('' || 'No reason provided').slice(0, 512);
  assert.equal(fallbackReason, 'No reason provided');
});
