import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { SecurityEngine } from '../src/security-engine.js';
import { CaseManager } from '../src/case-manager.js';
import { MemberOnboardingManager } from '../src/member-onboarding.js';
import { ServerTemplateEngine } from '../src/server-templates.js';
import { TicketManager } from '../src/tickets.js';
import { ApplicationManager } from '../src/applications.js';
import { WorkflowEngine, WorkflowTrigger, WorkflowConditionType, WorkflowActionType } from '../src/workflow-engine.js';
import { CommunityUtils } from '../src/community-utils.js';
import { TaskScheduler } from '../src/scheduler.js';
import { AnalyticsService } from '../src/analytics-service.js';
import { IntentRouter } from '../src/intent-router.js';

// Mock Discord Collection that extends Map
class MockCollection extends Map {
  find(fn) {
    for (const [key, val] of this.entries()) {
      if (fn(val, key)) return val;
    }
    return undefined;
  }
  filter(fn) {
    const result = new MockCollection();
    for (const [key, val] of this.entries()) {
      if (fn(val, key)) result.set(key, val);
    }
    return result;
  }
  some(fn) {
    for (const [key, val] of this.entries()) {
      if (fn(val, key)) return true;
    }
    return false;
  }
  first() {
    return this.values().next().value;
  }
}

// Mock Discord channel and guild factories
function createMockChannel(id, name, type = ChannelType.GuildText, guild = null) {
  const sentMessages = [];
  const overwrites = new Map();

  const ch = {
    id,
    name,
    type,
    topic: '',
    guildId: guild ? guild.id : 'guild_test',
    guild: guild,
    permissionOverwrites: {
      cache: overwrites,
      get: (targetId) => overwrites.get(targetId) || null,
      edit: async (roleOrMember, perms, options) => {
        overwrites.set(roleOrMember.id, {
          id: roleOrMember.id,
          allow: { bitfield: 0n },
          deny: { bitfield: perms.SendMessages === false ? PermissionFlagsBits.SendMessages : 0n }
        });
        return true;
      },
      delete: async (roleOrMember) => {
        overwrites.delete(roleOrMember.id);
        return true;
      }
    },
    isTextBased: () => type === ChannelType.GuildText || type === 0,
    send: async (payload) => {
      const msg = {
        id: `msg_${Date.now()}_${sentMessages.length}`,
        channelId: id,
        ...payload,
        createdAt: new Date(),
        author: { id: 'bot_honey', tag: 'Honey#0001' }
      };
      sentMessages.push(msg);
      return msg;
    },
    messages: {
      fetch: async () => new Map(sentMessages.map(m => [m.id, m]))
    },
    delete: async () => true,
    _getSentMessages: () => sentMessages
  };
  return ch;
}

