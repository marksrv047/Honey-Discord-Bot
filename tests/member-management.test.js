import test from 'node:test';
import assert from 'node:assert/strict';
import { Operations } from '../src/operations.js';
import { MemberResolver } from '../src/member-resolver.js';
import { IntentRouter } from '../src/intent-router.js';
import { CompletenessChecker } from '../src/completeness-checker.js';
import { ExecutionContext } from '../src/execution-context.js';
import { ActionLedger, RecoveryEngine } from '../src/recovery.js';
import { PermissionFlagsBits } from 'discord.js';

function createMockMember(options = {}) {
  const member = {
    id: options.id || '100000000000000001',
    nickname: options.nickname ?? null,
    displayName: options.displayName || options.nickname || 'TestUser',
    joinedTimestamp: options.joinedTimestamp || 1700000000000,
    communicationDisabledUntilTimestamp: options.communicationDisabledUntilTimestamp || null,
    user: {
      id: options.id || '100000000000000001',
      username: options.username || 'testuser',
      tag: `${options.username || 'testuser'}#0001`,
      bot: Boolean(options.bot),
      createdTimestamp: options.createdTimestamp || 1600000000000
    },
    roles: {
      highest: options.highestRole || { id: 'role_default', name: '@everyone', position: 0 },
      cache: new Map(options.roles ? options.roles.map(r => [r.id, r]) : [])
    },
    permissions: {
      has: (perm) => {
        if (options.isAdmin) return true;
        if (options.permissions && options.permissions.includes(perm)) return true;
        return false;
      }
    },
    guild: options.guild || { id: 'guild_test_1' },
    setNickname: async (newNick) => {
      if (options.rejectSetNickname) {
        throw new Error(options.rejectSetNickname);
      }
      member.nickname = newNick;
      member.displayName = newNick || member.user.username;
      return member;
    },
    displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/100000000000000001/avatar.png'
  };
  return member;
}

function createMockGuild(members = []) {
  const memberMap = new Map(members.map(m => [m.id, m]));
  const guild = {
    id: 'guild_test_1',
    name: 'Honey Test Server',
    ownerId: '999999999999999999',
    members: {
      cache: memberMap,
      fetch: async (query) => {
        if (typeof query === 'string') {
          return memberMap.get(query) || null;
        }
        if (query?.query) {
          const q = query.query.toLowerCase();
          return Array.from(memberMap.values()).filter(m =>
            m.displayName.toLowerCase().includes(q) || m.user.username.toLowerCase().includes(q)
          );
        }
        return Array.from(memberMap.values());
      },
      me: {
        id: 'bot_honey',
        roles: { highest: { id: 'role_bot', name: 'Honey Bot', position: 50 } },
        permissions: {
          has: (perm) => [PermissionFlagsBits.ManageNicknames, PermissionFlagsBits.Administrator].includes(perm)
        }
      }
    },
    roles: {
      cache: new Map([
        ['role_bot', { id: 'role_bot', name: 'Honey Bot', position: 50 }]
      ])
    }
  };
  return guild;
}

test('1. Nickname Replacement: Replaces existing nickname with exact requested value preserving spaces', async () => {
  const member = createMockMember({ id: '200000000000000001', username: 'alex', nickname: 'OldNick' });
  const guild = createMockGuild([member]);
  const context = {
    invokingUser: { id: 'admin_1', tag: 'Admin#0001' },
    resolveTarget: async () => member,
    executionId: 'exec_nick_1'
  };

  const res = await Operations.changeNickname(guild, 'alex', 'Night Owl', context);
  assert.strictEqual(res.success, true);
  assert.strictEqual(member.nickname, 'Night Owl');
  assert.strictEqual(res.verified, true);
  assert.ok(res.details.includes('"Night Owl"'));
});

