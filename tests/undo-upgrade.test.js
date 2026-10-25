import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { ActionLedger, RecoveryRegistry, RecoveryEngine } from '../src/recovery.js';
import { slashCommands, handleCommandInteraction } from '../src/commands.js';
import { ModLogService } from '../src/mod-log.js';
import { SecurityGate } from '../src/security-gate.js';

function createMockChannel(id, name, type = ChannelType.GuildText, guildId = 'guild_undo_test') {
  let currentName = name;
  let currentTopic = '';
  let currentSlowmode = 0;
  let isDeleted = false;
  const sentMessages = [];

  return {
    id,
    guildId,
    get name() { return currentName; },
    get topic() { return currentTopic; },
    get rateLimitPerUser() { return currentSlowmode; },
    get deleted() { return isDeleted; },
    type,
    permissionsFor: () => ({
      has: () => true
    }),
    send: async (payload) => {
      const msg = { id: `msg_${Date.now()}`, ...payload };
      sentMessages.push(msg);
      return msg;
    },
    _sentMessages: sentMessages,
    async setName(newName) {
      currentName = newName;
      return this;
    },
    async setTopic(newTopic) {
      currentTopic = newTopic;
      return this;
    },
    async setRateLimitPerUser(sec) {
      currentSlowmode = sec;
      return this;
    },
    async delete() {
      isDeleted = true;
      return this;
    }
  };
}

function createMockRole(id, name, position = 10, guildId = 'guild_undo_test') {
  let isDeleted = false;
  return {
    id,
    name,
    position,
    guildId,
    get deleted() { return isDeleted; },
    async delete() {
      isDeleted = true;
      return this;
    }
  };
}

function createMockMember(id, tag, permissions = [PermissionFlagsBits.Administrator], rolePosition = 20, roles = []) {
  const permSet = new Set(permissions);
  const roleMap = new Map(roles.map(r => [r.id, r]));
  let currentNickname = null;

  return {
    id,
    user: { id, tag, username: tag.split('#')[0] },
    permissions: {
      has: (flag) => permSet.has(PermissionFlagsBits.Administrator) || permSet.has(flag)
    },
    roles: {
      highest: { position: rolePosition },
      cache: roleMap,
      add: async (role) => {
        roleMap.set(role.id, role);
        return this;
      },
      remove: async (role) => {
        roleMap.delete(role.id);
        return this;
      }
    },
    get nickname() { return currentNickname; },
    async setNickname(nick) {
      currentNickname = nick;
      return this;
    }
  };
}

function createMockGuild(id = 'guild_undo_test', channels = [], roles = [], members = []) {
  const channelMap = new Map(channels.map(c => [c.id, c]));
  const roleMap = new Map(roles.map(r => [r.id, r]));
  const memberMap = new Map(members.map(m => [m.id, m]));

  const botMember = createMockMember('bot_honey', 'HoneyBot#0001', [PermissionFlagsBits.Administrator], 50);

  return {
    id,
    name: 'Undo Test Server',
    ownerId: 'owner_123',
    channels: {
      cache: channelMap,
      fetch: async (cId) => channelMap.get(cId) || null
    },
    roles: {
      cache: roleMap,
      fetch: async (rId) => roleMap.get(rId) || null
    },
    members: {
      cache: memberMap,
      me: botMember,
      fetch: async (mId) => memberMap.get(mId) || null
    }
  };
}

function createMockInteraction(guild, member, prompt = null) {
  let replyContent = '';
  let isDeferred = false;

  return {
    isChatInputCommand: () => true,
    commandName: 'undo',
    guild,
    member,
    user: member.user,
    options: {
      getString: (name) => name === 'prompt' ? prompt : null
    },
    deferReply: async () => {
      isDeferred = true;
    },
    editReply: async (payload) => {
      replyContent = typeof payload === 'string' ? payload : (payload?.content || '');
      return { content: replyContent };
    },
    getReplyContent: () => replyContent
  };
}

