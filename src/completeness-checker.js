import { resolveColor } from './color-utils.js';
import { Logger } from './logger.js';

const logger = new Logger('CompletenessChecker');

/**
 * Deterministic Request-Completeness Verification Engine.
 * Runs between planning and execution.
 * Ensures no requested action, property, target restriction, or filter is silently discarded.
 */
export class CompletenessChecker {
  /**
   * Evaluates the user prompt against the proposed execution plan.
   * Completes missing operations where deterministically possible, or rejects incomplete plans.
   */
  static verify(userPrompt, plan, executionContext = {}) {
    const prompt = String(userPrompt || '').trim();
    const promptLower = prompt.toLowerCase();
    const errors = [];
    let actions = Array.isArray(plan?.actions) ? [...plan.actions] : [];

    // =========================================================================
    // 1. SEARCH VS MUTATE INVARIANT
    // "Find a message must not cause a mutation unless the user explicitly requests one."
    // =========================================================================
    const isSearchOnly = /(?:find|search|look\s*for|check|locate)\s+(?:a\s+|the\s+|any\s+)?messages?/i.test(prompt) &&
                         !/(?:delete|purge|remove|erase|clear|wipe)/i.test(prompt);

    if (isSearchOnly) {
      // Ensure no deletion actions exist in a search-only request
      const hasDestructiveAction = actions.some(a => a.action === 'purge_messages' || a.action === 'delete_message');
      if (hasDestructiveAction) {
        logger.warn('CompletenessChecker: Neutralized destructive action in search-only request');
        actions = actions.filter(a => a.action !== 'purge_messages' && a.action !== 'delete_message');
      }

      // Ensure search action is present
      if (!actions.some(a => a.action === 'search_messages')) {
        const queryMatch = prompt.match(/(?:containing|with(?:\s+the)?\s+text|saying|for)\s+["']?([^"']+)["']?/i);
        const query = queryMatch ? queryMatch[1].trim() : prompt.replace(/^(?:find|search|look\s+for)\s+(?:a\s+|the\s+)?messages?\s*/i, '').trim();
        actions.push({
          action: 'search_messages',
          targetChannel: 'current',
          contains: query || undefined
        });
      }
    }

    // =========================================================================
    // 2. MESSAGE DELETION FILTER & SCOPE INVARIANTS
    // "A missing target restriction must never turn a narrow request into a broader action."
    // =========================================================================
    const isDeleteMessageRequest = /(?:delete|purge|remove|clear)\s+(?:my\s+|the\s+|all\s+)?messages?/i.test(prompt);

    if (isDeleteMessageRequest) {
      // Check for author restriction: "my messages", "messages from Alex", "Alex's messages"
      const myMessagesMatch = /(?:delete|purge|remove|clear)\s+my\s+messages?/i.test(prompt) ||
                             /messages?\s+from\s+(?:me|myself)/i.test(prompt);

      const fromAuthorMatch = prompt.match(/(?:delete|purge|remove|clear)\s+messages?\s+(?:from|by|sent\s+by)\s+(<@!?\d+>|@?[\w.-]+)/i) ||
                              prompt.match(/(?:delete|purge|remove|clear)\s+(<@!?\d+>|@?[\w.-]+)'s\s+messages?/i);

      for (let i = 0; i < actions.length; i++) {
        if (actions[i].action === 'purge_messages') {
          const act = { ...actions[i] };

          // If user requested "my messages", author must be bound to invoking user
          if (myMessagesMatch) {
            act.author = 'me';
            act.authorId = executionContext.invokingUser?.id || 'me';
          } else if (fromAuthorMatch) {
            const authorTarget = fromAuthorMatch[1].replace(/^@/, '');
            if (!/^(all|every|the|recent)$/i.test(authorTarget)) {
              act.author = authorTarget;
            }
          }

          // Check if user requested text content filtering
          const textMatch = prompt.match(/(?:containing|with(?:\s+the)?\s+text|saying)\s+["']?([^"']+)["']?/i);
          if (textMatch && !act.contains) {
            act.contains = textMatch[1].trim();
          }

          actions[i] = act;
        }
      }

      // If prompt requested "delete my messages" but plan has no purge action, create it
      if (myMessagesMatch && !actions.some(a => a.action === 'purge_messages')) {
        actions.push({
          action: 'purge_messages',
          targetChannel: 'current',
          author: 'me',
          authorId: executionContext.invokingUser?.id || 'me',
          count: 25
        });
      }
    }

    // =========================================================================
    // 3. ROLE MULTI-PROPERTY & COMPLETENESS INVARIANTS
    // "Example: Rename the Moderator role to Community Moderator and change its color to dark red."
    // The execution plan must contain distinct operations for each requested property change.
    // =========================================================================
    const hasRoleRename = /(?:rename|change\s+(?:the\s+)?name\s+of)\s+(?:the\s+)?(?:role\s+)?@?([\w\s.-]+?)\s+(?:role\s+)?to\s+([^,;]+?)(?=[,;]|(?:\s+(?:and|with))|$)/i.test(prompt);
    const hasRoleColor = /(?:(?:set|change|update)\s+(?:its\s+|the\s+)?color\s+(?:to|as)?|recolor\s+(?:it\s+to)?)\s+([#\w]+(?:\s+[\w]+)?)/i.test(prompt);
    const hasRoleHoist = /(?:enable\s+display\s+separately|display\s+separately|hoist\s*(?:role|it)?)/i.test(prompt);

    if (hasRoleRename && hasRoleColor) {
      // Extract target role, new name, and color
      const renameMatch = prompt.match(/(?:rename|change\s+(?:the\s+)?name\s+of)\s+(?:the\s+)?(?:role\s+)?@?([\w\s.-]+?)\s+(?:role\s+)?to\s+([^,;]+?)(?=[,;]|(?:\s+(?:and|with))|$)/i);
      const colorMatch = prompt.match(/(?:(?:set|change|update)\s+(?:its\s+|the\s+)?color\s+(?:to|as)?|recolor\s+(?:it\s+to)?)\s+([#\w]+(?:\s+[\w]+)?)/i);

      if (renameMatch && colorMatch) {
        const targetRole = renameMatch[1].trim().replace(/^@/, '');
        const newName = renameMatch[2].trim().replace(/^["']|["']$/g, '');
        const rawColor = colorMatch[1].trim().replace(/^["']|["']$/g, '');
        const resolvedColor = resolveColor(rawColor);

        if (!resolvedColor) {
          errors.push(`Could not resolve role color "${rawColor}". Please specify a valid hex color code (e.g. #8B0000) or standard color name.`);
        } else {
          // Check if plan already has both distinct operations
          const hasRenameAction = actions.some(a => a.action === 'edit_role' && a.name && a.name.toLowerCase() === newName.toLowerCase());
          const hasColorAction = actions.some(a => a.action === 'edit_role' && a.color && a.color.toUpperCase() === resolvedColor.toUpperCase());

          if (!hasRenameAction || !hasColorAction) {
            // Rebuild/complete actions array with distinct operations as required by Core Requirement 1
            const otherActions = actions.filter(a => a.action !== 'edit_role');
            actions = [
              ...otherActions,
              { action: 'edit_role', targetRole, name: newName },
              { action: 'edit_role', targetRole: newName, color: resolvedColor }
            ];

            if (hasRoleHoist) {
              actions.push({ action: 'edit_role', targetRole: newName, hoist: true });
            }
            logger.info('CompletenessChecker: Completed multi-property role operations into distinct actions', { targetRole, newName, color: resolvedColor });
          }
        }
      }
    } else if (hasRoleRename && !actions.some(a => a.action === 'edit_role' && a.name)) {
      const renameMatch = prompt.match(/(?:rename|change\s+(?:the\s+)?name\s+of)\s+(?:the\s+)?(?:role\s+)?@?([\w\s.-]+?)\s+(?:role\s+)?to\s+([a-zA-Z0-9_\s-]+?)(?:\s+(?:and|with|,|;|$))/i);
      if (renameMatch) {
        const targetRole = renameMatch[1].trim().replace(/^@/, '');
        const newName = renameMatch[2].trim().replace(/^["']|["']$/g, '');
        actions.push({ action: 'edit_role', targetRole, name: newName });
      }
    } else if (hasRoleColor && !actions.some(a => a.action === 'edit_role' && a.color)) {
      const colorMatch = prompt.match(/(?:(?:set|change|update)\s+(?:the\s+)?color\s+of\s+(?:role\s+)?@?([\w\s.-]+?)\s+to\s+([#a-zA-Z0-9_\s-]+)|(?:change|set)\s+(?:role\s+)?@?([\w\s.-]+?)\s+color\s+to\s+([#a-zA-Z0-9_\s-]+))/i);
      if (colorMatch) {
        const targetRole = (colorMatch[1] || colorMatch[3]).trim().replace(/^@/, '');
        const rawColor = (colorMatch[2] || colorMatch[4]).trim().replace(/^["']|["']$/g, '');
        const resolvedColor = resolveColor(rawColor);
        if (resolvedColor) {
          actions.push({ action: 'edit_role', targetRole, color: resolvedColor });
        } else {
          errors.push(`Could not resolve role color "${rawColor}".`);
        }
      }
    }

    // =========================================================================
    // 4. NICKNAME ACCURACY & REMOVAL INVARIANTS
    // "Distinguish member's server nickname from global Discord username. Handle removal as distinct operation."
    // =========================================================================
    const isNicknameRequest = /(?:change|set|rename|update|remove|reset|clear)\s+(?:my\s+|[\w.-]+'s\s+)?(?:server\s+)?nickname/i.test(prompt);

    if (isNicknameRequest) {
      const isMyNickname = /(?:my\s+(?:server\s+)?nickname|nickname\s+for\s+me|my\s+name\s+to)/i.test(prompt);
      const isRemoval = /(?:remove|reset|clear)\s+(?:[\w.-]+'s\s+|my\s+)?(?:server\s+)?nickname/i.test(prompt);

      let targetMember = isMyNickname ? 'me' : null;
      if (!targetMember) {
        const memberMatch = prompt.match(/(?:change|set|rename|update|remove|reset|clear)\s+(<@!?\d+>|@?[\w.-]+)'s\s+(?:server\s+)?nickname/i) ||
                            prompt.match(/(?:nickname\s+of\s+(?:the\s+member\s+)?(?:i\s+just\s+mentioned|(?<target><@!?\d+>|@?[\w.-]+)))/i);
        if (memberMatch) {
          targetMember = (memberMatch.groups?.target || memberMatch[1]).replace(/^@/, '');
        }
      }

      let newNickname = null;
      if (!isRemoval) {
        const nickMatch = prompt.match(/(?:to|as)\s+["']?([^"']+)["']?$/i) ||
                          prompt.match(/(?:to|as)\s+([a-zA-Z0-9_\s-]+?)(?:\s+in\s+this\s+server|$)/i);
        if (nickMatch) {
          newNickname = nickMatch[1].trim();
        }
      }

      // Ensure nickname action exists and adheres to exact parameters
      const existingNickIdx = actions.findIndex(a => a.action === 'change_nickname');
      if (existingNickIdx >= 0) {
        const act = { ...actions[existingNickIdx] };
        if (targetMember && (!act.targetMember || act.targetMember === 'current')) {
          act.targetMember = targetMember;
        }
        if (isRemoval) {
          act.nickname = null;
        } else if (newNickname && !act.nickname) {
          act.nickname = newNickname;
        }
        actions[existingNickIdx] = act;
      } else if (targetMember) {
        actions.push({
          action: 'change_nickname',
          targetMember,
          nickname: isRemoval ? null : (newNickname || 'Member')
        });
      }
    }

    // =========================================================================
    // 5. NEGATIVE CONSTRAINTS ENFORCEMENT
    // =========================================================================
    const negativeChannelMatch = prompt.match(/(?:do\s+not|don't|except)\s+(?:delete|modify|touch)\s+(?:#?([a-zA-Z0-9_-]+)|<#(\d+)>)/i);
    if (negativeChannelMatch) {
      const excluded = (negativeChannelMatch[2] || negativeChannelMatch[1]).toLowerCase();
      const forbiddenAction = actions.find(a => 
        (a.action.includes('channel') || a.action.includes('delete')) &&
        (String(a.targetChannel || a.targetRef).toLowerCase() === excluded)
      );
      if (forbiddenAction) {
        errors.push(`Negative constraint violation: Action on #${excluded} was explicitly forbidden by user prompt.`);
      }
    }

    const isValid = errors.length === 0 && actions.length > 0;

    return {
      valid: isValid,
      errors,
      repairedPlan: {
        thoughtProcess: plan?.thoughtProcess || 'Validated plan',
        isHighImpact: Boolean(plan?.isHighImpact),
        clarificationNeeded: errors.length > 0 ? errors[0] : null,
        actions
      }
    };
  }
}