function createMockGuild(id = 'guild_platform_test', channels = [], roles = []) {
  const channelMap = new MockCollection();
  const roleMap = new MockCollection();

  const everyoneRole = { id: id, name: '@everyone', permissions: { has: () => true } };
  roleMap.set(everyoneRole.id, everyoneRole);

  for (const r of roles) {
    roleMap.set(r.id, r);
  }

  const guild = {
    id,
    name: `Guild_${id}`,
    roles: {
      cache: roleMap,
      everyone: everyoneRole,
      create: async (data) => {
        const r = { id: `role_${Date.now()}_${roleMap.size}`, ...data };
        roleMap.set(r.id, r);
        return r;
      }
    },
    channels: {
      cache: channelMap,
      create: async (data) => {
        const ch = createMockChannel(`ch_${Date.now()}_${channelMap.size}`, data.name, data.type, guild);
        ch.topic = data.topic || '';
        channelMap.set(ch.id, ch);
        return ch;
      },
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

  for (const c of channels) {
    c.guild = guild;
    c.guildId = guild.id;
    channelMap.set(c.id, c);
  }

  return guild;
}

// =============================================================================
// 1. SECURITY & ANTI-SPAM
// =============================================================================
test('1. SecurityEngine: Detects rapid message bursts, duplicate spam, and unauthorized invites', async () => {
  const guild = createMockGuild('guild_sec_test');
  const channel = createMockChannel('ch_general', 'general');
  guild.channels.cache.set(channel.id, channel);

  SecurityEngine.updatePolicy(guild.id, {
    antiSpam: {
      enabled: true,
      maxMessagesPerWindow: 3,
      windowSeconds: 5,
      maxDuplicates: 2,
      duplicateWindowSeconds: 10,
      blockDiscordInvites: true,
      action: 'timeout',
      timeoutMinutes: 10
    }
  });

  const member = {
    id: 'spammer_1',
    moderatable: true,
    timeout: async () => true,
    permissions: { has: () => false },
    roles: { cache: new Map() }
  };

  const normalMsg = {
    guild,
    member,
    author: { id: member.id, tag: 'SpamUser#1111', bot: false },
    channel,
    content: 'Hello everyone!',
    deletable: true,
    delete: async () => true,
    mentions: { users: new Map(), roles: new Map() }
  };

  // Normal messages within limit
  const res1 = await SecurityEngine.evaluateMessage(normalMsg);
  assert.equal(res1.isViolation, false);

  // Rapid burst violation
  await SecurityEngine.evaluateMessage(normalMsg);
  await SecurityEngine.evaluateMessage(normalMsg);
  const burstRes = await SecurityEngine.evaluateMessage(normalMsg);
  assert.equal(burstRes.isViolation, true);
  assert.ok(burstRes.reason.includes('burst') || burstRes.reason.includes('duplicate'));

  // Invite link violation
  const inviteMsg = {
    guild,
    member,
    author: { id: member.id, tag: 'SpamUser#1111', bot: false },
    channel,
    content: 'Join my awesome server: https://discord.gg/malicious-server',
    deletable: true,
    delete: async () => true,
    mentions: { users: new Map(), roles: new Map() }
  };
  const inviteRes = await SecurityEngine.evaluateMessage(inviteMsg);
  assert.equal(inviteRes.isViolation, true);
  assert.ok(inviteRes.reason.includes('invitation'));
});

// =============================================================================
// 2. ANTI-RAID & EMERGENCY LOCKDOWN
// =============================================================================
test('2. SecurityEngine: Anti-Raid join velocity detection and emergency lockdown & lift', async () => {
  const ch1 = createMockChannel('c1', 'general');
  const ch2 = createMockChannel('c2', 'lounge');
  const guild = createMockGuild('guild_raid_test', [ch1, ch2]);

  SecurityEngine.updatePolicy(guild.id, {
    antiRaid: {
      enabled: true,
      maxJoinsPerWindow: 4,
      joinWindowSeconds: 10,
      autoLockdown: true
    }
  });

  // Simulate rapid joins
  const joiner = (id) => ({ id, guild, user: { id, tag: `Raider_${id}` } });
  assert.equal((await SecurityEngine.handleMemberJoin(joiner('u1'))).isRaid, false);
  assert.equal((await SecurityEngine.handleMemberJoin(joiner('u2'))).isRaid, false);
  assert.equal((await SecurityEngine.handleMemberJoin(joiner('u3'))).isRaid, false);

  const raidRes = await SecurityEngine.handleMemberJoin(joiner('u4'));
  assert.equal(raidRes.isRaid, true);
  assert.equal(SecurityEngine.isLockdownActive(guild.id), true);

  // Lift lockdown cleanly
  const liftRes = await SecurityEngine.liftLockdown(guild);
  assert.equal(liftRes.success, true);
  assert.equal(SecurityEngine.isLockdownActive(guild.id), false);
});

// =============================================================================
// 3. MODERATION CASE MANAGEMENT & AUTO-ESCALATION
// =============================================================================
test('3. CaseManager: Unified sequential case IDs, escalation triggers, and appeals', () => {
  const guildId = 'guild_cases_test';
  CaseManager.loadAll();
  CaseManager._cases.delete(guildId);
  CaseManager._counters.delete(guildId);
  const target = { id: 'bad_actor_99', tag: 'BadActor#9999' };
  const mod = { id: 'admin_1', tag: 'HeadMod#0001' };

  // 1. Create cases
  const c1 = CaseManager.createCase(guildId, {
    action: 'warn',
    target,
    moderator: mod,
    reason: 'First infraction - offensive language'
  });
  assert.equal(c1.caseId, 'CASE-0001');

  const c2 = CaseManager.createCase(guildId, {
    action: 'warn',
    target,
    moderator: mod,
    reason: 'Second infraction - trolling'
  });
  assert.equal(c2.caseId, 'CASE-0002');

  const c3 = CaseManager.createCase(guildId, {
    action: 'warn',
    target,
    moderator: mod,
    reason: 'Third infraction - spam'
  });
  assert.equal(c3.caseId, 'CASE-0003');

  // 2. Escalation check
  const escalation = CaseManager.checkEscalation(guildId, target.id);
  assert.equal(escalation.triggered, true);
  assert.equal(escalation.recommendedAction, 'timeout');
  assert.equal(escalation.durationMinutes, 15);

  // 3. Appeals
  CaseManager.submitAppeal(guildId, c1.caseId, { reason: 'I apologize, won\'t happen again', appellantId: target.id });
  const appealRes = CaseManager.resolveAppeal(guildId, c1.caseId, { decision: 'accepted', moderator: mod, notes: 'First offense forgiven' });
  assert.equal(appealRes.success, true);
  assert.equal(appealRes.case.status, 'appealed');
});

// =============================================================================
// 4. MEMBER ONBOARDING & AUTO-ROLES
// =============================================================================
test('4. MemberOnboardingManager: Formats greetings, executes auto-roles and verification panel', async () => {
  const ch = createMockChannel('ch_welcome', 'welcome');
  const roleMember = { id: 'role_member_1', name: 'Verified Member' };
  const guild = createMockGuild('guild_onboard_test', [ch], [roleMember]);

  MemberOnboardingManager.updateConfig(guild.id, {
    welcome: {
      enabled: true,
      channelId: ch.id,
      message: 'Welcome to {server}, {user}! Member #{memberCount}',
      sendEmbed: true
    },
    autoRoles: {
      enabled: true,
      memberRoleIds: [roleMember.id],
      botRoleIds: []
    },
    verification: {
      enabled: true,
      channelId: ch.id,
      verifiedRoleId: roleMember.id
    }
  });

  const assignedRoles = [];
  const newMember = {
    id: 'user_newbie',
    user: { id: 'user_newbie', tag: 'Newbie#0001', username: 'Newbie', bot: false },
    guild,
    roles: {
      cache: new Map(),
      add: async (r) => { assignedRoles.push(r.id); return true; }
    }
  };

  // Join trigger
  await MemberOnboardingManager.handleMemberJoin(newMember);

  // Welcome message dispatched
  const sent = ch._getSentMessages();
  assert.equal(sent.length, 1);
  assert.ok(sent[0].embeds[0].data.description.includes('Welcome to'));

  // Auto-role assigned
  assert.ok(assignedRoles.includes(roleMember.id));

  // Verification button click
  const mockInteraction = {
    isButton: () => true,
    customId: 'onboard:verify_member',
    guild,
    member: newMember,
    reply: async () => true
  };
  const verifiedHandled = await MemberOnboardingManager.handleVerificationInteraction(mockInteraction);
  assert.equal(verifiedHandled, true);
});

// =============================================================================
// 5. SERVER TEMPLATES
// =============================================================================
test('5. ServerTemplateEngine: Generates structural preview and applies templates', async () => {
  const guild = createMockGuild('guild_tmpl_test');

  const preview = ServerTemplateEngine.generatePreview('COMMUNITY_HUB');
  assert.ok(preview.includes('Community Hub'));
  assert.ok(preview.includes('WELCOME & RULES'));
  assert.ok(preview.includes('rules'));
  assert.ok(preview.includes('STAFF OPERATIONS'));

  const applyRes = await ServerTemplateEngine.applyTemplate(guild, 'COMMUNITY_HUB', { tag: 'Admin#0001' });
  assert.equal(applyRes.success, true);
  assert.ok(applyRes.createdCategories.length >= 3);
  assert.ok(applyRes.createdChannels.length >= 6);
  assert.ok(applyRes.createdRoles.length >= 2);
});

// =============================================================================
// 6. ENTERPRISE TICKETING & APPLICATIONS
// =============================================================================
test('6. TicketManager & ApplicationManager: Full support ticket and application lifecycle', async () => {
  const guild = createMockGuild('guild_tickets_test');
  ApplicationManager.loadAll();
  ApplicationManager._apps.delete(guild.id);
  TicketManager.loadAll();
  TicketManager._tickets.delete(guild.id);

  // Setup ticket panel
  const setupRes = await TicketManager.setupTicketSystem(guild, { channelName: 'support-center' });
  assert.equal(setupRes.success, true);

  // Modal ticket creation
  const mockModalInteraction = {
    isModalSubmit: () => true,
    customId: 'ticket_create_modal',
    guild,
    user: { id: 'ticket_user_1', tag: 'Client#1234', username: 'client' },
    fields: {
      getTextInputValue: (field) => field === 'ticket_subject' ? 'Billing inquiry' : 'Need invoice details'
    },
    deferReply: async () => true,
    editReply: async () => true
  };

  const modalHandled = await TicketManager.handleModalSubmit(mockModalInteraction);
  assert.equal(modalHandled, true);

  // Application submission & review
  const mockAppModal = {
    isModalSubmit: () => true,
    customId: 'app:submit:staff',
    guild,
    user: { id: 'applicant_1', tag: 'StaffHopeful#0001' },
    fields: {
      getTextInputValue: (field) => '3 years experience, 20 hrs/week'
    },
    deferReply: async () => true,
    editReply: async () => true
  };

  const appHandled = await ApplicationManager.handleModalSubmit(mockAppModal);
  assert.equal(appHandled, true);

  const apps = ApplicationManager.listApplications(guild.id);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].type, 'staff');
});

