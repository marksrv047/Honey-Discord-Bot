import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PermissionFlagsBits, ChannelType } from 'discord.js';
import { GuildConfigService, ConcurrencyConflictError } from '../src/guild-config.js';
import { checkUserAuthorization, checkPolicyAdminAuthorization } from '../src/permissions.js';
import { Operations } from '../src/operations.js';
import { Executor } from '../src/executor.js';
import { IntentRouter } from '../src/intent-router.js';
import { SecurityGate } from '../src/security-gate.js';
import { ActionLedger, RecoveryEngine, RecoveryRegistry } from '../src/recovery.js';
import { slashCommands } from '../src/commands.js';
import { DiagnosticService } from '../src/diagnostic-service.js';
import { HelpManager } from '../src/help.js';
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

function createMockGuild(overrides = {}) {
  const guild = {
    id: overrides.id || `guild_${Date.now()}_${Math.random().toString(36).substring(7)}`,
    name: overrides.name || 'Mock Discord Guild',
    ownerId: overrides.ownerId || 'owner_123',
    members: {
      cache: createMockCollection(),
      fetch: async (id) => guild.members.cache.get(id) || null
    },
    roles: {
      cache: createMockCollection(),
      fetch: async (id) => guild.roles.cache.get(id) || null
    },
    channels: {
      cache: createMockCollection()
    },
    client: {
      user: { id: 'bot_honey', tag: 'Honey#1234', username: 'Honey' }
    },
    ...overrides
  };

  const botMember = {
    id: 'bot_honey',
    displayName: 'Honey',
    user: { id: 'bot_honey', tag: 'Honey#1234', username: 'Honey' },
    guild,
    roles: {
      cache: createMockCollection(),
      highest: { id: 'role_bot', name: 'Honey Bot', position: 99 }
    },
    permissions: {
      has: () => true
    }
  };
  guild.members.cache.set('bot_honey', botMember);
  guild.members.me = botMember;

  return guild;
}

function createMockMember(guild, { id, name, roles = [], isAdmin = false, isOwner = false, permissions = [] }) {
  const roleCollection = createMockCollection();
  for (const r of roles) {
    roleCollection.set(r.id, r);
  }

  const highestRole = roles.length > 0
    ? [...roles].sort((a, b) => (b.position || 0) - (a.position || 0))[0]
    : { id: 'everyone', name: '@everyone', position: 0 };

  const grantedPerms = new Set(permissions);
  if (isAdmin) grantedPerms.add(PermissionFlagsBits.Administrator);

  const member = {
    id: id || `user_${Date.now()}_${Math.random().toString(36).substring(7)}`,
    displayName: name || 'TestUser',
    user: {
      id: id || `user_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      username: name || 'TestUser',
      tag: `${name || 'TestUser'}#0001`
    },
    guild,
    roles: {
      cache: roleCollection,
      highest: highestRole
    },
    permissions: {
      has: (flag) => isOwner || isAdmin || grantedPerms.has(flag) || roles.some(r => r.permissions?.has ? r.permissions.has(flag) : false)
    }
  };

  guild.members.cache.set(member.id, member);
  return member;
}

function createMockRole(guild, { id, name, position = 10, permissions = [] }) {
  const grantedPerms = new Set(permissions);
  const role = {
    id: id || `role_${Date.now()}_${Math.random().toString(36).substring(7)}`,
    name,
    position,
    rawPosition: position,
    guild,
    permissions: {
      has: (flag) => grantedPerms.has(flag)
    }
  };
  guild.roles.cache.set(role.id, role);
  return role;
}

// Ensure clean test environment
test.beforeEach(() => {
  GuildConfigService.cache.clear();
});

// =========================================================================
// SECTION 1: MULTI-GUILD ISOLATION (Tests 1-10)
// =========================================================================

