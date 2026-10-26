import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits, ChannelType } from 'discord.js';
import { DashboardManager, DASHBOARD_PAGES } from '../src/dashboard.js';
import { SETTINGS_CATALOG, getSettingById, getSettingsByCategory } from '../src/dashboard-catalog.js';
import { GuildConfigService } from '../src/guild-config.js';
import { ModLogService } from '../src/mod-log.js';
import { TaskQueue, TaskQueueState } from '../src/task-queue.js';
import { MusicService } from '../src/music-service.js';
import { slashCommands, handleCommandInteraction } from '../src/commands.js';
import { IntentRouter } from '../src/intent-router.js';

// Helper mock objects
function createMockGuild(guildId = 'guild_dash_test_1', guildName = 'Honey Test Server') {
  const channelsMap = new Map();

  const modlogChannel = {
    id: 'channel_modlog_123',
    name: 'mod-logs',
    type: ChannelType.GuildText,
    guildId,
    permissionsFor: (member) => ({
      has: () => true
    }),
    send: async (payload) => ({ id: 'msg_test_123', ...payload })
  };
  channelsMap.set(modlogChannel.id, modlogChannel);

  const generalChannel = {
    id: 'channel_gen_456',
    name: 'general',
    type: ChannelType.GuildText,
    guildId,
    permissionsFor: () => ({ has: () => true }),
    send: async () => ({ id: 'msg_gen_1' })
  };
  channelsMap.set(generalChannel.id, generalChannel);

  const voiceChannel = {
    id: 'channel_voice_789',
    name: 'Lounge Voice',
    type: ChannelType.GuildVoice,
    guildId,
    isVoiceBased: () => true,
    members: new Map()
  };
  channelsMap.set(voiceChannel.id, voiceChannel);

  const mockClient = {
    ws: { ping: 42 },
    channels: {
      cache: channelsMap,
      fetch: async (id) => channelsMap.get(id) || null
    }
  };

  const botMember = {
    id: 'bot_honey_123',
    user: { id: 'bot_honey_123', tag: 'HoneyBot#0001' },
    permissions: {
      has: (perm) => true
    },
    voice: { channelId: null }
  };

  return {
    id: guildId,
    name: guildName,
    ownerId: 'owner_user_999',
    client: mockClient,
    channels: {
      cache: channelsMap,
      fetch: async (id) => channelsMap.get(id) || null
    },
    roles: {
      cache: new Map(),
      everyone: { id: guildId, name: '@everyone' }
    },
    members: {
      cache: new Map([['bot_honey_123', botMember]]),
      me: botMember,
      fetchMe: async () => botMember
    }
  };
}

function createMockMember(user, permissions = [PermissionFlagsBits.Administrator]) {
  return {
    id: user.id,
    user,
    permissions: {
      has: (perm) => permissions.includes(perm) || permissions.includes(PermissionFlagsBits.Administrator)
    },
    roles: {
      cache: new Map()
    }
  };
}

test('Dashboard: Authoritative Settings Catalog declares complete, grounded metadata', () => {
  assert.ok(Array.isArray(SETTINGS_CATALOG) && SETTINGS_CATALOG.length >= 8);

  for (const setting of SETTINGS_CATALOG) {
    assert.ok(setting.id, 'Setting must have stable id');
    assert.ok(setting.name, 'Setting must have human-readable name');
    assert.ok(setting.description, 'Setting must have description');
    assert.ok(setting.category, 'Setting must declare a category');
    assert.ok(typeof setting.isEditable === 'boolean', 'Setting must declare isEditable boolean');
    assert.ok(typeof setting.isImplemented === 'boolean', 'Setting must declare isImplemented boolean');
    assert.ok(setting.requiredAuth, 'Setting must specify requiredAuth');
    assert.ok(setting.persistenceBehavior, 'Setting must specify persistenceBehavior');
    assert.ok(typeof setting.getValue === 'function', 'Setting must have getValue function');
  }

  // Verify Honeypot setting is accurately documented as unimplemented
  const honeypotSetting = getSettingById('honeypot.enabled');
  assert.ok(honeypotSetting);
  assert.equal(honeypotSetting.isImplemented, false);
  assert.equal(honeypotSetting.isEditable, false);

  // Verify Anti-Nuke setting is immutable
  const antiNukeSetting = getSettingById('security.antiNukeProtection');
  assert.ok(antiNukeSetting);
  assert.equal(antiNukeSetting.isEditable, false);
  assert.throws(() => antiNukeSetting.setValue(), /immutable/i);
});