// =============================================================================
// 7. AUTOMATION WORKFLOW ENGINE
// =============================================================================
test('7. WorkflowEngine: Executes Trigger -> Condition -> Action sequences with history', async () => {
  WorkflowEngine.loadAll();
  WorkflowEngine._workflows.delete('guild_wf_test');
  const ch = createMockChannel('ch_log', 'bot-logs');
  const guild = createMockGuild('guild_wf_test', [ch]);

  const wf = WorkflowEngine.registerWorkflow(guild.id, {
    name: 'Auto-Alert on Join',
    trigger: WorkflowTrigger.MEMBER_JOIN,
    conditions: [
      { type: WorkflowConditionType.IS_BOT, value: false }
    ],
    actions: [
      { type: WorkflowActionType.SEND_MESSAGE, channelId: ch.id, content: 'User {user} joined the server!' }
    ]
  });
  assert.ok(wf.id.startsWith('WF-'));

  const member = {
    id: 'user_joined_99',
    guild,
    user: { id: 'user_joined_99', bot: false }
  };

  const results = await WorkflowEngine.trigger(WorkflowTrigger.MEMBER_JOIN, {
    guild,
    member,
    user: member.user
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].succeeded, true);
  assert.equal(results[0].actionsExecuted, 1);

  const sent = ch._getSentMessages();
  assert.equal(sent.length, 1);
  assert.ok(sent[0].content.includes('User <@user_joined_99> joined'));
});

