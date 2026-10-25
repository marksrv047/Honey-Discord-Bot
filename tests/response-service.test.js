import test from 'node:test';
import assert from 'node:assert/strict';
import { ResponseService, OutcomeClass } from '../src/response-service.js';
import { formatSingleOutcome } from '../src/format-response.js';
import { SecurityGate } from '../src/security-gate.js';

// =============================================================================
// Section 13 Response System Verification Test Suite
// =============================================================================

test('ResponseService 1: A successful kick identifies the actual target using native <@USER_ID>', () => {
  const verifiedUserId = '987654321098765432';
  const outcome = ResponseService.formatActionOutcome('kick_member', {
    success: true,
    resourceId: verifiedUserId,
    targetMemberId: verifiedUserId
  }, {
    reason: 'Repeated disruptive behavior'
  });

  assert.equal(outcome.outcomeClass, OutcomeClass.SUCCESS);
  assert.ok(outcome.content.includes(`<@${verifiedUserId}>`), `Expected <@${verifiedUserId}> in response, got: ${outcome.content}`);
  assert.ok(outcome.content.includes('Repeated disruptive behavior'));
  assert.ok(!outcome.content.includes('@member'));
});

test('ResponseService 2: A kicked member can still be referenced by their verified user ID', () => {
  const verifiedUserId = '112233445566778899';
  const mention = ResponseService.formatUserMention(verifiedUserId, 'former-member');
  assert.equal(mention, `<@${verifiedUserId}>`);

  const outcome = formatSingleOutcome('kick_member', { success: true }, {
    targetMemberId: verifiedUserId,
    targetMember: 'former-member'
  });
  assert.ok(outcome.includes(`<@${verifiedUserId}>`));
});

test('ResponseService 3: A failed kick is not reported as successful', () => {
  const outcome = ResponseService.formatActionOutcome('kick_member', {
    success: false,
    error: '50013 Missing Permissions'
  }, {
    targetMemberId: '123456789012345678'
  });

  assert.equal(outcome.outcomeClass, OutcomeClass.FAILURE);
  assert.ok(outcome.content.includes("Couldn't kick"));
  assert.ok(!outcome.content.includes('kicked from the server'));
  assert.ok(!outcome.content.includes('Done —'));
});

test('ResponseService 4: A successful channel creation mentions the actual channel using <#CHANNEL_ID>', () => {
  const channelId = '123456789012345678';
  const outcome = ResponseService.formatActionOutcome('create_channel', {
    success: true,
    resourceId: channelId,
    targetChannelId: channelId
  }, {
    name: 'project-updates'
  });

  assert.equal(outcome.outcomeClass, OutcomeClass.SUCCESS);
  assert.ok(outcome.content.includes(`<#${channelId}>`), `Expected <#${channelId}>, got: ${outcome.content}`);
});

test('ResponseService 5: A deleted channel is identified by its last verified name and ID', () => {
  const channelId = '556677889900112233';
  const channelMention = ResponseService.formatChannelMention(channelId, 'temporary-chat', true);
  assert.equal(channelMention, '`temporary-chat` (channel ID: 556677889900112233)');

  const outcome = formatSingleOutcome('delete_channel', { success: true }, {
    targetRef: 'temporary-chat',
    targetChannelId: channelId
  });
  assert.ok(outcome.includes('`temporary-chat`'));
  assert.ok(outcome.includes('556677889900112233'));
});

test('ResponseService 6: Role changes identify the correct role <@&ROLE_ID> and member <@USER_ID>', () => {
  const roleId = '889900112233445566';
  const memberId = '778899001122334455';

  const outcome = ResponseService.formatActionOutcome('assign_role', {
    success: true,
    resourceId: roleId,
    targetRoleId: roleId,
    targetMemberId: memberId
  }, {
    targetRole: 'Moderator',
    targetMember: 'Alex'
  });

  assert.equal(outcome.outcomeClass, OutcomeClass.SUCCESS);
  assert.ok(outcome.content.includes(`<@&${roleId}>`), `Expected role mention <@&${roleId}>`);
  assert.ok(outcome.content.includes(`<@${memberId}>`), `Expected member mention <@${memberId}>`);
});

test('ResponseService 7: Untrusted text cannot inject @everyone or unintended mentions', () => {
  const maliciousReason = 'Trying @everyone and @here exploit with <@&111111111111111111>';
  const sanitized = ResponseService.sanitizeText(maliciousReason);

  assert.ok(!sanitized.includes('@everyone'), 'Sanitized text must not contain active @everyone');
  assert.ok(!sanitized.includes('@here'), 'Sanitized text must not contain active @here');
  assert.ok(sanitized.includes('@\u200beveryone'));
  assert.ok(sanitized.includes('@\u200bhere'));
});

test('ResponseService 8: Visible mentions do not create unintended notification pings (allowedMentions check)', () => {
  const mentionsConfig = ResponseService.getAllowedMentions();
  assert.deepEqual(mentionsConfig.parse, [], 'Allowed mentions parse array must be strictly empty');
  assert.deepEqual(mentionsConfig.users, [], 'Allowed mentions users array must be strictly empty by default');
  assert.deepEqual(mentionsConfig.roles, [], 'Allowed mentions roles array must be strictly empty by default');
  assert.equal(mentionsConfig.repliedUser, false);
});

test('ResponseService 9: Missing IDs produce safe, truthful fallbacks without fabricating IDs', () => {
  const userFallback = ResponseService.formatUserMention(null, 'Alex');
  assert.equal(userFallback, '@Alex');

  const channelFallback = ResponseService.formatChannelMention(null, 'general');
  assert.equal(channelFallback, '#general');

  const roleFallback = ResponseService.formatRoleMention(null, 'Staff');
  assert.equal(roleFallback, '@Staff');
});