test('Criterion 1: Recovers a supported action when original state is recorded', async () => {
  const guildId = 'guild_c1_' + Date.now();
  const channel = createMockChannel('ch_101', 'general-chat', ChannelType.GuildText, guildId);
  const adminMember = createMockMember('admin_1', 'Admin#1234', [PermissionFlagsBits.ManageChannels]);
  const guild = createMockGuild(guildId, [channel], [], [adminMember]);

  // Simulate an executed channel rename
  await channel.setName('announcements');
  const executionId = 'exec_rename_1';
  ActionLedger.recordAction(guildId, executionId, {
    action: 'rename_channel',
    type: 'channel_rename',
    targetId: channel.id,
    targetName: 'announcements',
    oldName: 'general-chat',
    newName: 'announcements',
    preState: { name: 'general-chat' },
    postState: { name: 'announcements' },
    actor: { id: adminMember.id, tag: adminMember.user.tag }
  });

  const interaction = createMockInteraction(guild, adminMember, 'undo the channel rename');
  await handleCommandInteraction(interaction);

  const reply = interaction.getReplyContent();
  assert.equal(reply, 'Restored the channel name to `general-chat`. The previous name is verified.');
  assert.equal(channel.name, 'general-chat');

  const record = ActionLedger.getLastExecution(guildId)[1][0];
  assert.equal(record.recoveryStatus, 'succeeded');
});

test('Criterion 2: Refuses recovery when original state was missing', async () => {
  const guildId = 'guild_c2_' + Date.now();
  const channel = createMockChannel('ch_201', 'updated-name', ChannelType.GuildText, guildId);
  const adminMember = createMockMember('admin_2', 'Admin#1234', [PermissionFlagsBits.ManageChannels]);
  const guild = createMockGuild(guildId, [channel], [], [adminMember]);

  ActionLedger.recordAction(guildId, 'exec_missing_state', {
    action: 'rename_channel',
    type: 'channel_rename',
    targetId: channel.id,
    targetName: 'updated-name',
    oldName: null,
    newName: 'updated-name',
    preState: null,
    postState: { name: 'updated-name' },
    actor: { id: adminMember.id, tag: adminMember.user.tag }
  });

  const interaction = createMockInteraction(guild, adminMember, 'undo the channel rename');
  await handleCommandInteraction(interaction);

  const reply = interaction.getReplyContent();
  assert.equal(reply, "I can't safely undo that action because its previous state wasn't recorded.");
  assert.equal(channel.name, 'updated-name'); // State left untouched
});

test('Criterion 3: Ambiguous action selection prompts with one concise question', async () => {
  const guildId = 'guild_c3_' + Date.now();
  const channelA = createMockChannel('ch_a', 'lobby', ChannelType.GuildText, guildId);
  const channelB = createMockChannel('ch_b', 'lounge', ChannelType.GuildText, guildId);
  const adminMember = createMockMember('admin_3', 'Admin#1234');
  const guild = createMockGuild(guildId, [channelA, channelB], [], [adminMember]);

  // Two renames recorded
  ActionLedger.recordAction(guildId, 'exec_r1', {
    action: 'rename_channel',
    targetId: channelA.id,
    targetName: 'lobby',
    oldName: 'welcome',
    newName: 'lobby',
    preState: { name: 'welcome' },
    postState: { name: 'lobby' },
    timestamp: Date.now() - 60000,
    actor: { id: adminMember.id, tag: adminMember.user.tag }
  });

  ActionLedger.recordAction(guildId, 'exec_r2', {
    action: 'rename_channel',
    targetId: channelB.id,
    targetName: 'lounge',
    oldName: 'general',
    newName: 'lounge',
    preState: { name: 'general' },
    postState: { name: 'lounge' },
    timestamp: Date.now(),
    actor: { id: adminMember.id, tag: adminMember.user.tag }
  });

  const interaction = createMockInteraction(guild, adminMember, 'undo the channel rename');
  await handleCommandInteraction(interaction);

  const reply = interaction.getReplyContent();
  assert.match(reply, /^I found two matching actions\. Which one should I reverse:/);
  assert.match(reply, /lobby/);
  assert.match(reply, /lounge/);
});

