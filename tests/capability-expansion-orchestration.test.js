import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChannelType, PermissionFlagsBits } from 'discord.js';

import { EmbedService, DISCORD_EMBED_LIMITS } from '../src/embed-service.js';
import { SelfRoleManager } from '../src/self-roles.js';
import { TaskQueue, TaskQueueState, TaskActionStatus } from '../src/task-queue.js';
import { CompletenessChecker } from '../src/completeness-checker.js';
import { SecurityGate } from '../src/security-gate.js';
import { checkRoleHierarchy } from '../src/permissions.js';
import { Operations } from '../src/operations.js';
import { Executor } from '../src/executor.js';
import { Verifier, VerificationStatus } from '../src/verification.js';
import { DiagnosticService, DiagnosticStatus } from '../src/diagnostic-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_STORAGE = path.join(__dirname, 'scratch-orchestration-task-queue.json');
const TEST_ROLES_STORAGE = path.join(__dirname, 'scratch-orchestration-self-roles.json');

describe('Honey Bot: Advanced Capability Expansion & Multi-Step Task Orchestration (15 Scenarios)', () => {
  beforeEach(() => {
    TaskQueue.storagePath = TEST_STORAGE;
    TaskQueue._tasks.clear();
    TaskQueue._guildLocks.clear();
    SelfRoleManager.storagePath = TEST_ROLES_STORAGE;
    SelfRoleManager._panels.clear();
    SelfRoleManager._loaded = false;

    if (fs.existsSync(TEST_STORAGE)) {
      try { fs.unlinkSync(TEST_STORAGE); } catch {}
    }
    if (fs.existsSync(TEST_ROLES_STORAGE)) {
      try { fs.unlinkSync(TEST_ROLES_STORAGE); } catch {}
    }
  });

  afterEach(() => {
    if (fs.existsSync(TEST_STORAGE)) {
      try { fs.unlinkSync(TEST_STORAGE); } catch {}
    }
    if (fs.existsSync(TEST_ROLES_STORAGE)) {
      try { fs.unlinkSync(TEST_ROLES_STORAGE); } catch {}
    }
  });

  // =========================================================================
  // SCENARIO 1: Successful embed creation and publishing
  // =========================================================================
  test('Scenario 1: Successful embed creation and publishing with rich properties and components', async () => {
    const embed = EmbedService.buildEmbed({
      title: '📢 Server Update',
      description: 'A major feature release is now deployed.',
      color: '#3498DB',
      fields: [
        { name: 'Feature 1', value: 'Embed Orchestration', inline: true },
        { name: 'Feature 2', value: 'Persistent Self-Roles', inline: true }
      ],
      footer: { text: 'Honey Bot Engineering' },
      timestamp: true,
      author: { name: 'Admin Team' }
    });

    assert.equal(embed.data.title, '📢 Server Update');
    assert.equal(embed.data.description, 'A major feature release is now deployed.');
    assert.equal(embed.data.fields.length, 2);
    assert.equal(embed.data.footer.text, 'Honey Bot Engineering');
    assert.ok(embed.data.timestamp);

    // Mock guild & channel publishing
    const sentMessages = [];
    const mockChannel = {
      id: 'ch_announcements',
      name: 'announcements',
      permissionsFor: () => ({
        has: () => true
      }),
      send: async (payload) => {
        const msg = { id: `msg_${Date.now()}`, ...payload };
        sentMessages.push(msg);
        return msg;
      }
    };

    const mockGuild = {
      id: 'guild_1',
      channels: {
        cache: new Map([['ch_announcements', mockChannel]])
      }
    };

    const pubResult = await EmbedService.publishEmbed(mockGuild, 'announcements', {
      title: '📢 Server Update',
      description: 'A major feature release is now deployed.',
      buttons: [{ label: 'View Changelog', style: 'Link', url: 'https://discord.com' }]
    }, { executionId: 'exec_1' });

    assert.equal(pubResult.success, true);
    assert.equal(pubResult.channelName, 'announcements');
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].components.length, 1);
  });

  // =========================================================================
  // SCENARIO 2: Multiple embeds within Discord limits and safe chunking
  // =========================================================================
  test('Scenario 2: Multiple embeds validated within limits and chunked when oversized', async () => {
    // 12 embeds (exceeds single message limit of 10)
    const embeds = [];
    for (let i = 1; i <= 12; i++) {
      embeds.push(EmbedService.buildEmbed({
        title: `Embed Part ${i}`,
        description: `Description for segment ${i}`
      }));
    }

    const batches = EmbedService.chunkEmbedsForDelivery(embeds);
    assert.equal(batches.length, 2);
    assert.equal(batches[0].length, 10);
    assert.equal(batches[1].length, 2);

    // Character bounds calculation
    const totalChars = EmbedService.calculateTotalCharacters(embeds.slice(0, 3));
    assert.ok(totalChars > 0 && totalChars < DISCORD_EMBED_LIMITS.TOTAL_CHARS_MAX);
  });

  // =========================================================================
  // SCENARIO 3: Creation of roles and a self-role channel via Multi-Step Orchestration
  // =========================================================================
  test('Scenario 3: Creation of roles and a self-role channel generates complete DAG plan', () => {
    const prompt = 'Create a reaction-role system for choosing game roles: RPG, FPS, Strategy';
    const planCheck = CompletenessChecker.verify(prompt, { thoughtProcess: 'Game self roles', actions: [] });

    assert.equal(planCheck.valid, true);
    const actions = planCheck.repairedPlan.actions;

    // Check step 1: create_channel
    assert.equal(actions[0].action, 'create_channel');
    assert.equal(actions[0].name, 'roles');

    // Check role creation steps
    const roleSteps = actions.filter(a => a.action === 'create_role');
    assert.equal(roleSteps.length, 3);
    assert.deepEqual(roleSteps.map(r => r.name), ['RPG', 'FPS', 'Strategy']);

    // Check panel setup step
    const panelStep = actions.find(a => a.action === 'setup_role_panel');
    assert.ok(panelStep);
    assert.equal(panelStep.panelType, 'reactions');
    assert.equal(panelStep.roles.length, 3);
    // Role panel step must depend on channel and role steps
    assert.ok(panelStep.dependsOn.length >= 4);
  });

  // =========================================================================
  // SCENARIO 4: Reaction-based role assignment and removal
  // =========================================================================
  test('Scenario 4: Reaction-based role assignment and removal', async () => {
    const assignedRoles = new Set();
    const mockMember = {
      id: 'user_gamer',
      user: { tag: 'GamerGuy#0001' },
      roles: {
        cache: {
          has: (roleId) => assignedRoles.has(roleId)
        },
        add: async (role) => { assignedRoles.add(role.id); },
        remove: async (role) => { assignedRoles.delete(role.id); }
      }
    };

    const mockRole = { id: 'role_rpg', name: 'RPG', position: 5 };
    const mockGuild = {
      id: 'guild_react',
      roles: {
        cache: new Map([['role_rpg', mockRole]])
      },
      members: {
        me: { roles: { highest: { position: 10 } } },
        fetch: async () => mockMember
      }
    };

    // Setup registered reaction panel in SelfRoleManager
    SelfRoleManager._panels.set('panel_react', {
      panelId: 'panel_react',
      guildId: 'guild_react',
      channelId: 'ch_roles',
      messageId: 'msg_panel_1',
      panelType: 'reactions',
      roles: [{ roleId: 'role_rpg', roleName: 'RPG', emoji: '🎮' }]
    });

    const mockReaction = {
      message: { id: 'msg_panel_1', guild: mockGuild },
      emoji: { name: '🎮', id: null }
    };

    // Reaction Add
    const addHandled = await SelfRoleManager.handleReactionAdd(mockReaction, { id: 'user_gamer', bot: false });
    assert.equal(addHandled, true);
    assert.equal(assignedRoles.has('role_rpg'), true);

    // Reaction Remove
    const removeHandled = await SelfRoleManager.handleReactionRemove(mockReaction, { id: 'user_gamer', bot: false });
    assert.equal(removeHandled, true);
    assert.equal(assignedRoles.has('role_rpg'), false);
  });

  // =========================================================================
  // SCENARIO 5: Button and select-menu role assignment
  // =========================================================================
  test('Scenario 5: Button and select-menu role assignment with single-select swap rule', async () => {
    const memberRoles = new Set();
    const mockMember = {
      id: 'user_1',
      roles: {
        cache: {
          has: (roleId) => memberRoles.has(roleId)
        },
        add: async (role) => { memberRoles.add(role.id); },
        remove: async (role) => { memberRoles.delete(role.id); }
      }
    };

    const roleA = { id: 'role_red', name: 'Red Team', position: 2 };
    const roleB = { id: 'role_blue', name: 'Blue Team', position: 2 };

    const mockGuild = {
      id: 'guild_buttons',
      roles: {
        cache: new Map([['role_red', roleA], ['role_blue', roleB]]),
        get: (id) => id === 'role_red' ? roleA : roleB
      },
      members: {
        me: { roles: { highest: { position: 10 } } }
      }
    };

    // Setup panel with single-selection rule
    SelfRoleManager._panels.set('panel_teams', {
      panelId: 'panel_teams',
      guildId: 'guild_buttons',
      channelId: 'ch_roles',
      messageId: 'msg_team',
      panelType: 'buttons',
      selectionRule: 'single',
      roles: [
        { roleId: 'role_red', roleName: 'Red Team' },
        { roleId: 'role_blue', roleName: 'Blue Team' }
      ]
    });

    // 1. Button Click: Choose Red Team
    let replyMsg = '';
    const btnInteraction1 = {
      isButton: () => true,
      customId: 'role:btn:panel_teams:role_red',
      guild: mockGuild,
      member: mockMember,
      deferred: false,
      replied: false,
      deferReply: async () => {},
      editReply: async (payload) => { replyMsg = payload.content; }
    };

    await SelfRoleManager.handleButtonInteraction(btnInteraction1);
    assert.ok(memberRoles.has('role_red'));
    assert.match(replyMsg, /Added \*\*@Red Team\*\*/);

    // 2. Select Menu Interaction: Choose Blue Team (Swaps Red for Blue because selectionRule === 'single')
    const selInteraction = {
      isStringSelectMenu: () => true,
      customId: 'role:sel:panel_teams',
      values: ['role_blue'],
      guild: mockGuild,
      member: mockMember,
      deferred: false,
      replied: false,
      deferReply: async () => {},
      editReply: async (payload) => { replyMsg = payload.content; }
    };

    await SelfRoleManager.handleSelectMenuInteraction(selInteraction);
    assert.ok(memberRoles.has('role_blue'));
    assert.equal(memberRoles.has('role_red'), false);
    assert.match(replyMsg, /Added \*\*@Blue Team\*\*/);
  });

  // =========================================================================
  // SCENARIO 6: Permission denial and role hierarchy restrictions
  // =========================================================================
  test('Scenario 6: Role hierarchy restriction prevents bot from assigning roles above it', async () => {
    const highRole = { id: 'role_admin', name: 'Admin', position: 20 };
    const mockGuild = {
      id: 'guild_hier',
      roles: {
        cache: new Map([['role_admin', highRole]]),
        get: () => highRole
      },
      members: {
        me: { roles: { highest: { position: 10 } } } // Bot position is strictly lower
      }
    };

    const mockMember = {
      id: 'user_1',
      roles: { cache: { has: () => false } }
    };

    SelfRoleManager._panels.set('panel_hier', {
      panelId: 'panel_hier',
      guildId: 'guild_hier',
      roles: [{ roleId: 'role_admin', roleName: 'Admin' }]
    });

    let replyMsg = '';
    const interaction = {
      isButton: () => true,
      customId: 'role:btn:panel_hier:role_admin',
      guild: mockGuild,
      member: mockMember,
      deferred: false,
      replied: false,
      deferReply: async () => {},
      editReply: async (payload) => { replyMsg = payload.content; }
    };

    await SelfRoleManager.handleButtonInteraction(interaction);
    assert.match(replyMsg, /Cannot modify role.*hierarchy/i);
  });

  // =========================================================================
  // SCENARIO 7: Ambiguous channel or role requests reject guessing
  // =========================================================================
  test('Scenario 7: Ambiguous channel and multi-channel requests trigger focused clarification', () => {
    // 1. Ambiguous channel for embed publishing
    const ambiguousEmbedPrompt = 'Create several announcement embeds and publish them in the channels I specify';
    const check1 = CompletenessChecker.verify(ambiguousEmbedPrompt, { actions: [] });
    assert.equal(check1.valid, false);
    assert.match(check1.errors[0], /specify which channels to publish/i);

    // 2. Ambiguous channel deletion
    const check2 = CompletenessChecker.verify('delete a channel', { actions: [] });
    assert.equal(check2.valid, false);
    assert.match(check2.errors[0], /No channel specified for deletion/i);
  });

  // =========================================================================
  // SCENARIO 8: Partial failure halfway through a multi-step task
  // =========================================================================
  test('Scenario 8: Partial failure preserves succeeded steps and marks dependent actions skipped', async () => {
    const task = TaskQueue.createTask({
      guildId: 'guild_partial',
      userId: 'user_admin',
      userPrompt: 'Create role VIP, set slowmode on general, and assign VIP to Alex',
      actions: [
        { id: 'step_1', action: 'create_role', name: 'VIP', dependsOn: [] },
        { id: 'step_2', action: 'simulate_failure', target: 'fail_target', dependsOn: ['step_1'] },
        { id: 'step_3', action: 'assign_role', targetRole: 'VIP', targetMember: 'Alex', dependsOn: ['step_2'] }
      ]
    });

    const mockExecutor = {
      executeSingleAction: async (guild, args) => {
        if (args.action === 'create_role') {
          return { success: true, roleId: 'role_vip_123', details: 'Role VIP created' };
        }
        if (args.action === 'simulate_failure') {
          return { success: false, error: 'Discord API error 50035: Invalid parameters' };
        }
        return { success: true };
      }
    };

    const executed = await TaskQueue.executeTask(task.taskId, {
      guild: { id: 'guild_partial', name: 'Test Guild', roles: { cache: new Map() } },
      member: { user: { id: 'user_admin' } },
      executor: mockExecutor
    });

    assert.equal(executed.status, TaskQueueState.PARTIALLY_COMPLETED);
    assert.equal(executed.actions[0].status, TaskActionStatus.SUCCEEDED);
    assert.equal(executed.actions[1].status, TaskActionStatus.FAILED);
    assert.equal(executed.actions[2].status, TaskActionStatus.SKIPPED);
  });

  // =========================================================================
  // SCENARIO 9: Retry without duplicate channels, roles, or messages
  // =========================================================================
  test('Scenario 9: Retry inspects Discord state and avoids creating duplicate roles or channels', async () => {
    let rolesCreatedCount = 0;
    const existingRoles = new Map();

    const mockGuild = {
      id: 'guild_retry',
      roles: {
        cache: existingRoles
      }
    };

    const mockExecutor = {
      executeSingleAction: async (guild, args) => {
        rolesCreatedCount++;
        const newRole = { id: 'role_test', name: args.name };
        existingRoles.set('role_test', newRole);
        return { success: true, roleId: 'role_test', details: `Role ${args.name} created` };
      }
    };

    const task = TaskQueue.createTask({
      guildId: 'guild_retry',
      userId: 'user_1',
      userPrompt: 'Create role Tester',
      actions: [{ id: 'step_1', action: 'create_role', name: 'Tester', dependsOn: [] }]
    });

    // First execution
    await TaskQueue.executeTask(task.taskId, {
      guild: mockGuild,
      member: { user: { id: 'user_1' } },
      executor: mockExecutor
    });
    assert.equal(rolesCreatedCount, 1);

    // Retry execution
    const retryTask = TaskQueue.createTask({
      guildId: 'guild_retry',
      userId: 'user_1',
      userPrompt: 'Create role Tester',
      actions: [{ id: 'step_1', action: 'create_role', name: 'Tester', dependsOn: [] }]
    });

    await TaskQueue.executeTask(retryTask.taskId, {
      guild: mockGuild,
      member: { user: { id: 'user_1' } },
      executor: mockExecutor
    });

    // rolesCreatedCount must still be 1 (idempotent reuse via _checkPreExistingOutcome)
    assert.equal(rolesCreatedCount, 1);
  });

  // =========================================================================
  // SCENARIO 10: Bot restart and safe task & panel recovery
  // =========================================================================
  test('Scenario 10: Bot restart preserves persistent panels and tasks without data loss', () => {
    SelfRoleManager._panels.set('panel_persist', {
      panelId: 'panel_persist',
      guildId: 'guild_restart',
      channelId: 'ch_1',
      title: 'Persistent Panel',
      roles: [{ roleId: 'r1', roleName: 'Gamer' }]
    });
    SelfRoleManager.persistPanels();

    // Simulate bot restart: wipe in-memory map and reload from storage
    SelfRoleManager._panels.clear();
    SelfRoleManager._loaded = false;
    SelfRoleManager.loadPanels();

    const loadedPanel = SelfRoleManager.getPanel('panel_persist');
    assert.ok(loadedPanel);
    assert.equal(loadedPanel.title, 'Persistent Panel');
    assert.equal(loadedPanel.roles[0].roleName, 'Gamer');
  });

  // =========================================================================
  // SCENARIO 11: Deleted panel messages and roles detected by diagnostics
  // =========================================================================
  test('Scenario 11: Deleted panel messages and roles are flagged by /diagnose', async () => {
    const mockGuild = {
      id: 'guild_diag',
      channels: {
        cache: new Map([['ch_roles', { id: 'ch_roles', name: 'roles', messages: { fetch: async () => null } }]])
      },
      roles: {
        cache: new Map() // Empty: role was deleted!
      },
      members: {
        me: { permissions: { has: () => true } }
      }
    };

    SelfRoleManager._panels.set('panel_broken', {
      panelId: 'panel_broken',
      guildId: 'guild_diag',
      channelId: 'ch_roles',
      channelName: 'roles',
      messageId: 'msg_deleted',
      title: 'Broken Panel',
      roles: [{ roleId: 'role_missing', roleName: 'DeletedRole' }]
    });

    const diag = await DiagnosticService.diagnoseSelfRolesHealth({ guild: mockGuild }, 'diag_1');
    assert.equal(diag.status, DiagnosticStatus.DEGRADED);
    assert.match(diag.response, /DeletedRole.*was deleted/i);
    assert.match(diag.response, /Panel message.*was deleted/i);
  });

  // =========================================================================
  // SCENARIO 12: Multiple guilds executing tasks concurrently
  // =========================================================================
  test('Scenario 12: Multiple guilds execute tasks concurrently with guild-isolated locks', async () => {
    const executedOrder = [];

    const makeExecutor = (name) => ({
      executeSingleAction: async () => {
        executedOrder.push(`${name}_start`);
        await new Promise(r => setTimeout(r, 20));
        executedOrder.push(`${name}_end`);
        return { success: true };
      }
    });

    const taskGuildA = TaskQueue.createTask({
      guildId: 'guild_A',
      userId: 'user_a',
      actions: [{ id: 'step_1', action: 'test_a', dependsOn: [] }]
    });

    const taskGuildB = TaskQueue.createTask({
      guildId: 'guild_B',
      userId: 'user_b',
      actions: [{ id: 'step_1', action: 'test_b', dependsOn: [] }]
    });

    await Promise.all([
      TaskQueue.executeTask(taskGuildA.taskId, {
        guild: { id: 'guild_A' },
        member: { user: { id: 'user_a' } },
        executor: makeExecutor('GuildA')
      }),
      TaskQueue.executeTask(taskGuildB.taskId, {
        guild: { id: 'guild_B' },
        member: { user: { id: 'user_b' } },
        executor: makeExecutor('GuildB')
      })
    ]);

    // Both guilds executed and both finished
    assert.ok(executedOrder.includes('GuildA_start') && executedOrder.includes('GuildA_end'));
    assert.ok(executedOrder.includes('GuildB_start') && executedOrder.includes('GuildB_end'));
  });

  // =========================================================================
  // SCENARIO 13: Discord rate limits and transient API errors handled with backoff
  // =========================================================================
  test('Scenario 13: Transient API errors (429 Rate Limit) retry with backoff and succeed', async () => {
    let attempts = 0;
    const mockExecutor = {
      executeSingleAction: async () => {
        attempts++;
        if (attempts === 1) {
          const err = new Error('You are being rate limited.');
          err.status = 429;
          throw err;
        }
        return { success: true, details: 'Succeeded on retry' };
      }
    };

    const task = TaskQueue.createTask({
      guildId: 'guild_rl',
      userId: 'user_1',
      actions: [{ id: 'step_1', action: 'send_message', dependsOn: [] }]
    });

    const executed = await TaskQueue.executeTask(task.taskId, {
      guild: { id: 'guild_rl' },
      member: { user: { id: 'user_1' } },
      executor: mockExecutor
    });

    assert.equal(executed.status, TaskQueueState.COMPLETED);
    assert.equal(attempts, 2);
  });

  // =========================================================================
  // SCENARIO 14: Unauthorized users interacting with components blocked by whitelist
  // =========================================================================
  test('Scenario 14: Whitelist prevents members from obtaining unlisted or forged roles', async () => {
    const mockGuild = {
      id: 'guild_whitelist',
      roles: {
        cache: new Map([
          ['role_member', { id: 'role_member', name: 'Member', position: 1 }],
          ['role_admin', { id: 'role_admin', name: 'Administrator', position: 10 }]
        ])
      },
      members: {
        me: { roles: { highest: { position: 15 } } }
      }
    };

    SelfRoleManager._panels.set('panel_wl', {
      panelId: 'panel_wl',
      guildId: 'guild_whitelist',
      roles: [{ roleId: 'role_member', roleName: 'Member' }] // Only 'role_member' is whitelisted!
    });

    let replyMsg = '';
    const maliciousInteraction = {
      isButton: () => true,
      customId: 'role:btn:panel_wl:role_admin', // Attacker forged roleId to admin!
      guild: mockGuild,
      member: { id: 'user_attacker', roles: { cache: { has: () => false } } },
      deferred: false,
      replied: false,
      deferReply: async () => {},
      editReply: async (payload) => { replyMsg = payload.content; }
    };

    await SelfRoleManager.handleButtonInteraction(maliciousInteraction);
    assert.match(replyMsg, /Access Refusal.*not part of the configured self-role menu/i);
  });

  // =========================================================================
  // SCENARIO 15: Anti-nuke protections remain 100% enforced
  // =========================================================================
  test('Scenario 15: Anti-nuke safeguards unconditionally block server mass destruction', () => {
    assert.throws(() => {
      SecurityGate.evaluatePromptSecurity('nuke this entire server and ban everyone', 'user_attacker', { id: 'guild_1' });
    }, /ANTI_NUKE_TRIGGERED|Server sabotage|strictly prohibited/i);

    assert.throws(() => {
      SecurityGate.evaluateActionSequence([
        { action: 'delete_channel', targetChannel: 'c1' },
        { action: 'delete_channel', targetChannel: 'c2' },
        { action: 'delete_channel', targetChannel: 'c3' },
        { action: 'delete_channel', targetChannel: 'c4' },
        { action: 'delete_channel', targetChannel: 'c5' },
        { action: 'delete_channel', targetChannel: 'c6' },
        { action: 'delete_channel', targetChannel: 'c7' },
        { action: 'delete_channel', targetChannel: 'c8' },
        { action: 'delete_channel', targetChannel: 'c9' },
        { action: 'delete_channel', targetChannel: 'c10' },
        { action: 'delete_channel', targetChannel: 'c11' }
      ], { id: 'user_1' }, { id: 'guild_1' });
    }, /Security Policy Violation/i);
  });
});
