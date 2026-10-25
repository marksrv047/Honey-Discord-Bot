import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Logger } from './logger.js';

const logger = new Logger('SelfRepair');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * Protected modules that self-repair is strictly prohibited from modifying.
 * This guarantees the self-repair engine cannot weaken security or bypass anti-nuke rules.
 */
export const PROTECTED_SECURITY_FILES = [
  'src/security-gate.js',
  'src/permissions.js',
  'src/capabilities.js'
];

/**
 * Deterministic Self-Repair and Patch Engine.
 * Follows the workflow:
 * INSPECT -> DIAGNOSE -> PRIORITIZE -> PROPOSE -> PATCH -> TEST -> REVIEW -> APPLY OR ROLLBACK -> REPORT
 */
export class SelfRepairEngine {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || PROJECT_ROOT;
    this.backupDir = path.join(this.projectRoot, '.repair_backups');
  }

  /**
   * Ensures the backup directory exists.
   */
  _ensureBackupDir() {
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }

  /**
   * Inspects and proposes repairs based on health check findings.
   */
  proposeRepairs(healthReport) {
    const proposals = [];

    for (const finding of healthReport.findings) {
      // 1. Git conflict markers repair proposal
      if (finding.name.includes('Git Conflict Check')) {
        const fileMatch = finding.message.match(/File\s+([^\s]+)\s+contains/);
        if (fileMatch) {
          proposals.push({
            id: `repair_conflict_${Date.now()}`,
            type: 'RESOLVE_CONFLICT_MARKERS',
            targetFile: fileMatch[1],
            severity: finding.severity,
            description: `Remove unresolved merge conflict markers from ${fileMatch[1]}.`,
            reversible: true,
            requiresApproval: false
          });
        }
      }

      // 2. Lockfile regeneration proposal
      if (finding.name.includes('Lockfile Presence') && finding.status === 'failed') {
        proposals.push({
          id: `repair_lockfile_${Date.now()}`,
          type: 'REGENERATE_LOCKFILE',
          targetFile: 'package-lock.json',
          severity: finding.severity,
          description: 'Regenerate package-lock.json using npm package manager.',
          reversible: true,
          requiresApproval: false
        });
      }

      // 3. Trailing whitespace or formatting repair proposal
      if (finding.name.includes('Empty File Check')) {
        proposals.push({
          id: `repair_empty_${Date.now()}`,
          type: 'REMOVE_EMPTY_FILE',
          targetFile: finding.message.match(/Source file\s+([^\s]+)\s+is empty/)?.[1] || 'unknown',
          severity: finding.severity,
          description: 'Remove redundant empty source file.',
          reversible: true,
          requiresApproval: true
        });
      }
    }

    return proposals;
  }

  /**
   * Validates whether a file can be safely modified.
   * Rejects any attempt to patch protected security modules or weaken safeguards.
   */
  validatePatchSafety(relFilePath, patchContent) {
    const normalized = relFilePath.replace(/\\/g, '/');

    // 1. Strictly forbid modification of protected security modules
    for (const protectedFile of PROTECTED_SECURITY_FILES) {
      if (normalized.endsWith(protectedFile)) {
        return {
          safe: false,
          reason: `Security refusal: Modification of protected security module "${protectedFile}" is prohibited.`
        };
      }
    }

    // 2. Forbid any patch attempting to disable anti-nuke or permission checks
    if (patchContent) {
      if (/disable.*(anti-?nuke|security|safety)/i.test(patchContent) ||
          /bypass.*(permission|authorization)/i.test(patchContent) ||
          /return\s+true;?\s*\/\/\s*bypass/i.test(patchContent)) {
        return {
          safe: false,
          reason: 'Security refusal: Patch content contains patterns attempting to disable or bypass security safeguards.'
        };
      }
    }

    return { safe: true };
  }

  /**
   * Applies a safe patch with automated backup and test verification.
   * If tests fail after applying, rolls back immediately.
   */
  applySafePatch(relFilePath, newContent) {
    const fullPath = path.resolve(this.projectRoot, relFilePath);
    const safety = this.validatePatchSafety(relFilePath, newContent);

    if (!safety.safe) {
      logger.warn('Patch rejected by self-repair safety gate', { file: relFilePath, reason: safety.reason });
      return {
        applied: false,
        rolledBack: false,
        reason: safety.reason
      };
    }

    if (!fs.existsSync(fullPath)) {
      return {
        applied: false,
        rolledBack: false,
        reason: `Target file "${relFilePath}" does not exist.`
      };
    }

    // 1. Create timestamped backup
    this._ensureBackupDir();
    const originalContent = fs.readFileSync(fullPath, 'utf8');
    const backupFileName = `${path.basename(relFilePath)}.${Date.now()}.bak`;
    const backupPath = path.join(this.backupDir, backupFileName);
    fs.writeFileSync(backupPath, originalContent, 'utf8');

    logger.info(`Applying safe repair to ${relFilePath}`, { backup: backupFileName });

    // 2. Write new content
    try {
      fs.writeFileSync(fullPath, newContent, 'utf8');
    } catch (writeErr) {
      return {
        applied: false,
        rolledBack: false,
        reason: `Failed to write file: ${writeErr.message}`
      };
    }

    // 3. Run regression tests
    let testsPassed = false;
    try {
      execSync('npm test', {
        cwd: this.projectRoot,
        stdio: 'pipe',
        timeout: 15000
      });
      testsPassed = true;
    } catch (testErr) {
      testsPassed = false;
      logger.error('Regression tests failed after applying patch. Rolling back.', { error: testErr.message });
    }

    // 4. Rollback if tests failed
    if (!testsPassed) {
      fs.writeFileSync(fullPath, originalContent, 'utf8');
      return {
        applied: false,
        rolledBack: true,
        reason: 'Automated regression test suite failed after applying patch. Safely restored original file.'
      };
    }

    return {
      applied: true,
      rolledBack: false,
      backupPath,
      message: `Patch applied and verified successfully against test suite.`
    };
  }

  /**
   * Cleans up backups older than maxAgeMs.
   */
  cleanupBackups(maxAgeMs = 24 * 60 * 60 * 1000) {
    if (!fs.existsSync(this.backupDir)) return 0;
    let count = 0;
    const now = Date.now();
    const files = fs.readdirSync(this.backupDir);
    for (const file of files) {
      const full = path.join(this.backupDir, file);
      try {
        const stats = fs.statSync(full);
        if (now - stats.mtimeMs > maxAgeMs) {
          fs.unlinkSync(full);
          count++;
        }
      } catch {}
    }
    return count;
  }
}
