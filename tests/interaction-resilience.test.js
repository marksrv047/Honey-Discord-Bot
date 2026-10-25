import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCommandInteraction, slashCommands } from '../src/commands.js';

test('Interaction Resilience: DM invocation is rejected with clear server-only message', async () => {
  let repliedMessage = null;
  let isEphemeral = false;

  const mockDmInteraction = {
    isChatInputCommand: () => true,
    guild: null,
    commandName: 'go',
    reply: async ({ content, ephemeral }) => {
      repliedMessage = content;
      isEphemeral = ephemeral;
    }
  };

  await handleCommandInteraction(mockDmInteraction);
  assert.ok(repliedMessage.includes('must be run inside a Discord server'));
  assert.equal(isEphemeral, true);
});

test('Interaction Resilience: Unknown slash commands receive immediate ephemeral response instead of timing out', async () => {
  let repliedContent = null;
  let isEphemeral = false;

  const mockUnknownInteraction = {
    isChatInputCommand: () => true,
    guild: { id: 'guild_test_resilience', name: 'Test Server' },
    commandName: 'unsupported_command',
    replied: false,
    deferred: false,
    reply: async ({ content, ephemeral }) => {
      repliedContent = content;
      isEphemeral = ephemeral;
    }
  };

  await handleCommandInteraction(mockUnknownInteraction);
  assert.ok(repliedContent.includes('Unknown command `/unsupported_command`'));
  assert.equal(isEphemeral, true);
});

test('Interaction Resilience: /go with empty prompt is safely handled without stranding interaction', async () => {
  let editContent = null;
  let deferred = false;

  const mockEmptyPromptInteraction = {
    isChatInputCommand: () => true,
    guild: { id: 'guild_test_resilience', name: 'Test Server' },
    commandName: 'go',
    options: {
      getString: () => '   '
    },
    replied: false,
    deferred: false,
    deferReply: async () => {
      deferred = true;
    },
    editReply: async ({ content }) => {
      editContent = content;
    }
  };

  await handleCommandInteraction(mockEmptyPromptInteraction);
  assert.equal(deferred, true);
  assert.ok(editContent.includes('Please provide an instruction for `/go`'));
});

test('Interaction Resilience: Uncaught error in command handler is caught and editReply delivers safe error', async () => {
  let editContent = null;
  let deferred = false;

  const mockCrashingInteraction = {
    isChatInputCommand: () => true,
    guild: { id: 'guild_test_resilience', name: 'Test Server' },
    commandName: 'diagnose',
    options: {
      getString: () => { throw new Error('Simulated gateway fault'); }
    },
    replied: false,
    deferred: false,
    async deferReply() {
      deferred = true;
      this.deferred = true;
    },
    async editReply({ content }) {
      editContent = content;
    },
    async reply() {}
  };

  await handleCommandInteraction(mockCrashingInteraction);
  assert.equal(deferred, true);
  assert.ok(editContent.includes('Simulated gateway fault'));
});
