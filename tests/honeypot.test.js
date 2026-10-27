import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PermissionFlagsBits, ChannelType } from 'discord.js';
import { HoneypotService } from '../src/honeypot-service.js';
import { handleHoneypotCommand, slashCommands } from '../src/commands.js';
import { ModLogService } from '../src/mod-log.js';
import { Operations } from '../src/operations.js';
import { IntentRouter } from '../src/intent-router.js';
import { DiagnosticService, DiagnosticStatus } from '../src/diagnostic-service.js';

// Setup temporary isolated config storage for tests
const tempDir = path.join(os.tmpdir(), `honey-honeypot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
fs.mkdirSync(tempDir, { recursive: true });
const tempStorage = path.join(tempDir, 'honeypot-config.json');

// Helper to create mock collection
function createMockCollection(entries = []) {
  const map = new Map(entries);
  map.find = (fn) => {
    for (const val of map.values()) {
      if (fn(val)) return val;
    }
    return undefined;
  };
  map.some = (fn) => {
    for (const val of map.values()) {
      if (fn(val)) return true;
    }
    return false;
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

// Helper to create mock guild
function createMockGuild(overrides = {}) {
  const guildId = overrides.id || `guild_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const channels = createMockCollection();
  const roles = createMockCollection();
  const members = createMockCollection();

  const botRole = { id: 'role_bot_high', name: 'Honey Bot', position: 50 };
  const memberRole = { id: 'role_member', name: 'Member', position: 10 };
  const adminRole = { id: 'role_admin', name: 'Admin', position: 90 };
  roles.set(botRole.id, botRole);
  roles.set(memberRole.id, memberRole);
  roles.set(adminRole.id, adminRole);

  const botMember = {
    id: 'bot_honey',
    user: { id: 'bot_honey', tag: 'HoneyBot#0001', bot: true },
    permissions: {
      has: (perm) => {
        if (overrides.botMissingKick && perm === PermissionFlagsBits.KickMembers) return false;
        return true;
      }
    },
    roles: {
      highest: botRole,
      cache: createMockCollection([[botRole.id, botRole]])
    }
  };

  const guild = {
    id: guildId,
    name: overrides.name || 'Test Guild',
    ownerId: overrides.ownerId || 'owner_123',
    members: {
      cache: members,
      me: botMember,
      fetch: async (id) => members.get(id) || null
    },
    roles: {
      cache: roles,
      everyone: { id: guildId, name: '@everyone' }
    },
    channels: {
      cache: channels,
      create: async (opts) => {
        const chan = {
          id: `ch_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name: opts.name,
          type: opts.type || ChannelType.GuildText,
          topic: opts.topic || null,
          permissionOverwrites: opts.permissionOverwrites || [],
          permissionsFor: (member) => ({
            has: (perm) => {
              if (overrides.channelMissingManage && perm === PermissionFlagsBits.ManageMessages) return false;
              return true;
            }
          }),
          send: async (payload) => ({
            id: `msg_sent_${Date.now()}`,
            content: typeof payload === 'string' ? payload : payload.content,
            delete: async () => {}
          }),
          messages: {
            fetch: async () => new Map()
          }
        };
        channels.set(chan.id, chan);
        return chan;
      }
    }
  };

  return guild;
}

// Helper to create mock member
function createMockMember(guild, { id, tag, roles = [], kickable = true, isOwner = false }) {
  const memberRoles = createMockCollection();
  for (const r of roles) {
    memberRoles.set(r.id, r);
  }
  const highestRole = roles.reduce((highest, curr) => (!highest || curr.position > highest.position ? curr : highest), null) || { id: 'r_none', position: 1 };

  let kicked = false;
  let kickReason = null;

  const member = {
    id,
    user: { id, tag: tag || `${id}#0001`, bot: false },
    guild,
    kickable,
    roles: {
      cache: memberRoles,
      highest: highestRole,
      some: (fn) => Array.from(memberRoles.values()).some(fn)
    },
    permissions: {
      has: (perm) => isOwner || memberRoles.has('role_admin')
    },
    kick: async (reason) => {
      kicked = true;
      kickReason = reason;
      return member;
    },
    get isKicked() {
      return kicked;
    },
    get lastKickReason() {
      return kickReason;
    }
  };

  guild.members.cache.set(id, member);
  return member;
}

// Point HoneypotService to clean temporary storage
HoneypotService.storagePath = tempStorage;

test('Honeypot Suite Setup', () => {
  assert.ok(fs.existsSync(tempDir));
  assert.equal(HoneypotService.storagePath, tempStorage);
});

// ============================================================================
// 1. Fresh honeypot setup
// ============================================================================
test('1. Fresh honeypot setup: returns default inactive template', () => {
  const guild = createMockGuild({ id: 'guild_fresh_1' });
  const config = HoneypotService.getConfig(guild.id);

  assert.equal(config.guildId, guild.id);
  assert.equal(config.enabled, false);
  assert.equal(config.strictMode, false);
  assert.equal(config.channelId, null);
  assert.deepEqual(config.exemptRoleIds, []);
  assert.deepEqual(config.exemptUserIds, []);
  assert.deepEqual(config.recentEvents, []);
});

// ============================================================================
// 2. Successful channel creation and configuration persistence
// ============================================================================
test('2. Successful channel creation and configuration persistence', async () => {
  const guild = createMockGuild({ id: 'guild_create_2' });
  const setupRes = await HoneypotService.setupHoneypot(guild, { createChannel: true, channelName: 'security-honeypot' });

  assert.equal(setupRes.success, true);
  assert.ok(setupRes.channel);
  assert.equal(setupRes.channel.name, 'security-honeypot');
  assert.ok(setupRes.channel.topic.includes('Honeypot'));

  const savedConfig = HoneypotService.getConfig(guild.id);
  assert.equal(savedConfig.channelId, setupRes.channel.id);
  assert.equal(savedConfig.channelName, 'security-honeypot');
});

// ============================================================================
// 3. Strict-mode confirmation and activation
// ============================================================================
test('3. Strict-mode confirmation and activation requires explicit consent', async () => {
  const guild = createMockGuild({ id: 'guild_strict_3' });
  const chan = await guild.channels.create({ name: 'honeypot-test' });
  await HoneypotService.setupHoneypot(guild, { channelId: chan.id, strictMode: true });

  // Enabling without confirmedUser should return requiresConfirmation
  const unconfirmedEnable = await HoneypotService.enableHoneypot(guild, null);
  assert.equal(unconfirmedEnable.success, false);
  assert.equal(unconfirmedEnable.requiresConfirmation, true);
  assert.ok(unconfirmedEnable.error.includes('STRICT HONEYPOT ENFORCEMENT'));

  // Enabling with confirmedUser activates strict mode
  const confirmedUser = { id: 'admin_user', tag: 'Admin#0001' };
  const confirmedEnable = await HoneypotService.enableHoneypot(guild, confirmedUser);
  assert.equal(confirmedEnable.success, true);
  assert.equal(confirmedEnable.config.enabled, true);
  assert.equal(confirmedEnable.config.strictMode, true);
  assert.ok(confirmedEnable.config.strictConfirmedAt > 0);
  assert.equal(confirmedEnable.config.strictConfirmedBy, 'Admin#0001');
});

// ============================================================================
// 4. Normal member posting in honeypot (monitored mode)
// ============================================================================
test('4. Normal member posting in monitored honeypot: message warned, member not kicked', async () => {
  const guild = createMockGuild({ id: 'guild_monitored_4' });
  const chan = await guild.channels.create({ name: 'honeypot-ch' });
  await HoneypotService.setupHoneypot(guild, { channelId: chan.id, strictMode: false, enable: true });

  const member = createMockMember(guild, { id: 'user_regular_4', tag: 'Regular#1234' });

  let deleted = false;
  const mockMessage = {
    id: 'msg_monitored_4',
    content: 'Just checking out this channel!',
    channel: chan,
    guild,
    author: member.user,
    member,
    delete: async () => { deleted = true; }
  };

  const handled = await HoneypotService.handleMessage(mockMessage, guild.client);
  assert.equal(handled, true);
  assert.equal(member.isKicked, false, 'Member must NOT be kicked for harmless message in monitored mode');

  const config = HoneypotService.getConfig(guild.id);
  assert.equal(config.recentEvents.length, 1);
  assert.equal(config.recentEvents[0].action, 'warn');
  assert.equal(config.recentEvents[0].mode, 'monitored');
});

// ============================================================================
// 5. Member posting harmless message in strict mode (verified kicked)
// ============================================================================
test('5. Member posting harmless message in strict mode is immediately kicked', async () => {
  const guild = createMockGuild({ id: 'guild_strict_5' });
  const chan = await guild.channels.create({ name: 'honeypot-strict' });
  await HoneypotService.setupHoneypot(guild, { channelId: chan.id, strictMode: true });
  await HoneypotService.enableHoneypot(guild, { id: 'admin_5', tag: 'Admin#0005' });

  const member = createMockMember(guild, { id: 'user_unlucky_5', tag: 'Accidental#5555' });

  let deleted = false;
  const mockMessage = {
    id: 'msg_strict_harmless_5',
    content: 'hello is anyone here? :-) lol',
    channel: chan,
    guild,
    author: member.user,
    member,
    delete: async () => { deleted = true; }
  };

  const handled = await HoneypotService.handleMessage(mockMessage, guild.client);
  assert.equal(handled, true);
  assert.equal(member.isKicked, true, 'Member MUST be kicked in strict mode even for harmless messages');
  assert.ok(member.lastKickReason.includes('[Honeypot Strict Mode]'));
  assert.equal(deleted, true);

  const config = HoneypotService.getConfig(guild.id);
  assert.equal(config.recentEvents[0].action, 'kick');
  assert.equal(config.recentEvents[0].outcome, 'succeeded');
  assert.equal(config.recentEvents[0].mode, 'strict');
});

// ============================================================================
// 6. Exempt member posting in honeypot (verified ignored/not kicked)
// ============================================================================
test('6. Exempt member posting in honeypot: server owner and exempt roles are not kicked', async () => {
  const guild = createMockGuild({ id: 'guild_exempt_6', ownerId: 'owner_user_6' });
  const chan = await guild.channels.create({ name: 'honeypot-exempt' });
  const staffRole = { id: 'role_staff_6', name: 'Staff', position: 40 };
  guild.roles.cache.set(staffRole.id, staffRole);

  await HoneypotService.setupHoneypot(guild, { channelId: chan.id, strictMode: true });
  await HoneypotService.enableHoneypot(guild, { id: 'admin_6', tag: 'Admin#0006' });
  HoneypotService.updateConfig(guild.id, {
    exemptRoleIds: [staffRole.id],
    exemptUserIds: ['test_account_6']
  });

  // Test 6a: Server Owner
  const owner = createMockMember(guild, { id: 'owner_user_6', tag: 'Owner#0001', isOwner: true });
  const msgOwner = {
    id: 'msg_owner_6',
    content: 'Testing trap as owner',
    channel: chan,
    guild,
    author: owner.user,
    member: owner
  };
  await HoneypotService.handleMessage(msgOwner, guild.client);
  assert.equal(owner.isKicked, false, 'Server owner must NEVER be kicked');

  // Test 6b: Member with Exempt Role
  const staffMember = createMockMember(guild, { id: 'staff_user_6', tag: 'Mod#6000', roles: [staffRole] });
  const msgStaff = {
    id: 'msg_staff_6',
    content: 'Staff inspection',
    channel: chan,
    guild,
    author: staffMember.user,
    member: staffMember
  };
  await HoneypotService.handleMessage(msgStaff, guild.client);
  assert.equal(staffMember.isKicked, false, 'Staff member with exempt role must not be kicked');

  // Test 6c: Explicitly Exempt User ID
  const testAccount = createMockMember(guild, { id: 'test_account_6', tag: 'QA#9999' });
  const msgQA = {
    id: 'msg_qa_6',
    content: 'Automated canary',
    channel: chan,
    guild,
    author: testAccount.user,
    member: testAccount
  };
  await HoneypotService.handleMessage(msgQA, guild.client);
  assert.equal(testAccount.isKicked, false, 'Exempt user ID must not be kicked');
});

// ============================================================================
// 7. Bot-authored messages being ignored
// ============================================================================
test('7. Bot-authored messages are ignored and return false', async () => {
  const guild = createMockGuild({ id: 'guild_bot_7' });
  const chan = await guild.channels.create({ name: 'honeypot-bot' });
  await HoneypotService.setupHoneypot(guild, { channelId: chan.id, strictMode: true });
  await HoneypotService.enableHoneypot(guild, { id: 'admin_7', tag: 'Admin#0007' });

  const botUser = { id: 'other_bot', tag: 'Notifier#0000', bot: true };
  const mockMessage = {
    id: 'msg_bot_7',
    content: 'Automated RSS feed notification',
    channel: chan,
    guild,
    author: botUser
  };

  const handled = await HoneypotService.handleMessage(mockMessage, guild.client);
  assert.equal(handled, false, 'Bot messages must be ignored completely');
});

// ============================================================================
// 8. Duplicate event handling (idempotency)
// ============================================================================
test('8. Duplicate event handling (idempotency) prevents duplicate kicks', async () => {
  const guild = createMockGuild({ id: 'guild_idemp_8' });
  const chan = await guild.channels.create({ name: 'honeypot-idemp' });
  await HoneypotService.setupHoneypot(guild, { channelId: chan.id, strictMode: true });
  await HoneypotService.enableHoneypot(guild, { id: 'admin_8', tag: 'Admin#0008' });

  const member = createMockMember(guild, { id: 'user_dup_8', tag: 'Spammer#8888' });
  let kickCount = 0;
  member.kick = async () => {
    kickCount++;
    return member;
  };

  const mockMessage = {
    id: 'msg_dup_8',
    content: 'claim free nitro http://discord-gift.click',
    channel: chan,
    guild,
    author: member.user,
    member,
    delete: async () => {}
  };

  // First invocation
  const first = await HoneypotService.handleMessage(mockMessage, guild.client);
  assert.equal(first, true);
  assert.equal(kickCount, 1);

  // Gateway replay duplicate invocation
  const second = await HoneypotService.handleMessage(mockMessage, guild.client);
  assert.equal(second, true);
  assert.equal(kickCount, 1, 'Duplicate message event must not trigger another kick');
});

// ============================================================================
// 9. Missing kick permissions (handled safely, failure category recorded)
// ============================================================================
test('9. Missing kick permissions: handled safely and records MISSING_BOT_PERMISSIONS', async () => {
  const guild = createMockGuild({ id: 'guild_noperm_9', botMissingKick: true });
  const chan = await guild.channels.create({ name: 'honeypot-noperm' });
  await HoneypotService.setupHoneypot(guild, { channelId: chan.id, strictMode: true });
  await HoneypotService.enableHoneypot(guild, { id: 'admin_9', tag: 'Admin#0009' });

  const member = createMockMember(guild, { id: 'user_victim_9', tag: 'User#9000' });
  const mockMessage = {
    id: 'msg_noperm_9',
    content: 'hello',
    channel: chan,
    guild,
    author: member.user,
    member
  };

  const handled = await HoneypotService.handleMessage(mockMessage, guild.client);
  assert.equal(handled, true);
  assert.equal(member.isKicked, false);

  const config = HoneypotService.getConfig(guild.id);
  assert.equal(config.recentEvents[0].outcome, 'failed');
  assert.equal(config.recentEvents[0].failureReason, 'MISSING_BOT_PERMISSIONS');
});

// ============================================================================
// 10. Role hierarchy preventing a kick (handled safely, failure category recorded)
// ============================================================================
test('10. Role hierarchy preventing a kick: records ROLE_HIERARCHY_CONSTRAINT', async () => {
  const guild = createMockGuild({ id: 'guild_hier_10' });
  const chan = await guild.channels.create({ name: 'honeypot-hier' });
  await HoneypotService.setupHoneypot(guild, { channelId: chan.id, strictMode: true });
  await HoneypotService.enableHoneypot(guild, { id: 'admin_10', tag: 'Admin#0010' });

  // Outranking member (kickable = false)
  const highRole = guild.roles.cache.get('role_admin');
  const superiorMember = createMockMember(guild, {
    id: 'user_superior_10',
    tag: 'Boss#1000',
    roles: [highRole],
    kickable: false
  });

  const mockMessage = {
    id: 'msg_hier_10',
    content: 'testing',
    channel: chan,
    guild,
    author: superiorMember.user,
    member: superiorMember
  };

  const handled = await HoneypotService.handleMessage(mockMessage, guild.client);
  assert.equal(handled, true);
  assert.equal(superiorMember.isKicked, false);

  const config = HoneypotService.getConfig(guild.id);
  assert.equal(config.recentEvents[0].outcome, 'failed');
  assert.equal(config.recentEvents[0].failureReason, 'ROLE_HIERARCHY_CONSTRAINT');
});

// ============================================================================
// 11. Deleted honeypot channels (detected, unsafe enforcement disabled)
// ============================================================================
test('11. Deleted honeypot channels: detected and disables unsafe enforcement', async () => {
  const guild = createMockGuild({ id: 'guild_deleted_11' });
  const chan = await guild.channels.create({ name: 'honeypot-delete' });
  await HoneypotService.setupHoneypot(guild, { channelId: chan.id, strictMode: true });
  await HoneypotService.enableHoneypot(guild, { id: 'admin_11', tag: 'Admin#0011' });

  assert.equal(HoneypotService.getConfig(guild.id).enabled, true);

  // Simulate channel deletion in Discord
  guild.channels.cache.delete(chan.id);

  // Message arriving with stale channel reference
  const mockMessage = {
    id: 'msg_deleted_11',
    content: 'hello',
    channel: chan,
    guild,
    author: { id: 'user_11', tag: 'U#1111' }
  };

  const handled = await HoneypotService.handleMessage(mockMessage, guild.client);
  assert.equal(handled, false);
  assert.equal(HoneypotService.getConfig(guild.id).enabled, false, 'Enforcement must be disabled when channel is deleted');
});

// ============================================================================
// 12. Bot restart and configuration recovery
// ============================================================================
test('12. Bot restart and configuration recovery restores persisted state from disk', async () => {
  const guild = createMockGuild({ id: 'guild_restart_12' });
  const chan = await guild.channels.create({ name: 'honeypot-persist' });
  await HoneypotService.setupHoneypot(guild, { channelId: chan.id, strictMode: true });
  await HoneypotService.enableHoneypot(guild, { id: 'admin_12', tag: 'Admin#0012' });

  // Simulate restart: clear memory cache
  HoneypotService._configs.clear();
  HoneypotService._isLoaded = false;

  // Reload config
  const restored = HoneypotService.getConfig(guild.id);
  assert.equal(restored.guildId, guild.id);
  assert.equal(restored.channelId, chan.id);
  assert.equal(restored.enabled, true);
  assert.equal(restored.strictMode, true);
  assert.equal(restored.strictConfirmedBy, 'Admin#0012');
});

// ============================================================================
// 13. Multiple guilds with independent settings
// ============================================================================
test('13. Multiple guilds have fully isolated independent settings and event logs', async () => {
  const guildA = createMockGuild({ id: 'guild_alpha_13' });
  const guildB = createMockGuild({ id: 'guild_bravo_13' });

  const chanA = await guildA.channels.create({ name: 'trap-a' });
  const chanB = await guildB.channels.create({ name: 'trap-b' });

  await HoneypotService.setupHoneypot(guildA, { channelId: chanA.id, strictMode: true });
  await HoneypotService.enableHoneypot(guildA, { id: 'admin_a', tag: 'AdminA#0001' });

  await HoneypotService.setupHoneypot(guildB, { channelId: chanB.id, strictMode: false });
  // Guild B remains disabled and in monitored mode

  const configA = HoneypotService.getConfig(guildA.id);
  const configB = HoneypotService.getConfig(guildB.id);

  assert.equal(configA.enabled, true);
  assert.equal(configA.strictMode, true);
  assert.equal(configA.channelId, chanA.id);

  assert.equal(configB.enabled, false);
  assert.equal(configB.strictMode, false);
  assert.equal(configB.channelId, chanB.id);
});

// ============================================================================
// 14. Logging success and failure accurately in modlog
// ============================================================================
test('14. Logging success and failure accurately in modlog', async () => {
  const guild = createMockGuild({ id: 'guild_modlog_14' });
  const chan = await guild.channels.create({ name: 'honeypot-log' });
  await HoneypotService.setupHoneypot(guild, { channelId: chan.id, strictMode: true });
  await HoneypotService.enableHoneypot(guild, { id: 'admin_14', tag: 'Admin#0014' });

  const loggedActions = [];
  const origLogAction = ModLogService.logAction;
  ModLogService.logAction = async (g, entry) => {
    loggedActions.push(entry);
    return { success: true };
  };

  try {
    const member = createMockMember(guild, { id: 'spammer_14', tag: 'SpamBot#1414' });
    const msg = {
      id: 'msg_modlog_14',
      content: 'free nitro click here discord.gg/fake',
      channel: chan,
      guild,
      author: member.user,
      member,
      delete: async () => {}
    };

    await HoneypotService.handleMessage(msg, guild.client);

    assert.equal(loggedActions.length, 1);
    assert.equal(loggedActions[0].action, 'kick_member');
    assert.equal(loggedActions[0].outcome, 'succeeded');
    assert.equal(loggedActions[0].source, 'HoneypotService');
    assert.equal(loggedActions[0].metadata?.mode, 'strict');
  } finally {
    ModLogService.logAction = origLogAction;
  }
});

// ============================================================================
// 15. Unauthorized users attempting configuration changes (denied)
// ============================================================================
test('15. Unauthorized users attempting honeypot commands and buttons are denied', async () => {
  const guild = createMockGuild({ id: 'guild_auth_15' });
  const nonAdminUser = { id: 'user_intruder_15', tag: 'Rando#1515' };
  const nonAdminMember = createMockMember(guild, { id: nonAdminUser.id, tag: nonAdminUser.tag, kickable: true, isOwner: false });

  // 15a. Command interaction unauthorized
  let replyPayload = null;
  const mockCommandInteraction = {
    isChatInputCommand: () => true,
    guild,
    member: nonAdminMember,
    user: nonAdminUser,
    options: {
      getSubcommand: () => 'setup'
    },
    reply: async (payload) => {
      replyPayload = payload;
    }
  };

  await handleHoneypotCommand(mockCommandInteraction);
  assert.ok(replyPayload);
  assert.ok(replyPayload.content.includes('Access Denied'));

  // 15b. Button interaction unauthorized
  let buttonReply = null;
  const mockButtonInteraction = {
    customId: `honeypot:toggle_active:${guild.id}`,
    guild,
    member: nonAdminMember,
    user: nonAdminUser,
    reply: async (payload) => {
      buttonReply = payload;
    }
  };

  const buttonHandled = await HoneypotService.handleInteraction(mockButtonInteraction);
  assert.equal(buttonHandled, true);
  assert.ok(buttonReply);
  assert.ok(buttonReply.content.includes('Access Denied'));
});

// ============================================================================
// 16. Non-destructive diagnostic testing (/honeypot test)
// ============================================================================
test('16. Non-destructive diagnostic testing verifies health without kicking members', async () => {
  const guild = createMockGuild({ id: 'guild_test_16' });
  const chan = await guild.channels.create({ name: 'honeypot-diag' });
  await HoneypotService.setupHoneypot(guild, { channelId: chan.id, strictMode: false });
  await HoneypotService.enableHoneypot(guild, { id: 'admin_16', tag: 'Admin#0016' });

  const testMember = createMockMember(guild, { id: 'test_member_16', tag: 'Tester#1616' });

  const diag = await HoneypotService.runDiagnosticTest(guild, testMember.user);
  assert.equal(diag.healthy, true);
  assert.equal(diag.passed, true);
  assert.ok(diag.embed);
  assert.equal(testMember.isKicked, false, 'Diagnostic test must NEVER kick members');

  // Verify 7 checks exist
  assert.ok(diag.checks['Honeypot Channel']);
  assert.ok(diag.checks['Channel Permissions']);
  assert.ok(diag.checks['Guild Kick Permission']);
  assert.ok(diag.checks['Role Hierarchy']);
  assert.ok(diag.checks['Enforcement Mode']);
  assert.ok(diag.checks['Configuration Persistence']);
  assert.ok(diag.checks['ModLog Integration']);

  // Also verify Operations.testHoneypot and DiagnosticService
  const opRes = await Operations.testHoneypot(guild, { invokingUser: testMember.user });
  assert.equal(opRes.success, true);
  assert.ok(opRes.details.includes('PASSED'));

  const diagServRes = await DiagnosticService.diagnoseHoneypotHealth({ guild, invokingUser: testMember.user }, 'corr_16');
  assert.equal(diagServRes.status, DiagnosticStatus.HEALTHY);
  assert.ok(diagServRes.response.includes('healthy'));
});

// Cleanup temp test directory
test('Cleanup Honeypot Suite Temporary Directory', () => {
  HoneypotService.storagePath = null;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});
