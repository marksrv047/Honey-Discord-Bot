import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../src/logger.js';

test('Logger: redactSecrets redacts Discord tokens', () => {
  const text = 'Connected with token: Bot MTA2Mjc1MjU2OTg4MTUzMzIwMg.Gk4abc.example_secret_token_123';
  const redacted = redactSecrets(text);
  assert.equal(redacted.includes('example_secret_token_123'), false);
  assert.match(redacted, /\[REDACTED_DISCORD_TOKEN\]/);
});

test('Logger: redactSecrets redacts Google AI Studio and Groq API keys', () => {
  const geminiText = 'Using AIzaSyD9examplekey1234567890abcdef12 for planning';
  assert.match(redactSecrets(geminiText), /\[REDACTED_GEMINI_KEY\]/);

  const groqText = 'Using gsk_abcdef1234567890abcdef1234567890abcdef123456789012 for planning';
  assert.match(redactSecrets(groqText), /\[REDACTED_GROQ_KEY\]/);
});

test('Logger: redactSecrets redacts sensitive keys in objects recursively', () => {
  const secretObj = {
    apiKey: 'secret_123',
    discordToken: 'token_456',
    nested: {
      password: 'super_secret_pw',
      normalField: 'hello world'
    }
  };

  const clean = redactSecrets(secretObj);
  assert.equal(clean.apiKey, '[REDACTED]');
  assert.equal(clean.discordToken, '[REDACTED]');
  assert.equal(clean.nested.password, '[REDACTED]');
  assert.equal(clean.nested.normalField, 'hello world');
});