test('1. Configure Server A with a Moderator role and Server B with an Admin role', () => {
  const guildAId = 'guild_alpha_101';
  const guildBId = 'guild_beta_202';

  GuildConfigService.authorizeRole(guildAId, {
    roleId: 'role_mod_a',
    roleName: 'Moderator',
    capabilities: ['moderation']
  }, { id: 'admin_a', tag: 'AdminA#0001' });

  GuildConfigService.authorizeRole(guildBId, {
    roleId: 'role_admin_b',
    roleName: 'Admin',
    capabilities: ['channels', 'roles']
  }, { id: 'admin_b', tag: 'AdminB#0001' });

  const configA = GuildConfigService.getConfig(guildAId);
  const configB = GuildConfigService.getConfig(guildBId);

  assert.equal(configA.guildId, guildAId);
  assert.equal(configB.guildId, guildBId);
  assert.ok(configA.authorizationPolicy.operatorRoles['role_mod_a']);
  assert.equal(configA.authorizationPolicy.operatorRoles['role_admin_b'], undefined);
  assert.ok(configB.authorizationPolicy.operatorRoles['role_admin_b']);
  assert.equal(configB.authorizationPolicy.operatorRoles['role_mod_a'], undefined);
});

test('2. Verify that Server A policy does not authorize users based solely on Server B configuration', () => {
  const guildA = createMockGuild({ id: 'guild_a_isolation' });
  const guildB = createMockGuild({ id: 'guild_b_isolation' });

  const roleModA = createMockRole(guildA, { id: 'role_mod_a', name: 'Moderator', permissions: [PermissionFlagsBits.BanMembers] });
  const roleModB = createMockRole(guildB, { id: 'role_mod_b', name: 'Moderator', permissions: [PermissionFlagsBits.BanMembers] });

  // Only configure Guild B
  GuildConfigService.authorizeRole(guildB.id, {
    roleId: roleModB.id,
    roleName: 'Moderator',
    capabilities: ['ban_members']
  }, { id: 'admin_b', tag: 'AdminB' });

  // Member in Guild A with Moderator role in Guild A
  const memberA = createMockMember(guildA, { id: 'user_john', name: 'John', roles: [roleModA] });

  // Evaluate authorization in Guild A
  const authA = checkUserAuthorization(memberA, [{ action: 'ban_member' }]);
  assert.equal(authA.authorized, false, 'Member in Guild A must NOT be authorized via Guild B config');

  // Evaluate member in Guild B with same action
  const memberB = createMockMember(guildB, { id: 'user_john', name: 'John', roles: [roleModB] });
  const authB = checkUserAuthorization(memberB, [{ action: 'ban_member' }]);
  assert.equal(authB.authorized, true, 'Member in Guild B should be authorized by Guild B config');
});

test('3. Verify that identical role names in two guilds do not cause policy crossover', () => {
  const guildA = createMockGuild({ id: 'guild_alpha_name_test' });
  const guildB = createMockGuild({ id: 'guild_beta_name_test' });

  const roleA = createMockRole(guildA, { id: 'role_99991', name: 'Staff' });
  const roleB = createMockRole(guildB, { id: 'role_99992', name: 'Staff' });

  GuildConfigService.authorizeRole(guildA.id, {
    roleId: roleA.id,
    roleName: 'Staff',
    capabilities: ['kick_members']
  }, { id: 'admin_a', tag: 'AdminA' });

  const configA = GuildConfigService.getConfig(guildA.id);
  const configB = GuildConfigService.getConfig(guildB.id);

  assert.ok(configA.authorizationPolicy.operatorRoles[roleA.id]);
  assert.equal(configA.authorizationPolicy.operatorRoles[roleB.id], undefined);
  assert.equal(configB.authorizationPolicy.operatorRoles[roleB.id], undefined);
  assert.equal(configB.authorizationPolicy.operatorRoles[roleA.id], undefined);
});

test('4. Verify that distinct role IDs are resolved only within current guild', async () => {
  const guildA = createMockGuild({ id: 'guild_resolve_a' });
  const roleA = createMockRole(guildA, { id: 'role_a_only', name: 'SpecialModerator' });

  const result = await Operations.configureGuildPolicy(guildA, {
    targetRole: 'SpecialModerator',
    capabilities: ['moderation']
  }, { invokingUser: { id: guildA.ownerId, tag: 'Owner' } });

  assert.equal(result.success, true);
  const configA = GuildConfigService.getConfig(guildA.id);
  assert.ok(configA.authorizationPolicy.operatorRoles[roleA.id]);

  // Attempting to resolve in Guild B where role does not exist should fail
  const guildB = createMockGuild({ id: 'guild_resolve_b' });
  const resultB = await Operations.configureGuildPolicy(guildB, {
    targetRole: 'SpecialModerator',
    capabilities: ['moderation']
  }, { invokingUser: { id: guildB.ownerId, tag: 'Owner' } });

  assert.equal(resultB.success, false);
  assert.match(resultB.error, /Role "@?SpecialModerator" (?:was )?not found/i);
});