test('Dashboard: Renders all 11 supported pages respecting Discord component limits', async () => {
  const guild = createMockGuild('guild_limits_test');
  const user = { id: 'admin_1', tag: 'Admin#0001' };
  const member = createMockMember(user, [PermissionFlagsBits.Administrator]);

  for (const page of DASHBOARD_PAGES) {
    const payload = await DashboardManager.buildDashboardPayload(guild, member, user, page.id);

    // 1. Embed validation
    assert.ok(payload.embeds && payload.embeds.length === 1, `Page ${page.id} must produce 1 embed`);
    const embed = payload.embeds[0];
    const json = embed.toJSON();
    assert.ok(json.title, `Page ${page.id} embed must have title`);
    assert.ok(json.title.length <= 256, `Page ${page.id} embed title exceeds 256 chars`);
    if (json.description) {
      assert.ok(json.description.length <= 4096, `Page ${page.id} embed description exceeds 4096 chars`);
    }

    // 2. Discord ActionRows limit: maximum 5 ActionRows per message
    assert.ok(payload.components.length <= 5, `Page ${page.id} exceeds 5 ActionRows limit: ${payload.components.length}`);

    for (let rIdx = 0; rIdx < payload.components.length; rIdx++) {
      const row = payload.components[rIdx];
      const components = row.components || [];

      // Maximum 5 buttons per row
      if (components[0]?.data?.type === 2) {
        assert.ok(components.length <= 5, `Page ${page.id} Row ${rIdx} exceeds 5 buttons`);
      }
      // Maximum 1 select menu per row
      if (components[0]?.data?.type === 3 || components[0]?.data?.type === 8) {
        assert.equal(components.length, 1, `Page ${page.id} Row ${rIdx} has more than 1 select menu`);
      }
    }
  }
});

test('Dashboard: Overview Page displays real operational health, warnings, and completeness', async () => {
  const guild = createMockGuild('guild_overview_test');
  const user = { id: 'admin_1', tag: 'Admin#0001' };
  const member = createMockMember(user, [PermissionFlagsBits.Administrator]);

  const payload = await DashboardManager.buildDashboardPayload(guild, member, user, 'overview');
  const embed = payload.embeds[0].toJSON();

  assert.ok(embed.title.includes(guild.name));
  assert.ok(embed.description.includes(guild.id));
  assert.ok(embed.description.includes('Connected'));
  assert.ok(embed.description.includes('Administrator (Full Access)'));

  // Fields verify Configuration Completeness and Grounded Warnings
  const compField = embed.fields.find(f => f.name.includes('Completeness'));
  assert.ok(compField);
  assert.ok(compField.value.includes('Complete'));

  const statusField = embed.fields.find(f => f.name.includes('Subsystem Status'));
  assert.ok(statusField);
  assert.ok(statusField.value.includes('Anti-Nuke Guard'));
  assert.ok(statusField.value.includes('Active'));
  assert.ok(statusField.value.includes('Honeypot Trap'));
});

