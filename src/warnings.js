import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Logger } from './logger.js';

const logger = new Logger('WarningManager');
const WARNINGS_FILE = path.resolve(process.cwd(), 'data', 'moderation-warnings.json');

/**
 * Lightweight, persistent warning storage and inspection service for Honey Bot.
 */
export class WarningManager {
  static cache = new Map(); // guildId -> Map(userId -> Array<warning>)
  static isLoaded = false;

  static ensureDataDir() {
    const dir = path.dirname(WARNINGS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  static loadWarnings() {
    if (this.isLoaded) return;
    this.ensureDataDir();

    try {
      if (fs.existsSync(WARNINGS_FILE)) {
        const raw = fs.readFileSync(WARNINGS_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        for (const [guildId, users] of Object.entries(parsed)) {
          const userMap = new Map();
          for (const [userId, warnings] of Object.entries(users)) {
            userMap.set(userId, Array.isArray(warnings) ? warnings : []);
          }
          this.cache.set(guildId, userMap);
        }
      }
      this.isLoaded = true;
    } catch (err) {
      logger.error('Failed to load moderation warnings from disk', { error: err.message });
      this.isLoaded = true;
    }
  }

  static saveWarnings() {
    this.ensureDataDir();
    try {
      const serializable = {};
      for (const [guildId, userMap] of this.cache.entries()) {
        serializable[guildId] = {};
        for (const [userId, warnings] of userMap.entries()) {
          serializable[guildId][userId] = warnings;
        }
      }

      const tmpFile = `${WARNINGS_FILE}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpFile, JSON.stringify(serializable, null, 2), 'utf-8');
      fs.renameSync(tmpFile, WARNINGS_FILE);
    } catch (err) {
      logger.error('Failed to save moderation warnings to disk', { error: err.message });
    }
  }

  /**
   * Adds a new warning to a user's record.
   */
  static addWarning(guildId, userId, { reason, moderatorId, moderatorTag }) {
    this.loadWarnings();
    if (!this.cache.has(guildId)) {
      this.cache.set(guildId, new Map());
    }
    const userMap = this.cache.get(guildId);
    if (!userMap.has(userId)) {
      userMap.set(userId, []);
    }

    const warning = {
      id: `warn_${crypto.randomBytes(4).toString('hex')}`,
      reason: String(reason || 'No reason provided').slice(0, 512),
      moderatorId: moderatorId || 'unknown',
      moderatorTag: moderatorTag || 'Administrator',
      timestamp: Date.now()
    };

    userMap.get(userId).push(warning);
    this.saveWarnings();
    return warning;
  }

  /**
   * Retrieves all warnings for a user in a guild.
   */
  static getWarnings(guildId, userId) {
    this.loadWarnings();
    const userMap = this.cache.get(guildId);
    if (!userMap || !userMap.has(userId)) return [];
    return [...userMap.get(userId)];
  }

  /**
   * Clears all warnings for a user in a guild.
   */
  static clearWarnings(guildId, userId) {
    this.loadWarnings();
    const userMap = this.cache.get(guildId);
    if (!userMap || !userMap.has(userId)) {
      return { count: 0, cleared: [] };
    }
    const previous = userMap.get(userId) || [];
    userMap.delete(userId);
    this.saveWarnings();
    return { count: previous.length, cleared: previous };
  }
}
