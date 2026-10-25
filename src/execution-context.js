import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { Logger } from './logger.js';

const logger = new Logger('ExecutionContext');

function getCacheValues(cache) {
  if (!cache) return [];
  if (Array.isArray(cache)) return cache;
  if (typeof cache.values === 'function') return Array.from(cache.values());
  return [];
}

function normalizeName(str) {
  if (!str) return '';
  return String(str)
    .replace(/^[\s#@\p{Emoji}\p{Punctuation}\u30FB\u2022\u25AA\u25AB\u2013\u2014\-・|]+/gu, '')
    .replace(/[\s#@\p{Emoji}\p{Punctuation}\u30FB\u2022\u25AA\u25AB\u2013\u2014\-・|]+$/gu, '')
    .trim()
    .toLowerCase();
}

function findInCache(cache, predicate) {
  if (!cache) return null;
  if (typeof cache.find === 'function') return cache.find(predicate);
  if (typeof cache.values === 'function') {
    return Array.from(cache.values()).find(predicate);
  }
  return null;
}

/**
 * Encapsulates the execution context of a Discord interaction.
 * Provides targeted, scoped lookups without discovering the entire guild unless explicitly requested.
 */
export class ExecutionContext {
  constructor(interaction, executionId = Logger.generateExecutionId()) {
    this.interaction = interaction;
    this.executionId = executionId;
    this.guild = interaction.guild;
    this.channel = interaction.channel;
    this.invokingMember = interaction.member;
    this.invokingUser = interaction.user;
    this.createdAt = Date.now();

    // Cache of resolved targets within this execution
    this.targetCache = new Map();
  }

  /**
   * Returns a minimal context snapshot suitable for lightweight intent interpretation.
   * Keeps token usage minimal (< 100 tokens).
   */
  getCompactContext() {
    return {
      guild: {
        id: this.guild?.id,
        name: this.guild?.name,
        boostTier: this.guild?.premiumTier || 0
      },
      currentChannel: this.channel ? {
        id: this.channel.id,
        name: this.channel.name,
        type: this.channel.type
      } : null,
      invokingUser: {
        id: this.invokingUser?.id,
        tag: this.invokingUser?.tag
      }
    };
  }

  /**
   * Resolves a target resource using the shortest reliable path:
   * 1. Relative keyword ('this', 'here', 'current') -> Current Channel
   * 2. Discord Mention (<#id>, <@id>, <@&id>) -> Direct ID extraction
   * 3. Direct Snowflake ID
   * 4. Discord.js Cache lookup (O(1) without API calls)
   * 5. Targeted API fetch (only if not found in cache)
   * NEVER performs full-server enumeration unless resourceType is explicitly 'collection'.
   */
  async resolveTarget(reference, resourceType = 'channel') {
    if (!reference || !this.guild) return null;

    const refStr = String(reference).trim();
    const cacheKey = `${resourceType}:${refStr.toLowerCase()}`;
    if (this.targetCache.has(cacheKey)) {
      return this.targetCache.get(cacheKey);
    }

    let resolved = null;

    // 1. Current Channel contextual resolution
    if (resourceType === 'channel' && /^(this(\s+channel)?|here|current(\s+channel)?|this-channel|my-channel)$/i.test(refStr)) {
      resolved = this.channel;
      if (resolved) {
        this.targetCache.set(cacheKey, resolved);
        return resolved;
      }
    }

    // 2. Mention extraction
    let cleanId = refStr;
    const channelMention = refStr.match(/^<#(\d+)>$/);
    const userMention = refStr.match(/^<@!?(\d+)>$/);
    const roleMention = refStr.match(/^<@&(\d+)>$/);

    if (channelMention) cleanId = channelMention[1];
    else if (userMention) cleanId = userMention[1];
    else if (roleMention) cleanId = roleMention[1];

    const isSnowflake = /^\d{17,20}$/.test(cleanId);

    switch (resourceType) {
      case 'channel': {
        // Targeted ID lookup
        if (isSnowflake && this.guild.channels?.cache) {
          resolved = this.guild.channels.cache.get(cleanId);
          if (!resolved && typeof this.guild.channels?.fetch === 'function') {
            try {
              resolved = await this.guild.channels.fetch(cleanId);
            } catch (err) {
              logger.debug(`Targeted channel fetch failed for ID ${cleanId}: ${err.message}`);
            }
          }
        }

        // Targeted Name lookup with normalization (handles emojis, middle dots, decorative prefixes)
        if (!resolved && this.guild.channels?.cache) {
          const cleanName = refStr.replace(/^#/, '').toLowerCase();
          const normRef = normalizeName(cleanName);

          // 1. Exact name match
          resolved = findInCache(this.guild.channels.cache, c => c.name?.toLowerCase() === cleanName);

          // 2. Normalized name match (e.g. "announce" matches "📢・announce" or "📢-announce")
          if (!resolved && normRef) {
            resolved = findInCache(this.guild.channels.cache, c => normalizeName(c.name) === normRef);
          }

          // 3. Substring inclusion
          if (!resolved && normRef.length >= 3) {
            resolved = findInCache(this.guild.channels.cache, c => {
              const cNorm = normalizeName(c.name);
              return cNorm.includes(normRef) || normRef.includes(cNorm);
            });
          }

          // 4. Cold cache fetch fallback
          if (!resolved && typeof this.guild.channels?.fetch === 'function') {
            try {
              const fetched = await this.guild.channels.fetch();
              const channels = getCacheValues(fetched);
              resolved = channels.find(c => c.name?.toLowerCase() === cleanName) ||
                         channels.find(c => normalizeName(c.name) === normRef) ||
                         channels.find(c => {
                           const cNorm = normalizeName(c.name);
                           return normRef.length >= 3 && (cNorm.includes(normRef) || normRef.includes(cNorm));
                         });
            } catch (err) {
              logger.debug(`Channel cache fetch failed: ${err.message}`);
            }
          }
        }
        break;
      }

      case 'role': {
        // Targeted ID lookup
        if (isSnowflake && this.guild.roles?.cache) {
          resolved = this.guild.roles.cache.get(cleanId);
          if (!resolved && typeof this.guild.roles?.fetch === 'function') {
            try {
              resolved = await this.guild.roles.fetch(cleanId);
            } catch (err) {
              logger.debug(`Targeted role fetch failed for ID ${cleanId}: ${err.message}`);
            }
          }
        }

        // Targeted Name lookup
        if (!resolved && this.guild.roles?.cache) {
          const cleanName = refStr.replace(/^@/, '').toLowerCase();
          const normRef = normalizeName(cleanName);

          resolved = findInCache(this.guild.roles.cache, r => r.name?.toLowerCase() === cleanName) ||
                     findInCache(this.guild.roles.cache, r => normalizeName(r.name) === normRef);

          if (!resolved && typeof this.guild.roles?.fetch === 'function') {
            try {
              const fetched = await this.guild.roles.fetch();
              const roles = getCacheValues(fetched);
              resolved = roles.find(r => r.name?.toLowerCase() === cleanName) ||
                         roles.find(r => normalizeName(r.name) === normRef);
            } catch (err) {
              logger.debug(`Role cache fetch failed: ${err.message}`);
            }
          }
        }
        break;
      }

      case 'member': {
        // Targeted ID lookup
        if (isSnowflake && this.guild.members?.cache) {
          resolved = this.guild.members.cache.get(cleanId);
          if (!resolved && typeof this.guild.members?.fetch === 'function') {
            try {
              resolved = await this.guild.members.fetch(cleanId);
            } catch (err) {
              logger.debug(`Targeted member fetch failed for ID ${cleanId}: ${err.message}`);
            }
          }
        }

        // Targeted Username lookup
        if (!resolved && this.guild.members?.cache) {
          const cleanUsername = refStr.replace(/^@/, '').toLowerCase();
          const normRef = normalizeName(cleanUsername);

          resolved = findInCache(this.guild.members.cache, m => 
            m.user?.username?.toLowerCase() === cleanUsername || 
            m.displayName?.toLowerCase() === cleanUsername ||
            normalizeName(m.user?.username) === normRef ||
            normalizeName(m.displayName) === normRef
          );

          if (!resolved && typeof this.guild.members?.fetch === 'function') {
            try {
              const fetched = await this.guild.members.fetch({ query: cleanUsername, limit: 5 });
              const members = getCacheValues(fetched);
              resolved = members[0] || null;
            } catch (err) {
              logger.debug(`Member query fetch failed: ${err.message}`);
            }
          }
        }
        break;
      }
    }

    if (resolved) {
      this.targetCache.set(cacheKey, resolved);
    }

    return resolved;
  }
}
