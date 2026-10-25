import test from 'node:test';
import assert from 'node:assert/strict';
import { slashCommands } from '../src/commands.js';

test('Five-Command Architecture: Honey Bot exposes exactly five top-level slash commands', () => {
  const registeredNames = slashCommands.map(cmd => cmd.name).sort();
  const expectedNames = ['diagnose', 'go', 'help', 'modlog', 'undo'];

  assert.deepEqual(
    registeredNames,
    expectedNames,
    `Registered commands [${registeredNames.join(', ')}] must exactly match [${expectedNames.join(', ')}]`
  );
  assert.equal(slashCommands.length, 5, 'Must expose exactly five slash commands, no more and no less.');
});

test('Five-Command Architecture: /go requires a single free-form string prompt option', () => {
  const goCmd = slashCommands.find(c => c.name === 'go');
  assert.ok(goCmd);

  const json = goCmd.toJSON();
  assert.ok(json.options && json.options.length === 1);
  assert.equal(json.options[0].name, 'prompt');
  assert.equal(json.options[0].required, true);
});

test('Five-Command Architecture: /modlog requires a single free-form string prompt option', () => {
  const modlogCmd = slashCommands.find(c => c.name === 'modlog');
  assert.ok(modlogCmd);

  const json = modlogCmd.toJSON();
  assert.ok(json.options && json.options.length === 1);
  assert.equal(json.options[0].name, 'prompt');
  assert.equal(json.options[0].required, true);
});

test('Five-Command Architecture: /diagnose, /undo, and /help have optional prompt options', () => {
  const diagnoseCmd = slashCommands.find(c => c.name === 'diagnose');
  const undoCmd = slashCommands.find(c => c.name === 'undo');
  const helpCmd = slashCommands.find(c => c.name === 'help');

  assert.ok(diagnoseCmd);
  assert.ok(undoCmd);
  assert.ok(helpCmd);

  const diagnoseJson = diagnoseCmd.toJSON();
  assert.equal(diagnoseJson.options[0].name, 'prompt');
  assert.equal(diagnoseJson.options[0].required, false);

  const undoJson = undoCmd.toJSON();
  assert.equal(undoJson.options[0].name, 'prompt');
  assert.equal(undoJson.options[0].required, false);

  const helpJson = helpCmd.toJSON();
  assert.equal(helpJson.options[0].name, 'prompt');
  assert.equal(helpJson.options[0].required, false);
});