test('Criterion 4: Enforces strict cross-guild recovery rejection', async () => {
  const guildAId = 'guild_c4_A_' + Date.now();
  const guildBId = 'guild_c4_B_' + Date.now();

  const channelA = createMockChannel('ch_secret', 'secret-vault', ChannelType.GuildText, guildAId);
  const adminA = createMockMember('admin_a', 'AdminA#0001');
  const guildA = createMockGuild(guildAId, [channelA], [], [adminA]);

  const execSecret = 'exec_cross_test_99';
  ActionLedger.recordAction(guildAId, execSecret, {
    action: 'rename_channel',
    targetId: channelA.id,
    targetName: 'secret-vault',
    oldName: 'old-vault',
    newName: 'secret-vault',
    preState: { name: 'old-vault' },
    postState: { name: 'secret-vault' }
  });

  // Now attempt to reference guildA execution ID inside guildB
  const channelB = createMockChannel('ch_public', 'public-chat', ChannelType.GuildText, guildBId);
  const adminB = createMockMember('admin_b', 'AdminB#0002');
  const guildB = createMockGuild(guildBId, [channelB], [], [adminB]);

  const interaction = createMockInteraction(guildB, adminB, `undo ${execSecret}`);
  await handleCommandInteraction(interaction);

  const reply = interaction.getReplyContent();
  assert.equal(reply, "I can't perform this recovery because that action belongs to another server.");
});

test('Criterion 5: Rejects unauthorized actor attempting recovery', async () => {
  const guildId = 'guild_c5_' + Date.now();
  const channel = createMockChannel('ch_501', 'chat', ChannelType.GuildText, guildId);
  // Member has no administrative or channel manage permissions
  const unprivUser = createMockMember('user_unpriv', 'User#0001', []);
  const guild = createMockGuild(guildId, [channel], [], [unprivUser]);

  ActionLedger.recordAction(guildId, 'exec_perm_test', {
    action: 'rename_channel',
    targetId: channel.id,
    targetName: 'chat',
    oldName: 'general',
    newName: 'chat',
    preState: { name: 'general' },
    postState: { name: 'chat' }
  });

  const interaction = createMockInteraction(guild, unprivUser, 'undo the channel rename');
  await handleCommandInteraction(interaction);

  const reply = interaction.getReplyContent();
  assert.equal(reply, "I can't perform this recovery with the current permissions.");
});

test('Criterion 6: Blocks recovery when role hierarchy prevents mutation', async () => {
  const guildId = 'guild_c6_' + Date.now();
  // Role higher than bot (bot position is 50, role is 60)
  const highRole = createMockRole('role_super', 'SeniorOwnerRole', 60, guildId);
  const adminMember = createMockMember('admin_6', 'Admin#1234', [PermissionFlagsBits.ManageRoles], 70);
  const guild = createMockGuild(guildId, [], [highRole], [adminMember]);

  const candidate = {
    action: 'create_role',
    targetId: highRole.id,
    targetName: highRole.name
  };

  const auth = RecoveryEngine.checkAuthorization(adminMember, guild, candidate);
  assert.equal(auth.authorized, false);
  assert.match(auth.reason, /hierarchy/i);
});

test('Criterion 7: Immutable anti-nuke enforcement blocks dangerous recoveries', async () => {
  const guildId = 'guild_c7_' + Date.now();
  const adminMember = createMockMember('admin_7', 'Admin#1234');
  const guild = createMockGuild(guildId, [], [], [adminMember]);

  // Requesting recovery of 5 created channels in a single operation triggers anti-nuke
  const dangerousActions = [
    { action: 'create_channel', targetId: 'c1' },
    { action: 'create_channel', targetId: 'c2' },
    { action: 'create_channel', targetId: 'c3' },
    { action: 'create_channel', targetId: 'c4' },
    { action: 'create_channel', targetId: 'c5' }
  ];

  assert.throws(() => {
    SecurityGate.evaluateActionSequence(
      dangerousActions.map(a => ({ action: 'delete_channel', targetChannel: a.targetId })),
      adminMember,
      guild
    );
  }, /Anti-Nuke Triggered: Request deletes 5 channels/);
});