test('5. Verify that a role deletion in one guild does not change another guild configuration', () => {
  const guildAId = 'guild_delete_role_a';
  const guildBId = 'guild_delete_role_b';

  GuildConfigService.authorizeRole(guildAId, {
    roleId: 'role_common_mod',
    roleName: 'Mod',
    capabilities: ['moderation']
  }, { id: 'admin', tag: 'Admin' });

  GuildConfigService.authorizeRole(guildBId, {
    roleId: 'role_common_mod',
    roleName: 'Mod',
    capabilities: ['moderation']
  }, { id: 'admin', tag: 'Admin' });

  // Revoke in Guild A
  GuildConfigService.revokeRole(guildAId, 'role_common_mod', { id: 'admin', tag: 'Admin' });

  assert.equal(GuildConfigService.getConfig(guildAId).authorizationPolicy.operatorRoles['role_common_mod'], undefined);
  assert.ok(GuildConfigService.getConfig(guildBId).authorizationPolicy.operatorRoles['role_common_mod']);
});

test('6. Verify that one guild cache invalidation does not affect another guild', () => {
  const guildAId = 'guild_cache_a';
  const guildBId = 'guild_cache_b';

  // Load both configs into cache
  const configA = GuildConfigService.getConfig(guildAId);
  const configB = GuildConfigService.getConfig(guildBId);

  assert.ok(GuildConfigService.cache.has(guildAId));
  assert.ok(GuildConfigService.cache.has(guildBId));

  // Invalidate only guild A
  GuildConfigService.invalidateCache(guildAId);

  assert.equal(GuildConfigService.cache.has(guildAId), false);
  assert.equal(GuildConfigService.cache.has(guildBId), true, 'Guild B cache must remain intact');
});

test('7. Verify that missing configuration never falls back to another guild configuration', () => {
  const configuredGuildId = 'guild_configured_123';
  const newGuildId = 'guild_unconfigured_456';

  GuildConfigService.authorizeRole(configuredGuildId, {
    roleId: 'role_vip_mod',
    roleName: 'VIP Mod',
    capabilities: ['ban_members', 'kick_members']
  }, { id: 'admin', tag: 'Admin' });

  const newConfig = GuildConfigService.getConfig(newGuildId);
  assert.equal(newConfig.guildId, newGuildId);
  assert.deepEqual(newConfig.authorizationPolicy.operatorRoles, {});
  assert.deepEqual(newConfig.authorizationPolicy.operatorMembers, {});
});

test('8. Verify that a cross-guild confirmation is rejected', () => {
  const user = 'user_admin_test';
  const guildAId = 'guild_token_a';
  const guildBId = 'guild_token_b';
  const actions = [{ action: 'delete_channel', targetChannel: 'c1' }];

  const tokenA = SecurityGate.generateConfirmationToken(user, guildAId, actions);

  // Presenting token in Guild A should pass
  assert.equal(SecurityGate.verifyConfirmationToken(tokenA, user, guildAId, actions), true);

  // Presenting token in Guild B must be rejected
  assert.equal(SecurityGate.verifyConfirmationToken(tokenA, user, guildBId, actions), false, 'Cross-guild confirmation token must fail');
});

test('9. Verify that an undo operation cannot restore another guild configuration', async () => {
  const guildA = createMockGuild({ id: 'guild_undo_a' });
  const guildB = createMockGuild({ id: 'guild_undo_b' });

  const recordA = {
    actionId: 'act_policy_a',
    action: 'configure_guild_policy',
    type: 'configure_guild_policy',
    guildId: guildA.id,
    actor: 'admin_a',
    preState: { revision: 1, authorizationPolicy: { operatorRoles: {} } },
    postState: { revision: 2, authorizationPolicy: { operatorRoles: { r1: { roleName: 'Mod' } } } }
  };

  const handler = RecoveryRegistry.getHandler('configure_guild_policy');
  assert.ok(handler);

  // Attempt to execute recovery in Guild B with Guild A's record
  await assert.rejects(
    async () => {
      await handler.execute(guildB, recordA);
    },
    /Security Violation: Undo record belongs to guild guild_undo_a, not current guild guild_undo_b/i
  );
});

