import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { ModLogService, LogCategory } from '../src/mod-log.js';
import { HoneypotRetentionService } from '../src/honeypot-retention.js';
import { HoneypotService } from '../src/honeypot-service.js';
import { ModlogInterpreter } from '../src/modlog-interpreter.js';

// Setup temporary isolated retention storage
const tempDir = path.join(os.tmpdir(), `honey-retention-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
fs.mkdirSync(tempDir, { recursive: true });
HoneypotRetentionService.storagePath = path.join(tempDir, 'honeypot-log-messages.json');

function createMockChannel(id, name, type = ChannelType.GuildText, botPerms = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]) {
  const permSet = new Set(botPerms);
  const sentMessages = [];
  return {
    id,
    name,
    type,
    guildId: 'guild_three_test',
    permissionsFor: () => ({
      has: (flag) => permSet.has(flag)
    }),
    send: async (payload) => {
      const msg = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        channelId: id,
        author: { id: 'bot_honey' },
        ...payload,
        delete: async () => ({ deleted: true })
      };
      sentMessages.push(msg);
      return msg;
    },
    messages: {
      fetch: async (msgId) => sentMessages.find(m => m.id === msgId) || null
    },
    _sentMessages: sentMessages
  };
}

function createMockGuild(id = 'guild_three_test', channels = []) {
  channels.forEach(c => { c.guildId = id; });
  const channelMap = new Map(channels.map(c => [c.id, c]));
  return {
    id,
    name: 'Test Three Channel Server',
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

test('Three-Channel Architecture: Configures and isolates all three logging channels independently', async () => {
  const modChan = createMockChannel('c_mod', 'mod-logs');
  const hpChan = createMockChannel('c_hp', 'honeypot-logs');
  const botChan = createMockChannel('c_bot', 'bot-logs');
  const guild = createMockGuild('guild_three_01', [modChan, hpChan, botChan]);

  // 1. Configure Moderation Channel
  const resMod = await ModLogService.setModLogChannel(guild, 'c_mod', 'Admin');
  assert.equal(resMod.success, true);
  assert.equal(resMod.config.modLogChannelId, 'c_mod');
  assert.equal(resMod.config.channelId, 'c_mod'); // backward compatibility

  // 2. Configure Honeypot Channel
  const resHp = await ModLogService.setHoneypotLogChannel(guild, 'c_hp', 'Admin');
  assert.equal(resHp.success, true);
  assert.equal(resHp.config.honeypotLogChannelId, 'c_hp');

  // 3. Configure Bot Operations Channel
  const resBot = await ModLogService.setBotLogChannel(guild, 'c_bot', 'Admin');
  assert.equal(resBot.success, true);
  assert.equal(resBot.config.botLogChannelId, 'c_bot');

  // 4. Configure Honeypot Retention
  const resRet = ModLogService.setHoneypotRetention(guild.id, 48, 'Admin');
  assert.equal(resRet.success, true);
  assert.equal(resRet.retentionHours, 48);

  // 5. Inspect Three-Channel Status
  const status = ModLogService.getThreeChannelStatus(guild);
  assert.equal(status.channels.moderation.configuredId, 'c_mod');
  assert.equal(status.channels.honeypot.configuredId, 'c_hp');
  assert.equal(status.channels.honeypot.retentionHours, 48);
  assert.equal(status.channels.botOperations.configuredId, 'c_bot');
});

test('Three-Channel Routing: Dispatches events to their exact designated channel', async () => {
  const modChan = createMockChannel('ch_mod', 'mod-logs');
  const hpChan = createMockChannel('ch_hp', 'honeypot-logs');
  const botChan = createMockChannel('ch_bot', 'bot-logs');
  const guild = createMockGuild('guild_route_test', [modChan, hpChan, botChan]);

  await ModLogService.setModLogChannel(guild, 'ch_mod', 'Admin');
  await ModLogService.setHoneypotLogChannel(guild, 'ch_hp', 'Admin');
  await ModLogService.setBotLogChannel(guild, 'ch_bot', 'Admin');

  // 1. Moderation Action -> Must route to #mod-logs
  const modRes = await ModLogService.logAction(guild, {
    action: 'ban_member',
    actor: { id: 'admin_1', tag: 'Mod#0001' },
    target: { id: 'spammer_1', tag: 'Spam#9999' },
    reason: 'Raid account',
    outcome: 'succeeded'
  });
  assert.equal(modRes.logged, true);
  assert.equal(modRes.category, LogCategory.MODERATION);
  assert.equal(modRes.channelId, 'ch_mod');
  assert.equal(modChan._sentMessages.length, 1);
  assert.equal(hpChan._sentMessages.length, 0);
  assert.equal(botChan._sentMessages.length, 0);

  // 2. Honeypot Security Evidence -> Must route to #honeypot-logs
  const hpRes = await ModLogService.logAction(guild, {
    category: LogCategory.HONEYPOT_SECURITY,
    action: 'honeypot_trigger',
    actor: { id: 'bot_honey', tag: 'Honey Bot' },
    target: { id: 'bot_spammer', tag: 'ScamBot#1111' },
    channel: { id: 'hp_trap', name: 'honeypot' },
    reason: 'Posted unauthorized message in honeypot',
    outcome: 'succeeded',
    correlationId: 'corr_hp_123',
    evidence: {
      messageId: 'msg_scam_1',
      contentSnippet: 'Free nitro http://phish.com',
      signals: ['PHISHING_URL', 'MASS_MENTION']
    }
  });
  assert.equal(hpRes.logged, true);
  assert.equal(hpRes.category, LogCategory.HONEYPOT_SECURITY);
  assert.equal(hpRes.channelId, 'ch_hp');
  assert.equal(hpChan._sentMessages.length, 1);
  assert.equal(modChan._sentMessages.length, 1);
  assert.equal(botChan._sentMessages.length, 0);

  // 3. Bot Operations (Role/Channel change) -> Must route to #bot-logs
  const botRes = await ModLogService.logAction(guild, {
    action: 'create_role',
    actor: { id: 'admin_1', tag: 'Admin#0001' },
    target: { id: 'role_vip', name: 'VIP' },
    changes: 'Created role @VIP with color #E5A93C',
    outcome: 'succeeded'
  });
  assert.equal(botRes.logged, true);
  assert.equal(botRes.category, LogCategory.BOT_OPERATIONS);
  assert.equal(botRes.channelId, 'ch_bot');
  assert.equal(botChan._sentMessages.length, 1);
  assert.equal(modChan._sentMessages.length, 1);
  assert.equal(hpChan._sentMessages.length, 1);
});

test('Honeypot Trigger: Generates linked temporary security evidence AND permanent moderation record', async () => {
  const modChan = createMockChannel('c_mod_link', 'mod-logs');
  const hpChan = createMockChannel('c_hp_link', 'honeypot-logs');
  const honeypotTrap = createMockChannel('c_trap', 'honeypot');
  const guild = createMockGuild('guild_hp_link', [modChan, hpChan, honeypotTrap]);

  await ModLogService.setModLogChannel(guild, 'c_mod_link', 'Admin');
  await ModLogService.setHoneypotLogChannel(guild, 'c_hp_link', 'Admin');

  // Configure Honeypot strict mode
  HoneypotService.updateConfig(guild.id, {
    channelId: 'c_trap',
    enabled: true,
    strictMode: true
  });

  const memberMock = {
    id: 'user_intruder_7',
    kickable: true,
    roles: { highest: { position: 1 }, cache: new Map() },
    kick: async (r) => ({ kicked: true })
  };

  const messageMock = {
    id: 'msg_trap_trigger_42',
    author: { id: 'user_intruder_7', tag: 'Intruder#7777', bot: false },
    channel: honeypotTrap,
    guild,
    content: 'hello honeypot!',
    delete: async () => ({})
  };

  guild.members.fetch = async (id) => (id === 'user_intruder_7' ? memberMock : null);

  // Trigger honeypot enforcement
  const handled = await HoneypotService.handleMessage(messageMock);
  assert.equal(handled, true);

  // Verify two linked log records were dispatched
  assert.equal(hpChan._sentMessages.length, 1); // #honeypot-logs
  assert.equal(modChan._sentMessages.length, 1); // #mod-logs

  const hpEmbed = hpChan._sentMessages[0].embeds[0].toJSON();
  const modEmbed = modChan._sentMessages[0].embeds[0].toJSON();

  assert.equal(hpEmbed.title, '[Honeypot Security Event] Honeypot Trigger Detected');
  assert.ok(modEmbed.title.includes('Kick Member'));

  // Extract correlation IDs
  const hpCorr = hpEmbed.fields.find(f => f.name === 'Correlation ID')?.value;
  const modCorr = modEmbed.footer.text;

  assert.ok(hpCorr);
  assert.ok(modCorr);
  // Both records must contain the matching correlation ID
  const rawHpId = hpCorr.replace(/`/g, '');
  assert.ok(modCorr.includes(rawHpId));
});

