import test from 'node:test';
import assert from 'node:assert/strict';
import { PostUpdateValidator, ValidationStatus } from '../src/post-update-validator.js';

test('PostUpdateValidator: Executes full validation sequence non-destructively', async () => {
  const validator = new PostUpdateValidator();
  const report = await validator.validateAll();

  assert.ok(report.timestamp);
  assert.ok(typeof report.durationMs === 'number');
  assert.equal(report.overallStatus, 'passed');

  assert.ok(report.summary.total >= 10);
  assert.ok(report.summary.passed >= 8);
  assert.equal(report.summary.failed, 0);

  // Verify all categories are populated
  assert.ok(report.categories.syntaxAndImports.length > 0);
  assert.ok(report.categories.dependencies.length > 0);
  assert.ok(report.categories.environment.length > 0);
  assert.ok(report.categories.commandRegistrations.length > 0);
  assert.ok(report.categories.persistence.length > 0);
  assert.ok(report.categories.audioAndMedia.length > 0);
  assert.ok(report.categories.backgroundServices.length > 0);
});

test('PostUpdateValidator: Confirms syntax across all source files', async () => {
  const validator = new PostUpdateValidator();
  const checks = await validator.checkSyntaxAndImports();

  const syntaxCheck = checks.find(c => c.name.includes('Syntax Verification'));
  assert.ok(syntaxCheck);
  assert.equal(syntaxCheck.status, ValidationStatus.PASSED);
});

test('PostUpdateValidator: Confirms exact 6 registered slash commands', async () => {
  const validator = new PostUpdateValidator();
  const checks = await validator.checkCommandRegistrations();

  const regCheck = checks.find(c => c.name.includes('Slash Command Registry'));
  assert.ok(regCheck);
  assert.equal(regCheck.status, ValidationStatus.PASSED);
  assert.ok(regCheck.message.includes('honeypot'));
});

test('PostUpdateValidator: Confirms data directory JSON databases parse cleanly', async () => {
  const validator = new PostUpdateValidator();
  const checks = await validator.checkPersistence();

  const persistCheck = checks.find(c => c.name.includes('Data Store Integrity'));
  assert.ok(persistCheck);
  assert.equal(persistCheck.status, ValidationStatus.PASSED);
});

