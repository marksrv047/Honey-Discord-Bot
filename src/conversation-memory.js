import { Logger } from './logger.js';

const logger = new Logger('ConversationMemoryManager');

/**
 * Manages Layer A (Short-Term Conversation History) and Layer C (Recent Entity & Action Context).
 * Enforces strict guild-level isolation, bounded entry limits, automatic compaction, and TTL expiry.
 */
export class ConversationMemoryManager {
  constructor(options = {}) {
    this.maxMessagesPerConversation = options.maxMessagesPerConversation || 25;
    this.maxSerializedBytesPerConversation = options.maxSerializedBytesPerConversation || 250 * 1024; // 250 KB
    this.historyTtlMs = options.historyTtlMs || 30 * 60 * 1000; // 30 minutes
    this.maxEntitiesPerGuild = options.maxEntitiesPerGuild || 20;

    // Map<conversationKey, Array<MessageTurn>>
    // conversationKey: "guildId:userId" or "guildId:userId:channelId"
    this.conversations = new Map();

    // Map<conversationKey, string> - compacted summary for older pruned turns
    this.summaries = new Map();

    // Map<guildId, GuildEntityContext>
    this.entityContexts = new Map();

    this._cleanupTimer = null;
    this.stats = {
      recordedMessages: 0,
      recordedEntities: 0,
      trimmedCount: 0,
      summarizedCount: 0,
      expiredConversations: 0
    };
  }

  _getConversationKey(guildId, userId, channelId = null) {
    if (!guildId || !userId) return null;
    return channelId ? `${guildId}:${userId}:${channelId}` : `${guildId}:${userId}`;
  }

  _getGuildEntityContext(guildId) {
    if (!guildId) return null;
    if (!this.entityContexts.has(guildId)) {
      this.entityContexts.set(guildId, {
        roles: [], // Array<{ id, name, color, permissions, timestamp }>
        channels: [], // Array<{ id, name, type, timestamp }>
        categories: [], // Array<{ id, name, timestamp }>
        members: [], // Array<{ id, tag, displayName, timestamp }>
        actions: [] // Array<{ action, targetRef, timestamp, details, outcome }>
      });
    }
    return this.entityContexts.get(guildId);
  }

  /**
   * Records a user message turn into conversation memory.
   */
  recordUserMessage(guildId, userId, channelId, content, metadata = {}) {
    if (!guildId || !userId || !content) return;
    const key = this._getConversationKey(guildId, userId, channelId);
    if (!key) return;

    if (!this.conversations.has(key)) {
      this.conversations.set(key, []);
    }

    const turns = this.conversations.get(key);
    const now = Date.now();

    turns.push({
      id: `turn_${now}_${Math.random().toString(36).substring(7)}`,
      role: 'user',
      content: String(content).trim(),
      timestamp: now,
      metadata: { ...metadata }
    });

    this.stats.recordedMessages++;
    this._compactConversationIfNeeded(key);
  }

  /**
   * Records a bot response turn into conversation memory.
   */
  recordBotResponse(guildId, userId, channelId, content, metadata = {}) {
    if (!guildId || !userId || !content) return;
    const key = this._getConversationKey(guildId, userId, channelId);
    if (!key) return;

    if (!this.conversations.has(key)) {
      this.conversations.set(key, []);
    }

    const turns = this.conversations.get(key);
    const now = Date.now();

    turns.push({
      id: `turn_${now}_${Math.random().toString(36).substring(7)}`,
      role: 'assistant',
      content: String(content).trim(),
      timestamp: now,
      action: metadata.action || null,
      taskId: metadata.taskId || null,
      clarificationQuestion: metadata.clarificationQuestion || null,
      metadata: { ...metadata }
    });

    this.stats.recordedMessages++;
    this._compactConversationIfNeeded(key);
  }

