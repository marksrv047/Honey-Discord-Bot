import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { ModLogService } from '../src/mod-log.js';
import { ModlogInterpreter } from '../src/modlog-interpreter.js';

function createMockChannel(id, name, type = ChannelType.GuildText, botPerms = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks], guildId = 'guild_upgrade_test') {
  const permSet = new Set(botPerms);
  const sentMessages = [];
  return {
    id,
    name,
    type,
    guildId,
    permissionsFor: () => ({
      has: (flag) => permSet.has(flag)
    }),
    send: async (payload) => {
      const msg = { id: `msg_${Date.now()}_${Math.random()}`, ...payload };
      sentMessages.push(msg);
      return msg;
    },
    _sentMessages: sentMessages
  };
}

function createMockGuild(id = 'guild_upgrade_test', channels = []) {
  const channelMap = new Map(channels.map(c => [c.id, c]));
  return {
    id,
    name: 'Upgrade Server',
    channels: {
      cache: channelMap,
      fetch: async (cId) => channelMap.get(cId) || null
    },
    members: {
      me: {
        id: 'bot_honey',
        permissions: { has: () => true }
      },
      fetchMe: async () => ({
        id: 'bot_honey',
        permissions: { has: () => true }
      })
    }
  };
}

test('Modlog Upgrade: Interprets all requested natural-language prompt variations', async () => {
  const interpreter = new ModlogInterpreter();

  // 1. Channel setup
  const r1 = await interpreter.interpret('Set #staff-logs as the moderation log channel.');
  assert.equal(r1.intent, 'configure_channel');
  assert.equal(r1.targetChannel, '#staff-logs');

  // 2. Use this channel
  const r2 = await interpreter.interpret('Use this channel for mod logs.');
  assert.equal(r2.intent, 'configure_channel');
  assert.equal(r2.targetChannel, 'current');

  // 3. Move logs
  const r3 = await interpreter.interpret('Move moderation logs to #admin-logs.');
  assert.equal(r3.intent, 'configure_channel');
  assert.equal(r3.targetChannel, '#admin-logs');

  // 4. Which channel configured
  const r4 = await interpreter.interpret('Which channel is currently configured?');
  assert.equal(r4.intent, 'inspect_config');

  // 5. Check if working
  const r5 = await interpreter.interpret('Check whether logging is working.');
  assert.equal(r5.intent, 'test_channel');

  // 6. Send test entry
  const r6 = await interpreter.interpret('Send a test entry to the configured channel.');
  assert.equal(r6.intent, 'test_channel');

  // 7. Check embeds
  const r7 = await interpreter.interpret('Check whether you can send embeds there.');
  assert.equal(r7.intent, 'test_channel');

  // 8. Disable logging
  const r8 = await interpreter.interpret('Disable moderation logging for this server.');
  assert.equal(r8.intent, 'disable_logging');

  // 9. Enable again
  const r9 = await interpreter.interpret('Enable logging again.');
  assert.equal(r9.intent, 'enable_logging');

  // 10. Troubleshoot missing log
  const r10 = await interpreter.interpret("Find out why the last moderation action wasn't logged.");
  assert.equal(r10.intent, 'troubleshoot_config');
  assert.equal(r10.repair, false);

  // 11. Switch, test, and tell me whether everything works
  const r11 = await interpreter.interpret('Switch to #staff-logs, test it, and tell me whether everything works.');
  assert.equal(r11.intent, 'configure_channel');
  assert.equal(r11.targetChannel, '#staff-logs');
  assert.equal(r11.testAfterConfig, true);

  // 12. Troubleshoot and safe repair
  const r12 = await interpreter.interpret("Check the configuration and repair anything that's safely fixable.");
  assert.equal(r12.intent, 'troubleshoot_config');
  assert.equal(r12.repair, true);
});

test('Modlog Upgrade: Rejects out-of-scope actions and directs them to /go', async () => {
  const interpreter = new ModlogInterpreter();

  const r1 = await interpreter.interpret('Ban Alex for repeated harassment');
  assert.equal(r1.intent, 'out_of_scope');
  assert.ok(r1.explanation.includes('/go'));

  const r2 = await interpreter.interpret('Purge the last 10 messages from this channel');
  assert.equal(r2.intent, 'out_of_scope');
  assert.ok(r2.explanation.includes('/go'));
});

test('Modlog Upgrade: Preserves previous valid configuration if new channel fails validation', async () => {
  const guildId = 'guild_preserve_on_fail';
  const goodChannel = createMockChannel('c_valid_1', 'mod-logs', ChannelType.GuildText, undefined, guildId);
  const brokenChannel = createMockChannel('c_broken_2', 'voice-room', ChannelType.GuildVoice, undefined, guildId);

  const guild = createMockGuild(guildId, [goodChannel, brokenChannel]);

  // Initial valid configuration
  const setupRes = await ModLogService.setLogChannel(guild, 'c_valid_1', 'AdminUser');
  assert.equal(setupRes.success, true);
  assert.equal(setupRes.config.channelId, 'c_valid_1');

  // Attempt to switch to invalid voice channel
  const failRes = await ModLogService.setLogChannel(guild, 'c_broken_2', 'AdminUser');
  assert.equal(failRes.success, false);
  assert.equal(failRes.preservedChannelId, 'c_valid_1');
  assert.equal(failRes.preservedChannelName, 'mod-logs');

  // Verify that saved config still has the previous valid channel
  const conf = ModLogService.getConfig(guildId);
  assert.equal(conf.channelId, 'c_valid_1');
  assert.equal(conf.channelName, 'mod-logs');
  assert.equal(conf.enabled, true);
});