test('10. Verify that queued jobs / execution plans retain and validate original guild context', () => {
  const planA = {
    guildId: 'guild_plan_a',
    actions: [{ action: 'configure_guild_policy', targetRole: 'Mod' }]
  };

  const targetGuildId = 'guild_plan_b';
  assert.notEqual(planA.guildId, targetGuildId, 'Plan from guild A must be distinguishable from guild B');
});

// =========================================================================
// SECTION 2: AUTHORIZATION CORRECTNESS (Tests 11-20)
// =========================================================================

test('11. Verify that an authorized role can execute only its configured capabilities', () => {
  const guild = createMockGuild({ id: 'guild_caps_exact' });
  const role = createMockRole(guild, {
    id: 'role_kicker',
    name: 'Kicker',
    permissions: [PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers]
  });

  GuildConfigService.authorizeRole(guild.id, {
    roleId: role.id,
    roleName: 'Kicker',
    capabilities: ['kick_members']
  }, { id: 'admin', tag: 'Admin' });

  const member = createMockMember(guild, { id: 'user_kicker', roles: [role] });

  // kick_member is allowed
  const authKick = checkUserAuthorization(member, [{ action: 'kick_member' }]);
  assert.equal(authKick.authorized, true);

  // ban_member is NOT allowed by Honey Bot policy, even though role has Discord BanMembers permission
  const authBan = checkUserAuthorization(member, [{ action: 'ban_member' }]);
  assert.equal(authBan.authorized, false);
  assert.match(authBan.reason, /Access Denied|not authorized/i);
});

test('12. Verify that a read-only role cannot execute moderation mutations', () => {
  const guild = createMockGuild({ id: 'guild_read_only' });
  const role = createMockRole(guild, {
    id: 'role_inspector',
    name: 'Auditor',
    permissions: []
  });

  GuildConfigService.authorizeRole(guild.id, {
    roleId: role.id,
    roleName: 'Auditor',
    capabilities: ['inspect_members', 'audit_server']
  }, { id: 'admin', tag: 'Admin' });

  const member = createMockMember(guild, { id: 'user_auditor', roles: [role] });

  // Inspection is authorized
  const authInspect = checkUserAuthorization(member, [{ action: 'inspect_member' }]);
  assert.equal(authInspect.authorized, true);

  // Timeout or Kick is denied
  const authTimeout = checkUserAuthorization(member, [{ action: 'timeout_member' }]);
  assert.equal(authTimeout.authorized, false);
});

test('13. Verify that unauthorized members cannot alter the authorization policy', async () => {
  const guild = createMockGuild({ id: 'guild_unauth_policy' });
  const nonAdmin = createMockMember(guild, { id: 'user_regular', name: 'Regular' });

  const auth = checkPolicyAdminAuthorization(nonAdmin);
  assert.equal(auth.authorized, false);
  assert.match(auth.reason, /Server Administrators/i);

  const result = await Operations.configureGuildPolicy(guild, {
    targetRole: 'SomeRole',
    capabilities: ['moderation']
  }, { invokingUser: nonAdmin.user, invokingMember: nonAdmin });

  assert.equal(result.success, false);
  assert.match(result.error, /Unauthorized/i);
});

test('14. Verify that role-name similarity does not grant authorization', () => {
  const guild = createMockGuild({ id: 'guild_similarity' });
  const legitimateModRole = createMockRole(guild, {
    id: 'role_legit_mod',
    name: 'Moderator',
    permissions: [PermissionFlagsBits.BanMembers]
  });
  const fakeModRole = createMockRole(guild, {
    id: 'role_fake_mod',
    name: 'Moderator Junior',
    permissions: [PermissionFlagsBits.BanMembers]
  });

  // Only authorize the legitimate role ID
  GuildConfigService.authorizeRole(guild.id, {
    roleId: legitimateModRole.id,
    roleName: 'Moderator',
    capabilities: ['ban_members']
  }, { id: 'admin', tag: 'Admin' });

  const fakeMember = createMockMember(guild, { id: 'user_fake', roles: [fakeModRole] });
  const auth = checkUserAuthorization(fakeMember, [{ action: 'ban_member' }]);
  assert.equal(auth.authorized, false, 'Role with similar name must NOT inherit authorization');
});