test('Honeypot Retention: Cleans expired records in #honeypot-logs without deleting #mod-logs', async () => {
  HoneypotRetentionService.clear();

  const hpChan = createMockChannel('c_hp_expire', 'honeypot-logs');
  const modChan = createMockChannel('c_mod_permanent', 'mod-logs');
  const guild = createMockGuild('guild_retention_test', [hpChan, modChan]);

  // Send a Honeypot log message
  const hpMsg = await hpChan.send({ content: 'Temporary honeypot log evidence' });
  // Send a Moderation log message
  const modMsg = await modChan.send({ content: 'Permanent moderation audit entry' });

  // Record Honeypot message with an expired timestamp (now - 1000ms)
  const expiredNow = Date.now() - 1000;
  const rec = HoneypotRetentionService.recordLogMessage(guild.id, hpChan.id, hpMsg.id, 24, 'corr_test_exp');
  rec.expiresAt = expiredNow;
  HoneypotRetentionService.saveRecords();

  const mockClient = {
    user: { id: 'bot_honey' },
    guilds: {
      cache: new Map([[guild.id, guild]]),
      fetch: async () => guild
    }
  };

  // Run cleanup sweep
  const cleanupRes = await HoneypotRetentionService.cleanupExpired(mockClient);
  assert.equal(cleanupRes.cleaned, 1);

  // Honeypot log record is cleaned
  assert.equal(HoneypotRetentionService._records.size, 0);

  // Moderation message remains untouched
  assert.equal(modChan._sentMessages.length, 1);
  assert.equal(modChan._sentMessages[0].id, modMsg.id);
});

test('ModlogInterpreter: Interprets natural language requests for all three channels and retention', async () => {
  const interp = new ModlogInterpreter();

  // 1. Honeypot channel request
  const r1 = await interp.interpret('Use #honeypot-logs for temporary Honeypot evidence');
  assert.equal(r1.intent, 'configure_honeypot_channel');
  assert.equal(r1.targetChannel, '#honeypot-logs');

  // 2. Bot operations channel request
  const r2 = await interp.interpret('Send bot activity and role changes to #bot-logs');
  assert.equal(r2.intent, 'configure_bot_channel');
  assert.equal(r2.targetChannel, '#bot-logs');

  // 3. Honeypot retention request
  const r3 = await interp.interpret('Keep Honeypot logs for 48 hours');
  assert.equal(r3.intent, 'configure_honeypot_retention');
  assert.equal(r3.retentionHours, 48);

  // 4. Test all channels request
  const r4 = await interp.interpret('Test all three logging channels');
  assert.equal(r4.intent, 'test_all_channels');
});

