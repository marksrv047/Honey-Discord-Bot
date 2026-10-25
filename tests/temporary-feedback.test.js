import test from 'node:test';
import assert from 'node:assert/strict';
import { TemporaryFeedback } from '../src/temporary-feedback.js';

test('TemporaryFeedback: Enforces 5 to 10 second delay bounds with default 7s', () => {
  assert.equal(TemporaryFeedback.clampDelay(), 7000);
  assert.equal(TemporaryFeedback.clampDelay(3), 5000); // Clamped up to 5s
  assert.equal(TemporaryFeedback.clampDelay(15), 10000); // Clamped down to 10s
  assert.equal(TemporaryFeedback.clampDelay(8), 8000);
});

test('TemporaryFeedback: Safely handles message deletion without throwing', async () => {
  let deleted = false;
  const mockMessage = {
    deletable: true,
    delete: async () => {
      deleted = true;
      return mockMessage;
    }
  };

  const timer = TemporaryFeedback.scheduleDeletion(mockMessage, 5); // 5 seconds
  assert.ok(timer);
  clearTimeout(timer);

  // Directly test safeDeleteMessage
  const success = await TemporaryFeedback.safeDeleteMessage(mockMessage);
  assert.equal(success, true);
  assert.equal(deleted, true);
});

test('TemporaryFeedback: Handles missing permissions or already-deleted message without crashing', async () => {
  const failingMessage = {
    deletable: false,
    delete: async () => {
      throw new Error('Missing Permissions (50013)');
    }
  };

  const result = await TemporaryFeedback.safeDeleteMessage(failingMessage);
  assert.equal(result, false); // Returned false cleanly without unhandled rejection
});
