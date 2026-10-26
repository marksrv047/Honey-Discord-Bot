import { CONTEXT_RESOLUTION_RULES } from './modules/context-resolution.js';

/**
 * Context and Follow-Up Reference Resolver
 * 
 * Binds pronouns and conversational anaphora ("it", "that role", "him", "again", "instead")
 * to recent guild-scoped interaction state.
 */
export class ContextResolver {
  /**
   * Resolves contextual references in an instruction against recent context.
   * @param {string} prompt Raw instruction
   * @param {object} recentContext State from ContextManager or ActionLedger
   * @param {string} guildId Current guild ID (enforces strict server isolation)
   */
  static resolve(prompt, recentContext = {}, guildId = null) {
    if (!prompt || typeof prompt !== 'string') {
      return { resolvedPrompt: prompt, resolvedEntities: {}, isContextual: false };
    }

    const clean = prompt.trim();
    let resolvedPrompt = clean;
    const resolvedEntities = {};
    let isContextual = false;

    // Check guild isolation
    if (recentContext.guildId && guildId && recentContext.guildId !== guildId) {
      // Cross-guild context isolation violated: discard context
      return { resolvedPrompt: prompt, resolvedEntities: {}, isContextual: false };
    }

    // 1. "Do that again" / "Repeat last action"
    if (/^(?:do\s+that\s+again|repeat\s+(?:that|last\s+action))$/i.test(clean)) {
      if (recentContext.lastAction) {
        return {
          resolvedPrompt: `repeat ${recentContext.lastAction}`,
          resolvedEntities: {
            action: recentContext.lastAction,
            target: recentContext.lastTarget
          },
          isContextual: true
        };
      }
    }

    // 2. "Make it private" / "Lock it"
    if (/^(?:make\s+it\s+private|lock\s+it)$/i.test(clean) && recentContext.lastChannel) {
      resolvedEntities.targetChannel = recentContext.lastChannel;
      return {
        resolvedPrompt: `lock channel ${recentContext.lastChannel}`,
        resolvedEntities,
        isContextual: true
      };
    }

    // 3. "Change it to <color> instead"
    const colorMatch = clean.match(/^(?:change|make)\s+it\s+(?:to\s+)?([#\w]+)(?:\s+instead)?$/i);
    if (colorMatch && !/\b(?:private|public)\b/i.test(colorMatch[1]) && recentContext.lastCreatedRole) {
      const newColor = colorMatch[1];
      resolvedEntities.targetRole = recentContext.lastCreatedRole;
      resolvedEntities.color = newColor;
      return {
        resolvedPrompt: `edit role ${recentContext.lastCreatedRole} color ${newColor}`,
        resolvedEntities,
        isContextual: true
      };
    }

    // 4. "Give that role to <user>" / "Give it to <user>" / "Give that to <user>"
    const assignMatch = clean.match(/^give\s+(?:that\s+role|it|that)\s+to\s+(@?\w+)(?:\s+too)?$/i);
    const targetRole = recentContext.lastCreatedRole || recentContext.lastRole;
    if (assignMatch && targetRole) {
      const targetUser = assignMatch[1];
      resolvedEntities.targetRole = targetRole;
      resolvedEntities.targetMember = targetUser;
      return {
        resolvedPrompt: `assign role ${targetRole} to ${targetUser}`,
        resolvedEntities,
        isContextual: true
      };
    }

    // 5. "Change that to <color>" / "Make that <color>"
    const changeThatColorMatch = clean.match(/^(?:change|make)\s+that\s+(?:to\s+)?([#\w]+)(?:\s+instead)?$/i);
    if (changeThatColorMatch && !/\b(?:private|public)\b/i.test(changeThatColorMatch[1]) && targetRole) {
      const newColor = changeThatColorMatch[1];
      resolvedEntities.targetRole = targetRole;
      resolvedEntities.color = newColor;
      return {
        resolvedPrompt: `edit role ${targetRole} color ${newColor}`,
        resolvedEntities,
        isContextual: true
      };
    }

    // 6. "Delete the old one"
    if (/^delete\s+(?:the\s+)?old\s+one$/i.test(clean)) {
      if (recentContext.lastCreatedChannel) {
        resolvedEntities.targetChannel = recentContext.lastCreatedChannel;
        return {
          resolvedPrompt: `delete channel ${recentContext.lastCreatedChannel}`,
          resolvedEntities,
          isContextual: true
        };
      }
      if (recentContext.lastCreatedRole) {
        resolvedEntities.targetRole = recentContext.lastCreatedRole;
        return {
          resolvedPrompt: `delete role ${recentContext.lastCreatedRole}`,
          resolvedEntities,
          isContextual: true
        };
      }
    }

    // 7. "Do the same thing here"
    if (/^do\s+the\s+same\s+thing\s+here$/i.test(clean)) {
      if (recentContext.lastAction) {
        return {
          resolvedPrompt: `${recentContext.lastAction} in current channel`,
          resolvedEntities: {
            action: recentContext.lastAction,
            targetChannel: 'current'
          },
          isContextual: true
        };
      }
    }

    // 8. "Play the second result" / "Play result 2" / "Play #2"
    const secondResultMatch = clean.match(/^play\s+(?:the\s+)?(?:second|2nd|#?2)\s+result$/i);
    if (secondResultMatch) {
      const results = recentContext.lastSearchResults;
      const secondTrack = Array.isArray(results) && results.length >= 2 ? results[1] : null;
      if (secondTrack) {
        const query = typeof secondTrack === 'string' ? secondTrack : secondTrack.title || secondTrack.url;
        resolvedEntities.query = query;
        return {
          resolvedPrompt: `play ${query}`,
          resolvedEntities,
          isContextual: true
        };
      }
    }

    // 9. "Undo what you just did" / "Undo that"
    if (/^undo\s+(?:what\s+you\s+(?:just\s+)?did|that)$/i.test(clean)) {
      return {
        resolvedPrompt: 'undo',
        resolvedEntities: { action: 'undo' },
        isContextual: true
      };
    }

    // 10. "Skip it" / "Pause it"
    if (/^skip\s+it$/i.test(clean)) {
      return {
        resolvedPrompt: 'skip track',
        resolvedEntities: { action: 'music_skip' },
        isContextual: true
      };
    }

    if (/^pause\s+it$/i.test(clean)) {
      return {
        resolvedPrompt: 'pause music',
        resolvedEntities: { action: 'music_pause' },
        isContextual: true
      };
    }

    return {
      resolvedPrompt,
      resolvedEntities,
      isContextual
    };
  }
}
