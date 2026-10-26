import test from 'node:test';
import assert from 'node:assert/strict';
import { IntentRouter } from '../src/intent-router.js';
import { ModlogInterpreter } from '../src/modlog-interpreter.js';
import { ChannelGuard } from '../src/channel-guard.js';
import { MusicService } from '../src/music-service.js';

test('IntentRouter: Recognizes dashboard requests reliably in all natural variations', async () => {
  const router = new IntentRouter({ isDeterministicOnly: true });

  const prompts = [
    'display bot dashboard',
    'open dashboard',
    'bot dashboard',
    'show server dashboard',
    'dashboard',
    'display the dashboard',
    'open the bot dashboard'
  ];

  for (const p of prompts) {
    const res = await router.route(p, {});
    assert.equal(res.intent, 'open_dashboard', `Failed to route "${p}" to open_dashboard`);
  }
});

test('IntentRouter: Routes modlog queries and setup in /go', async () => {
  const router = new IntentRouter({ isDeterministicOnly: true });

  const queryPrompts = [
    'what is the modlog channel',
    'where is the modlog channel',
    'state the modlog channel',
    'show modlog',
    'is modlog setup',
    'modlog status'
  ];

  for (const p of queryPrompts) {
    const res = await router.route(p, {});
    assert.equal(res.intent, 'inspect_modlog', `Failed to route "${p}" to inspect_modlog`);
  }

  const setupRes = await router.route('set up modlog', {});
  assert.equal(setupRes.intent, 'setup_modlog');
  assert.equal(setupRes.targetRef, 'mod-logs');
});

test('IntentRouter: Routes voice join and guard channel requests', async () => {
  const router = new IntentRouter({ isDeterministicOnly: true });

  const voiceRes = await router.route('connect to voice channel " 🎤 | hangout"', {});
  assert.equal(voiceRes.intent, 'voice_join');

  const guardRes = await router.route('guard this channel', {});
  assert.equal(guardRes.intent, 'guard_channel');

  const listGuardRes = await router.route('list guarded channels', {});
  assert.equal(listGuardRes.intent, 'list_guarded_channels');
});

test('ModlogInterpreter: Does not parse "set up" as channel name "up"', async () => {
  const res = await ModlogInterpreter.interpret('set up');
  assert.notEqual(res.targetChannel, 'up');
  assert.equal(res.intent, 'setup_logging');

  const res2 = await ModlogInterpreter.interpret('set up modlog');
  assert.notEqual(res2.targetChannel, 'up');
  assert.equal(res2.intent, 'setup_logging');
});

test('ChannelGuard: Detects spam patterns (invites, mass mentions, scam domains)', () => {
  // Invite
  const msg1 = { content: 'Join my awesome server discord.gg/abcdef', mentions: {} };
  assert.equal(ChannelGuard.isSpam(msg1).isSpam, true);

  // Mass mention
  const msg2 = { content: 'hello everyone', mentions: { everyone: true } };
  assert.equal(ChannelGuard.isSpam(msg2).isSpam, true);

  // Phishing link
  const msg3 = { content: 'free nitro here http://steamcommunity.link/gift', mentions: {} };
  assert.equal(ChannelGuard.isSpam(msg3).isSpam, true);

  // Normal message
  const msg4 = { content: 'hello friends how is everyone doing', mentions: {} };
  assert.equal(ChannelGuard.isSpam(msg4).isSpam, false);
});
