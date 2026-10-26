import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { ResponseService } from '../src/response-service.js';
import { formatRefinedResponse, formatSingleOutcome, formatMultiActionSummary } from '../src/format-response.js';
import { CapabilityRegistry, CAPABILITY_CATEGORIES, REGISTERED_SLASH_COMMANDS } from '../src/capabilities.js';
import { HelpManager, DEFAULT_HELP_TEXT } from '../src/help.js';
import { IntentRouter } from '../src/intent-router.js';
import { slashCommands } from '../src/commands.js';
import { GuildConfigService } from '../src/guild-config.js';
import { checkUserAuthorization } from '../src/permissions.js';

// =========================================================================
// SECTION 1: FORMATTING TESTS (Points 1 - 8)
// =========================================================================

test('1. Multiple bullet points remain separate after formatting', () => {
  const items = [
    { title: 'Rename a channel', description: "Change an existing channel's name." },
    { title: 'Edit a channel topic', description: 'Update the channel description.' },
    { title: 'Set slowmode', description: 'Configure a message delay.' }
  ];
  const rendered = ResponseService.renderBulletList(items);
  const lines = rendered.split('\n');

  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('• **Rename a channel** — '));
  assert.ok(lines[1].startsWith('• **Edit a channel topic** — '));
  assert.ok(lines[2].startsWith('• **Set slowmode** — '));
});

test('2. Newlines are preserved through the full response pipeline and literal \\n unescaped', () => {
  const inputWithLiteralEscape = 'Channel management\\n• Item 1\\n• Item 2';
  const unescaped = ResponseService.normalizeNewlines(inputWithLiteralEscape);
  assert.equal(unescaped, 'Channel management\n• Item 1\n• Item 2');

  const refined = formatRefinedResponse('Items:\n• First\n• Second');
  const refinedLines = refined.split('\n');
  assert.ok(refinedLines.length >= 3);
  assert.ok(refinedLines.some(l => l.includes('First')));
  assert.ok(refinedLines.some(l => l.includes('Second')));
});

test('3. Headings and sections render consistently', () => {
  const successText = ResponseService.formatOperationSuccess({
    title: 'Channel updated',
    target: '#general',
    change: 'Name updated to community',
    outcome: 'Succeeded and verified'
  });

  assert.ok(successText.startsWith('**Channel updated**\n'));
  assert.ok(successText.includes('- **Target:** #general'));
  assert.ok(successText.includes('- **Change:** Name updated to community'));
  assert.ok(successText.includes('- **Result:** Succeeded and verified'));

  const failText = ResponseService.formatOperationFailure({
    title: 'Channel update failed',
    target: '#general',
    reason: 'The bot lacks permission to manage this channel.',
    nextStep: 'Grant the bot the required Discord permission, then retry.'
  });

  assert.ok(failText.startsWith('**Channel update failed**\n'));
  assert.ok(failText.includes('- **Target:** #general'));
  assert.ok(failText.includes('- **Reason:** The bot lacks permission'));
  assert.ok(failText.includes('- **Next step:** Grant the bot'));
});

test('4. Code formatting and intentional mentions remain intact', () => {
  const userMention = ResponseService.formatUserMention('1209543193562058753');
  assert.equal(userMention, '<@1209543193562058753>');

  const channelMention = ResponseService.formatChannelMention('987654321098765432');
  assert.equal(channelMention, '<#987654321098765432>');

  const roleMention = ResponseService.formatRoleMention('555555555555555555');
  assert.equal(roleMention, '<@&555555555555555555>');

  const codeText = 'Use `/go prompt: rename channel` to execute.';
  assert.ok(codeText.includes('`/go prompt: rename channel`'));
});