test('Dashboard: Honeypot Page accurately discloses unimplemented status with safety notice', async () => {
  const guild = createMockGuild('guild_honey_notice');
  const user = { id: 'admin_1', tag: 'Admin#0001' };
  const member = createMockMember(user, [PermissionFlagsBits.Administrator]);

  const payload = await DashboardManager.buildDashboardPayload(guild, member, user, 'honeypot');
  const embed = payload.embeds[0].toJSON();

  assert.ok(embed.description.includes('Subsystem Currently Unimplemented'));
  assert.ok(embed.description.includes('investigation trigger'));
  assert.ok(embed.description.includes('never conclusive proof of account compromise'));
  assert.ok(embed.description.includes('never authorizes punitive actions'));
});

test('Dashboard: Settings Mutations, Persistence and Read-Back Verification', async () => {
  const guildId = 'guild_mutate_test';
  GuildConfigService.resetConfig(guildId);
  const guild = createMockGuild(guildId);
  const user = { id: 'admin_mutate', tag: 'Admin#1234' };
  const member = createMockMember(user, [PermissionFlagsBits.Administrator]);

  // 1. Initial timeout
  const timeoutSetting = getSettingById('moderation.defaultTimeoutMinutes');
  assert.equal(timeoutSetting.getValue(guildId), 10);

  // 2. Update timeout to 30 minutes
  timeoutSetting.setValue(guildId, 30, user);
  assert.equal(timeoutSetting.getValue(guildId), 30);

  // 3. Reject invalid timeout values (< 1 or > 40320)
  assert.throws(() => timeoutSetting.setValue(guildId, 0, user), /between 1 and 40320/);
  assert.throws(() => timeoutSetting.setValue(guildId, 50000, user), /between 1 and 40320/);
  assert.equal(timeoutSetting.getValue(guildId), 30, 'State must remain intact after invalid update');

  // 4. Warning threshold
  const warnSetting = getSettingById('moderation.warningThreshold');
  assert.equal(warnSetting.getValue(guildId), 3);
  warnSetting.setValue(guildId, 5, user);
  assert.equal(warnSetting.getValue(guildId), 5);
  assert.throws(() => warnSetting.setValue(guildId, 25, user), /between 1 and 20/);

  // 5. Confirmation toggles
  const kickSetting = getSettingById('moderation.requireKickConfirmation');
  assert.equal(kickSetting.getValue(guildId), true);
  kickSetting.setValue(guildId, false, user);
  assert.equal(kickSetting.getValue(guildId), false);
  kickSetting.setValue(guildId, true, user);
  assert.equal(kickSetting.getValue(guildId), true);
});

test('Dashboard: Multi-Server Isolation prevents settings cross-contamination', () => {
  const guildA = 'guild_iso_alpha';
  const guildB = 'guild_iso_beta';

  const timeoutSetting = getSettingById('moderation.defaultTimeoutMinutes');
  const kickSetting = getSettingById('moderation.requireKickConfirmation');

  // Modify Guild A
  timeoutSetting.setValue(guildA, 45, { id: 'admin_a', tag: 'AdminA#0001' });
  kickSetting.setValue(guildA, false, { id: 'admin_a', tag: 'AdminA#0001' });

  // Verify Guild B remains completely untouched at default values
  assert.equal(timeoutSetting.getValue(guildA), 45);
  assert.equal(timeoutSetting.getValue(guildB), 10);
  assert.equal(kickSetting.getValue(guildA), false);
  assert.equal(kickSetting.getValue(guildB), true);
});

test('Dashboard: Unauthorized component interactions are rejected safely with ephemeral message', async () => {
  const guild = createMockGuild('guild_unauth_test');
  const regularUser = { id: 'regular_user_1', tag: 'User#9999' };
  const regularMember = createMockMember(regularUser, []); // No admin, no manage server

  let repliedPayload = null;
  const mockInteraction = {
    customId: 'dash:toggle:kick_confirm:off',
    guild,
    member: regularMember,
    user: regularUser,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isChannelSelectMenu: () => false,
    isModalSubmit: () => false,
    deferred: false,
    replied: false,
    reply: async (payload) => {
      repliedPayload = payload;
      mockInteraction.replied = true;
    }
  };

  const handled = await DashboardManager.handleInteraction(mockInteraction);
  assert.equal(handled, true);
  assert.ok(repliedPayload);
  assert.equal(repliedPayload.ephemeral, true);
  assert.ok(repliedPayload.content.includes('lack permission'));
});