// =============================================================================
// 8. COMMUNITY UTILITIES (POLLS, SUGGESTIONS, STARBOARD, FAQS)
// =============================================================================
test('8. CommunityUtils: Interactive button polls, suggestions, starboard, and FAQs', async () => {
  const ch = createMockChannel('ch_community', 'community');
  const guild = createMockGuild('guild_comm_test', [ch]);

  // 1. Polls
  const poll = await CommunityUtils.createPoll(ch, {
    question: 'Should we add game nights?',
    options: ['Yes definitely', 'No'],
    creator: { id: 'admin_1', tag: 'Admin#0001' }
  });
  assert.equal(poll.options.length, 2);

  // Vote button
  const mockVoteInteraction = {
    isButton: () => true,
    customId: `poll:vote:${poll.pollId}:0`,
    user: { id: 'voter_1' },
    update: async () => true
  };
  await CommunityUtils.handleVote(mockVoteInteraction);
  assert.equal(poll.options[0].votes.length, 1);

  // 2. Suggestions
  const sug = await CommunityUtils.submitSuggestion(ch, {
    content: 'Add an anime discussion channel',
    author: { id: 'suggester_1', tag: 'AnimeFan#1234' }
  });
  assert.equal(sug.content, 'Add an anime discussion channel');

  // 3. Auto-Response FAQ
  CommunityUtils.addAutoResponse(guild.id, {
    trigger: 'how do i get roles',
    response: 'Visit #roles or click the verification panel in #rules!'
  });

  let repliedText = '';
  const mockMsg = {
    guild,
    author: { bot: false },
    content: 'Hey how do i get roles please?',
    reply: async (text) => { repliedText = text; }
  };
  const didReply = await CommunityUtils.checkAutoResponse(mockMsg);
  assert.equal(didReply, true);
  assert.ok(repliedText.includes('#roles'));
});

