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

    // 4. "Give that role to <user>"
    const assignMatch = clean.match(/^give\s+(?:that|the)\s+role\s+to\s+(@?\w+)(?:\s+too)?$/i);
    if (assignMatch && recentContext.lastCreatedRole) {
      const targetUser = assignMatch[1];
      resolvedEntities.targetRole = recentContext.lastCreatedRole;
      resolvedEntities.targetMember = targetUser;
      return {
        resolvedPrompt: `assign role ${recentContext.lastCreatedRole} to ${targetUser}`,
        resolvedEntities,
        isContextual: true
      };
    }

    // 5. "Skip it" / "Pause it"
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
