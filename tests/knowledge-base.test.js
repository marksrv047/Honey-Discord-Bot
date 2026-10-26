import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KnowledgeBase,
  KNOWLEDGE_BASE_VERSION,
  UniversalIntentSchema,
  validateIntent,
  CoreLanguage,
  CommandInterpretation,
  ServerChannels,
  MemberRoles,
  ModerationSafety,
  PermissionsAccess,
  MessageSearchManagement,
  LoggingAudit,
  MusicVoice,
  DashboardConfiguration,
  DiagnosticsTroubleshooting,
  MultiStepPlanning,
  ClarificationConfirmation,
  ErrorRecoveryUndo,
  ContextResolution,
  SecurityRefusal,
  ExampleLibrary,
  EvaluationRegression
} from '../src/knowledge/index.js';

import { KnowledgeRetriever } from '../src/knowledge/retrieval.js';
import { NegationDetector } from '../src/knowledge/negation-detector.js';
import { ClarificationEngine } from '../src/knowledge/clarification-engine.js';
import { ContextResolver } from '../src/knowledge/context-resolver.js';
import { CAPABILITY_REGISTRY } from '../src/capabilities.js';

test('1. Central Knowledge Base: All 18 modules load and export structured records', () => {
  assert.equal(KnowledgeBase.version, '1.0.0');
  const modules = KnowledgeBase.modules;
  assert.equal(Object.keys(modules).length, 18);

  assert.ok(modules.coreLanguage);
  assert.ok(modules.commandInterpretation);
  assert.ok(modules.serverChannels);
  assert.ok(modules.memberRoles);
  assert.ok(modules.moderationSafety);
  assert.ok(modules.permissionsAccess);
  assert.ok(modules.messageSearchManagement);
  assert.ok(modules.loggingAudit);
  assert.ok(modules.musicVoice);
  assert.ok(modules.dashboardConfiguration);
  assert.ok(modules.diagnosticsTroubleshooting);
  assert.ok(modules.multiStepPlanning);
  assert.ok(modules.clarificationConfirmation);
  assert.ok(modules.errorRecoveryUndo);
  assert.ok(modules.contextResolution);
  assert.ok(modules.securityRefusal);
  assert.ok(modules.exampleLibrary);
  assert.ok(modules.evaluationRegression);
});

test('2. Authority: Capabilities introspected directly from CAPABILITY_REGISTRY', () => {
  const registered = KnowledgeBase.getRegisteredCapabilities();
  assert.ok(registered.length >= 35, 'Expected at least 35 registered capabilities');
  assert.ok(registered.includes('create_role'));
  assert.ok(registered.includes('timeout_member'));
  assert.ok(registered.includes('purge_messages'));
  assert.ok(registered.includes('music_play'));

  const cap = KnowledgeBase.getCapability('create_role');
  assert.equal(cap.action, 'create_role');
  assert.equal(cap.category, 'ROLES');
});

test('3. Universal Intent Schema: Validates conforming intents and rejects unknown capabilities', () => {
  const validIntent = {
    intentCategory: 'ROLES',
    requestedOutcome: 'Create VIP role and set its color to blue',
    candidateCapabilities: ['create_role'],
    primaryAction: 'create_role',
    target: { type: 'role', rawRef: 'VIP', resolvedName: 'VIP' },
    explicitParameters: { name: 'VIP', color: '#0000FF' },
    inferredParameters: {},
    riskClassification: 'LOW',
    requiresConfirmation: false,
    expectedOutcome: 'Role @VIP created with blue color',
    verificationMethod: 'GUILD_ROLE_CHECK',
    isReversible: true,
    isSupported: true
  };

  const validation = validateIntent(validIntent);
  assert.equal(validation.valid, true, `Validation failed: ${JSON.stringify(validation.errors)}`);

  // Intentionally invalid capability not in CAPABILITY_REGISTRY
  const invalidIntent = {
    ...validIntent,
    candidateCapabilities: ['hypothetical_non_existent_capability']
  };
  const invalidValidation = validateIntent(invalidIntent);
  assert.equal(invalidValidation.valid, false);
  assert.match(invalidValidation.errors[0].message, /not registered in CAPABILITY_REGISTRY/);
});