// =============================================================================
// 9. EVENTS, PERSISTENT SCHEDULING & RSVPS
// =============================================================================
test('9. TaskScheduler: Schedules reminders, announcements, and community events with RSVPs', async () => {
  const ch = createMockChannel('ch_events', 'events');
  const guild = createMockGuild('guild_sched_test', [ch]);

  // 1. Schedule Reminder
  const task = TaskScheduler.scheduleReminder(guild.id, ch.id, 'user_remind_1', 'Time to vote on the server election!', new Date(Date.now() - 1000));
  assert.equal(task.type, 'REMINDER');

  // Sweep pending tasks
  const mockClient = {
    guilds: {
      cache: new Map([[guild.id, guild]]),
      fetch: async () => guild
    }
  };
  await TaskScheduler.checkPendingTasks(mockClient);
  assert.equal(task.status, 'executed');

  // 2. Community Event with RSVP
  const evt = await TaskScheduler.createCommunityEvent(ch, {
    title: 'Valorant Tournament Finals',
    description: 'Championship match live with commentary',
    startTime: new Date(Date.now() + 3600000),
    location: 'Tournament Voice 1',
    creator: { id: 'host_1', tag: 'Host#0001' }
  });
  assert.equal(evt.title, 'Valorant Tournament Finals');

  // RSVP interaction
  const mockRsvpInteraction = {
    isButton: () => true,
    customId: `rsvp:attending:${evt.id}`,
    user: { id: 'attendee_1' },
    update: async () => true
  };
  await TaskScheduler.handleRsvpInteraction(mockRsvpInteraction);
  assert.equal(evt.rsvps.attending.length, 1);
});

// =============================================================================
// 10. PRIVACY-SAFE ANALYTICS
// =============================================================================
test('10. AnalyticsService: Aggregates joins, message volume, moderation incidents safely', () => {
  const guildId = 'guild_analytics_test';
  AnalyticsService.loadAll();
  AnalyticsService._data.delete(guildId);

  AnalyticsService.recordJoin(guildId);
  AnalyticsService.recordJoin(guildId);
  AnalyticsService.recordLeave(guildId);
  AnalyticsService.recordMessage(guildId, 'ch_chat');
  AnalyticsService.recordMessage(guildId, 'ch_chat');
  AnalyticsService.recordSpamBlock(guildId);

  const metrics = AnalyticsService.getOverviewMetrics(guildId);
  assert.equal(metrics.today.joins, 2);
  assert.equal(metrics.today.leaves, 1);
  assert.equal(metrics.today.messages, 2);
  assert.equal(metrics.today.spamBlocks, 1);
  assert.equal(metrics.past7Days.netGrowth, 1);
});

// =============================================================================
// 11. UNIVERSAL NATURAL-LANGUAGE CONTROL FAST-PATHS (/go)
// =============================================================================
test('11. IntentRouter: Fast-path natural language routing for new platform capabilities', async () => {
  const router = new IntentRouter({ isDeterministicOnly: true });

  const r1 = await router.route('emergency lockdown the server', {});
  assert.equal(r1.intent, 'lockdown_server');

  const r2 = await router.route('lift the server lockdown', {});
  assert.equal(r2.intent, 'lift_lockdown');

  const r3 = await router.route('apply server template community hub', {});
  assert.equal(r3.intent, 'apply_server_template');
  assert.equal(r3.args.template.toUpperCase(), 'COMMUNITY HUB');

  const r4 = await router.route('preview server template gaming', {});
  assert.equal(r4.intent, 'preview_server_template');

  const r5 = await router.route('setup a ticket system for support', {});
  assert.equal(r5.intent, 'setup_ticket_system');

  const r6 = await router.route('setup verification in #rules', {});
  assert.equal(r6.intent, 'setup_verification');

  const r7 = await router.route('create a poll: Which map should we play? Haven, Ascent, Bind', {});
  assert.equal(r7.intent, 'create_poll');
  assert.ok(r7.args.options.length >= 2);

  const r8 = await router.route('show server analytics', {});
  assert.equal(r8.intent, 'view_analytics');
});