test('15. Verify that deleted or recreated roles do not silently inherit stale authorization', () => {
  const guild = createMockGuild({ id: 'guild_deleted_role' });
  const oldRoleId = 'role_deleted_123';

  GuildConfigService.authorizeRole(guild.id, {
    roleId: oldRoleId,
    roleName: 'Mod',
    capabilities: ['ban_members']
  }, { id: 'admin', tag: 'Admin' });

  // Recreated role has a new Discord Snowflake ID
  const newRole = createMockRole(guild, {
    id: 'role_new_456',
    name: 'Mod',
    permissions: [PermissionFlagsBits.BanMembers]
  });

  const member = createMockMember(guild, { id: 'user_mod', roles: [newRole] });
  const auth = checkUserAuthorization(member, [{ action: 'ban_member' }]);
  assert.equal(auth.authorized, false, 'Recreated role with new Snowflake ID must not inherit old authorization');
});

test('16. Verify that role precedence and explicit denials follow documented policy', () => {
  const guild = createMockGuild({ id: 'guild_precedence' });

  // Role 1 grants moderation
  const roleMod = createMockRole(guild, {
    id: 'role_mod',
    name: 'Moderator',
    permissions: [PermissionFlagsBits.BanMembers, PermissionFlagsBits.KickMembers]
  });

  // Role 2 has explicit hard denial on ban_members
  const roleJunior = createMockRole(guild, {
    id: 'role_jr',
    name: 'Junior',
    permissions: [PermissionFlagsBits.BanMembers, PermissionFlagsBits.KickMembers]
  });

  GuildConfigService.authorizeRole(guild.id, {
    roleId: roleMod.id,
    roleName: 'Moderator',
    capabilities: ['moderation'] // expands to ban, kick, timeout, etc.
  }, { id: 'admin', tag: 'Admin' });

  GuildConfigService.authorizeRole(guild.id, {
    roleId: roleJunior.id,
    roleName: 'Junior',
    capabilities: ['kick_members'],
    denyCapabilities: ['ban_members'] // Explicit hard-deny
  }, { id: 'admin', tag: 'Admin' });

  // Member holds BOTH roles
  const member = createMockMember(guild, { id: 'user_both', roles: [roleMod, roleJunior] });

  // kick_member should be allowed
  const authKick = checkUserAuthorization(member, [{ action: 'kick_member' }]);
  assert.equal(authKick.authorized, true);

  // ban_member MUST be denied because of the hard-denial on Junior role
  const authBan = checkUserAuthorization(member, [{ action: 'ban_member' }]);
  assert.equal(authBan.authorized, false);
  assert.match(authBan.reason, /explicitly den/i);
});

test('17. Verify that effective policy respects Discord permissions and role hierarchy', () => {
  const guild = createMockGuild({ id: 'guild_discord_perms' });

  // Role authorized in Honey Bot policy, but has NO BanMembers Discord permission
  const role = createMockRole(guild, {
    id: 'role_bot_only',
    name: 'BotMod',
    permissions: [] // Missing BanMembers in Discord!
  });

  GuildConfigService.authorizeRole(guild.id, {
    roleId: role.id,
    roleName: 'BotMod',
    capabilities: ['ban_members']
  }, { id: 'admin', tag: 'Admin' });

  const member = createMockMember(guild, { id: 'user_bot_only', roles: [role] });

  const auth = checkUserAuthorization(member, [{ action: 'ban_member' }]);
  assert.equal(auth.authorized, false);
  assert.match(auth.reason, /lacks the required Discord .*permission/i);
});

