import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger } from './logger.js';
import { CaseManager } from './case-manager.js';
import { TicketManager } from './tickets.js';
import { WorkflowEngine } from './workflow-engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = new Logger('AnalyticsService');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const ANALYTICS_FILE = path.join(DATA_DIR, 'server-analytics.json');

/**
 * AnalyticsService
 * Privacy-preserving aggregated metrics engine:
 * - Rolling 30-day member join/leave velocity
 * - Channel message volume aggregates (no message content stored)
 * - Moderation infractions and safety events
 * - Ticket turnaround times and workflow reliability
 */
export class AnalyticsService {
  static _data = new Map(); // guildId -> AnalyticsRecord
  static _isLoaded = false;
  static _storagePath = ANALYTICS_FILE;

  static get storagePath() {
    return this._storagePath;
  }

  static set storagePath(p) {
    this._storagePath = p;
    this._isLoaded = false;
  }

  static _ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      } catch (err) {
        logger.error('Failed to create data directory for analytics', { error: err.message });
      }
    }
  }

  static _getTodayKey() {
    return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
  }

  static getDefaultGuildData() {
    return {
      dailyStats: {}, // 'YYYY-MM-DD' -> { joins: 0, leaves: 0, messages: 0, modActions: 0, spamBlocks: 0 }
      channelActivity: {}, // channelId -> totalMessages
      musicPlaybackCount: 0,
      totalTicketsCreated: 0,
      retentionDays: 30
    };
  }

  static loadAll() {
    if (this._isLoaded) return;
    this._ensureDataDir();

    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const parsed = JSON.parse(raw);
        this._data.clear();
        for (const [guildId, rec] of Object.entries(parsed)) {
          this._data.set(guildId, {
            ...this.getDefaultGuildData(),
            ...rec
          });
        }
      }
      this._isLoaded = true;
    } catch (err) {
      logger.error('Failed to load analytics records from disk', { error: err.message });
      this._isLoaded = true;
    }
  }

  static saveAll() {
    this._ensureDataDir();
    const serializable = Object.fromEntries(this._data);
    const tmpFile = `${this.storagePath}.tmp.${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const payload = JSON.stringify(serializable, null, 2);
    try {
      fs.writeFileSync(tmpFile, payload, 'utf8');
      fs.renameSync(tmpFile, this.storagePath);
    } catch (err) {
      try {
        fs.writeFileSync(this.storagePath, payload, 'utf8');
      } catch (writeErr) {
        logger.error('Failed to save analytics records to disk', { error: writeErr.message });
      }
    } finally {
      if (fs.existsSync(tmpFile)) {
        try { fs.unlinkSync(tmpFile); } catch {}
      }
    }
  }

  static _getGuildRecord(guildId) {
    this.loadAll();
    if (!this._data.has(guildId)) {
      this._data.set(guildId, this.getDefaultGuildData());
    }
    const rec = this._data.get(guildId);
    const today = this._getTodayKey();
    if (!rec.dailyStats[today]) {
      rec.dailyStats[today] = { joins: 0, leaves: 0, messages: 0, modActions: 0, spamBlocks: 0 };
    }
    return rec;
  }

  // Event recorders
  static recordJoin(guildId) {
    const rec = this._getGuildRecord(guildId);
    const today = this._getTodayKey();
    rec.dailyStats[today].joins++;
    this._pruneOldRecords(rec);
    this.saveAll();
  }

  static recordLeave(guildId) {
    const rec = this._getGuildRecord(guildId);
    const today = this._getTodayKey();
    rec.dailyStats[today].leaves++;
    this._pruneOldRecords(rec);
    this.saveAll();
  }

  static recordMessage(guildId, channelId) {
    const rec = this._getGuildRecord(guildId);
    const today = this._getTodayKey();
    rec.dailyStats[today].messages++;
    rec.channelActivity[channelId] = (rec.channelActivity[channelId] || 0) + 1;
    this.saveAll();
  }

  static recordModAction(guildId) {
    const rec = this._getGuildRecord(guildId);
    const today = this._getTodayKey();
    rec.dailyStats[today].modActions++;
    this.saveAll();
  }

  static recordSpamBlock(guildId) {
    const rec = this._getGuildRecord(guildId);
    const today = this._getTodayKey();
    rec.dailyStats[today].spamBlocks++;
    this.saveAll();
  }

  static recordMusicSession(guildId) {
    const rec = this._getGuildRecord(guildId);
    rec.musicPlaybackCount = (rec.musicPlaybackCount || 0) + 1;
    this.saveAll();
  }

  static _pruneOldRecords(rec) {
    const days = rec.retentionDays || 30;
    const cutoff = new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
    for (const d of Object.keys(rec.dailyStats)) {
      if (d < cutoff) delete rec.dailyStats[d];
    }
  }

  // High-level summary queries
  static getOverviewMetrics(guildId) {
    this.loadAll();
    const rec = this._getGuildRecord(guildId);
    const today = this._getTodayKey();
    const todayStats = rec.dailyStats[today] || { joins: 0, leaves: 0, messages: 0, modActions: 0, spamBlocks: 0 };

    // Past 7 days
    const days = Object.keys(rec.dailyStats).sort().slice(-7);
    let totalJoins7d = 0;
    let totalLeaves7d = 0;
    let totalMessages7d = 0;
    let totalMod7d = 0;
    let totalSpam7d = 0;

    for (const d of days) {
      const s = rec.dailyStats[d];
      totalJoins7d += s.joins || 0;
      totalLeaves7d += s.leaves || 0;
      totalMessages7d += s.messages || 0;
      totalMod7d += s.modActions || 0;
      totalSpam7d += s.spamBlocks || 0;
    }

    const cases = CaseManager.listCases(guildId);
    const workflows = WorkflowEngine.listWorkflows(guildId);

    return {
      today: todayStats,
      past7Days: {
        joins: totalJoins7d,
        leaves: totalLeaves7d,
        netGrowth: totalJoins7d - totalLeaves7d,
        messages: totalMessages7d,
        modActions: totalMod7d,
        spamBlocks: totalSpam7d
      },
      totalCasesRecorded: cases.length,
      activeWorkflows: workflows.filter(w => w.enabled).length,
      musicSessionsCount: rec.musicPlaybackCount || 0,
      retentionDays: rec.retentionDays
    };
  }
}

