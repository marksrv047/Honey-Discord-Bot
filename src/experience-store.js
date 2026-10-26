import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = new Logger('ExperienceStore');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const EXPERIENCE_FILE = path.join(DATA_DIR, 'experience-records.json');

/**
 * Standard Failure Categories for Machine Learning & Reliability Insights
 */
export const FailureCategory = {
  NONE: 'NONE',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  INVALID_MUSIC_QUERY: 'INVALID_MUSIC_QUERY',
  VOICE_TIMEOUT: 'VOICE_TIMEOUT',
  LLM_PARSE_ERROR: 'LLM_PARSE_ERROR',
  SECURITY_BLOCKED: 'SECURITY_BLOCKED',
  RATE_LIMITED: 'RATE_LIMITED',
  UNSUPPORTED_ACTION: 'UNSUPPORTED_ACTION',
  UNKNOWN_FAILURE: 'UNKNOWN_FAILURE'
};

/**
 * Continuous Learning & Experience Storage Subsystem.
 * Records verified execution traces, user feedback, and error taxonomies.
 * Generates privacy-filtered evaluation datasets for offline model evaluation and fine-tuning.
 */
export class ExperienceStore {
  static _records = new Map(); // executionId -> ExperienceRecord
  static _loaded = false;
  static _maxRecordsPerGuild = 500;
  static _storagePath = EXPERIENCE_FILE;

  static get storagePath() {
    return this._storagePath;
  }

  static set storagePath(p) {
    this._storagePath = p;
    this._loaded = false;
  }

  static _ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  /**
   * Loads persisted experience records from disk.
   */
  static loadAll() {
    if (this._loaded) return;
    this._records.clear();
    this._ensureDataDir();

    if (fs.existsSync(this._storagePath)) {
      try {
        const raw = fs.readFileSync(this._storagePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          for (const [id, rec] of Object.entries(parsed)) {
            this._records.set(id, rec);
          }
        }
        logger.info('Loaded experience records from disk', { count: this._records.size });
      } catch (err) {
        logger.error('Failed to load experience records', { error: err.message });
      }
    }
    this._loaded = true;
  }

  /**
   * Persists experience records atomically to disk.
   */
  static persistAll() {
    this._ensureDataDir();
    const filePath = this._storagePath;
    const tempFile = `${filePath}.tmp.${Date.now()}_${Math.random().toString(36).substring(7)}`;

    const serializable = {};
    for (const [id, rec] of this._records.entries()) {
      serializable[id] = rec;
    }

    try {
      fs.writeFileSync(tempFile, JSON.stringify(serializable, null, 2), 'utf8');
      try {
        fs.renameSync(tempFile, filePath);
      } catch {
        fs.copyFileSync(tempFile, filePath);
        fs.unlinkSync(tempFile);
      }
    } catch (err) {
      logger.error('Failed to persist experience records', { error: err.message });
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch {}
    }
  }

  /**
   * Deterministically classifies an execution failure into a standard taxonomy.
   */
  static classifyFailure(errorMessage, plan = null) {
    if (!errorMessage) return FailureCategory.NONE;
    const err = String(errorMessage).toLowerCase();

    if (/permission|hierarchy|missing permissions|administrator|manage|unauthorized/i.test(err)) {
      return FailureCategory.PERMISSION_DENIED;
    }
    if (/not found|unknown channel|unknown role|unknown member|does not exist|could not find/i.test(err)) {
      return FailureCategory.TARGET_NOT_FOUND;
    }
    if (/no tracks found|unsupported media|age-restricted|soundcloud|youtube/i.test(err)) {
      return FailureCategory.INVALID_MUSIC_QUERY;
    }
    if (/voice connection timed out|voice connection/i.test(err)) {
      return FailureCategory.VOICE_TIMEOUT;
    }
    if (/anti-nuke|security policy|nuke|mass deletion|blocked unconditionally/i.test(err)) {
      return FailureCategory.SECURITY_BLOCKED;
    }
    if (/rate limit|too many requests|429/i.test(err)) {
      return FailureCategory.RATE_LIMITED;
    }
    if (/json|unparseable|syntaxerror|invalid response/i.test(err)) {
      return FailureCategory.LLM_PARSE_ERROR;
    }
    if (/unsupported action|unknown action/i.test(err)) {
      return FailureCategory.UNSUPPORTED_ACTION;
    }

    return FailureCategory.UNKNOWN_FAILURE;
  }