test('Modlog Upgrade: Decouples log delivery from action execution and enqueues pending deliveries on failure', async () => {
  const guildId = 'guild_decoupled_test_' + Date.now();
  const validChannel = createMockChannel('c_mod_logs', 'mod-logs', ChannelType.GuildText, undefined, guildId);
  const guild = createMockGuild(guildId, [validChannel]);

  await ModLogService.setLogChannel(guild, 'c_mod_logs', 'AdminUser');

  // 1. Successful log delivery
  const logRes1 = await ModLogService.logAction(guild, {
    action: 'ban_member',
    actor: { id: 'admin_1', tag: 'Mod' },
    target: { id: 'bad_actor', tag: 'Spammer' },
    reason: 'Spamming',
    outcome: 'succeeded',
    source: '/go'
  });
  assert.equal(logRes1.logged, true);

  const conf1 = ModLogService.getConfig(guildId);
  assert.ok(conf1.lastDeliverySuccess);
  assert.equal(conf1.deliveredCount, 1);

  // 2. Simulated channel failure (e.g. channel deletion or API drop)
  validChannel.send = async () => {
    throw new Error('Missing Permissions (50013)');
  };

  const logRes2 = await ModLogService.logAction(guild, {
    action: 'kick_member',
    actor: { id: 'admin_1', tag: 'Mod' },
    target: { id: 'bad_actor_2', tag: 'Troll' },
    reason: 'Disruptive behavior',
    outcome: 'succeeded',
    source: '/go'
  });

  // Action itself is NOT failed; log delivery failure is gracefully enqueued
  assert.equal(logRes2.logged, false);
  assert.equal(logRes2.queued, true);

  const conf2 = ModLogService.getConfig(guildId);
  assert.equal(conf2.pendingDeliveries.length, 1);
  assert.equal(conf2.lastDeliveryFailure.category, 'permission_denied');
  assert.ok(conf2.lastDeliveryFailure.error.includes('Missing Permissions'));

  // 3. Channel restored & flush pending deliveries
  validChannel.send = async (p) => ({ id: 'restored_msg', ...p });
  const flushRes = await ModLogService.flushPendingDeliveries(guild);
  assert.equal(flushRes.flushed, 1);
  assert.equal(flushRes.remaining, 0);

  const conf3 = ModLogService.getConfig(guildId);
  assert.equal(conf3.pendingDeliveries.length, 0);
  assert.equal(conf3.deliveredCount, 2);
});

test('Modlog Upgrade: Troubleshooting accurately diagnoses unconfigured, deleted, missing permissions, and pending logs', async () => {
  // Scenario A: Unconfigured
  const unconfiguredGuild = createMockGuild('guild_unconf', []);
  const diagA = await ModLogService.troubleshoot(unconfiguredGuild);
  assert.equal(diagA.healthy, false);
  assert.equal(diagA.status, 'unconfigured');
  assert.equal(diagA.userMessage, 'No mod-log channel is configured for this server.');

  // Scenario B: Configured channel deleted
  const deletedChannelGuild = createMockGuild('guild_deleted_ch', []);
  ModLogService.updateConfig('guild_deleted_ch', {
    channelId: 'ch_ghost_999',
    channelName: 'deleted-channel',
    enabled: true
  });
  const diagB = await ModLogService.troubleshoot(deletedChannelGuild);
  assert.equal(diagB.healthy, false);
  assert.equal(diagB.status, 'channel_missing');
  assert.ok(diagB.userMessage.includes('no longer exists'));

  // Scenario C: Missing SendMessages permission
  const guildNoSend = 'guild_no_send';
  const noSendChannel = createMockChannel('ch_restricted', 'staff-logs', ChannelType.GuildText, [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.EmbedLinks
    // Missing SendMessages
  ], guildNoSend);
  const noSendGuild = createMockGuild(guildNoSend, [noSendChannel]);
  ModLogService.updateConfig(guildNoSend, {
    channelId: 'ch_restricted',
    channelName: 'staff-logs',
    enabled: true
  });
  const diagC = await ModLogService.troubleshoot(noSendGuild);
  assert.equal(diagC.healthy, false);
  assert.equal(diagC.status, 'permission_denied');
  assert.ok(diagC.userMessage.includes('Honey Bot cannot send messages there. Grant the bot Send Messages permission and try again.'));

  // Scenario D: Logging disabled but channel healthy -> safe auto-repair
  const guildDisabled = 'guild_disabled';
  const healthyChannel = createMockChannel('ch_healthy', 'staff-logs', ChannelType.GuildText, undefined, guildDisabled);
  const disabledGuild = createMockGuild(guildDisabled, [healthyChannel]);
  ModLogService.updateConfig(guildDisabled, {
    channelId: 'ch_healthy',
    channelName: 'staff-logs',
    enabled: false
  });
  const diagD = await ModLogService.troubleshoot(disabledGuild, { autoRepair: true, userTagOrId: 'Admin' });
  assert.equal(diagD.repairs.length, 1);
  assert.ok(diagD.repairs[0].includes('Re-enabled moderation logging'));
  const repairedConf = ModLogService.getConfig(guildDisabled);
  assert.equal(repairedConf.enabled, true);
});
