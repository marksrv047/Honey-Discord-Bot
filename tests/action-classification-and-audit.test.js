import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import {
  ActionRegistry,
  FunctionalCategory,
  EventSource,
  OutcomeState,
  VerificationStatus,
  ACTION_DEFINITIONS,
  LEGACY_ACTION_MAPPINGS
} from '../src/action-registry.js';
import { ModLogService } from '../src/mod-log.js';
import { CapabilityRegistry } from '../src/capabilities.js';

// Mock helpers for isolated Discord guilds and channels
function createMockChannel(id, name, type = ChannelType.GuildText) {
  const messagesSent = [];
  return {
    id,
    name,
    type,
    guildId: 'guild_test',
    permissionsFor: () => ({
      has: () => true
    }),
    send: async (payload) => {
      messagesSent.push(payload);
      return { id: `msg_${Date.now()}_${messagesSent.length}`, ...payload };
    },
    _getSentMessages: () => messagesSent
  };
}

function createMockGuild(id = 'guild_test', channels = []) {
  const channelMap = new Map(channels.map(c => [c.id, c]));
  return {
    id,
    name: `Guild_${id}`,
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

// =============================================================================
// SCENARIO 1: Music play initiated through /go
// =============================================================================
test('Scenario 1: Music play initiated through /go is classified as Music & Voice, not Moderation', () => {
  const classified = ActionRegistry.classify('music_play', { source: '/go' });
  assert.equal(classified.category, FunctionalCategory.MUSIC_VOICE);
  assert.equal(classified.displayName, 'Music Play');
  assert.equal(classified.originatingCommand, '/go');

  const sourceMeta = ActionRegistry.normalizeEventSource('/go');
  assert.equal(sourceMeta.eventSource, EventSource.BOT_COMMAND);
  assert.equal(sourceMeta.interfaceName, 'Slash Command (/go)');

  const embed = ModLogService.createModLogEmbed({
    action: 'music_play',
    actor: { id: 'dj_user', tag: 'MusicLover#1234' },
    target: { id: 'vc_general', name: 'Lofi Lounge', type: 2 },
    reason: 'Chilled beats stream',
    outcome: 'succeeded',
    source: '/go',
    executionId: 'exec_music_go_1'
  });

  const json = embed.toJSON();
  assert.equal(json.title, '[Music & Voice] Music Play');
  assert.ok(!json.title.includes('Moderation'), 'Must never contain Moderation in title');

  // Initiator must be labeled "Initiated by", NOT "Moderator"
  const initiatorField = json.fields.find(f => f.name === 'Initiated by');
  assert.ok(initiatorField, 'Actor field must be "Initiated by" for music actions');
  assert.ok(initiatorField.value.includes('MusicLover#1234'));
  assert.equal(json.fields.find(f => f.name === 'Moderator'), undefined, 'Must not have a Moderator field');

  // Category field
  const catField = json.fields.find(f => f.name === 'Category');
  assert.ok(catField);
  assert.equal(catField.value, 'Music & Voice');

  // Audio green color (0x1DB954 = 1948084)
  assert.equal(json.color, 0x1DB954);
});

// =============================================================================
// SCENARIO 2: Music play initiated through a dedicated command
// =============================================================================
test('Scenario 2: Music play initiated through dedicated command retains Music & Voice and records dedicated command source', () => {
  const dedicatedSource = '/play';
  const classified = ActionRegistry.classify('music_play', { source: dedicatedSource });
  assert.equal(classified.category, FunctionalCategory.MUSIC_VOICE);

  const sourceMeta = ActionRegistry.normalizeEventSource(dedicatedSource);
  assert.equal(sourceMeta.eventSource, EventSource.BOT_COMMAND);
  assert.equal(sourceMeta.originatingCommand, '/play');
  assert.equal(sourceMeta.interfaceName, 'Slash Command (/play)');

  const embed = ModLogService.createModLogEmbed({
    action: 'music_play',
    actor: { id: 'user_456', tag: 'SongMaster#0001' },
    target: 'Synthwave Radio',
    reason: 'Direct play command',
    outcome: 'succeeded',
    source: dedicatedSource,
    executionId: 'exec_direct_play_1'
  });

  const json = embed.toJSON();
  assert.equal(json.title, '[Music & Voice] Music Play');

  const sourceField = json.fields.find(f => f.name === 'Event Source');
  assert.ok(sourceField);
  assert.equal(sourceField.value, 'Bot Command Execution');
  assert.ok(json.footer.text.includes('Slash Command (/play)'));
});

// =============================================================================
// SCENARIO 3: Moderation actions initiated through /go
// =============================================================================
test('Scenario 3: Moderation actions initiated through /go are classified as Moderation & Member Safety and attribute Moderator', () => {
  const modActions = [
    { action: 'timeout_member', expectedTitle: 'Timeout Member' },
    { action: 'kick_member', expectedTitle: 'Kick Member' },
    { action: 'ban_member', expectedTitle: 'Ban Member' }
  ];

  for (const { action, expectedTitle } of modActions) {
    const classified = ActionRegistry.classify(action, { source: '/go' });
    assert.equal(classified.category, FunctionalCategory.MODERATION_SAFETY);
    assert.equal(classified.displayName, expectedTitle);

    const embed = ModLogService.createModLogEmbed({
      action,
      actor: { id: 'mod_1', tag: 'ChiefEnforcer#9999' },
      target: { id: 'violator_1', tag: 'BadUser#0404' },
      reason: 'Rule 3 violation - Spamming links',
      outcome: 'succeeded',
      source: '/go',
      executionId: `exec_${action}_1`
    });

    const json = embed.toJSON();
    assert.equal(json.title, `[Moderation & Member Safety] ${expectedTitle}`);

    // Moderation actions must attribute to "Moderator"
    const modField = json.fields.find(f => f.name === 'Moderator');
    assert.ok(modField, `Action ${action} must have a "Moderator" field`);
    assert.ok(modField.value.includes('ChiefEnforcer#9999'));

    const catField = json.fields.find(f => f.name === 'Category');
    assert.equal(catField.value, 'Moderation & Member Safety');
  }
});

// =============================================================================
// SCENARIO 4: Channel and role operations
// =============================================================================
test('Scenario 4: Channel and role operations are correctly classified into Channel Management and Roles & Permissions', () => {
  // Channel operations
  const channelActions = ['create_channel', 'delete_channel', 'rename_channel', 'lock_channel', 'create_category'];
  for (const act of channelActions) {
    const classified = ActionRegistry.classify(act);
    assert.equal(classified.category, FunctionalCategory.CHANNEL_MANAGEMENT, `${act} must be Channel Management`);

    const embed = ModLogService.createModLogEmbed({
      action: act,
      actor: { id: 'admin_1', tag: 'ServerAdmin#1111' },
      target: { id: 'ch_444', name: 'announcements', type: 0 },
      reason: 'Channel maintenance',
      outcome: 'succeeded',
      source: '/go'
    });

    const json = embed.toJSON();
    assert.ok(json.title.startsWith('[Channel Management]'));
    assert.ok(!json.title.includes('Moderation'));
    assert.ok(json.fields.some(f => f.name === 'Initiated by'));
  }

  // Role operations
  const roleActions = ['create_role', 'delete_role', 'assign_role', 'remove_role', 'set_channel_permission'];
  for (const act of roleActions) {
    const classified = ActionRegistry.classify(act);
    assert.equal(classified.category, FunctionalCategory.ROLES_PERMISSIONS, `${act} must be Roles & Permissions`);

    const embed = ModLogService.createModLogEmbed({
      action: act,
      actor: { id: 'admin_1', tag: 'ServerAdmin#1111' },
      target: { id: 'role_555', name: 'VIP Members' },
      reason: 'Role restructuring',
      outcome: 'succeeded',
      source: '/go'
    });

    const json = embed.toJSON();
    assert.ok(json.title.startsWith('[Roles & Permissions]'));
    assert.ok(!json.title.includes('Moderation'));
    assert.ok(json.fields.some(f => f.name === 'Initiated by'));
  }
});

// =============================================================================
// SCENARIO 5: Embed publication
// =============================================================================
test('Scenario 5: Embed publication is classified as Messages & Embeds', () => {
  const embedActions = ['publish_embed', 'create_embed', 'send_announcement'];
  for (const act of embedActions) {
    const classified = ActionRegistry.classify(act);
    assert.equal(classified.category, FunctionalCategory.MESSAGES_EMBEDS, `${act} must be Messages & Embeds`);

    const embed = ModLogService.createModLogEmbed({
      action: act,
      actor: { id: 'comm_lead', tag: 'CommunityLead#0007' },
      target: { id: 'ch_info', name: 'server-info', type: 0 },
      reason: 'Publishing rules and onboarding guide',
      outcome: 'succeeded',
      source: '/go'
    });

    const json = embed.toJSON();
    assert.ok(json.title.startsWith('[Messages & Embeds]'));
    assert.ok(!json.title.includes('Moderation'));

    const catField = json.fields.find(f => f.name === 'Category');
    assert.equal(catField.value, 'Messages & Embeds');
  }
});

// =============================================================================
// SCENARIO 6: Help requests that must not execute mutations
// =============================================================================
test('Scenario 6: Help and informational inquiries are marked non-mutating and do not record moderation actions', () => {
  const helpActions = ['help_inquiry', 'conversational', 'show_help'];
  for (const act of helpActions) {
    const classified = ActionRegistry.classify(act);
    assert.ok(
      classified.category === FunctionalCategory.GENERAL_UTILITIES ||
      classified.category === FunctionalCategory.DIAGNOSTICS_RECOVERY
    );
    assert.notEqual(classified.category, FunctionalCategory.MODERATION_SAFETY);
  }

  // Capability matrix verification
  const readOnlyActions = ['list_channels', 'list_roles', 'search_messages', 'inspect_category'];
  for (const actId of readOnlyActions) {
    const cap = CapabilityRegistry.get(actId);
    if (cap) {
      const auth = CapabilityRegistry.toAuthoritative(cap);
      assert.equal(auth.isMutating, false, `${actId} must be non-mutating`);
      assert.notEqual(auth.functionalCategory, FunctionalCategory.MODERATION_SAFETY);
    }
  }
});

// =============================================================================
// SCENARIO 7: External Discord events
// =============================================================================
test('Scenario 7: External Discord events attribute "External Actor" while preserving real functional category', () => {
  const sourceMeta = ActionRegistry.normalizeEventSource('gateway_event');
  assert.equal(sourceMeta.eventSource, EventSource.EXTERNAL_EVENT);
  assert.equal(sourceMeta.interfaceName, 'External Discord Administrative Event');

  // 1. External channel creation
  const chEmbed = ModLogService.createModLogEmbed({
    action: 'channel_create',
    actor: { id: 'external_admin', tag: 'OwnerOutsideBot#0001' },
    target: { id: 'ch_ext_1', name: 'new-discussion' },
    reason: 'Created via Discord Mobile Client',
    outcome: 'succeeded',
    source: 'gateway_event'
  });
  const chJson = chEmbed.toJSON();
  assert.equal(chJson.title, '[Channel Management] Create Channel');
  const extActorField = chJson.fields.find(f => f.name === 'External Actor');
  assert.ok(extActorField, 'Actor must be labeled "External Actor"');
  assert.ok(extActorField.value.includes('OwnerOutsideBot#0001'));

  // 2. External member kick
  const kickEmbed = ModLogService.createModLogEmbed({
    action: 'kick_member',
    actor: { id: 'admin_direct', tag: 'DirectAdmin#0002' },
    target: { id: 'bad_user', tag: 'Spammer#3333' },
    reason: 'Kicked via Discord Desktop UI',
    outcome: 'succeeded',
    source: 'gateway_event'
  });
  const kickJson = kickEmbed.toJSON();
  assert.equal(kickJson.title, '[Moderation & Member Safety] Kick Member');
  const kickExtActor = kickJson.fields.find(f => f.name === 'External Actor');
  assert.ok(kickExtActor, 'Actor must be labeled "External Actor" even for moderation actions when from gateway');
});

// =============================================================================
// SCENARIO 8: Actions with missing or unknown metadata
// =============================================================================
test('Scenario 8: Actions with missing or unknown metadata fall back to neutral Unclassified, NEVER Moderation', () => {
  const unknownActions = ['nonexistent_action_xyz', 'custom_plugin_foo', '', null, undefined];

  for (const unk of unknownActions) {
    const classified = ActionRegistry.classify(unk);
    assert.equal(classified.category, FunctionalCategory.UNCLASSIFIED);
    assert.notEqual(classified.category, FunctionalCategory.MODERATION_SAFETY, 'Must never fall back to Moderation');
    assert.equal(classified.sourceResolution, 'unclassified_fallback');

    const embed = ModLogService.createModLogEmbed({
      action: unk,
      actor: { id: 'user_test', tag: 'Tester#0000' },
      outcome: 'succeeded'
    });
    const json = embed.toJSON();
    assert.ok(json.title.startsWith('[Unclassified]'), `Title "${json.title}" must start with [Unclassified]`);
    assert.ok(!json.title.includes('Moderation'), 'Must never contain Moderation');

    const catField = json.fields.find(f => f.name === 'Category');
    assert.equal(catField.value, 'Unclassified');

    const modField = json.fields.find(f => f.name === 'Moderator');
    assert.equal(modField, undefined, 'Must not attribute to Moderator for unclassified action');
  }
});

// =============================================================================
// SCENARIO 9: Partial multi-step failures
// =============================================================================
test('Scenario 9: Partial multi-step failures report truthful outcome and Partially Verified status', () => {
  const multiActionData = {
    action: 'multi_action',
    outcome: 'partially_completed',
    verified: false,
    actor: { id: 'admin_planner', tag: 'Planner#1111' },
    target: 'Multi-Action Execution (2 steps)',
    reason: 'Setup onboarding category and channels',
    details: 'Step 1 (create_category) succeeded; Step 2 (create_channel) failed: Channel limit exceeded'
  };

  const truthful = ActionRegistry.determineTruthfulOutcome(multiActionData, 'MUTATION_STATE_CHECK');
  assert.equal(truthful.outcome, OutcomeState.PARTIALLY_COMPLETED);
  assert.equal(truthful.verificationStatus, VerificationStatus.PARTIALLY_VERIFIED);
  assert.equal(truthful.isVerified, false);

  const embed = ModLogService.createModLogEmbed(multiActionData);
  const json = embed.toJSON();

  const outcomeField = json.fields.find(f => f.name === 'Outcome' || f.name === 'Result');
  assert.ok(outcomeField);
  assert.equal(outcomeField.value, 'Partially completed');

  const verField = json.fields.find(f => f.name === 'Verification Status');
  assert.ok(verField);
  assert.equal(verField.value, 'Partially Verified');

  // Orange alert color (0xE67E22 = 15105570)
  assert.equal(json.color, 0xE67E22);
});

// =============================================================================
// SCENARIO 10: Legacy logging compatibility
// =============================================================================
test('Scenario 10: Legacy action aliases map correctly and legacy event filter tokens match modern categories', () => {
  // Legacy aliases map accurately
  const legacyChecks = [
    { legacy: 'play', expectedCanonical: 'music_play', expectedCat: FunctionalCategory.MUSIC_VOICE },
    { legacy: 'timeout', expectedCanonical: 'timeout_member', expectedCat: FunctionalCategory.MODERATION_SAFETY },
    { legacy: 'ban', expectedCanonical: 'ban_member', expectedCat: FunctionalCategory.MODERATION_SAFETY },
    { legacy: 'channel_rename', expectedCanonical: 'rename_channel', expectedCat: FunctionalCategory.CHANNEL_MANAGEMENT },
    { legacy: 'role_create', expectedCanonical: 'create_role', expectedCat: FunctionalCategory.ROLES_PERMISSIONS },
    { legacy: 'announce', expectedCanonical: 'send_announcement', expectedCat: FunctionalCategory.MESSAGES_EMBEDS }
  ];

  for (const { legacy, expectedCanonical, expectedCat } of legacyChecks) {
    const classified = ActionRegistry.classify(legacy);
    assert.equal(classified.canonicalName, expectedCanonical, `Legacy ${legacy} must resolve to canonical ${expectedCanonical}`);
    assert.equal(classified.category, expectedCat, `Legacy ${legacy} must resolve to category ${expectedCat}`);
  }

  // Legacy preference filter matching
  // A guild configured with legacy lowercase filter ['channels', 'roles'] should match modern categories
  const legacyFilter = ['channels', 'roles'];
  assert.equal(ModLogService.matchesEventFilter(legacyFilter, FunctionalCategory.CHANNEL_MANAGEMENT, 'create_channel'), true);
  assert.equal(ModLogService.matchesEventFilter(legacyFilter, FunctionalCategory.ROLES_PERMISSIONS, 'assign_role'), true);
  assert.equal(ModLogService.matchesEventFilter(legacyFilter, FunctionalCategory.MUSIC_VOICE, 'music_play'), false);
  assert.equal(ModLogService.matchesEventFilter(legacyFilter, FunctionalCategory.MODERATION_SAFETY, 'ban_member'), false);

  // Modern category list filtering
  const modernFilter = [FunctionalCategory.MUSIC_VOICE, FunctionalCategory.MESSAGES_EMBEDS];
  assert.equal(ModLogService.matchesEventFilter(modernFilter, FunctionalCategory.MUSIC_VOICE, 'music_play'), true);
  assert.equal(ModLogService.matchesEventFilter(modernFilter, FunctionalCategory.CHANNEL_MANAGEMENT, 'create_channel'), false);
});

// =============================================================================
// SCENARIO 11: Concurrent actions across separate guilds
// =============================================================================
test('Scenario 11: Concurrent actions across separate guilds maintain isolated configurations and audit deliveries', async () => {
  const guildMusic = 'guild_concurrent_music';
  const guildMod = 'guild_concurrent_mod';
  const guildChan = 'guild_concurrent_chan';

  const chMusic = createMockChannel('ch_music_logs', 'music-audit');
  const chMod = createMockChannel('ch_mod_logs', 'mod-audit');
  const chChan = createMockChannel('ch_chan_logs', 'server-audit');

  const mockGuildMusic = createMockGuild(guildMusic, [chMusic]);
  const mockGuildMod = createMockGuild(guildMod, [chMod]);
  const mockGuildChan = createMockGuild(guildChan, [chChan]);

  // Setup distinct configurations
  ModLogService.updateConfig(guildMusic, {
    channelId: chMusic.id,
    enabled: true,
    preferences: { filterEvents: [FunctionalCategory.MUSIC_VOICE] }
  });

  ModLogService.updateConfig(guildMod, {
    channelId: chMod.id,
    enabled: true,
    preferences: { filterEvents: [FunctionalCategory.MODERATION_SAFETY] }
  });

  ModLogService.updateConfig(guildChan, {
    channelId: chChan.id,
    enabled: true,
    preferences: { filterEvents: [FunctionalCategory.CHANNEL_MANAGEMENT] }
  });

  // Execute concurrent logAction calls
  await Promise.all([
    ModLogService.logAction(mockGuildMusic, {
      action: 'music_play',
      actor: { id: 'dj_1', tag: 'DJ1#0001' },
      target: 'Lo-Fi Chill',
      outcome: 'succeeded',
      source: '/go'
    }),
    ModLogService.logAction(mockGuildMod, {
      action: 'ban_member',
      actor: { id: 'admin_1', tag: 'Admin1#0001' },
      target: { id: 'bad_1', tag: 'Bad1#0001' },
      outcome: 'succeeded',
      source: '/go'
    }),
    ModLogService.logAction(mockGuildChan, {
      action: 'create_channel',
      actor: { id: 'admin_2', tag: 'Admin2#0002' },
      target: { id: 'ch_new', name: 'gaming-chat' },
      outcome: 'succeeded',
      source: '/go'
    })
  ]);

  // Assert Guild Music only received Music entry
  const musicMessages = chMusic._getSentMessages();
  assert.equal(musicMessages.length, 1);
  const musicEmbed = musicMessages[0].embeds[0].toJSON();
  assert.equal(musicEmbed.title, '[Music & Voice] Music Play');

  // Assert Guild Mod only received Moderation entry
  const modMessages = chMod._getSentMessages();
  assert.equal(modMessages.length, 1);
  const modEmbed = modMessages[0].embeds[0].toJSON();
  assert.equal(modEmbed.title, '[Moderation & Member Safety] Ban Member');

  // Assert Guild Chan only received Channel Management entry
  const chanMessages = chChan._getSentMessages();
  assert.equal(chanMessages.length, 1);
  const chanEmbed = chanMessages[0].embeds[0].toJSON();
  assert.equal(chanEmbed.title, '[Channel Management] Create Channel');
});