  /**
   * Compacts / trims a conversation if it exceeds message limits or serialized byte size.
   */
  _compactConversationIfNeeded(key) {
    const turns = this.conversations.get(key);
    if (!turns) return;

    // Check message count limit
    if (turns.length > this.maxMessagesPerConversation) {
      const excess = turns.length - this.maxMessagesPerConversation;
      const pruned = turns.splice(0, excess);
      this.stats.trimmedCount += pruned.length;

      // Extract brief summary from pruned messages
      const actionsDiscussed = pruned
        .map(t => t.action || (t.content ? t.content.slice(0, 30) : null))
        .filter(Boolean);
      if (actionsDiscussed.length > 0) {
        const existingSummary = this.summaries.get(key) || '';
        const newSummary = `Previous context: ${[...new Set(actionsDiscussed)].join(', ')}.`;
        this.summaries.set(key, existingSummary ? `${existingSummary} ${newSummary}` : newSummary);
        this.stats.summarizedCount++;
      }
    }

    // Check serialized byte size
    try {
      const serialized = JSON.stringify(turns);
      if (serialized.length > this.maxSerializedBytesPerConversation) {
        // Drop oldest 25% of turns
        const dropCount = Math.max(1, Math.floor(turns.length * 0.25));
        turns.splice(0, dropCount);
        this.stats.trimmedCount += dropCount;
      }
    } catch {}
  }

  /**
   * Retrieves recent conversation turns for a user/channel scope.
   */
  getConversationHistory(guildId, userId, channelId = null, limit = 10) {
    const key = this._getConversationKey(guildId, userId, channelId);
    const fallbackKey = this._getConversationKey(guildId, userId);
    const turns = this.conversations.get(key) || this.conversations.get(fallbackKey) || [];

    const now = Date.now();
    // Filter out messages older than TTL
    const validTurns = turns.filter(t => (now - t.timestamp) <= this.historyTtlMs);

    return validTurns.slice(-limit);
  }

  /**
   * Gets conversation summary if available.
   */
  getConversationSummary(guildId, userId, channelId = null) {
    const key = this._getConversationKey(guildId, userId, channelId);
    const fallbackKey = this._getConversationKey(guildId, userId);
    return this.summaries.get(key) || this.summaries.get(fallbackKey) || null;
  }

  /**
   * Records a referenced or created Discord resource into Layer C (Entity Context).
   */
  recordEntity(guildId, entityType, entityData) {
    if (!guildId || !entityType || !entityData) return;
    const ctx = this._getGuildEntityContext(guildId);
    if (!ctx) return;

    const list = ctx[`${entityType}s`];
    if (!Array.isArray(list)) return;

    const now = Date.now();
    const entry = {
      id: entityData.id || null,
      name: entityData.name || null,
      timestamp: now,
      ...entityData
    };

    // Deduplicate existing entry by ID or name
    const existingIndex = list.findIndex(e => (entry.id && e.id === entry.id) || (entry.name && e.name?.toLowerCase() === entry.name?.toLowerCase()));
    if (existingIndex >= 0) {
      list.splice(existingIndex, 1);
    }

    list.unshift(entry);
    if (list.length > this.maxEntitiesPerGuild) {
      list.pop();
    }

    this.stats.recordedEntities++;
  }

  /**
   * Records an executed action into Layer C (Action Context).
   */
  recordAction(guildId, actionData) {
    if (!guildId || !actionData) return;
    const ctx = this._getGuildEntityContext(guildId);
    if (!ctx) return;

    const now = Date.now();
    const entry = {
      action: actionData.action,
      targetRef: actionData.targetRef || actionData.target || null,
      targetId: actionData.targetId || actionData.id || null,
      details: actionData.details || null,
      outcome: actionData.outcome || 'succeeded',
      timestamp: now,
      ...actionData
    };

    ctx.actions.unshift(entry);
    if (ctx.actions.length > this.maxEntitiesPerGuild) {
      ctx.actions.pop();
    }
  }

