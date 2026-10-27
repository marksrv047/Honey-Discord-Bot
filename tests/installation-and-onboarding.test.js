import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionFlagsBits, PermissionsBitField, ChannelType } from 'discord.js';
import { PermissionAuditService, RECOMMENDED_PERMISSIONS, CRITICAL_PERMISSIONS, PERMISSION_FEATURE_MAP } from '../src/permission-audit.js';
import { OnboardingManager } from '../src/onboarding.js';
import { IntentRouter } from '../src/intent-router.js';
import { GuildConfigService } from '../src/guild-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_DATA_DIR = path.resolve(__dirname, '..', 'data', 'test-onboarding');

// Mock Guild Factory for Onboarding Tests
function createOnboardingMockGuild(guildId, options = {}) {
  const channelsMap = new Map();

  const systemChannel = {
    id: `ch_sys_${guildId}`,
    name: 'general',
    type: ChannelType.GuildText,
    guildId,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => ({
      id: `msg_setup_${guildId}`,
      editable: true,
      edit: async (p) => ({ ...p, id: `msg_setup_${guildId}` }),
      ...payload
    })
  };
  channelsMap.set(systemChannel.id, systemChannel);

  const channelsList = options.channels || [systemChannel];
  channelsList.forEach(c => channelsMap.set(c.id, c));

  const grantedPerms = options.botPermissions !== undefined
    ? options.botPermissions
    : [PermissionFlagsBits.Administrator];

  const hasPerm = (flag) => {
    if (grantedPerms.includes(PermissionFlagsBits.Administrator)) return true;
    if (Array.isArray(flag)) {
      return flag.every(f => grantedPerms.includes(f));
    }
    return grantedPerms.includes(flag);
  };

  const botMember = {
    id: 'bot_honey_test',
    displayName: 'Honey Bot',
    user: { id: 'bot_honey_test', tag: 'honey#8758' },
    roles: {
      highest: options.botRole || { id: 'role_bot', name: 'Honey Bot', position: 10, rawPosition: 10 }
    },
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
      return {
        has: hasPerm
      };
    }
  };

  const rolesMap = new Map();
  const defaultRoles = options.roles || [
    { id: 'role_bot', name: 'Honey Bot', position: 10 },
    { id: 'role_member', name: 'Member', position: 1 }
  ];
  defaultRoles.forEach(r => rolesMap.set(r.id, r));

  const messagesMap = new Map();
  if (options.existingMessage) {
    messagesMap.set(options.existingMessage.id, options.existingMessage);
  }

  systemChannel.messages = {
    fetch: async (id) => messagesMap.get(id) || null
  };

  return {
    id: guildId,
    name: options.name || `Server ${guildId}`,
    ownerId: options.ownerId || 'owner_123',
    systemChannelId: systemChannel.id,
    systemChannel,
    channels: {
      cache: channelsMap,
      fetch: async (id) => channelsMap.get(id) || null
    },
    roles: {
      cache: rolesMap,
      everyone: { id: guildId, name: '@everyone' }
    },
    members: {
      cache: new Map([[botMember.id, botMember]]),
      me: botMember,
      fetchMe: async () => botMember
    }
  };
}

// Setup isolated storage for tests
test.beforeEach(() => {
  if (!fs.existsSync(TEST_DATA_DIR)) {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  }
  OnboardingManager.storagePath = path.join(TEST_DATA_DIR, 'onboarding-state.json');
  OnboardingManager._state.clear();
  OnboardingManager._isLoaded = false;
});

test.afterEach(() => {
  if (fs.existsSync(TEST_DATA_DIR)) {
    try {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    } catch {}
  }
});

// =========================================================================
// SCENARIO 1: Fresh Installation Using the Generated OAuth2 URL
// =========================================================================
test('Scenario 1: Generates official Discord OAuth2 URL with correct scopes and permission flags', () => {
  const clientId = '1563781678063689749';

  // 1. Administrator mode
  const adminUrl = PermissionAuditService.generateInviteUrl({ clientId, mode: 'admin', guildId: 'guild_101' });
  assert.ok(adminUrl.startsWith('https://discord.com/oauth2/authorize'));
  assert.ok(adminUrl.includes(`client_id=${clientId}`));
  assert.ok(adminUrl.includes('scope=bot%20applications.commands'));
  assert.ok(adminUrl.includes('permissions=8'), 'Administrator bitfield flag 8 must be requested');
  assert.ok(adminUrl.includes('guild_id=guild_101'));

  // 2. Recommended Least-Privilege mode
  const recUrl = PermissionAuditService.generateInviteUrl({ clientId, mode: 'recommended' });
  const recBits = PermissionsBitField.resolve(RECOMMENDED_PERMISSIONS).toString();
  assert.ok(recUrl.includes(`permissions=${recBits}`));
  assert.ok(recUrl.includes('scope=bot%20applications.commands'));

  // 3. Permission integer matches exact Discord.js calculation without hardcoded guesswork
  assert.equal(PermissionAuditService.calculatePermissionBits('admin'), '8');
  assert.equal(PermissionAuditService.calculatePermissionBits('recommended'), recBits);
});

