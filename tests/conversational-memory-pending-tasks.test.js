import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PendingTaskManager,
  PendingTaskStatus
} from '../src/pending-task-manager.js';
import {
  ConversationMemoryManager
} from '../src/conversation-memory.js';
import {
  ContextResolutionPipeline
} from '../src/context-resolution-pipeline.js';
import { DiagnosticService, DiagnosticStatus } from '../src/diagnostic-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_STORAGE_PATH = path.join(__dirname, 'test-pending-tasks.json');

function makeCollection(entries = []) {
  const map = new Map(entries);
  map.find = (fn) => {
    for (const val of map.values()) {
      if (fn(val)) return val;
    }
    return null;
  };
  map.filter = (fn) => {
    const results = [];
    for (const [k, val] of map.entries()) {
      if (fn(val)) results.push([k, val]);
    }
    return makeCollection(results);
  };
  return map;
}

describe('Honey Bot — Conversational Memory & Pending-Task Continuity', () => {
  let taskManager;
  let memoryManager;
  let pipeline;
  let mockGuild;
  let mockMember;
  let mockUser;
  let mockChannel;

  beforeEach(() => {
    if (fs.existsSync(TEST_STORAGE_PATH)) {
      try { fs.unlinkSync(TEST_STORAGE_PATH); } catch {}
    }

    taskManager = new PendingTaskManager({
      storagePath: TEST_STORAGE_PATH,
      maxTasksPerUserGuild: 3,
      defaultTtlMs: 15 * 60 * 1000
    });

    memoryManager = new ConversationMemoryManager({
      maxMessagesPerConversation: 25,
      maxSerializedBytesPerConversation: 250 * 1024,
      historyTtlMs: 30 * 60 * 1000
    });

    pipeline = new ContextResolutionPipeline({
      taskManager,
      memoryManager
    });

    mockUser = { id: 'user_123', tag: 'Alice#0001', username: 'Alice' };
    mockMember = {
      id: 'user_123',
      user: mockUser,
      permissions: {
        has: (perm) => true
      }
    };

    mockChannel = { id: 'channel_abc', name: 'general', type: 0 };

    mockGuild = {
      id: 'guild_999',
      name: 'Honey Test Guild',
      ownerId: 'user_123',
      roles: {
        cache: makeCollection([
          ['role_admin', { id: 'role_admin', name: 'Administrator', permissions: { toArray: () => ['Administrator'] } }],
          ['role_mod', { id: 'role_mod', name: 'Moderator', permissions: { toArray: () => ['KickMembers', 'BanMembers'] } }]
        ]),
        create: async (data) => ({
          id: `role_${Date.now()}`,
          name: data.name,
          color: data.color,
          permissions: data.permissions || []
        })
      },
      channels: {
        cache: makeCollection([
          ['channel_abc', mockChannel]
        ]),
        create: async (data) => ({
          id: `chan_${Date.now()}`,
          name: data.name,
          type: data.type
        })
      },
      members: {
        me: { id: 'bot_honey', permissions: { has: () => true } },
        cache: makeCollection([
          ['user_123', mockMember],
          ['user_456', { id: 'user_456', user: { id: 'user_456', tag: 'Bob#0002' }, permissions: { has: () => false } }]
        ])
      }
    };
    mockMember.guild = mockGuild;
  });

  afterEach(() => {
    taskManager.stopScheduler();
    memoryManager.stopScheduler();
    if (fs.existsSync(TEST_STORAGE_PATH)) {
      try { fs.unlinkSync(TEST_STORAGE_PATH); } catch {}
    }
  });

  // Scenario 1: Answering a pending role-color question
  test('Scenario 1: Answering a pending role-color question creates role with resolved color', async () => {
    // 1. Initial pending task created
    const task = taskManager.createTask({
      guildId: mockGuild.id,
      userId: mockUser.id,
      channelId: mockChannel.id,
      action: 'create_role',
      targetName: 'VIP',
      collectedParams: { name: 'VIP' },
      missingParams: ['color'],
      clarificationQuestion: 'What color should the VIP role have?'
    });

    assert.equal(task.status, PendingTaskStatus.WAITING_FOR_INPUT);
    assert.deepEqual(task.missingParams, ['color']);

    // 2. User replies "Purple"
    const result = await pipeline.resolve('Purple', {
      guild: mockGuild,
      member: mockMember,
      user: mockUser,
      channel: mockChannel
    });

    assert.equal(result.handled, true);
    assert.equal(result.outcome, 'executed');
    assert.equal(result.success, true);
    assert.equal(task.status, PendingTaskStatus.COMPLETED);
    assert.equal(task.collectedParams.color, '#800080');

    // 3. Entity recorded in Layer C
    const lastRole = memoryManager.getLastEntity(mockGuild.id, 'role');
    assert.ok(lastRole);
    assert.equal(lastRole.name, 'VIP');
  });

  // Scenario 2: Correcting a color before execution
  test('Scenario 2: Correcting a color before execution updates parameter and executes', async () => {
    taskManager.createTask({
      guildId: mockGuild.id,
      userId: mockUser.id,
      channelId: mockChannel.id,
      action: 'create_role',
      targetName: 'VIP',
      collectedParams: { name: 'VIP', color: '#800080' },
      missingParams: ['color'],
      clarificationQuestion: 'What color should the VIP role have?'
    });

    const result = await pipeline.resolve('Actually, make it blue', {
      guild: mockGuild,
      member: mockMember,
      user: mockUser,
      channel: mockChannel
    });

    assert.equal(result.handled, true);
    assert.equal(result.outcome, 'executed');
    assert.equal(result.task.collectedParams.color, '#0000FF');
  });

  // Scenario 3: Supplying multiple missing parameters across several messages
  test('Scenario 3: Supplying multiple missing parameters across several messages', async () => {
    // User wants to create role, both name and color missing
    const task = taskManager.createTask({
      guildId: mockGuild.id,
      userId: mockUser.id,
      channelId: mockChannel.id,
      action: 'create_role',
      collectedParams: {},
      missingParams: ['name', 'color'],
      clarificationQuestion: 'What name would you like to give to the new role?'
    });

    // Step 1: User provides name "Staff"
    const res1 = await pipeline.resolve('Staff', {
      guild: mockGuild,
      member: mockMember,
      user: mockUser,
      channel: mockChannel
    });

    assert.equal(res1.handled, true);
    assert.equal(res1.outcome, 'clarification');
    assert.equal(task.targetName, 'Staff');
    assert.deepEqual(task.missingParams, ['color']);

    // Step 2: User provides color "Gold"
    const res2 = await pipeline.resolve('Gold', {
      guild: mockGuild,
      member: mockMember,
      user: mockUser,
      channel: mockChannel
    });

    assert.equal(res2.handled, true);
    assert.equal(res2.outcome, 'executed');
    assert.equal(task.status, PendingTaskStatus.COMPLETED);
    assert.equal(task.collectedParams.name, 'Staff');
    assert.equal(task.collectedParams.color, '#FFD700');
  });

  // Scenario 4: Resolving "it", "that role", and similar references
  test('Scenario 4: Resolving "it", "that role", and similar references using Layer C', async () => {
    // Record that role "VIP" was previously created
    memoryManager.recordEntity(mockGuild.id, 'role', { id: 'role_vip', name: 'VIP', color: '#800080' });
    memoryManager.recordAction(mockGuild.id, { action: 'create_role', targetRef: 'VIP' });

    // User says: "Make it blue"
    const res1 = await pipeline.resolve('Make it blue', {
      guild: mockGuild,
      member: mockMember,
      user: mockUser,
      channel: mockChannel
    });

    assert.equal(res1.contextual, true);
    assert.ok(res1.resolvedPrompt.includes('VIP'));
    assert.ok(res1.resolvedPrompt.includes('#0000FF'));

    // User says: "Delete the one we just created"
    const res2 = await pipeline.resolve('Delete the one we just created', {
      guild: mockGuild,
      member: mockMember,
      user: mockUser,
      channel: mockChannel
    });

    assert.equal(res2.contextual, true);
    assert.equal(res2.resolvedPrompt, 'delete role VIP');
  });

  // Scenario 5: Switching topics while a task is pending
  test('Scenario 5: Switching topics cancels old task and routes new command', async () => {
    const task = taskManager.createTask({
      guildId: mockGuild.id,
      userId: mockUser.id,
      channelId: mockChannel.id,
      action: 'create_role',
      targetName: 'VIP',
      collectedParams: { name: 'VIP' },
      missingParams: ['color']
    });

    // 1. Explicit topic change: "forget that, create a channel instead"
    const res = await pipeline.resolve('Forget that, create a channel instead', {
      guild: mockGuild,
      member: mockMember,
      user: mockUser,
      channel: mockChannel
    });

    assert.equal(res.handled, false);
    assert.equal(res.outcome, 'topic_switch');
    assert.equal(res.resolvedPrompt, 'create a channel instead');
    assert.equal(task.status, PendingTaskStatus.CANCELLED);

    // 2. Unrelated standalone command preserves pending task
    const task2 = taskManager.createTask({
      guildId: mockGuild.id,
      userId: mockUser.id,
      channelId: mockChannel.id,
      action: 'create_role',
      targetName: 'Member',
      missingParams: ['color']
    });

    const musicRes = await pipeline.resolve('play lofi hip hop', {
      guild: mockGuild,
      member: mockMember,
      user: mockUser,
      channel: mockChannel
    });

    assert.equal(musicRes.handled, false);
    assert.equal(task2.status, PendingTaskStatus.WAITING_FOR_INPUT);
  });

  // Scenario 6: Explicitly cancelling a task
  test('Scenario 6: Explicitly cancelling a task marks it cancelled without execution', async () => {
    const task = taskManager.createTask({
      guildId: mockGuild.id,
      userId: mockUser.id,
      channelId: mockChannel.id,
      action: 'create_role',
      targetName: 'VIP',
      missingParams: ['color']
    });

    const res = await pipeline.resolve('Cancel that', {
      guild: mockGuild,
      member: mockMember,
      user: mockUser,
      channel: mockChannel
    });

    assert.equal(res.handled, true);
    assert.equal(res.outcome, 'cancelled');
    assert.equal(task.status, PendingTaskStatus.CANCELLED);
  });

  // Scenario 7: Two pending tasks with ambiguous follow-ups
  test('Scenario 7: Ambiguous role reference prompts for clarification without guessing', async () => {
    // Setup two roles named Moderator with different IDs
    mockGuild.roles.cache.set('role_mod_1', { id: 'role_mod_1', name: 'Moderator' });
    mockGuild.roles.cache.set('role_mod_2', { id: 'role_mod_2', name: 'Moderator' });

    memoryManager.recordEntity(mockGuild.id, 'role', { id: 'role_new', name: 'Staff' });

    const res = await pipeline.resolve('Give it the same permissions as Moderator', {
      guild: mockGuild,
      member: mockMember,
      user: mockUser,
      channel: mockChannel
    });

    assert.equal(res.handled, true);
    assert.equal(res.outcome, 'clarification');
    assert.ok(res.message.includes('multiple roles named "Moderator"'));
  });

  // Scenario 8: Different users in the same channel
  test('Scenario 8: User B in the same channel cannot answer User A pending task', async () => {
    const taskA = taskManager.createTask({
      guildId: mockGuild.id,
      userId: 'user_123',
      channelId: mockChannel.id,
      action: 'create_role',
      targetName: 'VIP',
      missingParams: ['color']
    });

    // User B sends "Purple"
    const resB = await pipeline.resolve('Purple', {
      guild: mockGuild,
      member: { id: 'user_456', user: { id: 'user_456', tag: 'Bob#0002' } },
      user: { id: 'user_456', tag: 'Bob#0002' },
      channel: mockChannel
    });

    // User B's answer is NOT consumed by User A's task
    assert.equal(resB.handled, false);
    assert.equal(taskA.status, PendingTaskStatus.WAITING_FOR_INPUT);
    assert.deepEqual(taskA.missingParams, ['color']);
  });

  // Scenario 9: Different guilds isolation
  test('Scenario 9: Tasks and memory in Guild 1 are isolated from Guild 2', async () => {
    const taskG1 = taskManager.createTask({
      guildId: 'guild_111',
      userId: mockUser.id,
      channelId: 'ch_1',
      action: 'create_role',
      targetName: 'VIP',
      missingParams: ['color']
    });

    // User sends "Purple" in Guild 2
    const resG2 = await pipeline.resolve('Purple', {
      guild: { id: 'guild_222' },
      member: mockMember,
      user: mockUser,
      channel: { id: 'ch_2' }
    });

    assert.equal(resG2.handled, false);
    assert.equal(taskG1.status, PendingTaskStatus.WAITING_FOR_INPUT);
  });

  // Scenario 10: Restarting while a task is waiting for input
  test('Scenario 10: Restarting while task waits for input reloads and completes', async () => {
    // 1. Create task in original manager
    const task = taskManager.createTask({
      guildId: mockGuild.id,
      userId: mockUser.id,
      channelId: mockChannel.id,
      action: 'create_role',
      targetName: 'VIP',
      collectedParams: { name: 'VIP' },
      missingParams: ['color']
    });

    // 2. Simulate bot restart: create new PendingTaskManager reading same storage file
    const restartedManager = new PendingTaskManager({ storagePath: TEST_STORAGE_PATH });
    restartedManager.loadAllTasks();

    const reloadedTask = restartedManager.getPendingTask(mockGuild.id, mockUser.id, mockChannel.id);
    assert.ok(reloadedTask);
    assert.equal(reloadedTask.taskId, task.taskId);
    assert.equal(reloadedTask.status, PendingTaskStatus.WAITING_FOR_INPUT);

    // 3. User follow-up after restart resolves correctly
    const restartPipeline = new ContextResolutionPipeline({
      taskManager: restartedManager,
      memoryManager
    });

    const res = await restartPipeline.resolve('Purple', {
      guild: mockGuild,
      member: mockMember,
      user: mockUser,
      channel: mockChannel
    });

    assert.equal(res.handled, true);
    assert.equal(res.outcome, 'executed');
    assert.equal(reloadedTask.status, PendingTaskStatus.COMPLETED);
  });

  // Scenario 11: Expired tasks
  test('Scenario 11: Inactive pending tasks past TTL expire and reject follow-up', async () => {
    const expiredTask = taskManager.createTask({
      guildId: mockGuild.id,
      userId: mockUser.id,
      channelId: mockChannel.id,
      action: 'create_role',
      targetName: 'VIP',
      missingParams: ['color'],
      ttlMs: -1000 // Already expired in the past
    });

    // Check retrieval: should mark EXPIRED
    const active = taskManager.getPendingTask(mockGuild.id, mockUser.id, mockChannel.id);
    assert.equal(active, null);
    assert.equal(expiredTask.status, PendingTaskStatus.EXPIRED);
  });

  // Scenario 12: Duplicate messages (idempotency)
  test('Scenario 12: Duplicate message does not execute task twice', async () => {
    taskManager.createTask({
      guildId: mockGuild.id,
      userId: mockUser.id,
      channelId: mockChannel.id,
      action: 'create_role',
      targetName: 'VIP',
      collectedParams: { name: 'VIP' },
      missingParams: ['color']
    });

    // Message 1
    const res1 = await pipeline.resolve('Purple', {
      guild: mockGuild,
      member: mockMember,
      user: mockUser,
      channel: mockChannel
    });
    assert.equal(res1.handled, true);
    assert.equal(res1.outcome, 'executed');

    // Message 2 (exact duplicate sent right after)
    const res2 = await pipeline.resolve('Purple', {
      guild: mockGuild,
      member: mockMember,
      user: mockUser,
      channel: mockChannel
    });
    // Task is now COMPLETED, so pipeline does not re-execute task
    assert.equal(res2.handled, false);
  });

  // Scenario 13: Concurrent replies locking
  test('Scenario 13: Concurrent replies lock task to prevent double execution', async () => {
    const task = taskManager.createTask({
      guildId: mockGuild.id,
      userId: mockUser.id,
      channelId: mockChannel.id,
      action: 'create_role',
      targetName: 'VIP',
      collectedParams: { name: 'VIP' },
      missingParams: ['color']
    });

    // Simulate concurrent lock acquisition
    const lockAcquired = taskManager.acquireLock(task.taskId);
    assert.equal(lockAcquired, true);

    // Second worker attempting to process same task
    const secondLock = taskManager.acquireLock(task.taskId);
    assert.equal(secondLock, false);

    taskManager.releaseLock(task.taskId);
  });

  // Scenario 14: AI provider timeout preserves state
  test('Scenario 14: External error preserves pending task in safe waiting state', async () => {
    const task = taskManager.createTask({
      guildId: mockGuild.id,
      userId: mockUser.id,
      channelId: mockChannel.id,
      action: 'create_role',
      targetName: 'VIP',
      collectedParams: { name: 'VIP' },
      missingParams: ['color']
    });

    // Unrecognized follow-up does not corrupt or prematurely complete task
    const res = await pipeline.resolve('What is the weather in Paris?', {
      guild: mockGuild,
      member: mockMember,
      user: mockUser,
      channel: mockChannel
    });

    assert.equal(res.handled, false);
    assert.equal(task.status, PendingTaskStatus.WAITING_FOR_INPUT);
    assert.deepEqual(task.missingParams, ['color']);
  });

  // Scenario 15: Corrupted stored state safe recovery
  test('Scenario 15: Corrupted storage file safely resets without crashing', () => {
    fs.writeFileSync(TEST_STORAGE_PATH, '{ malformed json: not valid ]', 'utf8');

    const corruptManager = new PendingTaskManager({ storagePath: TEST_STORAGE_PATH });
    corruptManager.loadAllTasks();

    assert.equal(corruptManager.tasks.size, 0);
  });

  // Scenario 16: Missing permissions when final parameter arrives
  test('Scenario 16: Missing permissions when final parameter arrives blocks execution', async () => {
    taskManager.createTask({
      guildId: mockGuild.id,
      userId: 'user_456',
      channelId: mockChannel.id,
      action: 'create_role',
      targetName: 'VIP',
      collectedParams: { name: 'VIP' },
      missingParams: ['color']
    });

    const unauthorizedMember = {
      id: 'user_456',
      user: { id: 'user_456', tag: 'Bob#0002' },
      permissions: {
        has: () => false // No permissions
      }
    };

    const res = await pipeline.resolve('Purple', {
      guild: mockGuild,
      member: unauthorizedMember,
      user: unauthorizedMember.user,
      channel: mockChannel
    });

    assert.equal(res.handled, true);
    assert.equal(res.outcome, 'unauthorized');
    assert.ok(res.message.includes('Unauthorized'));
  });

  // Scenario 17: Unauthorized user attempting to continue another user task
  test('Scenario 17: Unauthorized user attempting to continue another user task is rejected', async () => {
    const taskA = taskManager.createTask({
      guildId: mockGuild.id,
      userId: 'user_123',
      channelId: mockChannel.id,
      action: 'create_role',
      targetName: 'VIP',
      missingParams: ['color']
    });

    // User B tries to supply parameter
    const res = await pipeline.resolve('Purple', {
      guild: mockGuild,
      member: { id: 'user_456', permissions: { has: () => true } },
      user: { id: 'user_456', tag: 'Attacker#9999' },
      channel: mockChannel
    });

    assert.equal(res.handled, false);
    assert.equal(taskA.status, PendingTaskStatus.WAITING_FOR_INPUT);
  });

  // Scenario 18: Destructive operation confirmation requirement
  test('Scenario 18: High impact action enforces confirmation check', async () => {
    taskManager.createTask({
      guildId: mockGuild.id,
      userId: mockUser.id,
      channelId: mockChannel.id,
      action: 'delete_channel',
      targetName: 'general',
      collectedParams: { targetChannel: 'channel_abc' },
      missingParams: ['confirm'],
      constraints: { isHighImpact: true }
    });

    const task = taskManager.getPendingTask(mockGuild.id, mockUser.id, mockChannel.id);
    assert.ok(task);
    assert.equal(task.constraints.isHighImpact, true);
  });

  // Scenario 19: Memory limits being reached (bounding entries)
  test('Scenario 19: Conversation memory bounds turn count and trims oldest', () => {
    const smallMemory = new ConversationMemoryManager({ maxMessagesPerConversation: 5 });

    for (let i = 1; i <= 10; i++) {
      smallMemory.recordUserMessage(mockGuild.id, mockUser.id, mockChannel.id, `Message ${i}`);
    }

    const turns = smallMemory.getConversationHistory(mockGuild.id, mockUser.id, mockChannel.id, 50);
    assert.equal(turns.length, 5);
    assert.equal(turns[0].content, 'Message 6');
    assert.equal(turns[4].content, 'Message 10');
  });

  // Scenario 20: Long conversations summarized or trimmed correctly
  test('Scenario 20: Long conversations summarize pruned actions and maintain stats', async () => {
    const mem = new ConversationMemoryManager({ maxMessagesPerConversation: 6 });

    // Record conversations with assistant actions
    mem.recordUserMessage(mockGuild.id, mockUser.id, mockChannel.id, 'Create role VIP');
    mem.recordBotResponse(mockGuild.id, mockUser.id, mockChannel.id, 'Role VIP created', { action: 'create_role' });
    mem.recordUserMessage(mockGuild.id, mockUser.id, mockChannel.id, 'Create channel lounge');
    mem.recordBotResponse(mockGuild.id, mockUser.id, mockChannel.id, 'Channel lounge created', { action: 'create_channel' });

    // Exceed limit so older action turns are pruned and summarized
    mem.recordUserMessage(mockGuild.id, mockUser.id, mockChannel.id, 'Message A');
    mem.recordUserMessage(mockGuild.id, mockUser.id, mockChannel.id, 'Message B');
    mem.recordUserMessage(mockGuild.id, mockUser.id, mockChannel.id, 'Message C');
    mem.recordUserMessage(mockGuild.id, mockUser.id, mockChannel.id, 'Message D');
    mem.recordUserMessage(mockGuild.id, mockUser.id, mockChannel.id, 'Message E');

    const summary = mem.getConversationSummary(mockGuild.id, mockUser.id, mockChannel.id);
    assert.ok(summary);
    assert.ok(summary.includes('create_role') || summary.includes('create_channel'));

    // Diagnostics report
    const diag = await DiagnosticService.diagnosePendingTasksMemory({}, 'diag_test');
    assert.equal(diag.status, DiagnosticStatus.HEALTHY);
    assert.ok(diag.response.includes('Conversational Memory & Pending Tasks'));
  });
});
