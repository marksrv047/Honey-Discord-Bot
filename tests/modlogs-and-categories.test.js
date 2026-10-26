/**
 * tests/modlogs-and-categories.test.js
 * Comprehensive automated tests for Modlog reporting and Category administration.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';

import { ModLogService } from '../src/mod-log.js';
import { ModlogInterpreter } from '../src/modlog-interpreter.js';
import { IntentRouter } from '../src/intent-router.js';
import { Operations } from '../src/operations.js';
import { RecoveryRegistry } from '../src/recovery.js';

const {
  createCategory,
  renameCategory,
  deleteCategory,
  inspectCategory,
  listCategories,
  moveChannelToCategory,
  setCategoryPermission,
  syncCategoryPermissions,
  inspectCategorySync,
  resolveCategory
} = Operations;

function createMockGuild(guildId = '111122223333444455') {
  const channels = new Map();
  channels.filter = (fn) => {
    const res = new Map();
    for (const [k, v] of channels.entries()) {
      if (fn(v, k)) res.set(k, v);
    }
    return res;
  };
  channels.find = (fn) => {
    for (const [k, v] of channels.entries()) {
      if (fn(v, k)) return v;
    }
    return null;
  };

  const roles = new Map();
  roles.filter = (fn) => {
    const res = new Map();
    for (const [k, v] of roles.entries()) {
      if (fn(v, k)) res.set(k, v);
    }
    return res;
  };
  roles.find = (fn) => {
    for (const [k, v] of roles.entries()) {
      if (fn(v, k)) return v;
    }
    return null;
  };

  const everyoneRole = {
    id: guildId,
    name: '@everyone',
    permissions: { has: () => true }
  };
  roles.set(guildId, everyoneRole);

  const staffRole = {
    id: '999988887777666655',
    name: 'Staff',
    permissions: { has: () => true }
  };
  roles.set(staffRole.id, staffRole);

  const mockClient = {
    user: { id: 'bot-123', tag: 'HoneyBot#0001' }
  };

  const mockGuild = {
    id: guildId,
    name: `Test Guild ${guildId}`,
    client: mockClient,
    channels: {
      cache: channels,
      fetch: async (id) => channels.get(id) || null,
      create: async ({ name, type, parent, permissionOverwrites }) => {
        const id = `ch-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const overwritesMap = new Map();
        if (Array.isArray(permissionOverwrites)) {
          for (const ow of permissionOverwrites) {
            overwritesMap.set(ow.id, {
              id: ow.id,
              type: ow.type ?? 0,
              allow: { bitfield: BigInt(0), toArray: () => [], has: () => false },
              deny: { bitfield: BigInt(0), toArray: () => [], has: () => false },
              ...ow
            });
          }
        }

        const channel = {
          id,
          name,
          type,
          guildId,
          parentId: parent ?? null,
          parent: parent ? channels.get(parent) ?? null : null,
          permissionsLocked: false,
          permissionOverwrites: {
            cache: overwritesMap,
            edit: async (targetId, updates) => {
              const existing = overwritesMap.get(targetId) || {
                id: targetId,
                allow: { bitfield: BigInt(0), toArray: () => [], has: () => false },
                deny: { bitfield: BigInt(0), toArray: () => [], has: () => false }
              };
              overwritesMap.set(targetId, { ...existing, ...updates });
              return channel;
            },
            delete: async (targetId) => {
              overwritesMap.delete(targetId);
              return channel;
            }
          },
          permissionsFor: (memberOrRole) => ({
            has: (perm) => true
          }),
          setParent: async (newParent, opts) => {
            channel.parentId = newParent;
            channel.parent = newParent ? channels.get(newParent) ?? null : null;
            if (opts?.lockPermissions) {
              channel.permissionsLocked = true;
            }
            return channel;
          },
          lockPermissions: async () => {
            channel.permissionsLocked = true;
            return channel;
          },
          setName: async (newName) => {
            channel.name = newName;
            return channel;
          },
          delete: async () => {
            channels.delete(id);
            return channel;
          },
          send: async (payload) => {
            channel._lastMessage = payload;
            return { id: `msg-${Date.now()}`, ...payload };
          }
        };
        channels.set(id, channel);
        return channel;
      }
    },
    roles: {
      cache: roles,
      fetch: async (id) => roles.get(id) || null
    },
    members: {
      me: {
        id: 'bot-123',
        permissions: { has: () => true }
      },
      fetch: async (id) => ({
        id,
        user: { id, tag: `User#${id.slice(-4)}` },
        roles: { cache: new Map() }
      })
    }
  };

  return { mockGuild, channels, roles };
}

// ---------------------------------------------------------
// 1. MODLOG NATURAL LANGUAGE INTERPRETATION TESTS
// ---------------------------------------------------------

test('Modlog Interpreter: correctly parses natural-language setup and management requests', async () => {
  // Setup requests
  let result = await ModlogInterpreter.interpret('Set up the modlogs channel in this server.');
  assert.equal(result.intent, 'setup_logging');

  result = await ModlogInterpreter.interpret('Create a Modlogs channel and send all moderation reports there.');
  assert.equal(result.intent, 'setup_logging');

  result = await ModlogInterpreter.interpret('Use #staff-logs for moderation reports.');
  assert.equal(result.intent, 'configure_channel');
  assert.equal(result.targetChannel, '#staff-logs');

  // Inspection & Testing
  result = await ModlogInterpreter.interpret('Show me the current logging configuration.');
  assert.equal(result.intent, 'inspect_config');

  result = await ModlogInterpreter.interpret('Test whether moderation logs are working.');
  assert.equal(result.intent, 'test_channel');

  result = await ModlogInterpreter.interpret("Why aren't moderation reports appearing?");
  assert.equal(result.intent, 'troubleshoot_config');

  // Preference and Filtering
  result = await ModlogInterpreter.interpret('Log permission changes and category modifications too.');
  assert.equal(result.intent, 'update_filter');
  assert.ok(result.filterEvents.includes('categories'));
  assert.ok(result.filterEvents.includes('permissions'));

  result = await ModlogInterpreter.interpret('Stop logging successful actions but keep failed actions and denied attempts.');
  assert.equal(result.intent, 'update_filter');
  assert.equal(result.logSuccess, false);
  assert.equal(result.logFailed, true);
  assert.equal(result.logDenied, true);

  result = await ModlogInterpreter.interpret('Verify that all moderation actions are being recorded.');
  assert.equal(result.intent, 'test_channel');
});

// ---------------------------------------------------------
// 2. MODLOG SERVICE SETUP, DELIVERY, & FILTERING TESTS
// ---------------------------------------------------------

test('ModLogService: setupModlogs creates or configures log channel with full verification', async () => {
  const { mockGuild, channels } = createMockGuild('guild-modlog-test-1');

  // 1. Initial setup - auto creates channel
  const setupRes = await ModLogService.setupModlogs(mockGuild, {
    callerTag: 'Admin#0001'
  });
  assert.equal(setupRes.success, true);
  assert.ok(setupRes.channelId);
  assert.equal(setupRes.created, true);
  assert.equal(setupRes.tested, true);

  const cfg = ModLogService.getConfig(mockGuild.id);
  assert.equal(cfg.channelId, setupRes.channelId);
  assert.equal(cfg.setupStatus, 'configured');
  assert.ok(cfg.revision >= 1);

  // 2. Reconfiguration to existing channel
  const staffChannel = await mockGuild.channels.create({
    name: 'staff-logs',
    type: ChannelType.GuildText
  });

  const reconfigRes = await ModLogService.setupModlogs(mockGuild, {
    channelRef: staffChannel.id,
    callerTag: 'Admin#0001'
  });
  assert.equal(reconfigRes.success, true);
  assert.equal(reconfigRes.channelId, staffChannel.id);
  assert.equal(reconfigRes.created, false);

  const updatedCfg = ModLogService.getConfig(mockGuild.id);
  assert.equal(updatedCfg.channelId, staffChannel.id);
  assert.ok(updatedCfg.revision > cfg.revision);
});

test('ModLogService: event filtering and plain-text fallback', async () => {
  const { mockGuild } = createMockGuild('guild-filter-test');

  // Set up modlog
  await ModLogService.setupModlogs(mockGuild, { callerTag: 'Admin#0001' });

  // Update preferences to stop logging successful actions
  ModLogService.updatePreferences(mockGuild.id, { logSuccess: false }, 'Admin#0001');

  // Attempt to log a successful action -> should be skipped by policy
  const successLogRes = await ModLogService.logAction(mockGuild, {
    action: 'timeout_member',
    status: 'succeeded',
    target: { id: 'user-1', name: 'UserOne' },
    actor: { id: 'admin-1', tag: 'Admin#0001' },
    reason: 'Spam'
  });
  assert.equal(successLogRes.logged, false);
  assert.equal(successLogRes.reason, 'filtered_success');

  // Attempt to log a failed action -> should be logged
  const failedLogRes = await ModLogService.logAction(mockGuild, {
    action: 'timeout_member',
    status: 'failed',
    target: { id: 'user-1', name: 'UserOne' },
    actor: { id: 'admin-1', tag: 'Admin#0001' },
    error: 'Missing Permissions'
  });
  assert.equal(failedLogRes.logged, true);
});

test('ModLogService: durable pending delivery queue and retry without re-executing action', async () => {
  const { mockGuild, channels } = createMockGuild(`guild-retry-test-${Date.now()}`);
  await ModLogService.setupModlogs(mockGuild, { callerTag: 'Admin#0001' });
  const cfg = ModLogService.getConfig(mockGuild.id);
  const logChan = channels.get(cfg.channelId);

  // Simulate destination delivery failure
  const originalSend = logChan.send;
  logChan.send = async () => {
    throw new Error('DiscordAPIError[50001]: Missing Access');
  };

  const logRes = await ModLogService.logAction(mockGuild, {
    action: 'ban_member',
    status: 'succeeded',
    target: { id: 'bad-actor', name: 'Troll#1234' },
    actor: { id: 'mod-1', tag: 'Mod#0001' },
    reason: 'Raid'
  });

  assert.equal(logRes.logged, false);
  assert.ok(logRes.queued);

  const pending = ModLogService.getPendingDeliveries(mockGuild.id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].action, 'ban_member');

  // Restore destination delivery
  logChan.send = originalSend;

  // Flush pending deliveries -> should deliver without repeating moderation ban action
  const flushRes = await ModLogService.flushPendingDeliveries(mockGuild);
  assert.equal(flushRes.delivered, 1);
  assert.equal(flushRes.remaining, 0);
  assert.equal(ModLogService.getPendingDeliveries(mockGuild.id).length, 0);
});

// ---------------------------------------------------------
// 3. CATEGORY INTENT ROUTING IN /go
// ---------------------------------------------------------

test('Intent Router: accurately routes natural-language category management requests', async () => {
  const router = new IntentRouter({ isDeterministicOnly: true });
  const mockContext = { guild: { id: 'guild-router-test' } };

  let res = await router.route('Create a Support category.', mockContext);
  assert.equal(res.intent, 'create_category');
  assert.equal(res.args.name, 'Support');

  res = await router.route('Create a private Staff category.', mockContext);
  assert.equal(res.intent, 'create_category');
  assert.equal(res.args.name, 'Staff');
  assert.equal(res.args.isPrivate, true);

  res = await router.route('Rename the Support category to Customer Support.', mockContext);
  assert.equal(res.intent, 'rename_category');
  assert.equal(res.args.category, 'Support');
  assert.equal(res.args.newName, 'Customer Support');

  res = await router.route('Show me the channels inside Support.', mockContext);
  assert.equal(res.intent, 'inspect_category');
  assert.equal(res.args.category, 'Support');

  res = await router.route('Move #tickets into Support.', mockContext);
  assert.equal(res.intent, 'move_channel_to_category');
  assert.equal(res.args.channel, 'tickets');
  assert.equal(res.args.category, 'Support');

  res = await router.route('Allow the Support Team to view the Support category.', mockContext);
  assert.equal(res.intent, 'set_category_permission');
  assert.equal(res.args.category, 'Support');
  assert.equal(res.args.target, 'Support Team');
  assert.ok(res.args.allow.includes('ViewChannel'));

  res = await router.route('Make all channels in Support read-only for the Member role.', mockContext);
  assert.equal(res.intent, 'set_category_permission');
  assert.equal(res.args.category, 'Support');
  assert.equal(res.args.target, 'Member');
  assert.ok(res.args.deny.includes('SendMessages'));

  res = await router.route('Synchronize the child channels with the category permissions in Support.', mockContext);
  assert.equal(res.intent, 'sync_category_permissions');
  assert.equal(res.args.category, 'Support');

  res = await router.route('Show me which channels have permission overrides that differ from their category in Support.', mockContext);
  assert.equal(res.intent, 'inspect_category_sync');
  assert.equal(res.args.category, 'Support');

  res = await router.route('Explain what will change if I delete this category Support.', mockContext);
  assert.equal(res.intent, 'delete_category');
  assert.equal(res.args.category, 'Support');
  assert.equal(res.args.explainOnly, true);
});

// ---------------------------------------------------------
// 4. CATEGORY OPERATIONS & CHILD PERMISSION SEMANTICS
// ---------------------------------------------------------

test('Category Operations: create, rename, inspect, list, and delete categories safely', async () => {
  const { mockGuild } = createMockGuild('guild-cat-ops');
  const context = { executionId: 'exec-cat-1', user: { tag: 'Admin#0001' } };

  // 1. Create Category
  const createRes = await createCategory(
    mockGuild,
    { name: 'Community', isPrivate: false },
    context
  );
  assert.equal(createRes.success, true);
  assert.equal(createRes.category.name, 'Community');

  const catId = createRes.category.id;

  // 2. Rename Category
  const renameRes = await renameCategory(mockGuild, catId, 'Public Community', context);
  assert.equal(renameRes.success, true);
  assert.equal(renameRes.newName, 'Public Community');

  // Idempotent rename check
  const idempotentRename = await renameCategory(
    mockGuild,
    catId,
    'Public Community',
    context
  );
  assert.equal(idempotentRename.success, true);
  assert.equal(idempotentRename.alreadySatisfied, true);

  // 3. Inspect Category
  const inspectRes = await inspectCategory(mockGuild, catId, context);
  assert.equal(inspectRes.success, true);
  assert.equal(inspectRes.category.name, 'Public Community');
  assert.equal(inspectRes.category.childCount, 0);

  // 4. List Categories
  const listRes = await listCategories(mockGuild, context);
  assert.equal(listRes.success, true);
  assert.equal(listRes.count, 1);

  // 5. Delete empty category
  const deleteRes = await deleteCategory(mockGuild, catId, {}, context);
  assert.equal(deleteRes.success, true);
  assert.equal(deleteRes.category.name, 'Public Community');

  const afterDeleteList = await listCategories(mockGuild, context);
  assert.equal(afterDeleteList.count, 0);
});

test('Category Operations: move channel, sync permissions, and inspect sync state', async () => {
  const { mockGuild, channels } = createMockGuild('guild-sync-test');
  const context = { executionId: 'exec-sync-1', user: { tag: 'Admin#0001' } };

  // Create Category
  const catRes = await createCategory(mockGuild, { name: 'Support' }, context);
  const catId = catRes.category.id;

  // Create Child Channels
  const ticketChan = await mockGuild.channels.create({
    name: 'ticket-101',
    type: ChannelType.GuildText
  });
  const faqChan = await mockGuild.channels.create({
    name: 'faq',
    type: ChannelType.GuildText
  });

  // Move ticket-101 into Support with syncPermissions: true
  const moveRes = await moveChannelToCategory(
    mockGuild,
    ticketChan.id,
    catId,
    { syncPermissions: true },
    context
  );
  assert.equal(moveRes.success, true);
  assert.equal(moveRes.channel.parentId, catId);
  assert.equal(ticketChan.permissionsLocked, true);

  // Move faq into Support without sync (unsynchronized)
  const moveFaqRes = await moveChannelToCategory(
    mockGuild,
    faqChan.id,
    catId,
    { syncPermissions: false },
    context
  );
  assert.equal(moveFaqRes.success, true);
  assert.equal(faqChan.permissionsLocked, false);

  // Set category permissions for Staff -> reports affected children
  const permRes = await setCategoryPermission(
    mockGuild,
    catId,
    'Staff',
    ['ViewChannel', 'SendMessages'],
    [],
    context
  );
  assert.equal(permRes.success, true);
  assert.equal(permRes.affectedChildren.synchronizedCount, 1);
  assert.equal(permRes.affectedChildren.unsynchronizedCount, 1);

  // Inspect Category Sync
  const syncInspect = await inspectCategorySync(mockGuild, catId, context);
  assert.equal(syncInspect.success, true);
  assert.equal(syncInspect.synchronizedCount, 1);
  assert.equal(syncInspect.unsynchronizedCount, 1);
  assert.equal(syncInspect.unsynchronizedChannels[0].name, 'faq');

  // Synchronize all child channels
  const syncAllRes = await syncCategoryPermissions(mockGuild, catId, null, context);
  assert.equal(syncAllRes.success, true);
  assert.equal(syncAllRes.syncedChannels.length, 2);
  assert.equal(faqChan.permissionsLocked, true);
});

test('Category Operations: unparent child channels on category deletion', async () => {
  const { mockGuild } = createMockGuild('guild-cat-delete-safe');
  const context = { executionId: 'exec-del-1', user: { tag: 'Admin#0001' } };

  const catRes = await createCategory(mockGuild, { name: 'Archive' }, context);
  const catId = catRes.category.id;

  const docChan = await mockGuild.channels.create({
    name: 'old-docs',
    type: ChannelType.GuildText,
    parent: catId
  });

  // Explain-only preview
  const previewRes = await deleteCategory(mockGuild, catId, { explainOnly: true }, context);
  assert.equal(previewRes.success, true);
  assert.equal(previewRes.explainOnly, true);
  assert.equal(previewRes.consequences.childChannelCount, 1);

  // Safe delete: unparents child channels, does not delete them
  const deleteRes = await deleteCategory(mockGuild, catId, { deleteChildChannels: false }, context);
  assert.equal(deleteRes.success, true);
  assert.equal(deleteRes.unparentedChannels.length, 1);
  assert.equal(docChan.parentId, null);
  assert.ok(mockGuild.channels.cache.has(docChan.id));
});

// ---------------------------------------------------------
// 5. CATEGORY UNDO AND RECOVERY INTEGRATION
// ---------------------------------------------------------

test('Recovery Engine: rollbacks category creation, rename, and channel movements', async () => {
  const { mockGuild } = createMockGuild('guild-recovery-test');
  const context = { executionId: 'exec-rec-1', user: { tag: 'Admin#0001' } };

  // 1. Create Category & Undo
  const createRes = await createCategory(mockGuild, { name: 'Temporary' }, context);
  const catId = createRes.category.id;
  assert.ok(mockGuild.channels.cache.has(catId));

  const handlerCreate = RecoveryRegistry.getHandler('create_category');
  assert.ok(handlerCreate);
  const undoCreate = await handlerCreate.execute(mockGuild, { targetId: catId, name: 'Temporary' }, context);
  assert.equal(undoCreate.success, true);
  assert.ok(!mockGuild.channels.cache.has(catId));

  // 2. Rename Category & Undo
  const catRes2 = await createCategory(mockGuild, { name: 'Original Name' }, context);
  const catId2 = catRes2.category.id;

  const renameRes = await renameCategory(mockGuild, catId2, 'New Name', context);
  assert.equal(mockGuild.channels.cache.get(catId2).name, 'New Name');

  const handlerRename = RecoveryRegistry.getHandler('rename_category');
  assert.ok(handlerRename);
  const undoRename = await handlerRename.execute(mockGuild, { targetId: catId2, preState: { name: 'Original Name' } }, context);
  assert.equal(undoRename.success, true);
  assert.equal(mockGuild.channels.cache.get(catId2).name, 'Original Name');

  // 3. Move Channel & Undo
  const textChan = await mockGuild.channels.create({
    name: 'general',
    type: ChannelType.GuildText
  });
  assert.equal(textChan.parentId, null);

  const moveRes = await moveChannelToCategory(mockGuild, textChan.id, catId2, {}, context);
  assert.equal(textChan.parentId, catId2);

  const handlerMove = RecoveryRegistry.getHandler('move_channel_to_category');
  assert.ok(handlerMove);
  const undoMove = await handlerMove.execute(mockGuild, { targetId: textChan.id, preState: { parentId: null } }, context);
  assert.equal(undoMove.success, true);
  assert.equal(textChan.parentId, null);
});

// ---------------------------------------------------------
// 6. STRICT GUILD ISOLATION
// ---------------------------------------------------------

test('Strict Guild Isolation: prevents cross-guild category access or configuration leakage', async () => {
  const { mockGuild: guildA } = createMockGuild('guild-AAA-111');
  const { mockGuild: guildB } = createMockGuild('guild-BBB-222');

  // Setup logging in Guild A
  await ModLogService.setupModlogs(guildA, { callerTag: 'AdminA#0001' });
  const cfgA = ModLogService.getConfig(guildA.id);
  const cfgB = ModLogService.getConfig(guildB.id);

  assert.equal(cfgA.setupStatus, 'configured');
  assert.equal(cfgB.setupStatus, 'unconfigured');
  assert.notEqual(cfgA.channelId, cfgB.channelId);

  // Create Category in Guild A
  const catResA = await createCategory(guildA, { name: 'Guild A Only' }, { executionId: 'exec-iso-1' });

  // Guild B cannot resolve or modify Guild A's category
  const resolvedInB = await resolveCategory(guildB, catResA.category.id);
  assert.equal(resolvedInB, null);

  const resolvedByNameInB = await resolveCategory(guildB, 'Guild A Only');
  assert.equal(resolvedByNameInB, null);
});
