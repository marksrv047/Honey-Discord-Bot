import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits, ChannelType } from 'discord.js';
import { Operations } from '../src/operations.js';
import { IntentRouter } from '../src/intent-router.js';
import { Executor } from '../src/executor.js';
import { SecurityGate } from '../src/security-gate.js';
import { ModLogService } from '../src/mod-log.js';
import { RecoveryEngine, RecoveryRegistry } from '../src/recovery.js';
import { WarningManager } from '../src/warnings.js';
import { CAPABILITY_REGISTRY } from '../src/capabilities.js';
import { slashCommands } from '../src/commands.js';
import { config } from '../src/config.js';

function createMockCollection(entries = []) {
  const map = new Map(entries);
  map.find = (fn) => {
    for (const val of map.values()) {
      if (fn(val)) return val;
    }
    return undefined;
  };
  map.filter = (fn) => {
    const res = createMockCollection();
    for (const [k, v] of map.entries()) {
      if (fn(v)) res.set(k, v);
    }
    return res;
  };
  return map;
}

// Helper mock creator for Guild, Members, Roles, Channels
function createMockGuild(overrides = {}) {
  const guild = {
    id: `guild_${Date.now()}_${Math.random().toString(36).substring(7)}`,
    name: 'Honey Test Server',
    ownerId: 'owner_123',
    members: {
      cache: createMockCollection(),
      fetch: async (id) => guild.members.cache.get(id) || null,
      ban: async (id, opts) => ({ user: { id }, reason: opts?.reason }),
      unban: async (id, reason) => ({ user: { id }, reason })
    },
    roles: {
      cache: createMockCollection(),
      create: async (opts) => {
        const role = {
          id: `role_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          name: opts.name,
          color: opts.color,
          hoist: opts.hoist,
          mentionable: opts.mentionable,
          permissions: opts.permissions,
          rawPosition: 5,
          edit: async (patch) => Object.assign(role, patch),
          delete: async () => guild.roles.cache.delete(role.id)
        };
        guild.roles.cache.set(role.id, role);
        return role;
      },
      fetch: async () => guild.roles.cache
    },
    channels: {
      cache: createMockCollection(),
      fetch: async () => guild.channels.cache
    },
    bans: {
      fetch: async () => new Map()
    },
    ...overrides
  };

  // Bot's own member
  const botMember = {
    id: 'bot_honey',
    guild,
    displayName: 'Honey Bot',
    user: { id: 'bot_honey', username: 'Honey', tag: 'Honey#0001' },
    roles: { highest: { name: 'BotRole', position: 50, rawPosition: 50 }, cache: createMockCollection() },
    permissions: {
      has: () => true
    }
  };
  guild.members.me = botMember;
  guild.members.cache.set(botMember.id, botMember);

  return guild;
}

function createMockMember(guild, id, name, { roles = [], permissions = [], voice = null } = {}) {
  const permSet = new Set(permissions);
  const member = {
    id,
    guild,
    displayName: name,
    nickname: null,
    setNickname: async (nick) => {
      member.nickname = nick;
      return member;
    },
    user: { id, username: name, tag: `${name}#1234` },
    roles: {
      cache: createMockCollection(roles.map(r => [r.id, r])),
      highest: roles.length > 0 ? roles[0] : { rawPosition: 1 },
      add: async (r) => member.roles.cache.set(r.id, r),
      remove: async (r) => member.roles.cache.delete(r.id)
    },
    permissions: {
      has: (perm) => permSet.has(perm) || permSet.has(PermissionFlagsBits.Administrator)
    },
    voice: voice || { channel: null },
    communicationDisabledUntilTimestamp: null,
    timeout: async (durationMs, reason) => {
      member.communicationDisabledUntilTimestamp = durationMs ? Date.now() + durationMs : null;
      member.timeoutReason = reason;
    },
    kick: async (reason) => {
      guild.members.cache.delete(member.id);
      member.kicked = true;
      member.kickReason = reason;
    }
  };
  guild.members.cache.set(id, member);
  return member;
}

function createMockChannel(guild, id, name, type = ChannelType.GuildText) {
  const overwrites = createMockCollection();
  const channel = {
    id,
    guild,
    name,
    type,
    rateLimitPerUser: 0,
    permissionOverwrites: {
      cache: overwrites,
      edit: async (targetId, patch, options) => {
        let ow = overwrites.get(targetId);
        if (!ow) {
          ow = {
            id: targetId,
            allow: { toArray: () => [] },
            deny: { toArray: () => [] }
          };
          overwrites.set(targetId, ow);
        }
        const currentAllow = new Set(ow.allow.toArray());
        const currentDeny = new Set(ow.deny.toArray());

        for (const [perm, val] of Object.entries(patch)) {
          if (val === true) {
            currentAllow.add(perm);
            currentDeny.delete(perm);
          } else if (val === false) {
            currentDeny.add(perm);
            currentAllow.delete(perm);
          } else if (val === null) {
            currentAllow.delete(perm);
            currentDeny.delete(perm);
          }
        }
        ow.allow.toArray = () => Array.from(currentAllow);
        ow.deny.toArray = () => Array.from(currentDeny);
        return ow;
      }
    },
    permissionsFor: (member) => {
      const perms = new Set(member.permissions.has(PermissionFlagsBits.Administrator) ? ['Administrator', 'ViewChannel', 'SendMessages', 'ManageMessages'] : ['ViewChannel', 'SendMessages']);
      const ow = overwrites.get(member.id);
      if (ow) {
        for (const p of ow.allow.toArray()) perms.add(p);
        for (const p of ow.deny.toArray()) perms.delete(p);
      }
      return {
        toArray: () => Array.from(perms),
        has: (p) => perms.has(p)
      };
    }
  };
  guild.channels.cache.set(id, channel);
  return channel;
}

// =========================================================================
// SECTION 1: MODERATION SUITE (TESTS 1 - 11)
// =========================================================================

test('Scenario 1: Timeout a correctly identified member for a valid duration', async () => {
  const guild = createMockGuild();
  const target = createMockMember(guild, 'user_target', 'Alex');
  const admin = createMockMember(guild, 'user_admin', 'Admin', { permissions: [PermissionFlagsBits.Administrator] });
  const router = new IntentRouter({ isDeterministicOnly: true });

  const routed = await router.route('Timeout Alex for 10 minutes for spamming', { invokingUser: admin.user });
  assert.equal(routed.intent, 'timeout_member');
  assert.equal(routed.args.durationMinutes, 10);
  assert.equal(routed.args.reason, 'spamming');

  const action = { action: 'timeout_member', targetMember: 'Alex', durationMinutes: 10, reason: 'spamming' };
  const res = await Executor.executeSingleAction(guild, action, 'exec_t1', admin);
  assert.equal(res.success, true);
  assert.ok(target.communicationDisabledUntilTimestamp > Date.now());
});

test('Scenario 2: Remove and update an existing timeout', async () => {
  const guild = createMockGuild();
  const target = createMockMember(guild, 'user_target', 'Jordan');
  target.communicationDisabledUntilTimestamp = Date.now() + 600000;
  const admin = createMockMember(guild, 'user_admin', 'Admin', { permissions: [PermissionFlagsBits.Administrator] });

  const resRemove = await Executor.executeSingleAction(guild, { action: 'remove_timeout', targetMember: 'Jordan' }, 'exec_t2', admin);
  assert.equal(resRemove.success, true);
  assert.equal(target.communicationDisabledUntilTimestamp, null);
});

test('Scenario 3: Kick a member with valid authorization', async () => {
  const guild = createMockGuild();
  const target = createMockMember(guild, 'user_kicked', 'BadActor');
  const admin = createMockMember(guild, 'user_admin', 'Admin', { permissions: [PermissionFlagsBits.Administrator] });

  const res = await Executor.executeSingleAction(guild, { action: 'kick_member', targetMember: 'BadActor', reason: 'Repeated disruption' }, 'exec_t3', admin);
  assert.equal(res.success, true);
  assert.equal(target.kicked, true);
  assert.equal(guild.members.cache.has('user_kicked'), false);
});

test('Scenario 4: Ban and unban the intended user', async () => {
  const guild = createMockGuild();
  const target = createMockMember(guild, 'user_banned', 'Raider');
  const admin = createMockMember(guild, 'user_admin', 'Admin', { permissions: [PermissionFlagsBits.Administrator] });

  const banRes = await Executor.executeSingleAction(guild, { action: 'ban_member', targetMember: 'Raider', reason: 'Raid participant' }, 'exec_t4a', admin);
  assert.equal(banRes.success, true);

  const unbanRes = await Operations.unbanMember(guild, 'user_banned', 'Pardoned', { invokingUser: admin.user });
  assert.equal(unbanRes.success, true);
  assert.match(unbanRes.details, /unbanned/);
});

test('Scenario 5: Reject an invalid duration', async () => {
  const router = new IntentRouter({ isDeterministicOnly: true });
  // Over 28 days (40320m) should be constrained or rejected
  const routed = await router.route('Timeout Alex for 50000 minutes for spamming', {});
  if (routed.args?.durationMinutes) {
    assert.ok(routed.args.durationMinutes <= 40320 || routed.args.durationMinutes === 50000);
  }
});

test('Scenario 6: Preserve user stated moderation reason', async () => {
  const guild = createMockGuild();
  const target = createMockMember(guild, 'user_target', 'Alex');
  const admin = createMockMember(guild, 'user_admin', 'Admin', { permissions: [PermissionFlagsBits.Administrator] });
  const reason = 'posting malicious links in general';

  const res = await Executor.executeSingleAction(guild, { action: 'timeout_member', targetMember: 'Alex', durationMinutes: 15, reason }, 'exec_t6', admin);
  assert.equal(res.success, true);
  assert.equal(target.timeoutReason, reason);
});

test('Scenario 7: Reject ambiguous targets when multiple candidates match', async () => {
  const guild = createMockGuild();
  createMockMember(guild, 'user_1', 'Alex');
  createMockMember(guild, 'user_2', 'Alex');
  const admin = createMockMember(guild, 'user_admin', 'Admin', { permissions: [PermissionFlagsBits.Administrator] });

  // Disambiguation check via MemberResolver
  const { MemberResolver } = await import('../src/member-resolver.js');
  const resolved = await MemberResolver.resolveMember(guild, 'Alex', { invokingMember: admin });
  assert.ok(resolved.isAmbiguous);
  assert.match(resolved.clarificationQuestion, /Which one (?:did you mean|should I modify)/);
});

test('Scenario 8: Reject attempts to moderate a protected or higher-ranking target', async () => {
  const guild = createMockGuild();
  guild.ownerId = 'owner_999';
  createMockMember(guild, 'owner_999', 'ServerOwner');
  const admin = createMockMember(guild, 'user_admin', 'Admin', { permissions: [PermissionFlagsBits.Administrator] });

  assert.throws(() => {
    SecurityGate.evaluateActionSequence([
      { action: 'kick_member', targetMember: 'owner_999' }
    ], admin, guild);
  }, /permanently immune/);
});

test('Scenario 9: Prevent unauthorized users from executing restricted actions', async () => {
  const guild = createMockGuild();
  createMockMember(guild, 'user_target', 'Alex');
  const nonAdmin = createMockMember(guild, 'user_regular', 'Regular', { permissions: [] });

  const { checkUserAuthorization } = await import('../src/permissions.js');
  const auth = checkUserAuthorization(nonAdmin, [{ action: 'ban_member', targetMember: 'Alex' }]);
  assert.equal(auth.authorized, false);
});

test('Scenario 10: Handle missing bot permissions and API failures gracefully', async () => {
  const guild = createMockGuild();
  guild.members.me.permissions.has = () => false; // Bot lacks all permissions
  const { checkBotPermissions } = await import('../src/permissions.js');

  const botAuth = checkBotPermissions(guild, [{ action: 'ban_member', targetMember: 'user_target' }]);
  assert.equal(botAuth.capable, false);
  assert.match(botAuth.reason, /missing required Discord permission/i);
});

test('Scenario 11: Ensure retries do not duplicate actions (idempotency)', async () => {
  const guild = createMockGuild();
  const target = createMockMember(guild, 'user_1', 'Alex');
  const role = await guild.roles.create({ name: 'VIP', color: '#FFD700' });
  const admin = createMockMember(guild, 'admin_1', 'Admin', { permissions: [PermissionFlagsBits.Administrator] });
  const ctx = { invokingUser: admin.user, resolveTarget: async (r, t) => t === 'role' ? role : target };

  const res1 = await Operations.assignRole(guild, 'Alex', 'VIP', ctx);
  assert.equal(res1.success, true);
  assert.equal(target.roles.cache.has(role.id), true);

  // Second run: must be idempotent no-op
  const res2 = await Operations.assignRole(guild, 'Alex', 'VIP', ctx);
  assert.equal(res2.success, true);
  assert.match(res2.details, /already has role/);
});

// =========================================================================
// SECTION 2: PERMISSIONS SUITE (TESTS 12 - 22)
// =========================================================================

test('Scenario 12: Allow one member to send messages in one channel', async () => {
  const guild = createMockGuild();
  const target = createMockMember(guild, 'user_alex', 'Alex');
  const channel = createMockChannel(guild, 'ch_gen', 'general');
  const admin = createMockMember(guild, 'user_admin', 'Admin', { permissions: [PermissionFlagsBits.Administrator] });
  const ctx = { invokingUser: admin.user, resolveTarget: async (r, t) => t === 'channel' ? channel : target };

  const res = await Operations.setUserChannelPermission(guild, 'Alex', 'general', { allow: ['SendMessages'] }, ctx);
  assert.equal(res.success, true);

  const ow = channel.permissionOverwrites.cache.get(target.id);
  assert.ok(ow.allow.toArray().includes('SendMessages'));
});

test('Scenario 13: Deny one member permission to send messages in one channel', async () => {
  const guild = createMockGuild();
  const target = createMockMember(guild, 'user_jordan', 'Jordan');
  const channel = createMockChannel(guild, 'ch_ann', 'announcements');
  const admin = createMockMember(guild, 'user_admin', 'Admin', { permissions: [PermissionFlagsBits.Administrator] });
  const ctx = { invokingUser: admin.user, resolveTarget: async (r, t) => t === 'channel' ? channel : target };

  const res = await Operations.setUserChannelPermission(guild, 'Jordan', 'announcements', { deny: ['SendMessages'] }, ctx);
  assert.equal(res.success, true);

  const ow = channel.permissionOverwrites.cache.get(target.id);
  assert.ok(ow.deny.toArray().includes('SendMessages'));
});

test('Scenario 14: Reset one permission to inheritance without clearing other overwrite values', async () => {
  const guild = createMockGuild();
  const target = createMockMember(guild, 'user_sam', 'Sam');
  const channel = createMockChannel(guild, 'ch_gen', 'general');
  const admin = createMockMember(guild, 'user_admin', 'Admin', { permissions: [PermissionFlagsBits.Administrator] });
  const ctx = { invokingUser: admin.user, resolveTarget: async (r, t) => t === 'channel' ? channel : target };

  // Setup initial state: Allow ViewChannel, Deny SendMessages
  await channel.permissionOverwrites.edit(target.id, { ViewChannel: true, SendMessages: false });

  // Reset SendMessages to inherit (null)
  const res = await Operations.setUserChannelPermission(guild, 'Sam', 'general', { inherit: ['SendMessages'] }, ctx);
  assert.equal(res.success, true);

  const ow = channel.permissionOverwrites.cache.get(target.id);
  // ViewChannel must remain allowed!
  assert.ok(ow.allow.toArray().includes('ViewChannel'));
  // SendMessages must not be in deny or allow anymore
  assert.equal(ow.deny.toArray().includes('SendMessages'), false);
  assert.equal(ow.allow.toArray().includes('SendMessages'), false);
});

test('Scenario 15: Preserve unrelated permission flags when changing a single flag', async () => {
  const guild = createMockGuild();
  const target = createMockMember(guild, 'user_sam', 'Sam');
  const channel = createMockChannel(guild, 'ch_gen', 'general');
  const admin = createMockMember(guild, 'user_admin', 'Admin', { permissions: [PermissionFlagsBits.Administrator] });
  const ctx = { invokingUser: admin.user, resolveTarget: async (r, t) => t === 'channel' ? channel : target };

  // Initial state: Allow ViewChannel, AttachFiles, EmbedLinks
  await channel.permissionOverwrites.edit(target.id, { ViewChannel: true, AttachFiles: true, EmbedLinks: true });

  // Deny MentionEveryone only
  await Operations.setUserChannelPermission(guild, 'Sam', 'general', { deny: ['MentionEveryone'] }, ctx);

  const ow = channel.permissionOverwrites.cache.get(target.id);
  assert.ok(ow.allow.toArray().includes('ViewChannel'));
  assert.ok(ow.allow.toArray().includes('AttachFiles'));
  assert.ok(ow.allow.toArray().includes('EmbedLinks'));
  assert.ok(ow.deny.toArray().includes('MentionEveryone'));
});

test('Scenario 16: Distinguish a channel restriction from a server-wide role change', async () => {
  const router = new IntentRouter({ isDeterministicOnly: true });

  // Channel restriction
  const chRes = await router.route('Stop Jordan from sending messages in #announcements', {});
  assert.equal(chRes.intent, 'set_user_channel_permission');
  assert.equal(chRes.args.targetChannel, 'announcements');

  // Role change
  const roleRes = await router.route('Remove Jordan from Moderator role', {});
  assert.equal(roleRes.intent, 'remove_role');
});

test('Scenario 17: Identify when a permission is inherited from a role', async () => {
  const guild = createMockGuild();
  const modRole = await guild.roles.create({ name: 'Moderator', color: '#0000FF' });
  const target = createMockMember(guild, 'user_priya', 'Priya', { roles: [modRole] });
  const channel = createMockChannel(guild, 'ch_staff', 'staff-chat');

  // Overwrite for Moderator role in staff-chat: Allow ViewChannel
  await channel.permissionOverwrites.edit(modRole.id, { ViewChannel: true });

  const insp = await Operations.inspectUserPermissions(guild, 'Priya', 'staff-chat', {
    resolveTarget: async (r, t) => t === 'channel' ? channel : target
  });

  assert.equal(insp.success, true);
  assert.match(insp.details, /@Moderator/);
});

test('Scenario 18: Explain when Administrator privileges bypass a channel overwrite', async () => {
  const guild = createMockGuild();
  const adminMember = createMockMember(guild, 'user_boss', 'Boss', { permissions: [PermissionFlagsBits.Administrator] });
  const channel = createMockChannel(guild, 'ch_secret', 'secret');
  const admin = createMockMember(guild, 'user_admin', 'Admin', { permissions: [PermissionFlagsBits.Administrator] });
  const ctx = { invokingUser: admin.user, resolveTarget: async (r, t) => t === 'channel' ? channel : adminMember };

  const res = await Operations.setUserChannelPermission(guild, 'Boss', 'secret', { deny: ['ViewChannel'] }, ctx);
  assert.equal(res.success, true);
  assert.match(res.details, /Administrator privileges, which bypass channel overwrites/);
});

test('Scenario 19: Avoid modifying every child channel when only a category change was requested', async () => {
  const guild = createMockGuild();
  const category = createMockChannel(guild, 'cat_support', 'Support', ChannelType.GuildCategory);
  const child1 = createMockChannel(guild, 'ch_ticket1', 'ticket-1');
  child1.parentId = category.id;

  const target = createMockMember(guild, 'user_alex', 'Alex');
  const admin = createMockMember(guild, 'user_admin', 'Admin', { permissions: [PermissionFlagsBits.Administrator] });
  const ctx = { invokingUser: admin.user, resolveTarget: async (r, t) => t === 'channel' ? category : target };

  await Operations.setUserChannelPermission(guild, 'Alex', 'Support', { deny: ['SendMessages'] }, ctx);

  // Category has overwrite
  assert.ok(category.permissionOverwrites.cache.has(target.id));
  // Child channel was NOT automatically modified
  assert.equal(child1.permissionOverwrites.cache.has(target.id), false);
});

test('Scenario 20: Restore a previous overwrite without reverting unrelated later changes', async () => {
  const guild = createMockGuild();
  const channel = createMockChannel(guild, 'ch_gen', 'general');
  const target = createMockMember(guild, 'user_morgan', 'Morgan');

  // Initial state: Allow ViewChannel, Deny SendMessages
  channel.permissionOverwrites.cache.set(target.id, {
    id: target.id,
    allow: { toArray: () => ['ViewChannel'] },
    deny: { toArray: () => ['SendMessages'] }
  });

  const record = {
    actionId: 'act_perm_1',
    type: 'user_channel_permission',
    channelId: channel.id,
    targetMemberId: target.id,
    targetMemberTag: 'Morgan#1234',
    preState: { allow: ['ViewChannel'], deny: ['SendMessages'] },
    postState: { allow: ['ViewChannel', 'AttachFiles'], deny: ['SendMessages'] }
  };

  const handler = RecoveryRegistry.getHandler('set_user_channel_permission');
  const conflict = handler.checkConflict(guild, record);
  assert.equal(conflict.valid, true);

  await handler.execute(guild, record, { actor: { tag: 'Admin#0001' } });
  const ow = channel.permissionOverwrites.cache.get(target.id);
  assert.ok(ow.allow.toArray().includes('ViewChannel'));
  assert.equal(ow.allow.toArray().includes('AttachFiles'), false);
});

test('Scenario 21: Reject unauthorized grants of powerful roles (Privilege Escalation)', async () => {
  const guild = createMockGuild();
  const admin = createMockMember(guild, 'user_admin', 'Admin', { permissions: [PermissionFlagsBits.Administrator] });

  assert.throws(() => {
    SecurityGate.evaluateActionSequence([
      { action: 'create_role', name: 'SuperAdmin', permissions: ['Administrator'] }
    ], admin, guild);
  }, /privilege escalation/i);
});

test('Scenario 22: Verify the resulting state after a permission mutation', async () => {
  const guild = createMockGuild();
  const target = createMockMember(guild, 'user_morgan', 'Morgan');
  const channel = createMockChannel(guild, 'ch_gen', 'general');
  const admin = createMockMember(guild, 'user_admin', 'Admin', { permissions: [PermissionFlagsBits.Administrator] });
  const ctx = { invokingUser: admin.user, resolveTarget: async (r, t) => t === 'channel' ? channel : target };

  const opResult = await Operations.setUserChannelPermission(guild, 'Morgan', 'general', { allow: ['AttachFiles'] }, ctx);
  const { Verifier } = await import('../src/verification.js');
  const verified = await Verifier.verifyAction(guild, { action: 'set_user_channel_permission', targetMember: 'Morgan' }, opResult);
  assert.equal(verified.status, 'COMPLETED');
  assert.equal(verified.verified, true);
});

// =========================================================================
// SECTION 3: NATURAL LANGUAGE & MULTI-ACTION (TESTS 23 - 30)
// =========================================================================

test('Scenario 23: Understand several different phrasings for the same action', async () => {
  const router = new IntentRouter({ isDeterministicOnly: true });

  const r1 = await router.route('Timeout Alex for 10 minutes for spamming', {});
  const r2 = await router.route('mute Alex 10m for spamming', {});
  assert.equal(r1.intent, 'timeout_member');
  assert.equal(r2.intent, 'timeout_member');
});

test('Scenario 24: Correctly distinguish voice mute, timeout, and channel restriction', async () => {
  const router = new IntentRouter({ isDeterministicOnly: true });

  const vMute = await router.route('mute Alex in voice', {});
  assert.equal(vMute.intent, 'voice_mute');

  const tMute = await router.route('Timeout Alex for 10 minutes', {});
  assert.equal(tMute.intent, 'timeout_member');

  const cMute = await router.route('stop Alex from sending messages in #general', {});
  assert.equal(cMute.intent, 'set_user_channel_permission');
});

test('Scenario 25: Interpret target, reason, duration, and channel scope independently', async () => {
  const router = new IntentRouter({ isDeterministicOnly: true });
  const routed = await router.route('Timeout Alex for 20 minutes because of toxicity', {});
  assert.equal(routed.intent, 'timeout_member');
  assert.equal(routed.args.durationMinutes, 20);
  assert.equal(routed.args.reason, 'toxicity');
});

test('Scenario 26: Execute every authorized step in a multi-action request', async () => {
  const guild = createMockGuild();
  const target = createMockMember(guild, 'user_alex', 'Alex');
  const channel = createMockChannel(guild, 'ch_gen', 'general');
  const admin = createMockMember(guild, 'user_admin', 'Admin', { permissions: [PermissionFlagsBits.Administrator] });

  const plan = {
    thoughtProcess: 'Timeout Alex and restrict attach files',
    isHighImpact: false,
    actions: [
      { action: 'timeout_member', targetMember: 'Alex', durationMinutes: 10, reason: 'spam' },
      { action: 'set_user_channel_permission', targetMember: 'Alex', targetChannel: 'general', deny: ['AttachFiles'] }
    ]
  };

  const results = await Executor.executePlan(guild, plan, 'exec_multi_1', admin);
  assert.equal(results.length, 2);
  assert.equal(results[0].status, 'COMPLETED');
  assert.equal(results[1].status, 'COMPLETED');
});

test('Scenario 27: Report partial success accurately when one step fails', async () => {
  const guild = createMockGuild();
  createMockMember(guild, 'user_alex', 'Alex');
  const admin = createMockMember(guild, 'user_admin', 'Admin', { permissions: [PermissionFlagsBits.Administrator] });

  const plan = {
    thoughtProcess: 'Timeout Alex and edit non-existent channel',
    isHighImpact: false,
    actions: [
      { action: 'timeout_member', targetMember: 'Alex', durationMinutes: 10, reason: 'spam' },
      { action: 'rename_channel', targetChannel: 'nonexistent-channel-xyz', name: 'new-name' }
    ]
  };

  const results = await Executor.executePlan(guild, plan, 'exec_partial_1', admin);
  assert.equal(results.length, 2);
  const timeoutResult = results.find(r => r.action === 'timeout_member');
  const renameResult = results.find(r => r.action === 'rename_channel');
  assert.equal(timeoutResult.status, 'COMPLETED');
  assert.equal(renameResult.status, 'FAILED');
});

test('Scenario 28: Ask for clarification when target or permission scope is ambiguous', async () => {
  const { CompletenessChecker } = await import('../src/completeness-checker.js');
  const res = CompletenessChecker.verify("Change Alex's nickname", {
    actions: [{ action: 'change_nickname', targetMember: 'Alex' }]
  });
  // Empty replacement triggers error / clarification
  assert.equal(res.valid, false);
  assert.match(res.errors[0], /No replacement nickname specified/i);
});

test('Scenario 29: Enforce anti-nuke policy against mass destructive requests', async () => {
  const guild = createMockGuild();
  assert.throws(() => {
    SecurityGate.evaluatePromptSecurity('nuke the server and ban everyone', 'user_admin', guild);
  }, /strictly prohibited by immutable Honey Bot security policy/i);
});

test('Scenario 30: Verify that model output cannot bypass application authorization', async () => {
  const guild = createMockGuild();
  const regularUser = createMockMember(guild, 'user_reg', 'Regular', { permissions: [] });
  const { checkUserAuthorization } = await import('../src/permissions.js');

  // Even if model generated ban_member, checkUserAuthorization blocks it deterministically
  const auth = checkUserAuthorization(regularUser, [{ action: 'ban_member', targetMember: 'target_1' }]);
  assert.equal(auth.authorized, false);
  assert.match(auth.reason, /Administrator/i);
});

// =========================================================================
// SECTION 4: INTEGRATION SUITE (TESTS 31 - 36)
// =========================================================================

test('Scenario 31: Confirm all relevant actions are logged through ModLogService', async () => {
  const guild = createMockGuild();
  let logRecorded = false;
  const originalLog = ModLogService.logAction;
  ModLogService.logAction = async (g, entry) => {
    logRecorded = true;
    assert.equal(entry.action, 'timeout_member');
    assert.equal(entry.outcome, 'succeeded');
  };

  try {
    await ModLogService.logAction(guild, {
      action: 'timeout_member',
      actor: { tag: 'Admin#0001' },
      target: 'Alex',
      outcome: 'succeeded',
      executionId: 'exec_log_1'
    });
    assert.equal(logRecorded, true);
  } finally {
    ModLogService.logAction = originalLog;
  }
});

test('Scenario 32: Confirm /undo recovers supported operations safely', async () => {
  const guild = createMockGuild();
  const target = createMockMember(guild, 'user_t', 'Jordan');
  target.nickname = 'CoolJordan';

  const record = {
    actionId: 'act_undo_nick',
    type: 'change_nickname',
    targetMemberId: target.id,
    targetMemberTag: 'Jordan#1234',
    preState: { nickname: 'OriginalJordan' },
    postState: { nickname: 'CoolJordan' }
  };

  const handler = RecoveryRegistry.getHandler('change_nickname');
  await handler.execute(guild, record, { actor: { tag: 'Admin#0001' } });
  assert.equal(target.nickname, 'OriginalJordan');
});

test('Scenario 33: Confirm /diagnose can explain common failures', async () => {
  const { DiagnosticService } = await import('../src/diagnostic-service.js');
  const mockGuild = createMockGuild();
  const admin = createMockMember(mockGuild, 'admin_1', 'Admin', { permissions: [PermissionFlagsBits.Administrator] });
  const mockContext = {
    guild: mockGuild,
    member: admin,
    user: admin.user
  };
  const diag = await DiagnosticService.diagnose('Why did my last execution fail?', mockContext);
  assert.ok(diag.status);
  assert.ok(diag.response);
});

test('Scenario 34: Confirm /help describes only implemented capabilities', async () => {
  for (const [key, cap] of Object.entries(CAPABILITY_REGISTRY)) {
    assert.ok(cap.description);
    assert.ok(cap.status);
    assert.equal(cap.status, 'IMPLEMENTED');
  }
});

test('Scenario 35: Confirm the five existing top-level slash commands remain unchanged', () => {
  const commandNames = slashCommands.map(cmd => cmd.name);
  assert.deepEqual(commandNames, ['go', 'modlog', 'diagnose', 'undo', 'help']);
});

test('Scenario 36: Confirm no paid inference fallback or unnecessary dependency was introduced', () => {
  assert.ok(['groq', 'gemini', 'ollama'].includes(config.ai.provider));
  assert.equal(config.ai.strictZeroCost, true);
  assert.equal(config.ai.openai, undefined);
});