// =========================================================================
// SCENARIO 2: Installation with Administrator Permission Approved
// =========================================================================
test('Scenario 2: Installation audit succeeds when Administrator permission is approved', async () => {
  const mockGuild = createOnboardingMockGuild('guild_admin_approved', {
    botPermissions: [PermissionFlagsBits.Administrator]
  });

  const audit = await PermissionAuditService.auditGuild(mockGuild);

  assert.equal(audit.hasAdministrator, true);
  assert.equal(audit.overallStatus, 'ready');
  assert.equal(audit.missingCritical.length, 0);
  assert.equal(audit.missingRecommended.length, 0);
  assert.equal(audit.capabilities.messaging.status, 'ready');
  assert.equal(audit.capabilities.channels.status, 'ready');
  assert.equal(audit.capabilities.roles.status, 'ready');
  assert.equal(audit.capabilities.moderation.status, 'ready');
  assert.equal(audit.capabilities.voice.status, 'ready');

  const payload = OnboardingManager.buildSetupPayload(mockGuild, audit);
  assert.ok(payload.embeds.length === 1);
  assert.match(payload.embeds[0].data.description, /Administrator Access Active/);
  assert.equal(payload.embeds[0].data.color, 0x57F287); // Green
});

// =========================================================================
// SCENARIO 3: Installation Where Administrator Permission is Denied/Omitted
// =========================================================================
test('Scenario 3: Supports least-privilege installation when Administrator is omitted but recommended perms exist', async () => {
  const mockGuild = createOnboardingMockGuild('guild_least_privilege', {
    botPermissions: RECOMMENDED_PERMISSIONS
  });

  const audit = await PermissionAuditService.auditGuild(mockGuild);

  assert.equal(audit.hasAdministrator, false, 'Should not claim Administrator permission');
  assert.equal(audit.overallStatus, 'ready', 'Should be ready under recommended permissions');
  assert.equal(audit.missingRecommended.length, 0);

  const payload = OnboardingManager.buildSetupPayload(mockGuild, audit);
  assert.match(payload.embeds[0].data.description, /Recommended Least-Privilege Active/);
  assert.equal(payload.embeds[0].data.color, 0xFEE75C); // Gold
});

// =========================================================================
// SCENARIO 4: Existing Installation with Missing Permissions
// =========================================================================
test('Scenario 4: Accurately identifies missing permissions and affected features', async () => {
  // Omit Moderation and Voice permissions
  const partialPerms = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ManageChannels
  ];

  const mockGuild = createOnboardingMockGuild('guild_partial_perms', {
    botPermissions: partialPerms
  });

  const audit = await PermissionAuditService.auditGuild(mockGuild);

  assert.equal(audit.hasAdministrator, false);
  assert.equal(audit.overallStatus, 'partially_ready');
  assert.ok(audit.missingRecommended.includes('KickMembers'));
  assert.ok(audit.missingRecommended.includes('BanMembers'));
  assert.ok(audit.missingRecommended.includes('Connect'));

  assert.equal(audit.capabilities.channels.status, 'ready');
  assert.equal(audit.capabilities.moderation.status, 'blocked');
  assert.equal(audit.capabilities.voice.status, 'blocked');

  const payload = OnboardingManager.buildSetupPayload(mockGuild, audit);
  assert.match(payload.embeds[0].data.description, /Partial Permissions Active/);
  assert.ok(payload.embeds[0].data.fields.some(f => f.name.includes('Missing Permissions & Consequences')));
});

