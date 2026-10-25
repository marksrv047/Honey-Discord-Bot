import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SelfRepairEngine, PROTECTED_SECURITY_FILES } from '../src/self-repair.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

test('SelfRepair: Proposes targeted, reversible repairs based on health findings', () => {
  const repair = new SelfRepairEngine();
  const mockReport = {
    findings: [
      {
        name: 'Git Conflict Check: src/sample.js',
        message: 'File src/sample.js contains merge conflict markers',
        severity: 'critical'
      },
      {
        name: 'Lockfile Presence',
        message: 'package-lock.json is missing',
        severity: 'medium',
        status: 'failed'
      }
    ]
  };

  const proposals = repair.proposeRepairs(mockReport);
  assert.equal(proposals.length, 2);
  assert.equal(proposals[0].type, 'RESOLVE_CONFLICT_MARKERS');
  assert.equal(proposals[0].targetFile, 'src/sample.js');
  assert.equal(proposals[1].type, 'REGENERATE_LOCKFILE');
});

test('SelfRepair: Strictly rejects patches targeting protected security modules', () => {
  const repair = new SelfRepairEngine();

  for (const protectedFile of PROTECTED_SECURITY_FILES) {
    const safety = repair.validatePatchSafety(protectedFile, 'const x = 1;');
    assert.equal(safety.safe, false);
    assert.match(safety.reason, /Security refusal: Modification of protected security module/);
  }
});

test('SelfRepair: Strictly rejects patches that attempt to weaken safeguards or disable anti-nuke', () => {
  const repair = new SelfRepairEngine();

  const hostilePatches = [
    'function bypass() { return disable_antinuke_mode(); }',
    '// bypass permission check\nreturn true;',
    'function hack() { disable security gate; }'
  ];

  for (const patch of hostilePatches) {
    const safety = repair.validatePatchSafety('src/utils.js', patch);
    assert.equal(safety.safe, false);
    assert.match(safety.reason, /Security refusal/);
  }
});

test('SelfRepair: Allows safe patch on non-protected file with valid content', () => {
  const repair = new SelfRepairEngine();
  const safety = repair.validatePatchSafety('src/format-response.js', '// Clean comment');
  assert.equal(safety.safe, true);
});
