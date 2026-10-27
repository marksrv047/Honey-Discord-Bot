import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { ModLogService } from '../src/mod-log.js';

function createMockChannel(id, name, type = ChannelType.GuildText, botPerms = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]) {
  const permSet = new Set(botPerms);
  return {
    id,
    name,
    type,
    guildId: 'guild_123',
    permissionsFor: () => ({
      has: (flag) => permSet.has(flag)
    }),
    send: async (payload) => ({ id: `msg_${Date.now()}`, ...payload })
  };
}

function createMockGuild(id = 'guild_123', channels = []) {
  const channelMap = new Map(channels.map(c => [c.id, c]));
  return {
    id,
    name: 'Test Server',
    channels: {
      cache: channelMap,
      fetch: async (cId) => channelMap.get(cId) || null
    },
    members: {
      me: {
        id: 'bot_honey',
        permissions: {
          has: () => true
        }
      },
      fetchMe: async () => ({
        id: 'bot_honey',
        permissions: { has: () => true }
      })
    }
  };
}

test('ModLogService: Isolates configuration per guild and persists across reloads', () => {
  const guildA = 'guild_alpha_01';
  const guildB = 'guild_beta_02';

  // Configure guild A
  ModLogService.updateConfig(guildA, {
    channelId: 'channel_alpha',
    channelName: 'staff-logs',
    enabled: true,
    updatedBy: 'AdminAlpha'
  });

  // Configure guild B differently
  ModLogService.updateConfig(guildB, {
    channelId: 'channel_beta',
    channelName: 'mod-records',
    enabled: false,
    updatedBy: 'AdminBeta'
  });

  // Verify guild isolation
  const confA = ModLogService.getConfig(guildA);
  const confB = ModLogService.getConfig(guildB);

  assert.equal(confA.channelId, 'channel_alpha');
  assert.equal(confA.enabled, true);
  assert.equal(confA.updatedBy, 'AdminAlpha');

  assert.equal(confB.channelId, 'channel_beta');
  assert.equal(confB.enabled, false);
  assert.equal(confB.updatedBy, 'AdminBeta');

  // Reload cache from disk and verify persistence
  ModLogService.loadAllConfigs();
  const reloadedA = ModLogService.getConfig(guildA);
  assert.equal(reloadedA.channelId, 'channel_alpha');
  assert.equal(reloadedA.enabled, true);
});

test('ModLogService: Validates channel type and required bot permissions', async () => {
  const validChannel = createMockChannel('c1', 'mod-logs', ChannelType.GuildText);
  const voiceChannel = createMockChannel('c2', 'Voice Lounge', ChannelType.GuildVoice);
  const noEmbedChannel = createMockChannel('c3', 'restricted-logs', ChannelType.GuildText, [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages
    // Missing EmbedLinks
  ]);

  const guild = createMockGuild('guild_123', [validChannel, voiceChannel, noEmbedChannel]);

  // Valid channel should pass
  const validRes = await ModLogService.validateLogChannel(guild, 'c1');
  assert.equal(validRes.valid, true);
  assert.ok(validRes.channel);
  assert.equal(validRes.error, null);

  // Voice channel should fail
  const voiceRes = await ModLogService.validateLogChannel(guild, 'c2');
  assert.equal(voiceRes.valid, false);
  assert.ok(voiceRes.error.includes('not a text channel'));

  // Missing EmbedLinks should fail
  const noEmbedRes = await ModLogService.validateLogChannel(guild, 'c3');
  assert.equal(noEmbedRes.valid, false);
  assert.ok(noEmbedRes.error.includes('EmbedLinks'));

  // Non-existent channel should fail
  const missingRes = await ModLogService.validateLogChannel(guild, 'non_existent');
  assert.equal(missingRes.valid, false);
  assert.ok(missingRes.error.includes('not found'));
});

test('ModLogService: Disabling logging preserves previous valid channel', () => {
  const guildId = 'guild_preserve_test';

  ModLogService.updateConfig(guildId, {
    channelId: 'channel_safe',
    channelName: 'staff-logs',
    enabled: true,
    updatedBy: 'Owner'
  });

  const disableRes = ModLogService.disableLogging(guildId, 'Admin');
  assert.equal(disableRes.success, true);
  assert.equal(disableRes.config.enabled, false);
  assert.equal(disableRes.preservedChannelId, 'channel_safe');
  assert.equal(disableRes.preservedChannelName, 'staff-logs');

  const conf = ModLogService.getConfig(guildId);
  assert.equal(conf.enabled, false);
  assert.equal(conf.channelId, 'channel_safe');
});

test('ModLogService: Deduplicates gateway events against recent Honey Bot actions', () => {
  const guildId = 'guild_dedup_test';
  const action = 'ban_member';
  const targetId = 'user_target_999';

  // Initially not deduplicated
  assert.equal(ModLogService.isDeduplicated(guildId, action, targetId), false);

  // Bot executes action
  ModLogService.recordActionSignature(guildId, action, targetId);

  // External gateway event arrives within 15 seconds -> must be deduplicated
  assert.equal(ModLogService.isDeduplicated(guildId, action, targetId), true);

  // Different user is not deduplicated
  assert.equal(ModLogService.isDeduplicated(guildId, action, 'user_target_888'), false);
});

test('ModLogService: createModLogEmbed creates clean embed with all required audit fields', () => {
  const embed = ModLogService.createModLogEmbed({
    action: 'ban_member',
    actor: { id: 'admin_1', tag: 'ModAdmin#0001' },
    target: { id: 'bad_actor', tag: 'Troublemaker#1234' },
    reason: 'Repeated harassment in public lounge',
    outcome: 'succeeded',
    executionId: 'exec_test_abc',
    source: '/go'
  });

  const json = embed.toJSON();
  assert.equal(json.title, '[Moderation & Member Safety] Ban Member');

  const fields = json.fields;
  const modField = fields.find(f => f.name === 'Moderator');
  const targetField = fields.find(f => f.name === 'Target');
  const outcomeField = fields.find(f => f.name === 'Outcome');
  const reasonField = fields.find(f => f.name === 'Reason');

  assert.ok(modField.value.includes('ModAdmin#0001'));
  assert.ok(targetField.value.includes('Troublemaker#1234'));
  assert.equal(outcomeField.value, 'Completed');
  assert.equal(reasonField.value, 'Repeated harassment in public lounge');
  assert.ok(json.footer.text.includes('exec_test_abc'));
});