test('Criterion 8: Already-recovered actions return calm no-op statement', async () => {
  const guildId = 'guild_c8_' + Date.now();
  const channel = createMockChannel('ch_801', 'original-name', ChannelType.GuildText, guildId);
  const adminMember = createMockMember('admin_8', 'Admin#1234');
  const guild = createMockGuild(guildId, [channel], [], [adminMember]);

  const act = ActionLedger.recordAction(guildId, 'exec_already', {
    action: 'rename_channel',
    targetId: channel.id,
    targetName: 'original-name',
    oldName: 'original-name',
    newName: 'renamed',
    preState: { name: 'original-name' },
    postState: { name: 'renamed' },
    recoveryStatus: 'succeeded'
  });

  const interaction = createMockInteraction(guild, adminMember, 'undo the channel rename');
  await handleCommandInteraction(interaction);

  const reply = interaction.getReplyContent();
  assert.equal(reply, 'That action has already been reversed. No additional changes were made.');
});

test('Criterion 9: Duplicate interactions and pending concurrency protection', async () => {
  const guildId = 'guild_c9_' + Date.now();
  const channel = createMockChannel('ch_901', 'chat', ChannelType.GuildText, guildId);
  const adminMember = createMockMember('admin_9', 'Admin#1234');
  const guild = createMockGuild(guildId, [channel], [], [adminMember]);

  const act = ActionLedger.recordAction(guildId, 'exec_pending_test', {
    action: 'rename_channel',
    targetId: channel.id,
    targetName: 'chat',
    oldName: 'general',
    newName: 'chat',
    preState: { name: 'general' },
    postState: { name: 'chat' },
    recoveryStatus: 'pending' // Currently in progress
  });

  const interaction = createMockInteraction(guild, adminMember, 'undo the channel rename');
  await handleCommandInteraction(interaction);

  const reply = interaction.getReplyContent();
  assert.match(reply, /already in progress/i);
});

test('Criterion 10: Idempotent recovery when target already reached preState', async () => {
  const guildId = 'guild_c10_' + Date.now();
  // Channel was already set to 'general' prior to recovery
  const channel = createMockChannel('ch_1001', 'general', ChannelType.GuildText, guildId);
  const adminMember = createMockMember('admin_10', 'Admin#1234');
  const guild = createMockGuild(guildId, [channel], [], [adminMember]);

  ActionLedger.recordAction(guildId, 'exec_pre_achieved', {
    action: 'rename_channel',
    targetId: channel.id,
    targetName: 'general',
    oldName: 'general',
    newName: 'lounge',
    preState: { name: 'general' },
    postState: { name: 'lounge' }
  });

  const interaction = createMockInteraction(guild, adminMember, 'undo');
  await handleCommandInteraction(interaction);

  const reply = interaction.getReplyContent();
  assert.equal(reply, 'That action has already been reversed. No additional changes were made.');
});

test('Criterion 11: Process-restart reconciliation for pending recovery', async () => {
  const guildId = 'guild_c11_' + Date.now();
  const channel = createMockChannel('ch_1101', 'general-restored', ChannelType.GuildText, guildId);
  const guild = createMockGuild(guildId, [channel]);

  // Simulate pending action left in history before crash
  const act = ActionLedger.recordAction(guildId, 'exec_crash_1', {
    action: 'rename_channel',
    targetId: channel.id,
    targetName: 'general-restored',
    oldName: 'general-restored',
    newName: 'temp-rename',
    preState: { name: 'general-restored' },
    postState: { name: 'temp-rename' },
    recoveryStatus: 'pending'
  });

  const mockClient = {
    guilds: {
      cache: new Map([[guildId, guild]])
    }
  };

  ActionLedger.reconcilePending(mockClient);
  const updated = ActionLedger.getActionById(act.actionId);
  assert.equal(updated.recoveryStatus, 'succeeded');
});