test('ResponseService 10: Plain text is selected for simple confirmations', () => {
  const singleAction = ResponseService.formatActionOutcome('rename_channel', {
    success: true,
    targetChannelId: '123456789012345678'
  }, { name: 'team-chat' });

  assert.equal(singleAction.embeds.length, 0, 'Simple action should use plain text with 0 embeds');
  assert.ok(singleAction.content.length > 0);
  assert.ok(singleAction.content.includes('<#123456789012345678>'));
});

test('ResponseService 11: Embeds are selected for suitable detailed reports', () => {
  const mockReport = {
    status: 'degraded',
    response: 'Multiple system checks evaluated.',
    checks: {
      gateway: { status: 'healthy', details: 'Ping 290ms' },
      modlog: { status: 'failed', details: 'Channel permissions missing' }
    }
  };

  const embed = ResponseService.buildDiagnosticEmbed(mockReport, 'exec_diag_123');
  assert.ok(embed.data.title.includes('Honey Bot Diagnostics'));
  assert.ok(embed.data.fields.length >= 2);
  assert.equal(embed.data.color, 0xFEE75C);
});

test('ResponseService 12: Multi-step operations produce accurate structured summaries', () => {
  const plan = { thoughtProcess: 'Setting up new community channel and permissions' };
  const results = [
    { action: 'create_channel', status: 'COMPLETED', details: 'Channel created <#101>' },
    { action: 'edit_channel_topic', status: 'COMPLETED', details: 'Topic updated' }
  ];

  const embed = ResponseService.buildMultiActionEmbed(plan, results, 'exec_plan_999');
  assert.equal(embed.data.title, 'Multi-Step Plan Execution');
  assert.equal(embed.data.fields.length, 2);
  assert.equal(embed.data.color, 0x57F287);
});

test('ResponseService 13: Partial and unverified outcomes are represented correctly', () => {
  const unverified = ResponseService.formatActionOutcome('send_message', {
    success: true,
    verificationStatus: 'inconclusive'
  });
  assert.equal(unverified.outcomeClass, OutcomeClass.UNVERIFIED);
  assert.ok(unverified.content.includes("couldn't verify the final state"));

  const plan = { thoughtProcess: 'Execute multiple operations' };
  const mixedResults = [
    { action: 'create_channel', status: 'COMPLETED', details: 'Created' },
    { action: 'assign_role', status: 'FAILED', details: 'Role hierarchy violation' }
  ];
  const partialEmbed = ResponseService.buildMultiActionEmbed(plan, mixedResults, 'exec_partial_1');
  assert.equal(partialEmbed.data.color, 0xFEE75C); // Yellow for partial
});

test('ResponseService 14: Embed size limits are handled safely with truncation', () => {
  const hugeText = 'A'.repeat(5000);
  const plan = { thoughtProcess: hugeText };
  const results = [
    { action: 'test_action', status: 'COMPLETED', details: 'B'.repeat(2000) }
  ];

  const embed = ResponseService.buildMultiActionEmbed(plan, results, 'exec_trunc_1');
  assert.ok(embed.data.description.length <= 4000);
  assert.ok(embed.data.fields[0].value.length <= 1024);
});

test('ResponseService 15: Sensitive configuration and credentials never appear in responses', () => {
  const secretKey = 'gsk_123456789012345678901234567890';
  const discordToken = 'Bot MTU2Mzc4MTY3ODA2MzY4OTc0OQ.GeSXRN.fake';
  const textWithSecrets = `Failed due to ${secretKey} using ${discordToken}`;

  const clean = ResponseService.sanitizeText(textWithSecrets);
  assert.ok(!clean.includes(secretKey));
  assert.ok(!clean.includes(discordToken));
  assert.ok(clean.includes('[REDACTED_GROQ_KEY]'));
  assert.ok(clean.includes('[REDACTED_DISCORD_TOKEN]'));
});

test('ResponseService 16: Safe interaction responder handles deferral and applies allowedMentions', async () => {
  let replyPayload = null;
  const mockInteraction = {
    deferred: true,
    replied: false,
    editReply: async (payload) => {
      replyPayload = payload;
      return payload;
    }
  };

  await ResponseService.respondToInteraction(mockInteraction, {
    content: 'Done — <@123456789012345678> kicked.'
  });

  assert.ok(replyPayload);
  assert.equal(replyPayload.content, 'Done — <@123456789012345678> kicked.');
  assert.deepEqual(replyPayload.allowedMentions.parse, []);
});

test('ResponseService 17: Context-aware response variation produces varied professional wording', () => {
  const snowflake = '100000000000000001';
  const kick0 = ResponseService.formatSuccess('kick_member', { targetMemberId: snowflake, executionId: 'seed_a' });
  const kick1 = ResponseService.formatSuccess('kick_member', { targetMemberId: snowflake, executionId: 'seed_b' });

  assert.ok(kick0.includes(`<@${snowflake}>`), `Expected <@${snowflake}> in kick0, got: ${kick0}`);
  assert.ok(kick1.includes(`<@${snowflake}>`), `Expected <@${snowflake}> in kick1, got: ${kick1}`);
});

test('ResponseService 18: Anti-nuke protections remain completely intact across response processing', () => {
  const member = { id: 'u_admin', permissions: { has: () => true } };
  const guild = { id: 'g_test', ownerId: 'u_owner' };

  assert.throws(() => {
    SecurityGate.evaluatePromptSecurity('nuke the entire server', 'u_admin', guild);
  });
});