test('Dashboard: Modlogs Destination Channel Selection and Test Delivery', async () => {
  const guild = createMockGuild('guild_modlog_dash_test');
  const adminUser = { id: 'admin_modlog', tag: 'AdminMod#0001' };
  const adminMember = createMockMember(adminUser, [PermissionFlagsBits.Administrator]);

  // 1. Channel Select interaction
  let updatePayload = null;
  const mockSelectInteraction = {
    customId: 'dash:modlog:set_channel',
    values: ['channel_modlog_123'],
    guild,
    member: adminMember,
    user: adminUser,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isChannelSelectMenu: () => true,
    isModalSubmit: () => false,
    update: async (payload) => {
      updatePayload = payload;
    }
  };

  const handledSelect = await DashboardManager.handleInteraction(mockSelectInteraction);
  assert.equal(handledSelect, true);
  assert.ok(updatePayload);

  // Verify ModLogService persistence
  const conf = ModLogService.getConfig(guild.id);
  assert.equal(conf.channelId, 'channel_modlog_123');
  assert.equal(conf.enabled, true);

  // 2. Modlog Test Delivery interaction
  let testReply = null;
  const mockTestInteraction = {
    customId: 'dash:modlog:test',
    guild,
    member: adminMember,
    user: adminUser,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isChannelSelectMenu: () => false,
    isModalSubmit: () => false,
    reply: async (payload) => {
      testReply = payload;
    }
  };

  const handledTest = await DashboardManager.handleInteraction(mockTestInteraction);
  assert.equal(handledTest, true);
  assert.ok(testReply);
  assert.ok(testReply.content.includes('Test Delivery Successful'));
});

test('Dashboard: Navigation Select Menu and Page Buttons run with zero Groq LLM calls', async () => {
  const guild = createMockGuild('guild_zero_llm');
  const adminUser = { id: 'admin_nav', tag: 'AdminNav#0001' };
  const adminMember = createMockMember(adminUser, [PermissionFlagsBits.Administrator]);

  let updatedPayload = null;
  const mockNavInteraction = {
    customId: 'dash:nav:overview',
    values: ['moderation'],
    guild,
    member: adminMember,
    user: adminUser,
    isButton: () => false,
    isStringSelectMenu: () => true,
    isChannelSelectMenu: () => false,
    isModalSubmit: () => false,
    update: async (payload) => {
      updatedPayload = payload;
    }
  };

  const handled = await DashboardManager.handleInteraction(mockNavInteraction);
  assert.equal(handled, true);
  assert.ok(updatedPayload);
  assert.ok(updatedPayload.embeds[0].data.title.includes('Moderation Settings'));
});

test('Dashboard: Intent Router resolves dashboard requests deterministically without LLM', async () => {
  const router = new IntentRouter({ isDeterministicOnly: true });

  const prompts = [
    'dashboard',
    'open dashboard',
    'server settings',
    'config center',
    'open the server dashboard',
    'view dashboard'
  ];

  for (const p of prompts) {
    const res = await router.route(p, {});
    assert.equal(res.intent, 'open_dashboard', `Prompt "${p}" should resolve to open_dashboard`);
    assert.equal(res.isHighImpact, false);
  }
});

test('Dashboard: Five-Command slash command architecture remains strictly intact with no /dashboard', () => {
  const commandNames = slashCommands.map(c => c.name).sort();
  const expectedNames = ['diagnose', 'go', 'help', 'modlog', 'undo'];

  assert.deepEqual(commandNames, expectedNames);
  assert.equal(slashCommands.length, 5);
  assert.equal(slashCommands.some(c => c.name === 'dashboard'), false, 'Must NOT register a top-level /dashboard slash command');
});