test('2. Nickname Replacement: Preserves punctuation and interior spaces accurately', async () => {
  const member = createMockMember({ id: '200000000000000002', username: 'alex', nickname: null });
  const guild = createMockGuild([member]);
  const context = {
    invokingUser: { id: 'admin_1', tag: 'Admin#0001' },
    resolveTarget: async () => member
  };

  const res = await Operations.changeNickname(guild, 'alex', 'Dr. Night-Owl (Admin)', context);
  assert.strictEqual(res.success, true);
  assert.strictEqual(member.nickname, 'Dr. Night-Owl (Admin)');
  assert.strictEqual(res.verified, true);
});

test('3. Nickname Removal: Explicit nickname removal clears nickname to null', async () => {
  const member = createMockMember({ id: '200000000000000003', username: 'alex', nickname: 'Night Owl' });
  const guild = createMockGuild([member]);
  const context = {
    invokingUser: { id: 'admin_1', tag: 'Admin#0001' },
    resolveTarget: async () => member,
    executionId: 'exec_nick_rem_1'
  };

  const res = await Operations.removeNickname(guild, 'alex', context);
  assert.strictEqual(res.success, true);
  assert.strictEqual(member.nickname, null);
  assert.strictEqual(res.verified, true);
  assert.ok(res.details.includes('reverted to username'));
});

test('4. Nickname Safety: Missing nickname input does NOT accidentally clear an existing nickname', async () => {
  const member = createMockMember({ id: '200000000000000004', username: 'alex', nickname: 'Night Owl' });
  const guild = createMockGuild([member]);
  const context = {
    invokingUser: { id: 'admin_1', tag: 'Admin#0001' },
    resolveTarget: async () => member
  };

  // Calling changeNickname with undefined or empty string must fail and NOT clear nickname
  const resUndefined = await Operations.changeNickname(guild, 'alex', undefined, context);
  assert.strictEqual(resUndefined.success, false);
  assert.strictEqual(member.nickname, 'Night Owl', 'Nickname must remain intact');
  assert.ok(resUndefined.error.includes('No replacement nickname provided'));

  const resEmpty = await Operations.changeNickname(guild, 'alex', '   ', context);
  assert.strictEqual(resEmpty.success, false);
  assert.strictEqual(member.nickname, 'Night Owl', 'Nickname must remain intact');
});

test('5. Nickname Inspection: Read-only inspection does NOT mutate member state', async () => {
  let setNicknameCalled = false;
  const member = createMockMember({ id: '200000000000000005', username: 'alex', nickname: 'Night Owl' });
  member.setNickname = async () => { setNicknameCalled = true; };
  const guild = createMockGuild([member]);
  const context = {
    invokingUser: { id: 'admin_1', tag: 'Admin#0001' },
    resolveTarget: async () => member
  };

  const res = await Operations.inspectNickname(guild, 'alex', context);
  assert.strictEqual(res.success, true);
  assert.strictEqual(setNicknameCalled, false, 'setNickname must never be called on inspection');
  assert.ok(res.details.includes('"Night Owl"'));
  assert.ok(res.details.includes('alex'));
});

test('6. Member Resolver: Disambiguates when multiple members match same name', async () => {
  const m1 = createMockMember({ id: '300000000000000001', username: 'alex_one', displayName: 'Alex' });
  const m2 = createMockMember({ id: '300000000000000002', username: 'alex_two', displayName: 'Alex' });
  const guild = createMockGuild([m1, m2]);
  const context = { targetCache: new Map() };

  const resolved = await MemberResolver.resolveMember(guild, 'Alex', context);
  assert.strictEqual(resolved.isAmbiguous, true);
  assert.strictEqual(resolved.candidateCount, 2);
  assert.ok(resolved.clarificationQuestion.includes('I found 2 members named Alex. Which one did you mean?'));
  assert.strictEqual(resolved.candidates.length, 2);
});

