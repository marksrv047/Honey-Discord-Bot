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

import { Operations } from '../src/operations.js';

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

test('Role Assignment: Routes "Give the role <@&id> to the user <@id>" and auto-corrects reversed arguments', async () => {
  const router = new IntentRouter({ isDeterministicOnly: true });
  const p = 'Give the role <@&1564281970308030654> to the user <@1209543193562058753>';
  const routed = await router.route(p, {});
  assert.equal(routed.intent, 'assign_role');
  assert.equal(routed.args.targetRole, '1564281970308030654');
  assert.equal(routed.args.targetMember, '1209543193562058753');

  // Test Operations.assignRole auto-swap when arguments are reversed:
  const mockMember = {
    id: '1209543193562058753',
    user: { tag: 'TestUser#0001' },
    roles: {
      cache: new Map(),
      add: async (r) => { mockMember.roles.cache.set(r.id, r); }
    }
  };
  const mockRole = {
    id: '1564281970308030654',
    name: 'SpecialRole',
    position: 5
  };

  const mockGuild = {
    id: 'test-guild-1',
    members: {
      cache: new Map([[mockMember.id, mockMember]]),
      me: { roles: { highest: { position: 10 } } }
    },
    roles: {
      cache: new Map([[mockRole.id, mockRole]])
    }
  };

  const mockCtx = {
    invokingUser: { tag: 'Admin#0001' },
    resolveTarget: async (ref, type) => {
      if (type === 'role') return mockGuild.roles.cache.get(ref);
      if (type === 'member') return mockGuild.members.cache.get(ref);
      return null;
    }
  };

  // Call assignRole with role as memberRef and member as roleRef (reversed)
  const res = await Operations.assignRole(mockGuild, '<@&1564281970308030654>', '<@1209543193562058753>', mockCtx);
  assert.equal(res.success, true);
  assert.equal(res.targetRoleId, '1564281970308030654');
  assert.equal(res.targetMemberId, '1209543193562058753');
  assert.equal(mockMember.roles.cache.has(mockRole.id), true);
});