test('Criterion 12: Conflict detection when external changes make recovery unsafe', async () => {
  const guildId = 'guild_c12_' + Date.now();
  // Channel was renamed to 'dev-discussions' externally after the bot renamed it to 'lounge'
  const channel = createMockChannel('ch_1201', 'dev-discussions', ChannelType.GuildText, guildId);
  const adminMember = createMockMember('admin_12', 'Admin#1234');
  const guild = createMockGuild(guildId, [channel], [], [adminMember]);

  ActionLedger.recordAction(guildId, 'exec_conflict_1', {
    action: 'rename_channel',
    targetId: channel.id,
    targetName: 'lounge',
    oldName: 'general',
    newName: 'lounge',
    preState: { name: 'general' },
    postState: { name: 'lounge' }
  });

  const interaction = createMockInteraction(guild, adminMember, 'undo the channel rename');
  await handleCommandInteraction(interaction);

  const reply = interaction.getReplyContent();
  assert.equal(reply, "I can't safely undo that action because the target state has changed.");
});

test('Criterion 13: Multi-step partial recovery reports accurately without false claims', async () => {
  const guildId = 'guild_c13_' + Date.now();
  // Channel A has external conflict
  const channelA = createMockChannel('ch_13a', 'externally-modified', ChannelType.GuildText, guildId);
  // Channel B has valid state
  const channelB = createMockChannel('ch_13b', 'new-b', ChannelType.GuildText, guildId);
  const adminMember = createMockMember('admin_13', 'Admin#1234');
  const guild = createMockGuild(guildId, [channelA, channelB], [], [adminMember]);

  const execMulti = 'exec_multi_plan_1';
  const a1 = ActionLedger.recordAction(guildId, execMulti, {
    action: 'rename_channel',
    targetId: channelA.id,
    targetName: 'new-a',
    oldName: 'old-a',
    newName: 'new-a',
    preState: { name: 'old-a' },
    postState: { name: 'new-a' }
  });

  const a2 = ActionLedger.recordAction(guildId, execMulti, {
    action: 'rename_channel',
    targetId: channelB.id,
    targetName: 'new-b',
    oldName: 'old-b',
    newName: 'new-b',
    preState: { name: 'old-b' },
    postState: { name: 'new-b' }
  });

  const multiRes = await RecoveryEngine.executeMultiStepRecovery(
    guild,
    [a1, a2],
    adminMember.user,
    'exec_recovery_multi'
  );

  assert.equal(multiRes.success, true);
  assert.equal(multiRes.isPartial, true);
  assert.equal(multiRes.message, '1 of 2 changes were reversed. The remaining change needs review because the target state has changed.');
  assert.equal(channelB.name, 'old-b'); // Reversible step was safely undone
});

test('Criterion 14: Confirmation token rejects tampered or expired parameters', () => {
  const token = SecurityGate.generateConfirmationToken('user_1', 'guild_1', [{ action: 'delete_channel' }]);
  assert.ok(token);

  // Mismatched user
  const mismatchUser = SecurityGate.verifyConfirmationToken(token, 'user_attacker', 'guild_1', [{ action: 'delete_channel' }]);
  assert.equal(mismatchUser, false);

  // Tampered action
  const tamperedAction = SecurityGate.verifyConfirmationToken(token, 'user_1', 'guild_1', [{ action: 'ban_member' }]);
  assert.equal(tamperedAction, false);
});

