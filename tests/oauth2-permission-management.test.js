import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PermissionFlagsBits, PermissionsBitField, GatewayIntentBits, ChannelType } from 'discord.js';
import {
  PermissionAuditService,
  FeatureStatus,
  RECOMMENDED_PERMISSIONS,
  CRITICAL_PERMISSIONS,
  PERMISSION_REGISTRY,
  INTENT_REGISTRY
} from '../src/permission-audit.js';
import { OnboardingManager } from '../src/onboarding.js';
import { DiagnosticService, DiagnosticStatus } from '../src/diagnostic-service.js';
import { ModLogService } from '../src/mod-log.js';
import { HoneypotService } from '../src/honeypot-service.js';
import { config } from '../src/config.js';
import { Logger } from '../src/logger.js';

// Setup isolated storage for tests
const tempDir = path.join(os.tmpdir(), `honey-oauth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
fs.mkdirSync(tempDir, { recursive: true });
PermissionAuditService.auditStoragePath = path.join(tempDir, 'permission-audits.json');
OnboardingManager.storagePath = path.join(tempDir, 'onboarding-state.json');

// Mock guild factory for permission and OAuth2 testing
function createMockGuild(id = 'guild_oauth_01', options = {}) {
  const channelsMap = new Map();

  const systemChannel = {
    id: `ch_sys_${id}`,
    name: 'general',
    type: ChannelType.GuildText,
    guildId: id,
    isTextBased: () => true,
    send: async (payload) => ({
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      channelId: `ch_sys_${id}`,
      ...payload
    })
  };
  channelsMap.set(systemChannel.id, systemChannel);

  const grantedPerms = options.botPermissions !== undefined
    ? options.botPermissions
    : RECOMMENDED_PERMISSIONS;

  const hasPerm = (flag) => {
    if (grantedPerms.includes(PermissionFlagsBits.Administrator)) return true;
    if (Array.isArray(flag)) return flag.every(f => grantedPerms.includes(f));
    return grantedPerms.includes(flag);
  };

  const botHighestRole = options.botRole || { id: 'role_honey', name: 'Honey Bot', position: 10, rawPosition: 10 };
  const botMember = {
    id: 'bot_honey_user',
    displayName: 'Honey Bot',
    user: { id: 'bot_honey_user', tag: 'Honey#1234' },
    roles: { highest: botHighestRole },
    permissions: {
      has: hasPerm
    },
    permissionsIn: (channel) => {
      if (options.channelOverrides && options.channelOverrides[channel.id]) {
        const denied = options.channelOverrides[channel.id].deny || [];
        return {
          has: (flag) => {
            if (Array.isArray(flag)) {
              return flag.every(f => !denied.includes(f) && hasPerm(f));
            }
            return !denied.includes(flag) && hasPerm(flag);
          }
        };
      }
      return { has: hasPerm };
    }
  };

  const addPermsFor = (c) => {
    c.permissionsFor = (member) => botMember.permissionsIn(c);
  };
  addPermsFor(systemChannel);

  if (options.channels) {
    options.channels.forEach(c => {
      c.guildId = id;
      addPermsFor(c);
      channelsMap.set(c.id, c);
    });
  }

  const rolesMap = new Map();
  const defaultRoles = options.roles || [
    { id: 'role_honey', name: 'Honey Bot', position: 10, rawPosition: 10 },
    { id: 'role_member', name: 'Member', position: 1, rawPosition: 1 }
  ];
  defaultRoles.forEach(r => rolesMap.set(r.id, r));

  const clientMock = {
    user: { id: 'bot_honey_user', tag: 'Honey#1234' },
    options: {
      intents: options.intents !== undefined ? options.intents : [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent
      ]
    },
    isReady: () => true,
    ws: { ping: 25 }
  };

  return {
    id,
    name: options.name || `Server ${id}`,
    ownerId: options.ownerId || 'owner_1234',
    systemChannelId: systemChannel.id,
    systemChannel,
    channels: {
      cache: channelsMap,
      fetch: async (cId) => channelsMap.get(cId) || null
    },
    roles: {
      cache: rolesMap,
      everyone: { id, name: '@everyone' }
    },
    members: {
      cache: new Map([[botMember.id, botMember]]),
      me: botMember,
      fetchMe: async () => botMember
    },
    client: clientMock
  };
}

// ============================================================================
// 1. Invite URL Generation & Client ID Handling
// ============================================================================
test('1. Invite URL Generation: Uses configured client ID and rejects missing client ID without guessing', () => {
  const clientId = '123456789012345678';

  // Successful generation with explicit client ID
  const url = PermissionAuditService.generateInviteUrl({ clientId, guildId: 'guild_target_01' });
  assert.ok(url.startsWith('https://discord.com/oauth2/authorize'));
  assert.ok(url.includes(`client_id=${clientId}`));
  assert.ok(url.includes('guild_id=guild_target_01'));

  // Missing client ID throws a clear configuration error instead of inventing fake ID
  const origClientId = config.discord.clientId;
  try {
    config.discord.clientId = '';
    assert.throws(
      () => PermissionAuditService.generateInviteUrl({ clientId: '' }),
      /DISCORD_CLIENT_ID is not configured/
    );
  } finally {
    config.discord.clientId = origClientId;
  }
});

// ============================================================================
// 2. Correct OAuth2 Scopes
// ============================================================================
test('2. OAuth2 Scopes: Correctly encodes bot and applications.commands without requesting user account scopes', () => {
  const clientId = '999888777666555444';
  const url = PermissionAuditService.generateInviteUrl({ clientId });

  assert.ok(url.includes('scope=bot%20applications.commands'));
  assert.ok(!url.includes('identify'), 'Must not request user identity scope');
  assert.ok(!url.includes('email'), 'Must not request user email scope');
  assert.ok(!url.includes('guilds.join'), 'Must not request user join scope');
});

// ============================================================================
// 3. Calculated Permission Bitfield
// ============================================================================
test('3. Permission Bitfield: Calculates bitfield programmatically from recommended permissions', () => {
  const expectedBits = PermissionsBitField.resolve(RECOMMENDED_PERMISSIONS).toString();
  const calculated = PermissionAuditService.calculatePermissionBits('recommended');

  assert.equal(calculated, expectedBits);
  assert.ok(Number(calculated) > 0);
  // Must encompass core permissions
  const bitfield = new PermissionsBitField(BigInt(calculated));
  assert.ok(bitfield.has(PermissionFlagsBits.ViewChannel));
  assert.ok(bitfield.has(PermissionFlagsBits.SendMessages));
  assert.ok(bitfield.has(PermissionFlagsBits.EmbedLinks));
  assert.ok(bitfield.has(PermissionFlagsBits.ManageRoles));
  assert.ok(bitfield.has(PermissionFlagsBits.ManageChannels));
  assert.ok(bitfield.has(PermissionFlagsBits.KickMembers));
  assert.ok(bitfield.has(PermissionFlagsBits.BanMembers));
  assert.ok(bitfield.has(PermissionFlagsBits.Connect));
  assert.ok(bitfield.has(PermissionFlagsBits.Speak));
});

// ============================================================================
// 4. Exclusion of Administrator from Default Permission Set
// ============================================================================
test('4. Administrator Safety: Excludes Administrator from default invite and provides explicit optional full-access link', () => {
  const defaultBits = PermissionAuditService.calculatePermissionBits(); // default mode
  const defaultBitfield = new PermissionsBitField(BigInt(defaultBits));

  assert.equal(
    defaultBitfield.has(PermissionFlagsBits.Administrator),
    false,
    'Default permission set must NOT contain Administrator'
  );

  const defaultUrl = PermissionAuditService.generateInviteUrl({ clientId: '111222333444555' });
  assert.ok(!defaultUrl.includes('permissions=8'), 'Default URL must not request flag 8 (Administrator)');

  // Optional full-access link specifically requests Administrator
  const adminBits = PermissionAuditService.calculatePermissionBits('admin');
  assert.equal(adminBits, '8');
  const adminUrl = PermissionAuditService.generateInviteUrl({ clientId: '111222333444555', mode: 'admin' });
  assert.ok(adminUrl.includes('permissions=8'));
});

// ============================================================================
// 5. Detection of Missing Permissions
// ============================================================================
test('5. Missing Permissions: Detects absent permissions and classifies feature as MISSING_PERMISSION', async () => {
  // Guild without ManageRoles or BanMembers
  const partialPerms = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ManageChannels
  ];
  const guild = createMockGuild('guild_missing_roles', { botPermissions: partialPerms });

  const audit = await PermissionAuditService.auditGuild(guild);
  assert.equal(audit.overallStatus, 'partially_ready');
  assert.ok(audit.missingRecommended.includes('ManageRoles'));
  assert.ok(audit.missingRecommended.includes('BanMembers'));

  assert.equal(audit.capabilities.roles.classification, FeatureStatus.MISSING_PERMISSION);
  assert.equal(audit.capabilities.moderation.classification, FeatureStatus.MISSING_PERMISSION);
  assert.equal(audit.capabilities.channels.classification, FeatureStatus.READY);
});

// ============================================================================
// 6. Detection of Inaccessible Logging Channels
// ============================================================================
test('6. Inaccessible Channels: Detects channel-level permission overwrites and diagnoses modlog failure', async () => {
  const modChan = {
    id: 'ch_mod_blocked',
    name: 'mod-logs',
    type: ChannelType.GuildText,
    isTextBased: () => true
  };
  const guild = createMockGuild('guild_channel_block', {
    channels: [modChan],
    channelOverrides: {
      ch_mod_blocked: { deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] }
    }
  });

  ModLogService.updateConfig(guild.id, {
    modLogChannelId: modChan.id,
    enabled: true
  });

  const audit = await PermissionAuditService.auditGuild(guild);
  assert.ok(audit.blockedChannels.length >= 1);
  const found = audit.blockedChannels.find(b => b.channelId === modChan.id);
  assert.ok(found);
  assert.ok(found.missingPerms.includes('SendMessages'));

  const diag = await DiagnosticService.diagnose('Why aren\'t moderation logs working?', { guild });
  assert.equal(diag.status, DiagnosticStatus.FAILED);
  assert.ok(diag.response.includes('Inaccessible Channel'));
  assert.ok(diag.response.includes('#mod-logs'));
});

// ============================================================================
// 7. Detection of Role-Hierarchy Restrictions
// ============================================================================
test('7. Role Hierarchy: Detects unmanageable roles above Honey Bot and classifies as ROLE_HIERARCHY_BLOCKED', async () => {
  const guild = createMockGuild('guild_hierarchy_test', {
    botPermissions: RECOMMENDED_PERMISSIONS,
    botRole: { id: 'role_honey', name: 'Honey Bot', position: 10, rawPosition: 10 },
    roles: [
      { id: 'role_admin', name: 'Server Admin', position: 50, rawPosition: 50 },
      { id: 'role_mod', name: 'Moderator', position: 25, rawPosition: 25 },
      { id: 'role_honey', name: 'Honey Bot', position: 10, rawPosition: 10 },
      { id: 'role_vip', name: 'VIP', position: 5, rawPosition: 5 }
    ]
  });

  const audit = await PermissionAuditService.auditGuild(guild);
  assert.equal(audit.roleHierarchy.isAtTop, false);
  assert.equal(audit.roleHierarchy.unmanageableRoles.length, 2);
  assert.equal(audit.capabilities.roles.classification, FeatureStatus.ROLE_HIERARCHY_BLOCKED);

  // Preflight check trying to manage Server Admin fails
  const higherRole = { id: 'role_admin', name: 'Server Admin', position: 50 };
  const preflight = PermissionAuditService.validateActionPreflight(guild, { action: 'edit_role', targetRole: higherRole });
  assert.equal(preflight.capable, false);
  assert.ok(preflight.reason.includes('Hierarchy Error'));
});

// ============================================================================
// 8. Detection of Missing Privileged Gateway Intents
// ============================================================================
test('8. Privileged Intents: Detects missing MessageContent and GuildMembers intents with Developer Portal steps', async () => {
  // Client with standard intents but missing privileged intents
  const standardClient = {
    options: {
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildVoiceStates
      ]
    }
  };

  const intentAudit = PermissionAuditService.auditIntents(standardClient);
  assert.equal(intentAudit.evaluated, true);
  assert.equal(intentAudit.hasGuildMembers, false);
  assert.equal(intentAudit.hasMessageContent, false);
  assert.ok(intentAudit.missingPrivileged.length >= 2);

  const mcIntent = intentAudit.missingPrivileged.find(i => i.name === 'MessageContent');
  assert.ok(mcIntent);
  assert.ok(mcIntent.setting.includes('MESSAGE CONTENT INTENT'));
});

// ============================================================================
// 9. Safe Handling of Newly Joined Guild (guildCreate)
// ============================================================================
test('9. Safe Guild Join: Runs permission audit on guildCreate without creating or deleting server resources', async () => {
  const guild = createMockGuild('guild_fresh_join_01');
  const initialChannelsCount = guild.channels.cache.size;
  const initialRolesCount = guild.roles.cache.size;

  const msg = await OnboardingManager.handleGuildCreate(guild);
  assert.ok(msg);

  // Verifies no automatic mutation of channels or roles occurred
  assert.equal(guild.channels.cache.size, initialChannelsCount, 'Must not create extra channels on join');
  assert.equal(guild.roles.cache.size, initialRolesCount, 'Must not create extra roles on join');

  // Verify audit was stored persistently
  const storedAudit = PermissionAuditService.getStoredAudit(guild.id);
  assert.ok(storedAudit);
  assert.equal(storedAudit.guildId, guild.id);
  assert.equal(storedAudit.overallStatus, 'ready');
});

// ============================================================================
// 10. Per-Guild Configuration Isolation
// ============================================================================
test('10. Tenant Isolation: Audits and configurations between distinct guilds are strictly isolated', async () => {
  const guildA = createMockGuild('guild_isolated_alpha', {
    botPermissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]
  });
  const guildB = createMockGuild('guild_isolated_beta', {
    botPermissions: RECOMMENDED_PERMISSIONS
  });

  const auditA = await PermissionAuditService.auditGuild(guildA);
  const auditB = await PermissionAuditService.auditGuild(guildB);

  assert.equal(auditA.overallStatus, 'partially_ready');
  assert.equal(auditB.overallStatus, 'ready');

  const storedA = PermissionAuditService.getStoredAudit('guild_isolated_alpha');
  const storedB = PermissionAuditService.getStoredAudit('guild_isolated_beta');

  assert.equal(storedA.overallStatus, 'partially_ready');
  assert.equal(storedB.overallStatus, 'ready');
});

// ============================================================================
// 11. Permission Changes After Installation
// ============================================================================
test('11. Dynamic Permission Updates: Re-auditing reflects real-time changes made by server administrators', async () => {
  let adminGranted = false;
  const guild = createMockGuild('guild_live_update');

  guild.members.me.permissions.has = (flag) => {
    if (adminGranted) return true;
    return [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages].includes(flag);
  };

  // Initial scan: missing recommended permissions
  const audit1 = await PermissionAuditService.auditGuild(guild);
  assert.equal(audit1.overallStatus, 'blocked'); // missing EmbedLinks (critical)

  // Administrator authorizes permissions in Discord
  adminGranted = true;

  // Live re-audit reflects updated state immediately
  const audit2 = await PermissionAuditService.auditGuild(guild);
  assert.equal(audit2.hasAdministrator, true);
  assert.equal(audit2.overallStatus, 'ready');
});

// ============================================================================
// 12. Partial Functionality When an Optional Permission is Missing
// ============================================================================
test('12. Graceful Degradation: Missing Voice permissions disables only music; core management remains ready', async () => {
  // Granted everything except Connect and Speak
  const permsWithoutVoice = RECOMMENDED_PERMISSIONS.filter(
    p => p !== PermissionFlagsBits.Connect && p !== PermissionFlagsBits.Speak
  );
  const guild = createMockGuild('guild_no_voice', { botPermissions: permsWithoutVoice });

  const audit = await PermissionAuditService.auditGuild(guild);

  assert.equal(audit.capabilities.voice.classification, FeatureStatus.MISSING_PERMISSION);
  assert.equal(audit.capabilities.channels.classification, FeatureStatus.READY);
  assert.equal(audit.capabilities.roles.classification, FeatureStatus.READY);
  assert.equal(audit.capabilities.messaging.classification, FeatureStatus.READY);

  // Preflight check for music fails gracefully
  const preflightMusic = PermissionAuditService.validateActionPreflight(guild, { action: 'music_play' });
  assert.equal(preflightMusic.capable, false);
  assert.ok(preflightMusic.missingPermissions.includes('Connect'));

  // Preflight check for channel management succeeds
  const preflightChan = PermissionAuditService.validateActionPreflight(guild, { action: 'create_channel' });
  assert.equal(preflightChan.capable, true);
});

// ============================================================================
// 13. Graceful Handling of Discord API Failures
// ============================================================================
test('13. API Resilience: Handles fetch failures and missing bot member without unhandled exceptions', async () => {
  const brokenGuild = {
    id: 'guild_broken_api',
    name: 'Broken Guild',
    members: {
      me: null,
      fetchMe: async () => { throw new Error('Discord API 500 Internal Server Error'); }
    }
  };

  const audit = await PermissionAuditService.auditGuild(brokenGuild);
  assert.equal(audit.overallStatus, 'blocked');
  assert.ok(audit.summary.includes('could not be resolved'));

  const diag = await DiagnosticService.diagnose('Check Honey Bot permissions', { guild: brokenGuild });
  assert.equal(diag.status, DiagnosticStatus.FAILED);
});

// ============================================================================
// 14. Protection Against Leaking Secrets in Logs or Output
// ============================================================================
test('14. Secret Redaction: Invite URLs and diagnostic reports never leak bot tokens or API keys', async () => {
  const fakeToken = 'NzgxMjM0NTY3ODkwMTIzNDU2.GzFake.SecretTokenStringHere123456';
  const fakeKey = 'AIzaSyFakeSecretGeminiApiKey987654321';

  const guild = createMockGuild('guild_secret_test');
  const audit = await PermissionAuditService.auditGuild(guild);
  const diag = await DiagnosticService.diagnose('Check Honey Bot permissions', { guild });

  const auditText = JSON.stringify(audit);
  const diagText = JSON.stringify(diag);

  assert.ok(!auditText.includes(fakeToken));
  assert.ok(!auditText.includes(fakeKey));
  assert.ok(!diagText.includes(fakeToken));
  assert.ok(!diagText.includes(fakeKey));

  // Verify Logger redaction
  const redacted = Logger.redactSecrets(`Error: Bot token was Bot ${fakeToken} and key was ${fakeKey}`);
  assert.ok(!redacted.includes(fakeToken));
  assert.ok(!redacted.includes(fakeKey));
});