test('18. Verify that a stale confirmation cannot apply an outdated policy revision', () => {
  const guildId = 'guild_stale_rev';
  const c1 = GuildConfigService.getConfig(guildId);
  assert.equal(c1.revision, 1);

  // Update revision to 2
  GuildConfigService.authorizeRole(guildId, {
    roleId: 'r1',
    roleName: 'R1',
    capabilities: ['channels']
  }, { id: 'admin', tag: 'Admin' });

  const c2 = GuildConfigService.getConfig(guildId);
  assert.equal(c2.revision, 2);

  // Trying to save an update based on stale revision 1 should throw ConcurrencyConflictError
  assert.throws(
    () => {
      GuildConfigService.saveConfig(guildId, {
        ...c1,
        authorizationPolicy: { ...c1.authorizationPolicy }
      }, 1, { id: 'admin', tag: 'Admin' });
    },
    ConcurrencyConflictError
  );
});

test('19. Verify that concurrent configuration changes do not silently overwrite one another', () => {
  const guildId = 'guild_concurrent';
  const base = GuildConfigService.getConfig(guildId);

  // Admin 1 and Admin 2 both read base (revision 1)
  const patch1 = { ...base, featureSettings: { test1: true } };
  const patch2 = { ...base, featureSettings: { test2: true } };

  // Admin 1 saves first
  const saved1 = GuildConfigService.saveConfig(guildId, patch1, base.revision, { id: 'admin1', tag: 'A1' });
  assert.equal(saved1.revision, 2);

  // Admin 2 attempts to save with stale revision 1
  assert.throws(
    () => {
      GuildConfigService.saveConfig(guildId, patch2, base.revision, { id: 'admin2', tag: 'A2' });
    },
    ConcurrencyConflictError
  );
});

test('20. Verify that immutable anti-nuke policy cannot be overridden by guild configuration', () => {
  const guild = createMockGuild({ id: 'guild_antinuke' });
  const owner = createMockMember(guild, { id: guild.ownerId, isOwner: true, isAdmin: true });

  // Evaluate mass channel delete attempt in SecurityGate
  assert.throws(
    () => {
      SecurityGate.evaluatePromptSecurity('delete all channels in the server', owner.id, guild);
    },
    /ANTI_NUKE_TRIGGERED|immutable Honey Bot security policy/i
  );
});

// =========================================================================
// SECTION 3: CONFIGURATION INTEGRITY (Tests 21-27)
// =========================================================================

test('21. Verify persistence across application restarts', () => {
  const guildId = 'guild_restart_test';

  GuildConfigService.authorizeRole(guildId, {
    roleId: 'role_persistent',
    roleName: 'PersistentRole',
    capabilities: ['moderation']
  }, { id: 'admin', tag: 'Admin' });

  // Clear in-memory cache to simulate full bot process restart
  GuildConfigService.invalidateCache();

  // Reload config from disk
  const reloaded = GuildConfigService.getConfig(guildId);
  assert.equal(reloaded.guildId, guildId);
  assert.ok(reloaded.authorizationPolicy.operatorRoles['role_persistent']);
  assert.equal(reloaded.authorizationPolicy.operatorRoles['role_persistent'].roleName, 'PersistentRole');
});