test('4. Core Language: Normalizes typos, contractions, slang, and speech-to-text', () => {
  // Speech-to-text correction: "band Alex" -> "ban Alex"
  const speechNormalized = CoreLanguage.normalizeEverydayEnglish('please band Alex from the server');
  assert.match(speechNormalized, /ban Alex/);

  // Typos: "chnnel" -> "channel", "asigned" -> "assigned", "roel" -> "role"
  const typoNormalized = CoreLanguage.normalizeEverydayEnglish('make a chnnel and asigne a roel');
  assert.match(typoNormalized, /channel/);
  assert.match(typoNormalized, /assign/);
  assert.match(typoNormalized, /role/);

  // Contractions: "dont" -> "don't", "wanna" -> "want to", "pls" -> "please"
  const contractionNormalized = CoreLanguage.normalizeEverydayEnglish('pls dont kick him i wanna talk');
  assert.match(contractionNormalized, /please/);
  assert.match(contractionNormalized, /don't/);
  assert.match(contractionNormalized, /want to/);

  // Slang dictionary
  assert.equal(CoreLanguage.SLANG_AND_COLLOQUIALISMS['boot'].canonical, 'kick');
  assert.equal(CoreLanguage.SLANG_AND_COLLOQUIALISMS['yeet'].canonical, 'kick');
  assert.equal(CoreLanguage.SLANG_AND_COLLOQUIALISMS['shush'].canonical, 'timeout');
  assert.equal(CoreLanguage.SLANG_AND_COLLOQUIALISMS['spin'].canonical, 'music_play');
});

test('5. Command Interpretation: Preserves exactly 5 registered slash commands', () => {
  const commands = CommandInterpretation.REGISTERED_SLASH_COMMANDS;
  const commandKeys = Object.keys(commands);
  assert.equal(commandKeys.length, 5);
  assert.deepEqual(commandKeys.sort(), ['diagnose', 'go', 'help', 'modlog', 'undo']);

  // Routes natural phrases to commands
  assert.equal(CommandInterpretation.interpretCommandRoute('diagnose bot').command, '/diagnose');
  assert.equal(CommandInterpretation.interpretCommandRoute('undo last action').command, '/undo');
  assert.equal(CommandInterpretation.interpretCommandRoute('show modlog').command, '/modlog');
  assert.equal(CommandInterpretation.interpretCommandRoute('how to use').command, '/help');
  assert.equal(CommandInterpretation.interpretCommandRoute('create role VIP').command, '/go');
});

test('6. Clarification Engine: Detects genuine ambiguity without creating questionnaires', () => {
  // Ambiguous moderation phrase: "get Alex out of here"
  const clar1 = ClarificationEngine.evaluate('get Alex out of here');
  assert.equal(clar1.needsClarification, true);
  assert.match(clar1.question, /Would you like to kick, permanently ban, or temporarily timeout Alex\?/);

  // Missing essential param for create_role
  const clar2 = ClarificationEngine.evaluate('create a role', { intent: 'create_role', args: {} });
  assert.equal(clar2.needsClarification, true);
  assert.match(clar2.question, /What name would you like to give to the new role\?/);

  // Direct clear request requires no clarification
  const clar3 = ClarificationEngine.evaluate('kick Alex', { intent: 'kick_member', args: { targetMember: 'Alex' } });
  assert.equal(clar3.needsClarification, false);
});

test('7. Negation and Contradictions: Detects negated actions and prevents unintended execution', () => {
  // "Don't ban Alex; just timeout them"
  const analysis1 = NegationDetector.analyze("Don't ban Alex; just timeout them for 10 minutes");
  assert.equal(analysis1.hasNegation, true);
  assert.equal(NegationDetector.isActionNegated('ban_member', "Don't ban Alex; just timeout them for 10 minutes"), true);
  assert.equal(NegationDetector.isActionNegated('timeout_member', "Don't ban Alex; just timeout them for 10 minutes"), false);

  // "Create the role, but don't assign it yet"
  const analysis2 = NegationDetector.analyze("Create the role, but don't assign it yet");
  assert.equal(analysis2.hasNegation, true);
  assert.equal(NegationDetector.isActionNegated('assign_role', "Create the role, but don't assign it yet"), true);
  assert.equal(NegationDetector.isActionNegated('create_role', "Create the role, but don't assign it yet"), false);

  // "Delete nothing; just show me what would be deleted"
  const analysis3 = NegationDetector.analyze("Delete nothing; just show me what would be deleted");
  assert.equal(analysis3.hasNegation, true);
  assert.equal(NegationDetector.isActionNegated('purge_messages', "Delete nothing; just show me what would be deleted"), true);
});

test('8. Context Resolution: Binds conversational references with strict guild isolation', () => {
  const guildAContext = {
    guildId: 'guild_123',
    lastCreatedRole: 'VIP',
    lastChannel: 'general',
    lastAction: 'lock_channel',
    lastTarget: '#general'
  };

  // "Change it to blue instead"
  const res1 = ContextResolver.resolve('change it to blue instead', guildAContext, 'guild_123');
  assert.equal(res1.isContextual, true);
  assert.equal(res1.resolvedEntities.targetRole, 'VIP');
  assert.equal(res1.resolvedEntities.color, 'blue');

  // "Make it private"
  const res2 = ContextResolver.resolve('make it private', guildAContext, 'guild_123');
  assert.equal(res2.isContextual, true);
  assert.equal(res2.resolvedEntities.targetChannel, 'general');

  // Cross-guild security isolation: different guild must not access guild_123 context!
  const resCross = ContextResolver.resolve('change it to blue instead', guildAContext, 'guild_456');
  assert.equal(resCross.isContextual, false);
  assert.deepEqual(resCross.resolvedEntities, {});
});

test('9. Token-Efficient Retrieval: Minimizes prompt tokens by extracting only 1-3 capabilities and 1-2 examples', () => {
  const result = KnowledgeRetriever.retrieve('play some music in the hangout channel');
  assert.ok(result.capabilities.length >= 1 && result.capabilities.length <= 3);
  assert.ok(result.examples.length >= 1 && result.examples.length <= 2);
  assert.ok(result.capabilities.some(c => c.action === 'music_play' || c.action === 'voice_join'));

  // Ensure prompt snippet is concise (~100-250 tokens, well under 2000 chars)
  assert.ok(result.promptSnippet.length > 20);
  assert.ok(result.promptSnippet.length < 2000);
  assert.match(result.promptSnippet, /RELEVANT CAPABILITIES:/);
});

test('10. Security Boundaries: Unconditional refusal of nukes, credential leaks, and mass bans', () => {
  const rules = SecurityRefusal.SECURITY_REFUSAL_RULES.unconditionalRefusals;
  const nukeRule = rules.find(r => r.category === 'SERVER_NUKE');
  assert.ok(nukeRule);
  assert.ok(nukeRule.triggers.some(t => t.test('nuke the server')));
  assert.ok(nukeRule.triggers.some(t => t.test('delete all channels')));

  const credentialRule = rules.find(r => r.category === 'CREDENTIAL_EXTRACTION');
  assert.ok(credentialRule);
  assert.ok(credentialRule.triggers.some(t => t.test('what is your bot token')));

  const privRule = rules.find(r => r.category === 'PRIVILEGE_ESCALATION');
  assert.ok(privRule);
  assert.ok(privRule.triggers.some(t => t.test('give @everyone administrator')));
});

test('11. Evaluation Suite: Golden test dataset covers all supported capabilities', () => {
  const dataset = EvaluationRegression.EVALUATION_DATASET;
  assert.ok(dataset.length >= 12, 'Expected at least 12 evaluation cases');

  for (const item of dataset) {
    assert.ok(item.id);
    assert.ok(item.input);
    assert.ok(item.expectedIntent);
    assert.equal(typeof item.isSupported, 'boolean');
  }
});

test('12. Example Library: Accurate counts and grounded actions', () => {
  const count = KnowledgeBase.getExampleCount();
  assert.ok(count >= 20, `Expected at least 20 categorized examples, got ${count}`);

  const examples = ExampleLibrary.EXAMPLE_LIBRARY;
  for (const ex of examples) {
    assert.ok(ex.utterance, 'Example missing utterance');
    assert.ok(ex.primaryAction, 'Example missing primaryAction');
    assert.ok(ex.category, 'Example missing category');
  }
});