test('7. Member Resolver: Resolves exact snowflake ID and explicit mention with highest priority', async () => {
  const m1 = createMockMember({ id: '300000000000000001', username: 'alex_one', displayName: 'Alex' });
  const m2 = createMockMember({ id: '300000000000000002', username: 'alex_two', displayName: 'Alex' });
  const guild = createMockGuild([m1, m2]);
  const context = { targetCache: new Map() };

  // Explicit snowflake
  const resolvedSnowflake = await MemberResolver.resolveMember(guild, '300000000000000002', context);
  assert.strictEqual(resolvedSnowflake.id, '300000000000000002');

  // Explicit mention
  const resolvedMention = await MemberResolver.resolveMember(guild, '<@300000000000000001>', context);
  assert.strictEqual(resolvedMention.id, '300000000000000001');

  // Mention with exclamation mark (<@!id>)
  const resolvedExclMention = await MemberResolver.resolveMember(guild, '<@!300000000000000002>', context);
  assert.strictEqual(resolvedExclMention.id, '300000000000000002');
});

test('8. Member Resolver: Rejects cross-guild targets', async () => {
  const foreignGuild = { id: 'guild_foreign_99' };
  const foreignMember = createMockMember({ id: '400000000000000001', guild: foreignGuild });
  const currentGuild = createMockGuild([]);

  const resolved = await MemberResolver.resolveMember(currentGuild, foreignMember);
  assert.strictEqual(resolved, null, 'Must reject target belonging to a different guild');
});

test('9. Role Hierarchy: Prevents modifying member with higher or equal role than bot', async () => {
  const higherRole = { id: 'role_admin', name: 'Server Admin', position: 99 };
  const member = createMockMember({ id: '500000000000000001', highestRole: higherRole });
  const guild = createMockGuild([member]);
  const context = {
    invokingUser: { id: 'admin_1', tag: 'Admin#0001' },
    resolveTarget: async () => member
  };

  const res = await Operations.changeNickname(guild, 'admin_user', 'NewNick', context);
  assert.strictEqual(res.success, false);
  assert.ok(res.error.includes('higher than or equal to the bot'));
});

test('10. API Errors: Discord API errors report actual failure reason without false success', async () => {
  const member = createMockMember({
    id: '600000000000000001',
    rejectSetNickname: 'DiscordAPIError[50013]: Missing Permissions'
  });
  const guild = createMockGuild([member]);
  const context = {
    invokingUser: { id: 'admin_1', tag: 'Admin#0001' },
    resolveTarget: async () => member
  };

  await assert.rejects(async () => {
    await Operations.changeNickname(guild, 'alex', 'Night Owl', context);
  }, /Missing Permissions/);
});

test('11. Profile Inspection: Displays global username, server nickname, roles, and permissions correctly', async () => {
  const roleMod = { id: 'role_mod', name: 'Moderator', position: 20 };
  const member = createMockMember({
    id: '700000000000000001',
    username: 'alex_global',
    nickname: 'AlexServer',
    displayName: 'AlexServer',
    highestRole: roleMod,
    roles: [roleMod],
    permissions: [PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageMessages]
  });
  const guild = createMockGuild([member]);
  const context = {
    invokingUser: { id: 'admin_1', tag: 'Admin#0001' },
    resolveTarget: async () => member
  };

  const res = await Operations.lookupMember(guild, 'alex', context);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.verified, true);
  assert.ok(res.embed, 'Must produce a Discord Embed');
  assert.ok(res.details, 'Must produce structured text details');

  // Verify Identity breakdown
  assert.ok(res.details.includes('`alex_global`'), 'Displays global username');
  assert.ok(res.details.includes('"AlexServer"'), 'Displays server nickname');
  assert.ok(res.details.includes('`700000000000000001`'), 'Displays user ID');

  // Verify roles & permissions
  assert.ok(res.details.includes('@Moderator'), 'Displays assigned roles');
  assert.ok(res.details.includes('Moderate Members'), 'Calculates key permissions accurately');

  // Verify voice & presence truthfulness
  assert.ok(res.details.includes('Presence data unavailable'), 'Does not fabricate presence');
});

