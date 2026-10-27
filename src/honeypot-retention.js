import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger } from './logger.js';

const logger = new Logger('HoneypotRetention');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const RETENTION_FILE = path.join(DATA_DIR, 'honeypot-log-messages.json');

/**
 * HoneypotRetentionService
 * Manages persistence and safe automated cleanup of temporary Honeypot security log messages.
 * - Enforces 24h (default) or 48h retention per-guild.
 * - Safely deletes ONLY Honey Bot's own log messages in the designated #honeypot-logs channel.
 * - NEVER deletes permanent moderation records (#mod-logs) or operational records (#bot-logs).
 * - Resumes cleanup across bot restarts.
 * - Complies with Discord rate limits with bounded batch deletions.
 */
export class HoneypotRetentionService {
  static _records = new Map(); // messageId -> Record
  static _isLoaded = false;
  static _customStoragePath = null;

  static get storagePath() {
    return this._customStoragePath || RETENTION_FILE;
  }

  static set storagePath(p) {
    this._customStoragePath = p;
    this._isLoaded = false;
  }

  static _ensureDataDir() {
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Loads persisted Honeypot log message records from disk.
   */
  static loadRecords() {
    if (this._isLoaded) return this._records;
    this._ensureDataDir();

    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          this._records.clear();
          for (const item of data) {
            if (item && item.messageId) {
              this._records.set(item.messageId, item);
            }
          }
        }
      }
      this._isLoaded = true;
    } catch (err) {
      logger.error('Failed to load honeypot retention records', { error: err.message });
      this._records.clear();
      this._isLoaded = true;
    }
    return this._records;
  }

  /**
   * Persists records atomically to disk.
   */
  static saveRecords() {
    this._ensureDataDir();
    const filePath = this.storagePath;
    const tempPath = `${filePath}.tmp.${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    try {
      const arr = Array.from(this._records.values());
      fs.writeFileSync(tempPath, JSON.stringify(arr, null, 2), 'utf8');
      fs.renameSync(tempPath, filePath);
    } catch (err) {
      logger.error('Failed to persist honeypot retention records', { error: err.message });
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
    }
  }

  /**
   * Records a delivered Honeypot security log message for expiry tracking.
   */
  static recordLogMessage(guildId, channelId, messageId, retentionHours = 24, correlationId = null) {
    if (!guildId || !channelId || !messageId) return null;
    this.loadRecords();

    const hours = Number(retentionHours) === 48 ? 48 : 24;
    const now = Date.now();
    const record = {
      messageId,
      channelId,
      guildId,
      createdAt: now,
      expiresAt: now + (hours * 3600 * 1000),
      retentionHours: hours,
      correlationId: correlationId || `hp_${now}`
    };

    this._records.set(messageId, record);
    this.saveRecords();
    logger.info(`Recorded Honeypot security log message for cleanup in ${hours}h`, {
      messageId,
      guildId,
      expiresAt: new Date(record.expiresAt).toISOString()
    });
    return record;
  }

  /**
   * Cleans up expired Honeypot security log messages across guilds.
   * Only deletes Honey Bot's own messages in the configured honeypotLogChannelId.
   */
  static async cleanupExpired(client, maxBatch = 15) {
    if (!client) return { cleaned: 0, errors: 0 };
    this.loadRecords();

    const now = Date.now();
    const expired = Array.from(this._records.values()).filter(r => r.expiresAt <= now);
    if (expired.length === 0) return { cleaned: 0, errors: 0 };

    logger.info(`Starting Honeypot security log cleanup for ${expired.length} expired records`);
    let cleaned = 0;
    let errors = 0;

    const toProcess = expired.slice(0, maxBatch);

    for (const record of toProcess) {
      try {
        const guild = client.guilds?.cache?.get?.(record.guildId) || await client.guilds?.fetch?.(record.guildId).catch(() => null);
        if (!guild) {
          // Guild no longer accessible; prune record safely
          this._records.delete(record.messageId);
          cleaned++;
          continue;
        }

        const channel = guild.channels?.cache?.get?.(record.channelId) || await guild.channels?.fetch?.(record.channelId).catch(() => null);
        if (!channel) {
          // Channel deleted; prune record safely
          this._records.delete(record.messageId);
          cleaned++;
          continue;
        }

        // Fetch message to verify ownership
        try {
          const msg = await channel.messages.fetch(record.messageId).catch(() => null);
          if (msg) {
            // Verify message author is Honey Bot before deleting
            const botId = client.user?.id;
            if (!botId || msg.author.id === botId) {
              await msg.delete();
            } else {
              logger.warn('Skipping deletion of non-bot message in honeypot log channel', { messageId: record.messageId });
            }
          }
        } catch (fetchErr) {
          // Code 10008 = Unknown Message (already deleted by user or admin) -> safe to prune
          if (fetchErr.code !== 10008) {
            logger.warn('Error fetching/deleting honeypot log message', { error: fetchErr.message, messageId: record.messageId });
          }
        }

        this._records.delete(record.messageId);
        cleaned++;

        // Rate limit safety delay
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        errors++;
        logger.error('Failed to cleanup honeypot log message', { error: err.message, messageId: record.messageId });
      }
    }

    if (cleaned > 0) {
      this.saveRecords();
      logger.info(`Honeypot log cleanup completed: removed ${cleaned} expired records (errors: ${errors})`);
    }

    return { cleaned, errors, remaining: this._records.size };
  }

  /**
   * Resets all in-memory and disk records (used for test isolation).
   */
  static clear() {
    this._records.clear();
    this._isLoaded = true;
    if (fs.existsSync(this.storagePath)) {
      try { fs.unlinkSync(this.storagePath); } catch {}
    }
  }
}