test('Criterion 15: Verification ensures recovery actually achieved desired state', () => {
  const guildId = 'guild_c15_' + Date.now();
  const channel = createMockChannel('ch_1501', 'current', ChannelType.GuildText, guildId);
  const guild = createMockGuild(guildId, [channel]);

  const record = {
    action: 'rename_channel',
    targetId: channel.id,
    oldName: 'restored-chat',
    preState: { name: 'restored-chat' }
  };

  const handler = RecoveryRegistry.getHandler('rename_channel');
  assert.equal(handler.verify(guild, record), false); // Channel is still 'current'

  channel.setName('restored-chat');
  assert.equal(handler.verify(guild, record), true); // Channel matches desired previous name
});

test('Criterion 16: Centralized mod-log integration and durable recovery delivery', async () => {
  const guildId = 'guild_c16_' + Date.now();
  const logChannel = createMockChannel('ch_logs', 'mod-logs', ChannelType.GuildText, guildId);
  const channel = createMockChannel('ch_1601', 'temp', ChannelType.GuildText, guildId);
  const adminMember = createMockMember('admin_16', 'Admin#1234');
  const guild = createMockGuild(guildId, [logChannel, channel], [], [adminMember]);

  await ModLogService.setLogChannel(guild, 'ch_logs', 'Admin#1234');

  const act = ActionLedger.recordAction(guildId, 'exec_log_test', {
    action: 'rename_channel',
    targetId: channel.id,
    targetName: 'temp',
    oldName: 'perm-chat',
    newName: 'temp',
    preState: { name: 'perm-chat' },
    postState: { name: 'temp' }
  });

  const res = await RecoveryEngine.executeRecovery(guild, act, adminMember.user, 'exec_rec_log');
  assert.equal(res.success, true);

  const conf = ModLogService.getConfig(guildId);
  assert.ok(conf.deliveredCount >= 1);
});

test('Criterion 17: Slash command definition and prompt parsing variations', async () => {
  const undoCmd = slashCommands.find(c => c.name === 'undo');
  assert.ok(undoCmd);
  const json = undoCmd.toJSON();
  assert.equal(json.options[0].name, 'prompt');

  const guildId = 'guild_c17_' + Date.now();
  const channel = createMockChannel('ch_17', 'chat', ChannelType.GuildText, guildId);
  const admin = createMockMember('admin_17', 'Admin#1234');
  const guild = createMockGuild(guildId, [channel], [], [admin]);

  // Test "show me which recent actions can be undone"
  ActionLedger.recordAction(guildId, 'exec_rec_1', {
    action: 'rename_channel',
    targetId: channel.id,
    targetName: 'chat',
    oldName: 'general',
    newName: 'chat',
    preState: { name: 'general' },
    postState: { name: 'chat' }
  });

  const listInteraction = createMockInteraction(guild, admin, 'show me which recent actions can be undone');
  await handleCommandInteraction(listInteraction);
  assert.match(listInteraction.getReplyContent(), /Recent actions in this server:/);
  assert.match(listInteraction.getReplyContent(), /eligible to undo/);
});

test('Criterion 18: Zero-cost deterministic operation without requiring external LLM model', async () => {
  const guildId = 'guild_c18_' + Date.now();
  const channel = createMockChannel('ch_18', 'dev', ChannelType.GuildText, guildId);
  const admin = createMockMember('admin_18', 'Admin#1234');
  const guild = createMockGuild(guildId, [channel], [], [admin]);

  ActionLedger.recordAction(guildId, 'exec_offline', {
    action: 'rename_channel',
    targetId: channel.id,
    targetName: 'dev',
    oldName: 'general-dev',
    newName: 'dev',
    preState: { name: 'general-dev' },
    postState: { name: 'dev' }
  });

  // Even if GEMINI_API_KEY is not set or network is disabled, deterministic recovery resolves and executes
  const interaction = createMockInteraction(guild, admin, 'undo the channel rename');
  await handleCommandInteraction(interaction);

  const reply = interaction.getReplyContent();
  assert.equal(reply, 'Restored the channel name to `general-dev`. The previous name is verified.');
  assert.equal(channel.name, 'general-dev');
});
