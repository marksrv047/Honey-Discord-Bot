import { Logger } from './logger.js';

const logger = new Logger('MemberResolver');

function getCacheValues(cache) {
  if (!cache) return [];
  if (Array.isArray(cache)) return cache;
  if (typeof cache.values === 'function') return Array.from(cache.values());
  return [];
}

export function normalizeName(str) {
  if (!str) return '';
  return String(str)
    .replace(/^[\s#@\p{Emoji}\p{Punctuation}\u30FB\u2022\u25AA\u25AB\u2013\u2014\-・|]+/gu, '')
    .replace(/[\s#@\p{Emoji}\p{Punctuation}\u30FB\u2022\u25AA\u25AB\u2013\u2014\-・|]+$/gu, '')
    .trim()
    .toLowerCase();
}

/**
 * Shared Member Target Resolver Service.
 * Implements strict 6-stage hierarchical target resolution:
 * 1. Explicit Discord user mention (<@ID>, <@!ID>)
 * 2. Explicit Discord snowflake user ID (17-20 digits)
 * 3. Invoking user identity ("me", "my", "myself", "self", "i")
 * 4. Contextual reference ("that user", "that member", "the member i just mentioned")
 * 5. Scoped guild member cache lookup (exact username/tag/nickname/displayName, normalized)
 * 6. Carefully bounded API fetch lookup (query with limit: 10)
 * 
 * Enforces ambiguity detection: if multiple candidates match, returns an ambiguity report
 * with candidate IDs, tags, and nicknames instead of picking an arbitrary member.
 * Enforces cross-guild isolation: rejects targets outside the interaction guild.
 */
export class MemberResolver {
  /**
   * Resolves a member reference within a guild context.
   * @param {import('discord.js').Guild} guild 
   * @param {string|object} reference 
   * @param {object} context - ExecutionContext or similar options object
   * @returns {Promise<import('discord.js').GuildMember|object|null>}
   */
  static async resolveMember(guild, reference, context = {}) {
    if (!guild) return null;
    if (!reference) return null;

    // 0. If reference is already an object resembling a GuildMember
    if (typeof reference === 'object') {
      if (reference.isAmbiguous) return reference;
      // Cross-guild check
      if (reference.guild && reference.guild.id && reference.guild.id !== guild.id) {
        logger.warn('Rejected cross-guild member reference', {
          targetGuildId: reference.guild.id,
          expectedGuildId: guild.id
        });
        return null;
      }
      if (reference.user?.id || reference.id) {
        return reference;
      }
    }

    const refStr = String(reference).trim();
    if (!refStr) return null;

    // 1. Explicit Discord user mention (<@123456789012345678> or <@!123456789012345678>)
    const mentionMatch = refStr.match(/^<@!?(\d{17,20})>$/);
    if (mentionMatch) {
      const snowflake = mentionMatch[1];
      const member = await this._fetchMemberById(guild, snowflake);
      if (member) return this._recordResolved(member, context);
      return null;
    }

    // 2. Explicit Discord user ID (17-20 digit snowflake)
    if (/^\d{17,20}$/.test(refStr)) {
      const member = await this._fetchMemberById(guild, refStr);
      if (member) return this._recordResolved(member, context);
      return null;
    }

    // 3. Invoking user identity ("me", "my", "myself", "self", "i")
    if (/^(?:me|my|myself|self|i)$/i.test(refStr)) {
      if (context.invokingMember && (!context.invokingMember.guild || context.invokingMember.guild.id === guild.id)) {
        return this._recordResolved(context.invokingMember, context);
      }
      if (context.invokingUser?.id) {
        const member = await this._fetchMemberById(guild, context.invokingUser.id);
        if (member) return this._recordResolved(member, context);
      }
    }

    // 4. Contextual reference ("that user", "that member", "the member i just mentioned", "the user i just mentioned")
    if (/(?:that\s+user|that\s+member|the\s+member\s+i\s+just\s+mentioned|the\s+user\s+i\s+just\s+mentioned)/i.test(refStr)) {
      const lastTargeted = context.targetCache?.get?.('last_targeted_member');
      if (lastTargeted && (!lastTargeted.guild || lastTargeted.guild.id === guild.id)) {
        return lastTargeted;
      }
    }

    // 5. Scoped guild member cache lookup
    const cleanName = refStr.replace(/^@/, '').trim();
    const cleanLower = cleanName.toLowerCase();
    const normRef = normalizeName(cleanName);

    const cachedMembers = getCacheValues(guild.members?.cache);
    const matchedMap = new Map();

    const addMatch = (m) => {
      if (m && m.id && !matchedMap.has(m.id)) {
        // Enforce cross-guild validation
        if (!m.guild || m.guild.id === guild.id) {
          matchedMap.set(m.id, m);
        }
      }
    };

    // Priority 5a: Exact matches in cache (username, discriminator tag, nickname, display name)
    for (const m of cachedMembers) {
      const username = m.user?.username?.toLowerCase();
      const tag = m.user?.tag?.toLowerCase();
      const nickname = m.nickname?.toLowerCase();
      const displayName = m.displayName?.toLowerCase();

      if (username === cleanLower || tag === cleanLower || nickname === cleanLower || displayName === cleanLower) {
        addMatch(m);
      }
    }

    // Priority 5b: Normalized matches if no exact match found
    if (matchedMap.size === 0 && normRef.length >= 2) {
      for (const m of cachedMembers) {
        const normUsername = normalizeName(m.user?.username);
        const normNick = normalizeName(m.nickname);
        const normDisplay = normalizeName(m.displayName);

        if (normUsername === normRef || normNick === normRef || normDisplay === normRef) {
          addMatch(m);
        }
      }
    }

    // Handle cached results
    if (matchedMap.size > 1) {
      return this._buildAmbiguityResponse(cleanName, Array.from(matchedMap.values()));
    }
    if (matchedMap.size === 1) {
      return this._recordResolved(Array.from(matchedMap.values())[0], context);
    }

    // 6. Carefully bounded API fetch lookup (query with limit: 10)
    if (typeof guild.members?.fetch === 'function') {
      try {
        const fetched = await guild.members.fetch({ query: cleanName, limit: 10 });
        const fetchedList = getCacheValues(fetched);

        const fetchedMap = new Map();
        for (const m of fetchedList) {
          if (m && m.id && !fetchedMap.has(m.id)) {
            if (!m.guild || m.guild.id === guild.id) {
              fetchedMap.set(m.id, m);
            }
          }
        }

        if (fetchedMap.size > 1) {
          return this._buildAmbiguityResponse(cleanName, Array.from(fetchedMap.values()));
        }
        if (fetchedMap.size === 1) {
          return this._recordResolved(Array.from(fetchedMap.values())[0], context);
        }
      } catch (err) {
        logger.debug(`Bounded member search fetch failed for "${cleanName}": ${err.message}`);
      }
    }

    return null;
  }

  /**
   * Fetches a member by snowflake ID safely.
   */
  static async _fetchMemberById(guild, snowflake) {
    if (guild.members?.cache?.has(snowflake)) {
      const m = guild.members.cache.get(snowflake);
      if (!m.guild || m.guild.id === guild.id) return m;
      return null;
    }

    if (typeof guild.members?.fetch === 'function') {
      try {
        const fetched = await guild.members.fetch(snowflake);
        if (fetched && (!fetched.guild || fetched.guild.id === guild.id)) {
          return fetched;
        }
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Records successfully resolved member in execution target cache.
   */
  static _recordResolved(member, context) {
    if (context && context.targetCache?.set && member && !member.isAmbiguous) {
      context.targetCache.set(`member:${member.id}`, member);
      context.targetCache.set('last_targeted_member', member);
    }
    return member;
  }

  /**
   * Constructs a structured ambiguity response object.
   */
  static _buildAmbiguityResponse(cleanName, candidates) {
    const candidateSummary = candidates.slice(0, 5).map(m => {
      const tag = m.user?.tag || m.user?.username || 'Unknown';
      const nick = m.nickname ? ` [Nick: "${m.nickname}"]` : '';
      const bot = m.user?.bot ? ' 🤖' : '';
      return `• **${m.displayName}** (${tag} — ID: \`${m.id}\`${nick}${bot})`;
    }).join('\n');

    return {
      isAmbiguous: true,
      candidateCount: candidates.length,
      name: cleanName,
      candidates: candidates.map(m => ({
        id: m.id,
        username: m.user?.username,
        tag: m.user?.tag || m.user?.username,
        displayName: m.displayName,
        nickname: m.nickname || null,
        isBot: Boolean(m.user?.bot)
      })),
      clarificationQuestion: `I found ${candidates.length} members named ${cleanName}. Which one did you mean?\n${candidateSummary}\n*Please specify the exact user ID or mention the member to proceed.*`
    };
  }
}