  /**
   * Retrieves the most recent entity of a given type in a guild.
   */
  getLastEntity(guildId, entityType) {
    const ctx = this._getGuildEntityContext(guildId);
    if (!ctx) return null;
    const list = ctx[`${entityType}s`];
    return Array.isArray(list) && list.length > 0 ? list[0] : null;
  }

  /**
   * Retrieves all recent entities of a given type in a guild.
   */
  getEntities(guildId, entityType, limit = 5) {
    const ctx = this._getGuildEntityContext(guildId);
    if (!ctx) return [];
    const list = ctx[`${entityType}s`];
    return Array.isArray(list) ? list.slice(0, limit) : [];
  }

  /**
   * Retrieves the most recently executed action in a guild.
   */
  getLastAction(guildId) {
    const ctx = this._getGuildEntityContext(guildId);
    if (!ctx || !ctx.actions || ctx.actions.length === 0) return null;
    return ctx.actions[0];
  }

  /**
   * Builds a structured context snapshot for IntentInterpreter and ContextResolver.
   */
  buildRecentContextSnapshot(guildId, userId, channelId = null) {
    if (!guildId) return {};

    const lastRole = this.getLastEntity(guildId, 'role');
    const lastChannel = this.getLastEntity(guildId, 'channel');
    const lastMember = this.getLastEntity(guildId, 'member');
    const lastAction = this.getLastAction(guildId);
    const summary = this.getConversationSummary(guildId, userId, channelId);
    const history = this.getConversationHistory(guildId, userId, channelId, 6);

    return {
      guildId,
      userId,
      channelId,
      lastRole: lastRole ? lastRole.name : null,
      lastRoleId: lastRole ? lastRole.id : null,
      lastCreatedRole: lastRole ? lastRole.name : null,
      lastCreatedRoleId: lastRole ? lastRole.id : null,
      lastRoleColor: lastRole ? lastRole.color : null,
      lastChannel: lastChannel ? lastChannel.name : null,
      lastChannelId: lastChannel ? lastChannel.id : null,
      lastCreatedChannel: lastChannel ? lastChannel.name : null,
      lastCreatedChannelId: lastChannel ? lastChannel.id : null,
      lastMember: lastMember ? (lastMember.tag || lastMember.name) : null,
      lastMemberId: lastMember ? lastMember.id : null,
      lastAction: lastAction ? lastAction.action : null,
      lastTarget: lastAction ? lastAction.targetRef : null,
      summary,
      recentTurnsCount: history.length
    };
  }

  /**
   * Sweeps expired conversation histories.
   */
  cleanupExpired() {
    const now = Date.now();
    for (const [key, turns] of this.conversations.entries()) {
      const activeTurns = turns.filter(t => (now - t.timestamp) <= this.historyTtlMs);
      if (activeTurns.length === 0) {
        this.conversations.delete(key);
        this.summaries.delete(key);
        this.stats.expiredConversations++;
      } else if (activeTurns.length < turns.length) {
        this.conversations.set(key, activeTurns);
      }
    }
  }

  startScheduler(intervalMs = 10 * 60 * 1000) {
    if (this._cleanupTimer) return;
    this._cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, intervalMs);
    this._cleanupTimer.unref?.();
  }

  stopScheduler() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  reset() {
    this.conversations.clear();
    this.summaries.clear();
    this.entityContexts.clear();
    this.stats = {
      recordedMessages: 0,
      recordedEntities: 0,
      trimmedCount: 0,
      summarizedCount: 0,
      expiredConversations: 0
    };
  }

  getStats() {
    let totalMessages = 0;
    let approxBytes = 0;

    for (const turns of this.conversations.values()) {
      totalMessages += turns.length;
      try {
        approxBytes += JSON.stringify(turns).length;
      } catch {}
    }

    return {
      activeConversations: this.conversations.size,
      totalTurns: totalMessages,
      approximateSerializedBytes: approxBytes,
      guildsTracked: this.entityContexts.size,
      historicalStats: { ...this.stats }
    };
  }
}

export const defaultConversationMemoryManager = new ConversationMemoryManager();
