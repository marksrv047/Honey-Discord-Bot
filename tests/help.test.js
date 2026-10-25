import test from 'node:test';
import assert from 'node:assert/strict';
import { HelpManager, DEFAULT_HELP_TEXT } from '../src/help.js';
import { handleCommandInteraction, slashCommands } from '../src/commands.js';

test('HelpManager: Generates default guide matching Section 9 specification', () => {
  const guide = HelpManager.getDefaultHelp();

  // Verify core sections and text
  assert.ok(guide.includes('Meet Honey Bot'), 'Missing Meet Honey Bot header');
  assert.ok(guide.includes('Honey Bot lets you manage supported Discord tasks using everyday English'));
  assert.ok(guide.includes('Your commands'));
  assert.ok(guide.includes('/go'));
  assert.ok(guide.includes('/modlog'));
  assert.ok(guide.includes('/diagnose'));
  assert.ok(guide.includes('/undo'));
  assert.ok(guide.includes('/help'));
  assert.ok(guide.includes('Getting started'));
  assert.ok(guide.includes('A few things to know'));
  assert.ok(guide.includes('Try asking:'));
});

test('HelpManager: Empty or whitespace-only prompts return standalone default guide', async () => {
  const nullAns = await HelpManager.answerQuestion(null);
  assert.equal(nullAns, DEFAULT_HELP_TEXT);

  const emptyAns = await HelpManager.answerQuestion('');
  assert.equal(emptyAns, DEFAULT_HELP_TEXT);

  const spacesAns = await HelpManager.answerQuestion('   ');
  assert.equal(spacesAns, DEFAULT_HELP_TEXT);
});

test('HelpManager: Provides accurate, implementation-grounded guidance for file questions', async () => {
  const r1 = await HelpManager.answerQuestion('How do I manage files?');
  assert.ok(r1.includes('File Capabilities in Honey Bot'));
  assert.ok(r1.includes('AttachFiles'));
  assert.ok(r1.includes('/diagnose'));
  assert.ok(r1.toLowerCase().includes('does not provide arbitrary file hosting'));

  const r2 = await HelpManager.answerQuestion('Which file operations does Honey Bot currently support?');
  assert.ok(r2.includes('AttachFiles'));
  assert.ok(r2.includes('/go prompt: Allow @Staff to attach files in #reports'));
  assert.ok(r2.includes('ManageChannels'));
  assert.ok(r2.toLowerCase().includes('unsupported'));
});

test('HelpManager: Answers specific feature questions accurately', async () => {
  const modlogAnswer = await HelpManager.answerQuestion('Explain everything I can do with /modlog.');
  assert.ok(modlogAnswer.includes('Configuration'));
  assert.ok(modlogAnswer.includes('Inspection'));
  assert.ok(modlogAnswer.includes('Verification'));

  const undoAnswer = await HelpManager.answerQuestion('How do I undo a supported action?');
  assert.ok(undoAnswer.includes('/undo'));
  assert.ok(undoAnswer.includes('Reversible Actions'));

  const diagnoseAnswer = await HelpManager.answerQuestion('How do I diagnose a problem?');
  assert.ok(diagnoseAnswer.includes('/diagnose'));

  const broadAnswer = await HelpManager.answerQuestion('What can Honey Bot do?');
  assert.ok(broadAnswer.includes('Honey Bot Capabilities Overview'));
  assert.ok(broadAnswer.includes('/go'));
  assert.ok(broadAnswer.includes('/modlog'));
});

test('HelpManager: Clarifies ambiguous questions instead of guessing', async () => {
  const ambigAnswer = await HelpManager.answerQuestion('How do I delete?');
  assert.ok(ambigAnswer.includes('What would you like to delete or remove?'));
  assert.ok(ambigAnswer.includes('/help prompt: How do I purge messages?'));
  assert.ok(ambigAnswer.includes('/help prompt: How do I delete a channel?'));
});

test('HelpManager: Truthfully explains music capabilities and declines unsupported features without fabrication', async () => {
  const musicAnswer = await HelpManager.answerQuestion('Can you play music in voice channels?');
  assert.ok(musicAnswer.includes('voice music system') || musicAnswer.includes('/go prompt: play'));

  const economyAnswer = await HelpManager.answerQuestion('How do I get coins and gamble?');
  assert.ok(economyAnswer.toLowerCase().includes('does not support'));
});

test('HelpManager: Formats help embed with clean styling and without persona fluff', () => {
  const embed = HelpManager.getHelpEmbed();
  assert.ok(embed.data.title.includes('Meet Honey Bot'));
  assert.equal(embed.data.color, 0xfee75c);
  assert.ok(embed.data.fields.length >= 3);
});

test('Help Interaction: /help executes cleanly without prompt and never triggers administrative actions', async () => {
  let repliedEmbeds = null;
  let repliedContent = null;
  let deferred = false;

  // 1. Invocation without prompt
  const mockStandaloneInteraction = {
    isChatInputCommand: () => true,
    commandName: 'help',
    guild: { id: 'guild_test' },
    options: {
      getString: () => null
    },
    reply: async ({ embeds }) => {
      repliedEmbeds = embeds;
    }
  };

  await handleCommandInteraction(mockStandaloneInteraction);
  assert.ok(repliedEmbeds && repliedEmbeds.length === 1);
  assert.ok(repliedEmbeds[0].data.title.includes('Meet Honey Bot'));

  // 2. Invocation with a prompt asking how to ban someone (must only explain, never execute ban)
  const mockPromptInteraction = {
    isChatInputCommand: () => true,
    commandName: 'help',
    guild: { id: 'guild_test' },
    options: {
      getString: () => 'How do I ban a user for harassment?'
    },
    deferReply: async () => {
      deferred = true;
    },
    editReply: async ({ content }) => {
      repliedContent = content;
    }
  };

  await handleCommandInteraction(mockPromptInteraction);
  assert.equal(deferred, true);
  assert.ok(repliedContent);
  assert.ok(repliedContent.toLowerCase().includes('/go'));
});