// =========================================================================
// SCENARIO 5: Channel-Level Permission Overwrites Blocking the Bot
// =========================================================================
test('Scenario 5: Detects channel-level permission overwrites blocking communication', async () => {
  const chBlocked = {
    id: 'ch_blocked_announcements',
    name: 'announcements',
    type: ChannelType.GuildText,
    isTextBased: () => true
  };

  const mockGuild = createOnboardingMockGuild('guild_overwrite_test', {
    botPermissions: RECOMMENDED_PERMISSIONS,
    channels: [chBlocked],
    channelOverrides: {
      ch_blocked_announcements: {
        deny: [PermissionFlagsBits.SendMessages]
      }
    }
  });

  const audit = await PermissionAuditService.auditGuild(mockGuild);
  assert.equal(audit.blockedChannels.length, 1);
  assert.equal(audit.blockedChannels[0].channelName, 'announcements');
  assert.ok(audit.blockedChannels[0].missingPerms.includes('SendMessages'));

  // Action preflight check targeting blocked channel
  const preflight = PermissionAuditService.validateActionPreflight(mockGuild, { action: 'send_message' }, chBlocked);
  assert.equal(preflight.capable, false);
  assert.match(preflight.reason, /Honey Bot lacks the required Discord permission/);
});

// =========================================================================
// SCENARIO 6: Missing Message/Embed Permissions Preventing Setup Messages
// =========================================================================
test('Scenario 6: Gracefully handles missing message/embed permissions without crashing', async () => {
  // Guild where bot has no send permissions anywhere
  const mockGuild = createOnboardingMockGuild('guild_no_send_perms', {
    botPermissions: [PermissionFlagsBits.ViewChannel], // Cannot SendMessages or EmbedLinks
    channelOverrides: {
      ch_sys_guild_no_send_perms: {
        deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]
      }
    }
  });

  // handleGuildCreate should not throw, should return null and record fallback failure safely
  const result = await OnboardingManager.handleGuildCreate(mockGuild);
  assert.equal(result, null);

  const state = OnboardingManager.getState(mockGuild.id);
  assert.equal(state.fallbackMessageFailed, true);
});

// =========================================================================
// SCENARIO 7: Reauthorization Followed by a Successful Permission Recheck
// =========================================================================
test('Scenario 7: Recheck button updates embed live after simulated reauthorization', async () => {
  let hasAdmin = false;
  const mockGuild = createOnboardingMockGuild('guild_recheck_flow', {
    botPermissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]
  });

  // Dynamically reflect permission changes
  mockGuild.members.me.permissions.has = (perm) => {
    if (hasAdmin) return true;
    return [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks].includes(perm);
  };

  // Step 1: Initial state (missing permissions)
  let audit1 = await PermissionAuditService.auditGuild(mockGuild);
  assert.equal(audit1.overallStatus, 'partially_ready');

  // Step 2: Administrator reauthorizes Honey Bot
  hasAdmin = true;

  // Step 3: Click 'Check Permissions Again' (setup:recheck)
  let updatedPayload = null;
  const mockInteraction = {
    customId: 'setup:recheck',
    guild: mockGuild,
    member: {
      id: mockGuild.ownerId,
      permissions: { has: () => true }
    },
    deferUpdate: async () => {},
    editReply: async (payload) => { updatedPayload = payload; },
    followUp: async () => {}
  };

  const handled = await OnboardingManager.handleInteraction(mockInteraction);
  assert.equal(handled, true);
  assert.ok(updatedPayload);
  assert.match(updatedPayload.embeds[0].data.description, /Administrator Access Active/);
  assert.equal(updatedPayload.embeds[0].data.color, 0x57F287);
});

// =========================================================================
// SCENARIO 8: A User Without Sufficient Authority Attempting to Change Setup
// =========================================================================
test('Scenario 8: Rejects unauthorized members from modifying setup configuration', async () => {
  const mockGuild = createOnboardingMockGuild('guild_unauth_test', {
    ownerId: 'owner_real_123'
  });

  let errorContent = null;
  const unauthorizedInteraction = {
    customId: 'setup:complete',
    guild: mockGuild,
    member: {
      id: 'regular_member_789',
      permissions: { has: () => false } // Not Administrator, not Server Owner
    },
    reply: async (msg) => { errorContent = msg.content; }
  };

  const handled = await OnboardingManager.handleInteraction(unauthorizedInteraction);
  assert.equal(handled, true);
  assert.match(errorContent, /Access Denied/);

  // State must remain incomplete
  const state = OnboardingManager.getState(mockGuild.id);
  assert.equal(state.completed, false);
});

