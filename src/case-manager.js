import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionFlagsBits } from 'discord.js';
import { Logger } from './logger.js';
import { ModLogService } from './mod-log.js';
import { ActionRegistry, FunctionalCategory, OutcomeState, VerificationStatus } from './action-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = new Logger('CaseManager');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const CASES_FILE = path.join(DATA_DIR, 'moderation-cases.json');

/**
 * CaseManager
 * Authoritative system for unified moderation case management, infraction tracking,
 * automatic escalation rules, temporary punishment scheduling, and appeal records.
 */
export class CaseManager {
  static _cases = new Map(); // guildId -> Map(caseId -> CaseRecord)
  static _counters = new Map(); // guildId -> currentCounter
  static _escalationRules = new Map(); // guildId -> EscalationConfig
  static _isLoaded = false;
  static _storagePath = CASES_FILE;
  static _timerInterval = null;

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
        logger.error('Failed to create data directory for cases', { error: err.message });
      }
    }
  }

  static loadAll() {
    if (this._isLoaded) return;
    this._ensureDataDir();

    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const parsed = JSON.parse(raw);

        this._cases.clear();
        this._counters.clear();
        this._escalationRules.clear();

        for (const [guildId, data] of Object.entries(parsed)) {
          const caseMap = new Map();
          if (Array.isArray(data.cases)) {
            for (const c of data.cases) {
              caseMap.set(c.caseId, c);
            }
          }
          this._cases.set(guildId, caseMap);
          this._counters.set(guildId, Number(data.counter) || caseMap.size);
          this._escalationRules.set(guildId, data.escalationRules || this.getDefaultEscalationRules());
        }
      }
      this._isLoaded = true;
    } catch (err) {
      logger.error('Failed to load moderation cases from disk', { error: err.message });
      this._isLoaded = true;
    }
  }

  static saveAll() {
    this._ensureDataDir();
    try {
      const serializable = {};
      for (const [guildId, caseMap] of this._cases.entries()) {
        serializable[guildId] = {
          counter: this._counters.get(guildId) || 0,
          escalationRules: this._escalationRules.get(guildId) || this.getDefaultEscalationRules(),
          cases: Array.from(caseMap.values())
        };
      }

      const tmpFile = `${this.storagePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpFile, JSON.stringify(serializable, null, 2), 'utf8');
      fs.renameSync(tmpFile, this.storagePath);
    } catch (err) {
      logger.error('Failed to save moderation cases to disk', { error: err.message });
    }
  }

  static getDefaultEscalationRules() {
    return {
      enabled: true,
      windowHours: 24,
      thresholds: [
        { count: 3, action: 'timeout', durationMinutes: 15, reason: 'Auto-escalation: 3 infractions reached' },
        { count: 5, action: 'timeout', durationMinutes: 1440, reason: 'Auto-escalation: 5 infractions reached' },
        { count: 7, action: 'kick', reason: 'Auto-escalation: 7 infractions reached' }
      ]
    };
  }

  static getEscalationRules(guildId) {
    this.loadAll();
    return this._escalationRules.get(guildId) || this.getDefaultEscalationRules();
  }

  static setEscalationRules(guildId, rules) {
    this.loadAll();
    this._escalationRules.set(guildId, {
      ...this.getDefaultEscalationRules(),
      ...rules
    });
    this.saveAll();
    return this._escalationRules.get(guildId);
  }

  /**
   * Generates the next sequential Case ID for a guild.
   */
  static generateCaseId(guildId) {
    this.loadAll();
    const current = (this._counters.get(guildId) || 0) + 1;
    this._counters.set(guildId, current);
    return `CASE-${String(current).padStart(4, '0')}`;
  }

  /**
   * Creates a formal moderation case.
   */
  static createCase(guildId, {
    action,
    target,
    moderator,
    reason = 'No reason provided',
    durationMinutes = null,
    evidence = null,
    notes = null,
    source = '/go',
    executionId = null
  }) {
    this.loadAll();
    if (!this._cases.has(guildId)) {
      this._cases.set(guildId, new Map());
    }

    const caseId = this.generateCaseId(guildId);
    const now = Date.now();
    const expiresAt = durationMinutes ? now + (durationMinutes * 60 * 1000) : null;

    const caseRecord = {
      caseId,
      guildId,
      action: String(action).toLowerCase(),
      target: typeof target === 'object' ? { id: target.id, tag: target.tag || target.username } : { id: String(target), tag: String(target) },
      moderator: typeof moderator === 'object' ? { id: moderator.id, tag: moderator.tag || moderator.username } : { id: String(moderator), tag: String(moderator) },
      reason,
      durationMinutes,
      evidence,
      notes: notes ? [notes] : [],
      status: 'active',
      createdAt: new Date(now).toISOString(),
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      source,
      executionId,
      appeal: null
    };

    this._cases.get(guildId).set(caseId, caseRecord);
    this.saveAll();

    logger.info(`Moderation case created: ${caseId} (${action}) for user ${caseRecord.target.id} in guild ${guildId}`);
    return caseRecord;
  }

  /**
   * Retrieves a specific case by ID.
   */
  static getCase(guildId, caseId) {
    this.loadAll();
    const guildCases = this._cases.get(guildId);
    if (!guildCases) return null;
    return guildCases.get(caseId.toUpperCase()) || null;
  }

  /**
   * Lists all cases for a guild, optionally filtered by user or action.
   */
  static listCases(guildId, filter = {}) {
    this.loadAll();
    const guildCases = this._cases.get(guildId);
    if (!guildCases) return [];

    let cases = Array.from(guildCases.values());

    if (filter.targetId) {
      cases = cases.filter(c => c.target.id === filter.targetId);
    }
    if (filter.action) {
      cases = cases.filter(c => c.action === filter.action.toLowerCase());
    }
    if (filter.status) {
      cases = cases.filter(c => c.status === filter.status);
    }

    return cases.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  /**
   * Appends notes to an existing case.
   */
  static addNote(guildId, caseId, note, moderator) {
    const c = this.getCase(guildId, caseId);
    if (!c) return { success: false, error: 'Case not found' };

    c.notes.push({
      note,
      author: typeof moderator === 'object' ? moderator.tag || moderator.id : String(moderator),
      addedAt: new Date().toISOString()
    });
    this.saveAll();
    return { success: true, case: c };
  }

  /**
   * Registers an appeal against a case.
   */
  static submitAppeal(guildId, caseId, { reason, appellantId }) {
    const c = this.getCase(guildId, caseId);
    if (!c) return { success: false, error: 'Case not found' };

    c.appeal = {
      appellantId,
      reason,
      status: 'pending',
      submittedAt: new Date().toISOString(),
      decision: null
    };
    this.saveAll();
    return { success: true, case: c };
  }

  /**
   * Resolves an appeal (accept or deny).
   */
  static resolveAppeal(guildId, caseId, { decision, moderator, notes }) {
    const c = this.getCase(guildId, caseId);
    if (!c || !c.appeal) return { success: false, error: 'Case or appeal not found' };

    c.appeal.status = decision === 'accepted' ? 'accepted' : 'denied';
    c.appeal.decision = {
      decision,
      moderator: typeof moderator === 'object' ? moderator.tag || moderator.id : String(moderator),
      notes: notes || 'No decision notes provided',
      resolvedAt: new Date().toISOString()
    };

    if (decision === 'accepted') {
      c.status = 'appealed';
    }

    this.saveAll();
    return { success: true, case: c };
  }

  /**
   * Evaluates active infractions and triggers escalation action if thresholds are crossed.
   */
  static checkEscalation(guildId, targetUserId) {
    this.loadAll();
    const rules = this.getEscalationRules(guildId);
    if (!rules.enabled) return null;

    const windowMs = (rules.windowHours || 24) * 60 * 60 * 1000;
    const cutoff = Date.now() - windowMs;

    // Count non-appealed infractions within window
    const recentCases = this.listCases(guildId, { targetId: targetUserId })
      .filter(c => c.status !== 'appealed' && c.status !== 'reverted' && new Date(c.createdAt).getTime() >= cutoff);

    const count = recentCases.length;

    // Check thresholds sorted descending
    const sortedThresholds = [...rules.thresholds].sort((a, b) => b.count - a.count);
    for (const thresh of sortedThresholds) {
      if (count >= thresh.count) {
        return {
          triggered: true,
          infractionCount: count,
          recommendedAction: thresh.action,
          durationMinutes: thresh.durationMinutes || null,
          reason: thresh.reason || `Automated escalation for ${count} infractions`
        };
      }
    }

    return {
      triggered: false,
      infractionCount: count,
      recommendedAction: null
    };
  }

  /**
   * Periodic scheduler to check expired temporary punishments (temp bans/timeouts)
   * and safe recovery.
   */
  static async checkExpiredCases(client) {
    this.loadAll();
    const now = Date.now();

    for (const [guildId, guildCases] of this._cases.entries()) {
      for (const [caseId, c] of guildCases.entries()) {
        if (c.status === 'active' && c.expiresAt && new Date(c.expiresAt).getTime() <= now) {
          c.status = 'expired';
          logger.info(`Case ${caseId} (${c.action}) expired for user ${c.target.id}`);

          // If action was a temporary ban, perform automated unban if bot has permissions
          if (c.action === 'ban' && client) {
            try {
              const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
              if (guild && guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
                await guild.bans.remove(c.target.id, `Temporary ban expired (${caseId})`);
                await ModLogService.logAction(guild, {
                  action: 'unban_member',
                  actor: client.user,
                  target: c.target,
                  reason: `Automated expiry of ${caseId}`,
                  outcome: 'succeeded',
                  source: 'scheduled_task'
                });
              }
            } catch (unbanErr) {
              logger.warn(`Failed to auto-unban user ${c.target.id} on case ${caseId} expiry: ${unbanErr.message}`);
            }
          }
        }
      }
    }
    this.saveAll();
  }

  /**
   * Initializes background expiry monitor.
   */
  static startScheduler(client, intervalMs = 60000) {
    if (this._timerInterval) clearInterval(this._timerInterval);
    this._timerInterval = setInterval(() => {
      this.checkExpiredCases(client).catch(err => {
        logger.error('Error during case expiry sweep', { error: err.message });
      });
    }, intervalMs);
    if (typeof this._timerInterval?.unref === 'function') {
      this._timerInterval.unref();
    }
    // Run an initial sweep
    this.checkExpiredCases(client).catch(() => {});
  }

  static stopScheduler() {
    if (this._timerInterval) {
      clearInterval(this._timerInterval);
      this._timerInterval = null;
    }
  }
}