  /**
   * Records a completed or failed execution into continuous experience memory.
   */
  static recordExecution({
    executionId = `exec_${Date.now()}_${Math.random().toString(36).substring(7)}`,
    guildId,
    userId,
    userPrompt,
    normalizedIntent,
    plan = null,
    capabilities = [],
    clarificationNeeded = null,
    outcome = 'succeeded', // 'succeeded' | 'partially_completed' | 'failed' | 'denied'
    verificationEvidence = null,
    errorMessage = null,
    errorCategory = null,
    modelId = 'groq/openai/gpt-oss-120b',
    latencyMs = 0,
    tokenEstimate = 0
  }) {
    if (!guildId) return null;
    this.loadAll();

    // Redact sensitive secrets from prompt
    const sanitizedPrompt = Logger.redactSecrets(String(userPrompt || '')).slice(0, 1000);

    const resolvedCategory = errorCategory || (outcome === 'succeeded' ? FailureCategory.NONE : this.classifyFailure(errorMessage, plan));

    const record = {
      executionId,
      guildId: String(guildId),
      userId: String(userId || 'unknown'),
      userPrompt: sanitizedPrompt,
      normalizedIntent: normalizedIntent || 'unknown',
      plan: plan ? JSON.parse(JSON.stringify(plan)) : null,
      capabilities: Array.isArray(capabilities) ? capabilities : [],
      clarificationNeeded: clarificationNeeded || null,
      outcome,
      verificationEvidence: verificationEvidence ? String(verificationEvidence).slice(0, 500) : null,
      errorCategory: resolvedCategory,
      errorMessage: errorMessage ? String(errorMessage).slice(0, 500) : null,
      feedback: null, // { rating: 'positive' | 'negative', comment: string, timestamp: number }
      modelId,
      latencyMs: Math.max(0, parseInt(latencyMs, 10) || 0),
      tokenEstimate: Math.max(0, parseInt(tokenEstimate, 10) || 0),
      timestamp: Date.now()
    };

    // Prune old records for this guild if over capacity
    const guildRecords = Array.from(this._records.values()).filter(r => r.guildId === String(guildId));
    if (guildRecords.length >= this._maxRecordsPerGuild) {
      guildRecords.sort((a, b) => a.timestamp - b.timestamp);
      const toRemove = guildRecords.slice(0, guildRecords.length - this._maxRecordsPerGuild + 1);
      for (const r of toRemove) {
        this._records.delete(r.executionId);
      }
    }

    this._records.set(executionId, record);
    this.persistAll();

    logger.info('Recorded execution experience', { executionId, guildId, outcome, errorCategory: resolvedCategory });
    return record;
  }

  /**
   * Attaches explicit user feedback (thumbs up / thumbs down) to an execution record.
   */
  static recordFeedback(executionId, { rating, comment = null, userId = null }) {
    this.loadAll();
    const record = this._records.get(executionId);
    if (!record) {
      return { success: false, error: 'Execution record not found or expired.' };
    }

    record.feedback = {
      rating: rating === 'positive' ? 'positive' : 'negative',
      comment: comment ? String(comment).slice(0, 200) : null,
      userId: userId ? String(userId) : null,
      timestamp: Date.now()
    };

    this.persistAll();
    logger.info('Recorded user feedback on experience', { executionId, rating });
    return { success: true, record };
  }