// =========================================================================
// SCENARIO 9: Multiple Guilds Configured Independently (Tenant Isolation)
// =========================================================================
test('Scenario 9: Multiple guilds maintain completely isolated onboarding states', () => {
  const guildA = 'guild_tenant_alpha';
  const guildB = 'guild_tenant_beta';

  OnboardingManager.updateState(guildA, {
    completed: true,
    completedBy: 'AlphaAdmin',
    featureSettings: { music: false, moderation: true }
  });

  OnboardingManager.updateState(guildB, {
    completed: false,
    completedBy: null,
    featureSettings: { music: true, moderation: true }
  });

  const stateA = OnboardingManager.getState(guildA);
  const stateB = OnboardingManager.getState(guildB);

  assert.equal(stateA.completed, true);
  assert.equal(stateA.completedBy, 'AlphaAdmin');
  assert.equal(stateA.featureSettings.music, false);

  assert.equal(stateB.completed, false);
  assert.equal(stateB.completedBy, null);
  assert.equal(stateB.featureSettings.music, true);
});

// =========================================================================
// SCENARIO 10: Bot Restart and Setup-Message Deletion Recovery
// =========================================================================
test('Scenario 10: Persists state across simulated restart and recovers if setup message was deleted', async () => {
  const guildId = 'guild_restart_test';

  // 1. Initial State before restart
  OnboardingManager.updateState(guildId, {
    lastSetupMessageId: 'deleted_msg_id_404',
    lastSetupChannelId: `ch_sys_${guildId}`
  });

  // 2. Simulate Bot Process Restart (Clear RAM caches)
  OnboardingManager._state.clear();
  OnboardingManager._isLoaded = false;

  // 3. Guild exists, but message was deleted in Discord
  const mockGuild = createOnboardingMockGuild(guildId, {
    existingMessage: null // Message no longer in Discord cache/API
  });

  let sentPayload = null;
  mockGuild.systemChannel.send = async (payload) => {
    sentPayload = payload;
    return { id: 'new_msg_recovered_999' };
  };

  const newMsg = await OnboardingManager.handleGuildCreate(mockGuild);
  assert.ok(newMsg, 'Should send a fresh message if the previous one was deleted');
  assert.equal(newMsg.id, 'new_msg_recovered_999');

  const reloadedState = OnboardingManager.getState(guildId);
  assert.equal(reloadedState.lastSetupMessageId, 'new_msg_recovered_999');
});

// =========================================================================
// SCENARIO 11: Intent Routing Integration for /go setup
// =========================================================================
test('Scenario 11: IntentRouter recognizes natural setup prompts for /go', async () => {
  const router = new IntentRouter({ isDeterministicOnly: true });

  const setupPrompts = [
    'setup',
    'open setup',
    'bot setup',
    'show setup panel',
    'check bot permissions',
    'permissions setup',
    'install bot',
    'reauthorize bot'
  ];

  for (const prompt of setupPrompts) {
    const res = await router.route(prompt, {});
    assert.equal(res.intent, 'open_setup', `Prompt "${prompt}" should route to open_setup`);
  }
});

// =========================================================================
// SCENARIO 12: Role Hierarchy Inspection Warns When Bot Role is Low
// =========================================================================
test('Scenario 12: Audit flags role hierarchy warning when bot role is positioned low', async () => {
  const mockGuild = createOnboardingMockGuild('guild_low_role', {
    botPermissions: [PermissionFlagsBits.Administrator],
    botRole: { id: 'bot_role_id', name: 'Honey Bot', position: 5, rawPosition: 5 },
    roles: [
      { id: 'role_owner', name: 'Server Owner', position: 100, rawPosition: 100 },
      { id: 'role_admin', name: 'Administrators', position: 50, rawPosition: 50 },
      { id: 'role_mod', name: 'Moderators', position: 20, rawPosition: 20 },
      { id: 'bot_role_id', name: 'Honey Bot', position: 5, rawPosition: 5 }
    ]
  });

  const audit = await PermissionAuditService.auditGuild(mockGuild);
  assert.equal(audit.roleHierarchy.isAtTop, false);
  assert.ok(audit.roleHierarchy.unmanageableRoles.length >= 3);
  assert.match(audit.roleHierarchy.hierarchyWarning, /positioned below/);

  // Preflight check trying to edit higher role fails with hierarchy reason
  const higherRole = { id: 'role_admin', name: 'Administrators', position: 50 };
  const preflight = PermissionAuditService.validateActionPreflight(mockGuild, { action: 'edit_role', targetRole: higherRole });
  assert.equal(preflight.capable, false);
  assert.match(preflight.reason, /Hierarchy Error/);
});
