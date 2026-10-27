import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger } from './logger.js';

const logger = new Logger('InstanceLock');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const PID_FILE = path.resolve(DATA_DIR, 'bot.pid');

/**
 * Single-Instance Process Lock Engine.
 * 
 * Prevents multiple Honey Bot instances from running concurrently with the same
 * bot token, which causes interaction routing race conditions and ghost-online states.
 * Safely cleans up stale PID files when previous processes terminated abruptly.
 */
export class InstanceLock {
  static getPidFilePath() {
    return PID_FILE;
  }

  /**
   * Tests if a process with the given PID is currently alive.
   */
  static isProcessAlive(pid) {
    if (!pid || typeof pid !== 'number' || pid <= 0) return false;
    try {
      // Signal 0 tests for existence without actually sending a signal
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means process exists but we don't have permission to kill it -> Still alive!
      if (err.code === 'EPERM') return true;
      // ESRCH means process does not exist -> Dead / stale!
      return false;
    }
  }

  /**
   * Attempts to acquire the single-instance lock for the current process.
   * 
   * @param {object} options
   * @param {boolean} options.force If true, overwrites any existing lock.
   * @returns {{ acquired: boolean, pid: number, previousPid?: number, wasStale?: boolean, reason?: string }}
   */
  static acquire(options = {}) {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      const currentPid = process.pid;

      if (fs.existsSync(PID_FILE)) {
        let storedPid = null;
        try {
          const content = fs.readFileSync(PID_FILE, 'utf8').trim();
          storedPid = parseInt(content, 10);
        } catch {
          storedPid = null;
        }

        if (storedPid && storedPid === currentPid) {
          // Already acquired by this exact process
          return { acquired: true, pid: currentPid, wasStale: false };
        }

        if (storedPid && this.isProcessAlive(storedPid)) {
          if (!options.force) {
            logger.error(`Another Honey Bot process is already running (PID: ${storedPid}). Aborting duplicate startup.`);
            return {
              acquired: false,
              pid: currentPid,
              existingPid: storedPid,
              reason: 'ANOTHER_INSTANCE_RUNNING'
            };
          }
          logger.warn(`Force flag supplied. Overriding active instance lock from PID ${storedPid}`);
        } else {
          logger.info(`Stale instance lock detected from terminated process (PID: ${storedPid || 'unknown'}). Reclaiming lock.`);
        }
      }

      // Write current process PID atomically
      fs.writeFileSync(PID_FILE, String(currentPid), 'utf8');
      logger.info(`Acquired single-instance lock (PID: ${currentPid})`);

      return {
        acquired: true,
        pid: currentPid,
        wasStale: fs.existsSync(PID_FILE)
      };
    } catch (err) {
      logger.error('Failed to manage instance lock file', { error: err.message });
      return {
        acquired: false,
        pid: process.pid,
        reason: `IO_ERROR: ${err.message}`
      };
    }
  }

  /**
   * Releases the single-instance lock file if owned by the current process.
   */
  static release() {
    try {
      if (!fs.existsSync(PID_FILE)) return true;

      const content = fs.readFileSync(PID_FILE, 'utf8').trim();
      const storedPid = parseInt(content, 10);

      // Only delete if this process owns the lock
      if (storedPid === process.pid) {
        fs.unlinkSync(PID_FILE);
        logger.info(`Released single-instance lock (PID: ${process.pid})`);
        return true;
      }
      return false;
    } catch (err) {
      logger.warn('Failed to release instance lock file', { error: err.message });
      return false;
    }
  }

  /**
   * Gets current lock status.
   */
  static getStatus() {
    if (!fs.existsSync(PID_FILE)) {
      return { locked: false, activePid: null, isCurrentProcess: false };
    }

    try {
      const storedPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      const isAlive = this.isProcessAlive(storedPid);
      return {
        locked: isAlive,
        activePid: storedPid,
        isCurrentProcess: storedPid === process.pid,
        isStale: !isAlive
      };
    } catch {
      return { locked: false, activePid: null, isCurrentProcess: false };
    }
  }
}