  /**
   * Retrieves high-level reliability metrics and failure breakdown for a guild.
   */
  static getGuildMetrics(guildId) {
    this.loadAll();
    const records = Array.from(this._records.values()).filter(r => r.guildId === String(guildId));

    const total = records.length;
    if (total === 0) {
      return {
        totalExecutions: 0,
        successRate: 100,
        positiveFeedback: 0,
        negativeFeedback: 0,
        failureBreakdown: {},
        recentFailures: [],
        averageLatencyMs: 0
      };
    }

    let successes = 0;
    let positive = 0;
    let negative = 0;
    let totalLatency = 0;
    const failureBreakdown = {};

    for (const r of records) {
      if (r.outcome === 'succeeded') successes++;
      if (r.feedback?.rating === 'positive') positive++;
      if (r.feedback?.rating === 'negative') negative++;
      totalLatency += r.latencyMs || 0;

      if (r.errorCategory && r.errorCategory !== FailureCategory.NONE) {
        failureBreakdown[r.errorCategory] = (failureBreakdown[r.errorCategory] || 0) + 1;
      }
    }

    const recentFailures = records
      .filter(r => r.outcome !== 'succeeded')
      .slice(-5)
      .map(r => ({
        executionId: r.executionId,
        prompt: r.userPrompt,
        category: r.errorCategory,
        error: r.errorMessage,
        timestamp: r.timestamp
      }));

    return {
      totalExecutions: total,
      successRate: Math.round((successes / total) * 100),
      positiveFeedback: positive,
      negativeFeedback: negative,
      failureBreakdown,
      recentFailures,
      averageLatencyMs: Math.round(totalLatency / total)
    };
  }

  /**
   * Generates a privacy-conscious, quality-filtered evaluation and training dataset.
   * Strips Discord-specific snowflake IDs, tokens, and personal identifiers.
   * Exports in ChatML JSONL format ready for evaluation or fine-tuning pipelines.
   */
  static exportEvaluationDataset({ guildId = null, onlySuccessful = true } = {}) {
    this.loadAll();
    let records = Array.from(this._records.values());

    if (guildId) {
      records = records.filter(r => r.guildId === String(guildId));
    }

    if (onlySuccessful) {
      records = records.filter(r => r.outcome === 'succeeded' || r.feedback?.rating === 'positive');
    }

    const exportedEntries = [];

    for (const r of records) {
      // Quality gate: require prompt and plan
      if (!r.userPrompt || !r.plan) continue;

      // Anonymize snowflakes and mentions: <@123456789> -> @User, <#123456789> -> #channel, <@&123456789> -> @Role
      const anonymizedPrompt = r.userPrompt
        .replace(/<@!?\d+>/g, '@User')
        .replace(/<#\d+>/g, '#channel')
        .replace(/<@&\d+>/g, '@Role')
        .replace(/\b\d{17,20}\b/g, 'SNOWFLAKE_ID');

      const anonymizedPlan = JSON.parse(
        JSON.stringify(r.plan)
          .replace(/<@!?\d+>/g, '@User')
          .replace(/<#\d+>/g, '#channel')
          .replace(/<@&\d+>/g, '@Role')
          .replace(/\b\d{17,20}\b/g, 'SNOWFLAKE_ID')
      );

      exportedEntries.push({
        id: r.executionId,
        messages: [
          {
            role: 'system',
            content: 'You are Honey Bot, an autonomous Discord administration agent. Given a natural language user request, return a structured administrative execution plan.'
          },
          {
            role: 'user',
            content: anonymizedPrompt
          },
          {
            role: 'assistant',
            content: JSON.stringify(anonymizedPlan)
          }
        ],
        metadata: {
          intent: r.normalizedIntent,
          verified: r.outcome === 'succeeded',
          feedbackRating: r.feedback?.rating || 'unrated',
          timestamp: r.timestamp
        }
      });
    }

    return exportedEntries;
  }
}