test('12. Profile Inspection: Retrieves recorded moderation history from ActionLedger', async () => {
  const member = createMockMember({ id: '800000000000000001', username: 'bad_actor' });
  const guild = createMockGuild([member]);
  const context = {
    invokingUser: { id: 'admin_1', tag: 'Admin#0001' },
    resolveTarget: async () => member,
    executionId: 'exec_prev_timeout'
  };

  // Record a timeout in ActionLedger
  ActionLedger.recordAction(guild.id, 'exec_prev_timeout', {
    type: 'member_timeout',
    action: 'timeout_member',
    targetMemberId: member.id,
    targetMemberTag: member.user.tag,
    reason: 'Spamming invite links in chat',
    timestamp: Date.now() - 3600000
  });

  const res = await Operations.lookupMember(guild, 'bad_actor', context);
  assert.strictEqual(res.success, true);
  assert.ok(res.details.includes('timeout member') || res.details.includes('member timeout'));
  assert.ok(res.details.includes('Spamming invite links in chat'));
});

test('13. Intent Router: Routes "Rename Alex to Night Owl" and "Remove Alex\'s server nickname" accurately', async () => {
  const router = new IntentRouter({ isAvailable: () => false });
  const mockContext = { invokingUser: { id: 'admin_1' } };

  // Nickname replacement
  const route1 = await router.route('Rename Alex to Night Owl', mockContext);
  assert.strictEqual(route1.intent, 'change_nickname');
  assert.strictEqual(route1.args.nickname, 'Night Owl');
  assert.strictEqual(route1.targetRef, 'Alex');

  // Nickname replacement with 's nickname to
  const route2 = await router.route("Change Alex's nickname to Night Owl", mockContext);
  assert.strictEqual(route2.intent, 'change_nickname');
  assert.strictEqual(route2.args.nickname, 'Night Owl');

  // Nickname removal
  const route3 = await router.route("Remove Alex's server nickname", mockContext);
  assert.strictEqual(route3.intent, 'remove_nickname');
  assert.strictEqual(route3.targetRef, 'Alex');

  // Nickname inspection (read-only)
  const route4 = await router.route("What is Alex's current nickname?", mockContext);
  assert.strictEqual(route4.intent, 'inspect_nickname');
  assert.strictEqual(route4.targetRef, 'Alex');

  // Profile lookup
  const route5 = await router.route('Inspect Alex\'s profile', mockContext);
  assert.strictEqual(route5.intent, 'lookup_member');
  assert.strictEqual(route5.targetRef, 'Alex');
});

test('14. Completeness Checker: Rejects ambiguous change request lacking replacement without wiping nickname', () => {
  const planWithoutNick = {
    actions: [{ action: 'change_nickname', targetMember: 'Alex' }]
  };
  const checkResult = CompletenessChecker.verify("Change Alex's nickname", planWithoutNick);
  assert.strictEqual(checkResult.valid, false);
  assert.ok(checkResult.errors.some(e => e.includes('No replacement nickname specified')));
});

test('15. Recovery Integration: Reverts nickname changes via /undo accurately', async () => {
  const member = createMockMember({ id: '900000000000000001', username: 'alex', nickname: 'Night Owl' });
  const guild = createMockGuild([member]);
  const execId = 'exec_undo_nick_test';

  const record = {
    actionId: 'act_nick_undo_1',
    type: 'nickname_change',
    action: 'change_nickname',
    targetMemberId: member.id,
    targetMemberTag: member.user.tag,
    oldNickname: 'OriginalAlex',
    newNickname: 'Night Owl',
    preState: { nickname: 'OriginalAlex' },
    postState: { nickname: 'Night Owl' },
    actor: { id: 'admin_1', tag: 'Admin#0001' },
    reversibility: 'reversible',
    status: 'succeeded',
    timestamp: Date.now()
  };

  ActionLedger.recordAction(guild.id, execId, record);

  const result = await RecoveryEngine.executeRecovery(guild, record, { id: 'admin_1', tag: 'Admin#0001' }, 'rec_exec_1');
  assert.strictEqual(result.success, true);
  assert.strictEqual(member.nickname, 'OriginalAlex');
});