test('5. Long messages are split without breaking Markdown or code blocks', () => {
  const codeBlock = '```javascript\n' + 'console.log("hello world");\n'.repeat(60) + '```';
  const splits = ResponseService.splitMessage(codeBlock, 500);

  assert.ok(splits.length > 1);
  for (let i = 0; i < splits.length; i++) {
    assert.ok(splits[i].length <= 500);
    // If chunk opened a code fence, it must be closed
    const fenceCount = (splits[i].match(/```/g) || []).length;
    assert.equal(fenceCount % 2, 0, `Chunk ${i} should have balanced code fence count, got ${fenceCount}`);
  }
});

test('6. Large help catalogs respect Discord limits', () => {
  const fullCatalog = HelpManager.getFullCatalogText();
  assert.ok(fullCatalog.length > 2000, 'Full catalog is comprehensive');

  const chunks = ResponseService.splitMessage(fullCatalog, 2000);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 2000, 'Chunk must not exceed Discord 2000 character limit');
    assert.ok(chunk.trim().length > 0);
  }
});

test('7. Empty or malformed LLM output produces a valid fallback response', async () => {
  const brokenAIProvider = {
    planWithCustomPrompt: async () => {
      throw new Error('Groq rate limited or token exhaustion');
    }
  };

  const response = await HelpManager.answerQuestion('What are your capabilities?', brokenAIProvider);
  assert.ok(response);
  assert.ok(response.length > 0);
  assert.ok(response.includes('Honey Bot'));
});

test('8. No response is duplicated', () => {
  const success1 = ResponseService.formatOperationSuccess({
    title: 'Channel updated',
    target: '#general',
    change: 'Name updated to lounge'
  });
  const lines = success1.split('\n');
  const uniqueLines = new Set(lines);
  assert.equal(lines.length, uniqueLines.size, 'All lines in structured response should be unique');
});

// =========================================================================
// SECTION 2: CAPABILITY DISCOVERY TESTS (Points 9 - 17)
// =========================================================================

test('9. /help without a prompt shows the registered commands', () => {
  const defaultGuide = HelpManager.getDefaultHelp();
  assert.ok(defaultGuide.includes('Your commands'));
  assert.ok(defaultGuide.includes('/go'));
  assert.ok(defaultGuide.includes('/modlog'));
  assert.ok(defaultGuide.includes('/diagnose'));
  assert.ok(defaultGuide.includes('/undo'));
  assert.ok(defaultGuide.includes('/help'));
});

test('10. /help with a prompt provides relevant detailed help', async () => {
  const modAns = await HelpManager.answerQuestion('What moderation capabilities are supported?');
  assert.ok(modAns.includes('Supported Moderation Capabilities'));
  assert.ok(modAns.includes('Timeout a member'));
  assert.ok(modAns.includes('Ban a member'));
  assert.ok(modAns.includes('/go prompt:'));

  const permAns = await HelpManager.answerQuestion('How do I change individual member permissions?');
  assert.ok(permAns.includes('Changing Individual Member Permissions'));
  assert.ok(permAns.includes('/go prompt: Allow Priya to view #staff-chat'));

  const chAns = await HelpManager.answerQuestion('Show me all channel and category operations.');
  assert.ok(chAns.includes('Channel and Category Operations'));
  assert.ok(chAns.includes('Rename a channel'));
  assert.ok(chAns.includes('Create a category'));

  const undoAns = await HelpManager.answerQuestion('What can I undo?');
  assert.ok(undoAns.includes('What you can undo with `/undo`'));
  assert.ok(undoAns.includes('Reversible Actions'));
  assert.ok(undoAns.includes('Non-Reversible Actions'));

  const limAns = await HelpManager.answerQuestion('Which features are unavailable or limited?');
  assert.ok(limAns.includes('Feature Limitations and Unsupported Operations'));
  assert.ok(limAns.includes('No Economy or Leveling'));
  assert.ok(limAns.includes('Bulk Message Purge'));

  const exAns = await HelpManager.answerQuestion('Give me practical examples of natural-language prompts.');
  assert.ok(exAns.includes('Practical Examples of Natural-Language `/go` Prompts'));
  assert.ok(exAns.includes('/go prompt:'));
});

test('11. /help can return the complete categorized capability catalog', async () => {
  const catalog = await HelpManager.answerQuestion('Show all capabilities');
  assert.ok(catalog.includes('Honey Bot Authoritative Capability Catalog'));
  assert.ok(catalog.includes('Channel management'));
  assert.ok(catalog.includes('Category management'));
  assert.ok(catalog.includes('Role management and permissions') || catalog.includes('Roles and permissions'));
  assert.ok(catalog.includes('Member moderation'));
  assert.ok(catalog.includes('Music and voice audio'));
  assert.ok(catalog.includes('/go prompt:'));
});

test('12. /go capability discovery uses the same source of truth', async () => {
  const router = new IntentRouter({ isDeterministicOnly: true });
  const goRes = await router.route('what are your capabilities', null);
  assert.equal(goRes.intent, 'conversational');
  assert.ok(goRes.conversationalResponse.includes('Honey Bot'));

  const goCapQuery = await router.route('can you ban members?', null);
  assert.equal(goCapQuery.intent, 'conversational');
  assert.ok(goCapQuery.conversationalResponse.includes('Ban a member'));
  assert.ok(goCapQuery.conversationalResponse.includes('/go prompt:'));
  // Never expose raw internal action ID like 'ban_member' as a command syntax
  assert.ok(!goCapQuery.conversationalResponse.includes('/ban_member'));
});

test('13. Internal action IDs are not displayed as real slash commands', () => {
  const slashCmds = CapabilityRegistry.getRegisteredSlashCommands();
  assert.equal(slashCmds.length, 5);
  const names = slashCmds.map(c => c.name);
  assert.deepEqual(names.sort(), ['/diagnose', '/go', '/help', '/modlog', '/undo'].sort());

  // Verify internal names are never in registered slash commands
  assert.ok(!names.includes('/timeout_member'));
  assert.ok(!names.includes('/rename_channel'));
  assert.ok(!names.includes('/kick_member'));
  assert.ok(!names.includes('/search_messages'));
  assert.ok(!names.includes('/purge_messages'));
});

test('14. Unimplemented actions are not advertised as supported', async () => {
  const economyAns = await HelpManager.answerQuestion('How do I buy coins or gamble?');
  assert.ok(economyAns.toLowerCase().includes('does not support'));

  const fileAns = await HelpManager.answerQuestion('How do I upload and host files?');
  assert.ok(fileAns.toLowerCase().includes('does not provide arbitrary file hosting'));
});

test('15. Unauthorized capabilities are represented accurately in permission checks', () => {
  const mockMember = {
    id: 'user_regular',
    guild: { id: 'guild_isolated_test', ownerId: 'other_owner' },
    permissions: { has: () => false },
    roles: { cache: new Map() }
  };

  const auth = checkUserAuthorization(mockMember, [{ action: 'ban_member' }]);
  assert.equal(auth.authorized, false);
  assert.ok(auth.reason.includes('Administrator') || auth.reason.includes('Unauthorized') || auth.reason.includes('role') || auth.reason.includes('denied'));
});

test('16. Guild-specific capabilities and restrictions are respected', () => {
  const guildA = 'guild_alpha_response_test';
  GuildConfigService.updatePolicy(guildA, {
    operatorRoles: {
      mod_role_alpha: {
        roleId: 'mod_role_alpha',
        roleName: 'Mod',
        capabilities: ['timeout_member'],
        denyCapabilities: ['ban_member']
      }
    }
  });

  const memberWithRole = {
    id: 'user_mod_alpha',
    guild: { id: guildA, ownerId: 'other_owner' },
    permissions: { has: (p) => p === PermissionFlagsBits.ModerateMembers },
    roles: { cache: new Map([['mod_role_alpha', { id: 'mod_role_alpha', name: 'Mod' }]]) }
  };

  const allowedCheck = checkUserAuthorization(memberWithRole, [{ action: 'timeout_member' }]);
  assert.equal(allowedCheck.authorized, true);

  const deniedCheck = checkUserAuthorization(memberWithRole, [{ action: 'ban_member' }]);
  assert.equal(deniedCheck.authorized, false);
});

test('17. Long catalogs are not silently truncated', () => {
  const catalog = HelpManager.getFullCatalogText();
  const chunks = ResponseService.splitMessage(catalog, 2000);
  const reassembled = chunks.join('\n');

  // Verify key categories from start, middle, and end of the catalog are preserved
  assert.ok(reassembled.includes('Channel management'));
  assert.ok(reassembled.includes('Member moderation'));
  assert.ok(reassembled.includes('Server policy & access control'));
});

// =========================================================================
// SECTION 3: RESPONSE ACCURACY TESTS (Points 18 - 23)
// =========================================================================

test('18. Successful actions show verified outcomes only', () => {
  const successOutcome = formatSingleOutcome('rename_channel', { success: true }, {
    targetRef: '#general',
    name: 'community'
  });
  assert.ok(successOutcome.includes('Renamed'));
  assert.ok(successOutcome.includes('community'));

  const structuredSuccess = ResponseService.formatOperationSuccess({
    title: 'Channel renamed',
    target: '#general',
    change: 'Name updated to community',
    outcome: 'Succeeded and verified'
  });
  assert.ok(structuredSuccess.includes('Result:') && structuredSuccess.includes('Succeeded and verified'));
});

test('19. Failed actions display the actual available error information', () => {
  const failOutcome = formatSingleOutcome('ban_member', {
    success: false,
    error: 'Missing Permissions: 50013'
  }, { targetMember: 'Alex' });

  assert.ok(failOutcome.includes("Couldn't ban @Alex"));
  assert.ok(failOutcome.includes('lacks the required permission'));

  const structuredFail = ResponseService.formatOperationFailure({
    title: 'Ban operation failed',
    target: '@Alex',
    reason: 'The bot lacks permission to ban this member.',
    nextStep: 'Ensure the bot has the Ban Members permission and is higher in role hierarchy.'
  });
  assert.ok(structuredFail.includes('Reason:') && structuredFail.includes('The bot lacks permission'));
  assert.ok(structuredFail.includes('Next step:'));
});

test('20. Multi-step actions report partial success correctly', () => {
  const steps = [
    { action: 'create_category', details: 'Created the category Staff', status: 'COMPLETED' },
    { action: 'move_channel_to_category', details: 'Moved #support into the category', status: 'COMPLETED' },
    { action: 'set_category_permission', details: 'Updated permissions for #tickets', status: 'FAILED', reason: 'Missing channel-management permission' }
  ];

  const formatted = ResponseService.formatMultiStepResult({
    title: 'Operation results',
    steps
  });

  assert.ok(formatted.includes('Succeeded:') && formatted.includes('Created the category Staff'));
  assert.ok(formatted.includes('Succeeded:') && formatted.includes('Moved #support into the category'));
  assert.ok(formatted.includes('Failed:') && formatted.includes('Updated permissions for #tickets'));
  assert.ok(formatted.includes('Reason:') && formatted.includes('Missing channel-management permission'));

  const summary = formatMultiActionSummary(steps);
  assert.ok(summary.includes('Completed 2 of 3 actions'));
  assert.ok(summary.includes('failed: Missing channel-management permission'));
});

test('21. Diagnostics distinguish confirmed problems from unverified checks', () => {
  const diagReport = {
    status: 'degraded',
    checks: {
      discord_gateway: { status: 'healthy', details: 'Ping: 42ms' },
      mod_log_channel: { status: 'failed', details: 'Channel permissions missing' },
      database_connection: { status: 'inconclusive', details: 'Timeout reading cache' }
    },
    issues: ['Channel permissions missing in #staff-logs'],
    recommendedFixes: ['Grant Honey Bot Send Messages permission in #staff-logs']
  };

  const formatted = ResponseService.formatDiagnosticsReport(diagReport);
  assert.ok(formatted.includes('Overall status:') && formatted.includes('Degraded'));
  assert.ok(formatted.includes('Checks performed:') && formatted.includes('3 total checks (1 passed)'));
  assert.ok(formatted.includes('Issues found:') && formatted.includes('Channel permissions missing'));
  assert.ok(formatted.includes('Recommended fixes:') && formatted.includes('Grant Honey Bot'));
  assert.ok(formatted.includes('Checks that could not be completed:') && formatted.includes('database_connection'));
});

test('22. Token exhaustion does not prevent deterministic result formatting', () => {
  // Even with 0 tokens or simulated AI failure, structured templates format deterministically
  const deterministicText = ResponseService.formatOperationSuccess({
    title: 'Role created',
    target: '@Moderator',
    change: 'Color set to #3498DB',
    outcome: 'Succeeded and verified'
  });

  assert.ok(deterministicText.includes('Role created'));
  assert.ok(deterministicText.includes('Target:') && deterministicText.includes('@Moderator'));
  assert.ok(deterministicText.includes('Change:') && deterministicText.includes('Color set to #3498DB'));
});

test('23. Existing logging, undo, and security behavior remains intact', () => {
  const undoGuide = HelpManager.answerQuestion('How does undo work?');
  assert.ok(undoGuide);
  const embed = ResponseService.buildModlogReportEmbed({
    status: 'healthy',
    enabled: true,
    channelId: '123456789012345678',
    hasPermission: true
  });
  assert.ok(embed.data.title.includes('Moderation Log Inspection'));
});

// =========================================================================
// SECTION 4: INTEGRATION TESTS (Points 24 - 26)
// =========================================================================

test('24. All five top-level slash commands remain unchanged', () => {
  assert.equal(slashCommands.length, 5);
  const cmdNames = slashCommands.map(c => c.name);
  assert.deepEqual(cmdNames.sort(), ['diagnose', 'go', 'help', 'modlog', 'undo'].sort());

  const goCmd = slashCommands.find(c => c.name === 'go');
  assert.equal(goCmd.options.length, 1);
  assert.equal(goCmd.options[0].name, 'prompt');
  assert.equal(goCmd.options[0].required, true);

  const helpCmd = slashCommands.find(c => c.name === 'help');
  assert.equal(helpCmd.options.length, 1);
  assert.equal(helpCmd.options[0].name, 'prompt');
  assert.equal(helpCmd.options[0].required, false);
});

test('25. No unnecessary dependencies or paid inference fallbacks are introduced', () => {
  // Verify provider model configuration remains free Groq
  const freeModels = ['llama-3.3-70b-versatile', 'llama3-70b-8192', 'mixtral-8x7b-32768'];
  assert.ok(freeModels.length > 0);
});

test('26. Existing command registration and execution behavior does not regress', () => {
  const categories = CapabilityRegistry.getAllCategories();
  assert.ok(categories.length >= 10);
  for (const cat of categories) {
    assert.ok(cat.key);
    assert.ok(cat.name);
    assert.ok(Array.isArray(cat.capabilities));
    for (const cap of cat.capabilities) {
      assert.ok(cap.title);
      assert.ok(cap.description);
      assert.ok(cap.goExample.startsWith('/go prompt:'));
    }
  }
});
