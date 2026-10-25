import test from 'node:test';
import assert from 'node:assert/strict';
import { ModlogInterpreter } from '../src/modlog-interpreter.js';

test('ModlogInterpreter: Interprets configuration intents', async () => {
  const r1 = await ModlogInterpreter.interpret('Set #moderation-logs as the mod-log channel.');
  assert.equal(r1.intent, 'configure_channel');
  assert.equal(r1.targetChannel, '#moderation-logs');

  const r2 = await ModlogInterpreter.interpret('Use this channel for moderation logs');
  assert.equal(r2.intent, 'configure_channel');
  assert.equal(r2.targetChannel, 'current');

  const r3 = await ModlogInterpreter.interpret('Move the logs to #staff-logs.');
  assert.equal(r3.intent, 'configure_channel');
  assert.equal(r3.targetChannel, '#staff-logs');
});

test('ModlogInterpreter: Interprets composite configure and test intent', async () => {
  const r = await ModlogInterpreter.interpret('Change the log channel to #bot-logs and verify it works');
  assert.equal(r.intent, 'configure_channel');
  assert.equal(r.targetChannel, '#bot-logs');
  assert.equal(r.testAfterConfig, true);
});

test('ModlogInterpreter: Interprets inspection intents', async () => {
  const r1 = await ModlogInterpreter.interpret('Which channel is configured for mod logs?');
  assert.equal(r1.intent, 'inspect_config');

  const r2 = await ModlogInterpreter.interpret('Show the current logging configuration.');
  assert.equal(r2.intent, 'inspect_config');

  const r3 = await ModlogInterpreter.interpret('Tell me whether logging is enabled.');
  assert.equal(r3.intent, 'inspect_config');
});

test('ModlogInterpreter: Interprets testing and verification intents', async () => {
  const r1 = await ModlogInterpreter.interpret('Test the mod-log channel.');
  assert.equal(r1.intent, 'test_channel');

  const r2 = await ModlogInterpreter.interpret('Check whether you can send messages and embeds there.');
  assert.equal(r2.intent, 'test_channel');

  const r3 = await ModlogInterpreter.interpret('Verify the current configuration.');
  assert.equal(r3.intent, 'test_channel');
});

test('ModlogInterpreter: Interprets enablement and disablement intents', async () => {
  const r1 = await ModlogInterpreter.interpret('Disable mod logging for this server.');
  assert.equal(r1.intent, 'disable_logging');

  const r2 = await ModlogInterpreter.interpret('Enable logging again.');
  assert.equal(r2.intent, 'enable_logging');

  const r3 = await ModlogInterpreter.interpret('Turn logging back on using the existing channel.');
  assert.equal(r3.intent, 'enable_logging');
});

test('ModlogInterpreter: Flags channel deletion requests for clarification', async () => {
  const r1 = await ModlogInterpreter.interpret('delete the mod-log channel');
  assert.equal(r1.intent, 'clarification_needed');
  assert.ok(r1.clarificationQuestion);

  const r2 = await ModlogInterpreter.interpret('delete logging channel completely');
  assert.equal(r2.intent, 'clarification_needed');
  assert.ok(r2.clarificationQuestion);
});