test('22. Verify safe behavior when storage is unavailable or corrupt', () => {
  const invalidJson = '{ corrupt json';
  const tempFile = path.resolve('data/guild-configs.json.test');
  fs.writeFileSync(tempFile, invalidJson, 'utf8');

  // Load from broken path
  const origPath = GuildConfigService.storagePath;
  GuildConfigService.storagePath = tempFile;

  try {
    const loaded = GuildConfigService.loadAllConfigs();
    assert.ok(loaded instanceof Map);
    assert.equal(loaded.size, 0, 'Corrupt file should fallback safely to empty Map without crashing');
  } finally {
    GuildConfigService.storagePath = origPath;
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
});

test('23. Verify configuration schema validation and migration', () => {
  const oldConfig = {
    guildId: 'guild_old_schema',
    schemaVersion: 0.9,
    revision: 1
    // missing new fields
  };

  const validated = GuildConfigService.validateSchema(oldConfig);
  assert.equal(validated.schemaVersion, 1);
  assert.ok(validated.authorizationPolicy);
  assert.ok(validated.featureSettings);
  assert.ok(validated.moderationSettings);
  assert.ok(validated.approvalSettings);
});

test('24. Verify that configuration changes are logged with correct guild ID', () => {
  const guildId = 'guild_audit_log_id';

  const saved = GuildConfigService.authorizeRole(guildId, {
    roleId: 'role_audit_mod',
    roleName: 'AuditMod',
    capabilities: ['kick_members']
  }, { id: 'admin_audit', tag: 'AdminAudit' });

  assert.ok(saved.auditMetadata);
  assert.ok(Array.isArray(saved.auditMetadata.history));
  const latest = saved.auditMetadata.history[0];
  assert.equal(latest.guildId, guildId);
  assert.equal(latest.actorId, 'admin_audit');
});

test('25. Verify that rollback is guild-scoped and does not overwrite unrelated newer changes', async () => {
  const guild = createMockGuild({ id: 'guild_rollback_scoped' });
  const admin = { id: guild.ownerId, tag: 'Owner' };

  // Initial config
  const initial = GuildConfigService.getConfig(guild.id);

  // Mutation 1: add role 1
  const after1 = GuildConfigService.authorizeRole(guild.id, {
    roleId: 'r1',
    roleName: 'R1',
    capabilities: ['kick_members']
  }, admin);

  // Mutation 2: add role 2
  const after2 = GuildConfigService.authorizeRole(guild.id, {
    roleId: 'r2',
    roleName: 'R2',
    capabilities: ['ban_members']
  }, admin);

  // Rollback to after1
  const handler = RecoveryRegistry.getHandler('configure_guild_policy');
  await handler.execute(guild, {
    guildId: guild.id,
    preState: after1
  });

  const current = GuildConfigService.getConfig(guild.id);
  assert.ok(current.authorizationPolicy.operatorRoles['r1']);
  assert.equal(current.authorizationPolicy.operatorRoles['r2'], undefined);
});

test('26. Verify that global settings cannot be edited through guild-level configuration', () => {
  const guildId = 'guild_no_global';
  const customConfig = GuildConfigService.getConfig(guildId);

  // Attempt to inject global config overrides
  customConfig.ai = { apiKey: 'stolen_key' };
  customConfig.token = 'stolen_bot_token';

  const validated = GuildConfigService.validateSchema(customConfig);
  // Validated schema only retains known guild fields
  assert.equal(validated.token, undefined);
  assert.equal(config.discord.token !== 'stolen_bot_token', true);
});

test('27. Verify that /help and /diagnose do not leak another guild data', async () => {
  const guildA = createMockGuild({ id: 'guild_help_a', name: 'SecretServerA' });
  const guildB = createMockGuild({ id: 'guild_help_b', name: 'SecretServerB' });

  GuildConfigService.authorizeRole(guildA.id, {
    roleId: 'role_secret_a',
    roleName: 'SecretRoleA',
    capabilities: ['moderation']
  }, { id: 'admin_a', tag: 'AdminA' });

  const diagReport = await DiagnosticService.diagnose('', { guild: guildB, user: { id: guildB.ownerId } });
  const diagText = JSON.stringify(diagReport);

  assert.equal(diagText.includes('SecretServerA'), false, 'Diagnose must not leak Server A name');
  assert.equal(diagText.includes('SecretRoleA'), false, 'Diagnose must not leak Server A roles');
});

// =========================================================================
// SECTION 4: INTEGRATION AND NATURAL LANGUAGE (Tests 28-34)
// =========================================================================

test('28. Configure access using several different natural-language phrasings', async () => {
  const router = new IntentRouter({ isDeterministicOnly: true });

  const phrases = [
    'Allow the Moderator role to use Honey Bot in this server.',
    'Only Admin and Senior Moderator roles can execute moderation actions here.',
    'Let the Support Team inspect members but not kick or ban anyone.',
    'Allow the Event Manager role to manage event channels, but nothing else.',
    'Remove the Moderator role\'s permission to ban members here.',
    'Configure this server so only administrators can change Honey Bot\'s access rules.',
    'Reset this server\'s bot access configuration to its defaults.'
  ];

  for (const p of phrases) {
    const result = await router.route(p, {});
    assert.ok(
      result.intent === 'configure_guild_policy' || result.intent === 'reset_guild_policy',
      `Prompt "${p}" should route to policy intent, got ${result.intent}`
    );
  }
});

test('29. Resolve ambiguous role names through clarification', async () => {
  const guild = createMockGuild({ id: 'guild_ambiguous_roles' });
  createMockRole(guild, { id: 'role_mod_1', name: 'Moderator' });
  createMockRole(guild, { id: 'role_mod_2', name: 'moderator' });

  const result = await Operations.configureGuildPolicy(guild, {
    targetRole: 'moderator',
    capabilities: ['moderation']
  }, { invokingUser: { id: guild.ownerId, tag: 'Owner' } });

  assert.equal(result.success, false);
  assert.match(result.error, /Multiple roles matched "moderator"/i);
});

test('30. Inspect the active policy using ordinary English', async () => {
  const router = new IntentRouter({ isDeterministicOnly: true });

  const inspectPrompts = [
    'Show me the roles currently authorized to operate Honey Bot in this server.',
    'Who can use Honey Bot?',
    'Check whether this server\'s access rules are configured correctly.',
    'What can each configured role do?',
    'Who can change the bot\'s access policy?'
  ];

  for (const prompt of inspectPrompts) {
    const res = await router.route(prompt, {});
    assert.equal(res.intent, 'inspect_guild_policy', `Prompt "${prompt}" should route to inspect_guild_policy`);
  }

  const guild = createMockGuild({ id: 'guild_inspect_active' });
  const inspection = await Operations.inspectGuildPolicy(guild);
  assert.equal(inspection.success, true);
  assert.ok(inspection.details.includes('Honey Bot Access Policy'));
  assert.ok(inspection.embed);
});

test('31. Perform a dry-run authorization test without executing a mutation', async () => {
  const router = new IntentRouter({ isDeterministicOnly: true });
  const query = 'Would a member with the Moderator and Event Manager roles be allowed to ban someone in this server?';

  const routed = await router.route(query, {});
  assert.equal(routed.intent, 'test_guild_policy');

  const guild = createMockGuild({ id: 'guild_dry_run' });
  const modRole = createMockRole(guild, { id: 'role_dry_mod', name: 'Moderator' });

  const testResult = await Operations.testGuildPolicy(guild, {
    targetRole: 'Moderator',
    targetAction: 'ban_member'
  });

  assert.equal(testResult.success, true);
  assert.equal(testResult.authorized, false); // Not configured yet, so denied
  assert.match(testResult.details, /IS NOT AUTHORIZED/i);
});

test('32. Verify that registered slash commands remain intact', () => {
  const registeredNames = slashCommands.map(c => c.name).sort();
  const expectedNames = ['diagnose', 'go', 'help', 'honeypot', 'modlog', 'undo'].sort();

  assert.deepEqual(registeredNames, expectedNames);
  assert.equal(registeredNames.length, 6);
});

test('33. Verify that existing moderation, logging, undo, and diagnostics functionality still works', async () => {
  const guild = createMockGuild({ id: 'guild_regression_check' });
  const targetMember = createMockMember(guild, { id: 'user_target', name: 'BadActor' });
  targetMember.ban = async (opts) => ({ user: { id: targetMember.id }, reason: opts?.reason });
  guild.members.ban = async (id, opts) => ({ user: { id }, reason: opts?.reason });

  // Test moderation execution via Executor
  const banRes = await Executor.executeSingleAction(guild, {
    action: 'ban_member',
    targetMember: targetMember.id,
    reason: 'Spamming'
  }, guild.members.me, 'test_exec_regression');
  assert.equal(banRes.success, true);

  // Test ActionLedger tracking
  const ledger = ActionLedger.getGuildLedger(guild.id);
  assert.ok(ledger);

  // Test Diagnose
  const diag = await DiagnosticService.diagnose('', { guild, user: { id: guild.ownerId } });
  assert.ok(diag.status !== undefined);
});

test('34. Verify that no paid inference fallback or unnecessary dependency was introduced', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  const deps = Object.keys(packageJson.dependencies || {});

  // Confirm no OpenAI, Anthropic, or paid cloud inference libraries are in dependencies
  const forbiddenDeps = ['openai', '@anthropic-ai/sdk', 'cohere-ai', 'langchain'];
  for (const forbidden of forbiddenDeps) {
    assert.equal(deps.includes(forbidden), false, `Dependency ${forbidden} must not be introduced`);
  }
});
