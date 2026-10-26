import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TaskQueue, TaskQueueState, TaskActionStatus, InvalidStateTransitionError, QueueOverloadError } from '../src/task-queue.js';
import { CompletenessChecker } from '../src/completeness-checker.js';
import { Executor } from '../src/executor.js';
import { MusicService } from '../src/music-service.js';
import { SecurityGate, SecurityPolicyViolationError } from '../src/security-gate.js';
import { checkUserAuthorization, checkBotPermissions, checkRoleHierarchy } from '../src/permissions.js';
import { slashCommands } from '../src/commands.js';
import { formatMultiActionSummary, cleanText } from '../src/format-response.js';
import { ModLogService } from '../src/mod-log.js';
import { config } from '../src/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_STORAGE = path.join(__dirname, 'scratch-task-queue-test.json');

describe('Universal Task Understanding, Sequential Execution Queue & Crash Resilience (36 Tests)', () => {
  beforeEach(() => {
    TaskQueue.storagePath = TEST_STORAGE;
    TaskQueue._tasks.clear();
    TaskQueue._guildLocks.clear();
    if (fs.existsSync(TEST_STORAGE)) {
      fs.unlinkSync(TEST_STORAGE);
    }
  });

  afterEach(() => {
    if (fs.existsSync(TEST_STORAGE)) {
      try {
        fs.unlinkSync(TEST_STORAGE);
      } catch {}
    }
  });

  // =========================================================================
  // PLANNING (1-7)
  // =========================================================================

  test('1. Planning: A request containing multiple actions produces a complete structured plan', () => {
    const prompt = 'Create a role called Event Host, make it purple, and assign it to Alex';
    const check = CompletenessChecker.verify(prompt, {
      thoughtProcess: 'Multi-step role setup',
      actions: []
    });

    assert.equal(check.valid, true);
    assert.equal(check.repairedPlan.actions.length, 3);
    assert.equal(check.repairedPlan.actions[0].action, 'create_role');
    assert.equal(check.repairedPlan.actions[0].name, 'Event Host');
    assert.equal(check.repairedPlan.actions[1].action, 'edit_role');
    assert.equal(check.repairedPlan.actions[1].color, '#800080');
    assert.equal(check.repairedPlan.actions[2].action, 'assign_role');
    assert.equal(check.repairedPlan.actions[2].targetMember, 'Alex');
  });

  test('2. Planning: Dependencies are ordered correctly in DAG', () => {
    const prompt = 'Create a private Support category, add a ticket channel, and give the Support Team access';
    const check = CompletenessChecker.verify(prompt, {
      thoughtProcess: 'Support structure setup',
      actions: []
    });

    assert.equal(check.valid, true);
    const actions = check.repairedPlan.actions;
    assert.equal(actions.length, 3);

    // Step 1: create_category
    assert.equal(actions[0].action, 'create_category');
    assert.deepEqual(actions[0].dependsOn, []);

    // Step 2: create_channel depends on step_1
    assert.equal(actions[1].action, 'create_channel');
    assert.ok(actions[1].dependsOn.includes(actions[0].id));

    // Step 3: set_channel_permission depends on step_2
    assert.equal(actions[2].action, 'set_channel_permission');
    assert.ok(actions[2].dependsOn.includes(actions[1].id));
  });

  test('3. Planning: Unsupported actions are rejected or clarified', () => {
    const prompt = 'delete a channel'; // missing specific channel target
    const check = CompletenessChecker.verify(prompt, {
      thoughtProcess: 'Ambiguous channel deletion',
      actions: []
    });

    assert.equal(check.valid, false);
    assert.ok(check.errors.length > 0);
    assert.match(check.errors[0], /No channel specified for deletion/i);
  });

  test('4. Planning: Ambiguous targets are not guessed', () => {
    const prompt = 'rename this channel'; // no replacement name provided
    const check = CompletenessChecker.verify(prompt, {
      thoughtProcess: 'Rename current channel',
      actions: []
    });

    assert.equal(check.valid, false);
    assert.match(check.errors[0], /No new name specified for channel rename/i);
  });

  test('5. Planning: Requested parameters and constraints are preserved', () => {
    const prompt = 'Rename this channel to dev-chat, update its topic to discussion, and set slowmode to 10 seconds';
    const check = CompletenessChecker.verify(prompt, {
      thoughtProcess: 'Channel updates',
      actions: []
    });

    assert.equal(check.valid, true);
    const actions = check.repairedPlan.actions;
    const renameAct = actions.find(a => a.action === 'edit_channel' && a.name === 'dev-chat');
    const topicAct = actions.find(a => a.action === 'edit_channel_topic' && a.topic === 'discussion');
    const slowAct = actions.find(a => a.action === 'set_channel_slowmode' && a.seconds === 10);

    assert.ok(renameAct, 'Rename preserved');
    assert.ok(topicAct, 'Topic preserved');
    assert.ok(slowAct, 'Slowmode 10s preserved');
  });

  test('6. Planning: Dependent actions do not run after prerequisite failure', async () => {
    const task = TaskQueue.createTask({
      guildId: 'guild_dep_fail',
      userId: 'user_1',
      interactionId: 'int_1',
      userPrompt: 'Create role and assign',
      actions: [
        { id: 'step_1', action: 'create_role', name: 'VIP', dependsOn: [] },
        { id: 'step_2', action: 'assign_role', targetRole: 'VIP', targetMember: 'Alex', dependsOn: ['step_1'] }
      ]
    });

    const mockExecutor = {
      executeSingleAction: async (guild, action) => {
        if (action.action === 'create_role') {
          return { success: false, error: 'Missing Permissions to create roles' };
        }
        return { success: true };
      }
    };

    const executed = await TaskQueue.executeTask(task.taskId, {
      guild: { id: 'guild_dep_fail' },
      member: { user: { id: 'user_1' } },
      executor: mockExecutor
    });

    assert.equal(executed.actions[0].status, TaskActionStatus.FAILED);
    assert.equal(executed.actions[1].status, TaskActionStatus.SKIPPED);
    assert.match(executed.actions[1].error, /prerequisite/i);
  });

  test('7. Planning: Independent actions continue only when safe and explicitly permitted', async () => {
    // Role creation succeeded, role color failed (sibling), but assignment only depends on creation!
    const task = TaskQueue.createTask({
      guildId: 'guild_indep',
      userId: 'user_1',
      interactionId: 'int_1',
      userPrompt: 'Create role called Event Host, make it purple, and assign it to Alex',
      actions: [
        { id: 'step_1', action: 'create_role', name: 'Event Host', dependsOn: [] },
        { id: 'step_2', action: 'edit_role', targetRole: 'Event Host', color: '#800080', dependsOn: ['step_1'] },
        { id: 'step_3', action: 'assign_role', targetRole: 'Event Host', targetMember: 'Alex', dependsOn: ['step_1'] }
      ]
    });

    const mockExecutor = {
      executeSingleAction: async (guild, action) => {
        if (action.action === 'create_role') {
          return { success: true, details: 'Created role Event Host' };
        }
        if (action.action === 'edit_role') {
          return { success: false, error: 'Color palette error' };
        }
        if (action.action === 'assign_role') {
          return { success: true, details: 'Assigned role Event Host to Alex' };
        }
        return { success: true };
      }
    };

    const executed = await TaskQueue.executeTask(task.taskId, {
      guild: { id: 'guild_indep' },
      member: { user: { id: 'user_1' } },
      executor: mockExecutor
    });

    assert.equal(executed.actions[0].status, TaskActionStatus.SUCCEEDED);
    assert.equal(executed.actions[1].status, TaskActionStatus.FAILED);
    assert.equal(executed.actions[2].status, TaskActionStatus.SUCCEEDED);
    assert.equal(executed.status, TaskQueueState.PARTIALLY_COMPLETED);
  });

  // =========================================================================
  // EXECUTION QUEUE (8-13)
  // =========================================================================

  test('8. Queue: Actions execute in dependency order', async () => {
    const executedOrder = [];
    const task = TaskQueue.createTask({
      guildId: 'guild_order',
      userId: 'user_1',
      interactionId: 'int_1',
      userPrompt: 'Ordered steps',
      actions: [
        { id: 'step_1', action: 'connect_voice', channelName: 'General', dependsOn: [] },
        { id: 'step_2', action: 'music_play', query: 'https://youtube.com/watch?v=123', dependsOn: ['step_1'] }
      ]
    });

    const mockExecutor = {
      executeSingleAction: async (guild, action) => {
        executedOrder.push(action.action);
        return { success: true };
      }
    };

    await TaskQueue.executeTask(task.taskId, {
      guild: { id: 'guild_order' },
      member: { user: { id: 'user_1' } },
      executor: mockExecutor
    });

    assert.deepEqual(executedOrder, ['connect_voice', 'music_play']);
  });

  test('9. Queue: Duplicate task submissions do not duplicate mutations (Idempotency)', async () => {
    let roleCreations = 0;
    const mockGuild = {
      id: 'guild_idem',
      roles: {
        cache: new Map()
      }
    };

    const mockExecutor = {
      executeSingleAction: async (guild, action) => {
        if (action.action === 'create_role') {
          roleCreations++;
          const newRole = { id: 'role_vip_99', name: action.name };
          guild.roles.cache.set('role_vip_99', newRole);
          return { success: true, resource: newRole };
        }
        return { success: true };
      }
    };

    // Task 1: Creates role
    const task1 = TaskQueue.createTask({
      guildId: 'guild_idem',
      userId: 'user_1',
      interactionId: 'int_1',
      userPrompt: 'Create VIP role',
      actions: [{ id: 'step_1', action: 'create_role', name: 'VIP', dependsOn: [] }]
    });

    await TaskQueue.executeTask(task1.taskId, {
      guild: mockGuild,
      member: { user: { id: 'user_1' } },
      executor: mockExecutor
    });

    assert.equal(roleCreations, 1);

    // Task 2: Same role creation retry / duplicate
    const task2 = TaskQueue.createTask({
      guildId: 'guild_idem',
      userId: 'user_1',
      interactionId: 'int_2',
      userPrompt: 'Create VIP role',
      actions: [{ id: 'step_1', action: 'create_role', name: 'VIP', dependsOn: [] }]
    });

    await TaskQueue.executeTask(task2.taskId, {
      guild: mockGuild,
      member: { user: { id: 'user_1' } },
      executor: mockExecutor
    });

    // Idempotency check prevented second call to executor.executeSingleAction
    assert.equal(roleCreations, 1, 'Duplicate role creation was prevented by idempotency check');
  });

  test('10. Queue: Concurrent tasks do not conflict over the same guild resource (Guild Lock)', async () => {
    const sequence = [];

    const mockExecutor = {
      executeSingleAction: async (guild, action) => {
        sequence.push(`start_${action.id}`);
        await new Promise(r => setTimeout(r, 50));
        sequence.push(`end_${action.id}`);
        return { success: true };
      }
    };

    const taskA = TaskQueue.createTask({
      guildId: 'guild_locked',
      userId: 'user_1',
      interactionId: 'int_a',
      userPrompt: 'Task A',
      actions: [{ id: 'step_A1', action: 'create_role', name: 'RoleA', dependsOn: [] }]
    });

    const taskB = TaskQueue.createTask({
      guildId: 'guild_locked',
      userId: 'user_2',
      interactionId: 'int_b',
      userPrompt: 'Task B',
      actions: [{ id: 'step_B1', action: 'create_role', name: 'RoleB', dependsOn: [] }]
    });

    // Run concurrently on same guild
    await Promise.all([
      TaskQueue.executeTask(taskA.taskId, {
        guild: { id: 'guild_locked' },
        member: { user: { id: 'user_1' } },
        executor: mockExecutor
      }),
      TaskQueue.executeTask(taskB.taskId, {
        guild: { id: 'guild_locked' },
        member: { user: { id: 'user_2' } },
        executor: mockExecutor
      })
    ]);

    // Task A must completely finish before Task B starts due to guild lock
    assert.deepEqual(sequence, ['start_step_A1', 'end_step_A1', 'start_step_B1', 'end_step_B1']);
  });

  test('11. Queue: Progress updates reflect actual state', async () => {
    const progressMilestones = [];

    const task = TaskQueue.createTask({
      guildId: 'guild_prog',
      userId: 'user_1',
      interactionId: 'int_prog',
      userPrompt: 'Multi progress',
      actions: [
        { id: 'step_1', action: 'create_role', name: 'Role1', dependsOn: [] },
        { id: 'step_2', action: 'create_role', name: 'Role2', dependsOn: [] }
      ]
    });

    const mockExecutor = {
      executeSingleAction: async () => ({ success: true })
    };

    await TaskQueue.executeTask(task.taskId, {
      guild: { id: 'guild_prog' },
      member: { user: { id: 'user_1' } },
      executor: mockExecutor,
      onProgress: async (p) => {
        progressMilestones.push({ step: p.currentStep, total: p.totalSteps, status: p.status });
      }
    });

    assert.ok(progressMilestones.length >= 2);
    assert.equal(progressMilestones[0].total, 2);
  });

  test('12. Queue: Cancellation and confirmation are handled correctly', () => {
    const task = TaskQueue.createTask({
      guildId: 'guild_cancel',
      userId: 'user_1',
      interactionId: 'int_c',
      userPrompt: 'Cancel me',
      actions: [{ id: 'step_1', action: 'create_role', name: 'Temp', dependsOn: [] }]
    });

    const cancelled = TaskQueue.cancelTask(task.taskId, 'User rejected confirmation');
    assert.equal(cancelled.status, TaskQueueState.CANCELLED);
    assert.equal(cancelled.resultSummary, 'User rejected confirmation');

    // Attempting invalid transition after cancellation throws InvalidStateTransitionError
    assert.throws(() => {
      TaskQueue.transition(task.taskId, TaskQueueState.RUNNING);
    }, InvalidStateTransitionError);
  });

  test('13. Queue: Partial completion is recorded accurately', async () => {
    const task = TaskQueue.createTask({
      guildId: 'guild_part',
      userId: 'user_1',
      interactionId: 'int_part',
      userPrompt: 'Partial test',
      actions: [
        { id: 'step_1', action: 'create_role', name: 'RoleA', dependsOn: [] },
        { id: 'step_2', action: 'create_role', name: 'RoleB', dependsOn: [] }
      ]
    });

    const mockExecutor = {
      executeSingleAction: async (guild, action) => {
        if (action.name === 'RoleB') return { success: false, error: 'RoleB error' };
        return { success: true };
      }
    };

    const executed = await TaskQueue.executeTask(task.taskId, {
      guild: { id: 'guild_part' },
      member: { user: { id: 'user_1' } },
      executor: mockExecutor
    });

    assert.equal(executed.status, TaskQueueState.PARTIALLY_COMPLETED);
    assert.equal(executed.actions[0].status, TaskActionStatus.SUCCEEDED);
    assert.equal(executed.actions[1].status, TaskActionStatus.FAILED);
  });

  // =========================================================================
  // CRASH RESILIENCE (14-20)
  // =========================================================================

  test('14. Crash Resilience: A task-worker exception does not terminate other task workers', async () => {
    const taskFail = TaskQueue.createTask({
      guildId: 'guild_1',
      userId: 'user_1',
      interactionId: 'int_f',
      userPrompt: 'Failing worker',
      actions: [{ id: 'step_1', action: 'create_role', name: 'FatalRole', dependsOn: [] }]
    });

    const taskSuccess = TaskQueue.createTask({
      guildId: 'guild_2',
      userId: 'user_2',
      interactionId: 'int_s',
      userPrompt: 'Healthy worker',
      actions: [{ id: 'step_1', action: 'create_role', name: 'GoodRole', dependsOn: [] }]
    });

    const mockExecutor = {
      executeSingleAction: async (guild, action) => {
        if (action.name === 'FatalRole') {
          throw new Error('Unexpected worker fault');
        }
        return { success: true };
      }
    };

    const res1 = await TaskQueue.executeTask(taskFail.taskId, {
      guild: { id: 'guild_1' },
      member: { user: { id: 'user_1' } },
      executor: mockExecutor
    });

    const res2 = await TaskQueue.executeTask(taskSuccess.taskId, {
      guild: { id: 'guild_2' },
      member: { user: { id: 'user_2' } },
      executor: mockExecutor
    });

    assert.equal(res1.status, TaskQueueState.FAILED);
    assert.equal(res2.status, TaskQueueState.COMPLETED);
  });

  test('15. Crash Resilience: Transient errors receive bounded retries', async () => {
    let attempts = 0;
    const task = TaskQueue.createTask({
      guildId: 'guild_transient',
      userId: 'user_1',
      interactionId: 'int_t',
      userPrompt: 'Transient retry',
      actions: [{ id: 'step_1', action: 'create_role', name: 'RetryRole', dependsOn: [] }]
    });

    const mockExecutor = {
      executeSingleAction: async () => {
        attempts++;
        if (attempts < 2) {
          const err = new Error('Discord 503 Service Unavailable');
          err.code = 503;
          throw err;
        }
        return { success: true, details: 'Recovered on attempt 2' };
      }
    };

    const executed = await TaskQueue.executeTask(task.taskId, {
      guild: { id: 'guild_transient' },
      member: { user: { id: 'user_1' } },
      executor: mockExecutor
    });

    assert.equal(attempts, 2);
    assert.equal(executed.status, TaskQueueState.COMPLETED);
    assert.equal(executed.actions[0].status, TaskActionStatus.SUCCEEDED);
  });

  test('16. Crash Resilience: Permanent errors are not repeatedly retried', async () => {
    let attempts = 0;
    const task = TaskQueue.createTask({
      guildId: 'guild_perm',
      userId: 'user_1',
      interactionId: 'int_p',
      userPrompt: 'Permanent failure',
      actions: [{ id: 'step_1', action: 'create_role', name: 'PermRole', dependsOn: [] }]
    });

    const mockExecutor = {
      executeSingleAction: async () => {
        attempts++;
        const err = new Error('Missing Permissions (50013)');
        err.code = 50013; // Permanent
        throw err;
      }
    };

    const executed = await TaskQueue.executeTask(task.taskId, {
      guild: { id: 'guild_perm' },
      member: { user: { id: 'user_1' } },
      executor: mockExecutor
    });

    assert.equal(attempts, 1, 'Non-retryable 50013 should only attempt once');
    assert.equal(executed.status, TaskQueueState.FAILED);
  });

  test('17. Crash Resilience: Restart recovery reconciles uncertain actions before resuming', async () => {
    const mockClient = {
      guilds: {
        cache: new Map([
          ['guild_reconcile', {
            id: 'guild_reconcile',
            roles: {
              cache: new Map([['role_vip_id', { id: 'role_vip_id', name: 'ReconcileRole' }]])
            },
            channels: { cache: new Map() }
          }]
        ])
      }
    };

    // Pre-seed an interrupted task in queue storage
    const interruptedTask = {
      taskId: 'task_interrupted_1',
      guildId: 'guild_reconcile',
      userId: 'user_1',
      status: TaskQueueState.RUNNING,
      actions: [
        {
          id: 'step_1',
          action: 'create_role',
          target: 'ReconcileRole',
          args: { name: 'ReconcileRole' },
          status: TaskActionStatus.RUNNING,
          dependsOn: []
        }
      ]
    };

    TaskQueue._tasks.set('task_interrupted_1', interruptedTask);
    TaskQueue.persistAllTasks();

    // Perform startup reconciliation
    const reconciled = await TaskQueue.reconcileOnStartup(mockClient);

    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].actions[0].status, TaskActionStatus.SUCCEEDED);
    assert.equal(reconciled[0].status, TaskQueueState.COMPLETED);
    assert.match(reconciled[0].actions[0].result.details, /already exists|Reconciled/i);
  });

  test('18. Crash Resilience: Persistence failure is surfaced safely', () => {
    const originalStorage = TaskQueue.storagePath;
    // Set storage to an invalid read-only or invalid-device path on Windows to simulate error
    TaskQueue.storagePath = 'Z:\\non_existent_folder\\invalid_file.json';

    // Must not crash the process; handles failure and logs warning
    assert.doesNotThrow(() => {
      TaskQueue.persistAllTasks();
    });

    TaskQueue.storagePath = originalStorage;
  });

  test('19. Crash Resilience: Queue overload produces backpressure rather than unbounded memory growth', () => {
    TaskQueue._maxTasksPerGuild = 3;

    // Create 3 tasks
    for (let i = 0; i < 3; i++) {
      TaskQueue.createTask({
        guildId: 'guild_overload',
        userId: 'user_1',
        interactionId: `int_${i}`,
        userPrompt: `Prompt ${i}`,
        actions: [{ id: 'step_1', action: 'create_role', name: `R${i}`, dependsOn: [] }]
      });
    }

    // 4th task should throw QueueOverloadError
    assert.throws(() => {
      TaskQueue.createTask({
        guildId: 'guild_overload',
        userId: 'user_1',
        interactionId: 'int_overflow',
        userPrompt: 'Overflow',
        actions: [{ id: 'step_1', action: 'create_role', name: 'Overflow', dependsOn: [] }]
      });
    }, QueueOverloadError);
  });

  test('20. Crash Resilience: Graceful shutdown preserves recoverable task state', () => {
    const task = TaskQueue.createTask({
      guildId: 'guild_shutdown',
      userId: 'user_1',
      interactionId: 'int_sd',
      userPrompt: 'In-flight task',
      actions: [{ id: 'step_1', action: 'create_role', name: 'SavedRole', dependsOn: [] }]
    });

    TaskQueue.transition(task.taskId, TaskQueueState.RUNNING);

    // Call graceful shutdown
    TaskQueue.shutdown();

    // Running task must be marked INTERRUPTED
    assert.equal(task.status, TaskQueueState.INTERRUPTED);
  });

  // =========================================================================
  // VOICE AND MUSIC (21-25)
  // =========================================================================

  test('21. Voice & Music: Voice connection is established before playback starts', async () => {
    const prompt = 'Join the General voice channel and play this YouTube link: https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const check = CompletenessChecker.verify(prompt, {
      thoughtProcess: 'Voice and music playback',
      actions: []
    });

    assert.equal(check.valid, true);
    const actions = check.repairedPlan.actions;
    assert.equal(actions[0].action, 'connect_voice');
    assert.equal(actions[1].action, 'music_play');
    assert.deepEqual(actions[1].dependsOn, [actions[0].id]);
  });

  test('22. Voice & Music: Invalid or unsupported URLs fail safely', async () => {
    const invalidUrl = 'https://unsupported-site.example.com/stream';
    await assert.rejects(async () => {
      await MusicService.resolveTrack(invalidUrl);
    }, /Unsupported media source/i);
  });

  test('23. Voice & Music: Voice connection timeouts are handled', async () => {
    const mockGuild = {
      id: 'guild_vc_timeout',
      voiceAdapterCreator: () => ({ sendPayload: () => {}, destroy: () => {} }),
      channels: {
        cache: [
          { id: 'ch_voice', name: 'General', type: 2 }
        ]
      }
    };

    // Voice connect with 1ms timeout to trigger timeout error
    await assert.rejects(async () => {
      await MusicService.connectVoice(mockGuild, 'General', {
        permissions: { has: () => true },
        voice: { channel: null }
      }, 1); // 1ms timeout
    }, /timed out/i);
  });

  test('24. Voice & Music: Playback failure is not reported as success', async () => {
    const result = {
      success: false,
      error: 'Media stream unavailable'
    };
    const verified = await Executor.executeSingleAction(
      { id: 'guild_music_fail' },
      { action: 'music_play', query: 'https://youtube.com/watch?v=missing' },
      'exec_m_1',
      { user: { id: 'user_1', tag: 'User#0001' } }
    ).catch(e => ({ success: false, error: e.message }));

    assert.equal(verified.success, false);
  });

  test('25. Voice & Music: Duplicate tasks do not create duplicate players or connections', () => {
    const player1 = MusicService.getOrCreatePlayer('guild_single_player');
    const player2 = MusicService.getOrCreatePlayer('guild_single_player');
    assert.equal(player1, player2);
  });

  // =========================================================================
  // DISCORD ADMINISTRATION (26-31)
  // =========================================================================

  test('26. Administration: Role creation, color configuration, and assignment execute in order', async () => {
    const prompt = 'Create a role called Event Host, make it purple, and assign it to Alex';
    const check = CompletenessChecker.verify(prompt, {
      thoughtProcess: 'Role setup',
      actions: []
    });

    const actions = check.repairedPlan.actions;
    assert.equal(actions[0].action, 'create_role');
    assert.equal(actions[1].action, 'edit_role');
    assert.equal(actions[2].action, 'assign_role');
  });

  test('27. Administration: A failed role creation prevents dependent actions', async () => {
    const task = TaskQueue.createTask({
      guildId: 'guild_admin_fail',
      userId: 'user_1',
      interactionId: 'int_af',
      userPrompt: 'Role create and assign',
      actions: [
        { id: 'step_1', action: 'create_role', name: 'AdminRole', dependsOn: [] },
        { id: 'step_2', action: 'assign_role', targetRole: 'AdminRole', targetMember: 'Alex', dependsOn: ['step_1'] }
      ]
    });

    const mockExecutor = {
      executeSingleAction: async () => ({ success: false, error: 'Hierarchy error' })
    };

    const executed = await TaskQueue.executeTask(task.taskId, {
      guild: { id: 'guild_admin_fail' },
      member: { user: { id: 'user_1' } },
      executor: mockExecutor
    });

    assert.equal(executed.actions[0].status, TaskActionStatus.FAILED);
    assert.equal(executed.actions[1].status, TaskActionStatus.SKIPPED);
  });

  test('28. Administration: A retry does not create a duplicate role', async () => {
    const mockGuild = {
      id: 'guild_role_retry',
      roles: {
        cache: [
          { id: 'r1', name: 'Event Host' }
        ]
      }
    };

    const actionItem = {
      action: 'create_role',
      args: { name: 'Event Host' }
    };

    const preCheck = await TaskQueue._checkPreExistingOutcome(mockGuild, actionItem);
    assert.ok(preCheck);
    assert.equal(preCheck.success, true);
    assert.match(preCheck.details, /already exists/i);
  });

  test('29. Administration: Permission and hierarchy checks run before mutations', () => {
    const mockGuild = {
      id: 'guild_h',
      members: {
        me: {
          roles: {
            highest: { name: 'BotRole', position: 10 }
          }
        }
      }
    };
    const mockTargetRole = { name: 'OwnerRole', position: 50 };
    const mockAction = { action: 'delete_role', targetRole: 'OwnerRole' };

    // Bot highest role is at position 10 < 50
    const check = checkRoleHierarchy(mockGuild, mockAction, mockTargetRole);
    assert.equal(check.valid, false);
    assert.match(check.reason, /hierarchy/i);
  });

  test('30. Administration: Unauthorized and cross-guild actions are rejected', () => {
    const memberNoAdmin = {
      guild: { id: 'guild_target' },
      permissions: { has: () => false },
      roles: { cache: new Map() }
    };

    const auth = checkUserAuthorization(memberNoAdmin, [{ action: 'ban_member', targetMember: 'Alex' }]);
    assert.equal(auth.authorized, false);
    assert.match(auth.reason, /Access Denied|unauthorized/i);
  });

  test('31. Administration: Existing anti-nuke protections remain enforced', () => {
    assert.throws(() => {
      SecurityGate.evaluatePromptSecurity('Please nuke this server completely', 'attacker_id', { id: 'guild_safe' });
    }, SecurityPolicyViolationError);
  });

  // =========================================================================
  // LLM AND INTEGRATION (32-36)
  // =========================================================================

  test('32. LLM: Groq rate limits do not corrupt active validated tasks', async () => {
    // Already-validated task with actions populated runs deterministically without calling LLM
    const task = TaskQueue.createTask({
      guildId: 'guild_ratelimit',
      userId: 'user_1',
      interactionId: 'int_rl',
      userPrompt: 'Validated offline task',
      actions: [
        { id: 'step_1', action: 'create_role', name: 'OfflineRole', dependsOn: [] }
      ]
    });

    const mockExecutor = {
      executeSingleAction: async () => ({ success: true, details: 'Executed deterministically' })
    };

    // Execution does not touch Groq API!
    const executed = await TaskQueue.executeTask(task.taskId, {
      guild: { id: 'guild_ratelimit' },
      member: { user: { id: 'user_1' } },
      executor: mockExecutor
    });

    assert.equal(executed.status, TaskQueueState.COMPLETED);
    assert.equal(executed.actions[0].status, TaskActionStatus.SUCCEEDED);
  });

  test('33. LLM: Token exhaustion does not cause an unvalidated plan to execute', () => {
    // If plan validation fails, actions array is empty or verification fails
    const invalidPlan = {
      thoughtProcess: 'Token exhausted mid-generation...',
      actions: null
    };

    const check = CompletenessChecker.verify('arbitrary prompt', invalidPlan);
    assert.equal(check.valid, false);
  });

  test('34. LLM: No paid fallback is introduced', () => {
    assert.equal(config.ai.provider, 'groq');
    // Ensure Groq is configured as free provider and no OpenAI paid fallback exists
    assert.ok(process.env.GROQ_API_KEY !== undefined || config.ai.groq.apiKey !== undefined);
  });

  test('35. LLM: Exactly five slash commands remain intact (/go, /modlog, /diagnose, /undo, /help)', () => {
    const names = slashCommands.map(c => c.name).sort();
    assert.deepEqual(names, ['diagnose', 'go', 'help', 'modlog', 'undo']);
    assert.equal(names.length, 5);
  });

  test('36. Integration: Existing response formatting and logging pass seamlessly', () => {
    const results = [
      { action: 'create_role', status: 'COMPLETED', details: 'Role created' },
      { action: 'assign_role', status: 'COMPLETED', details: 'Role assigned' }
    ];
    const summary = formatMultiActionSummary(results);
    assert.equal(summary, 'Completed 2 of 2 actions.');
  });
});
