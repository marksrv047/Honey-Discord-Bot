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
    const isDirectRename = /^rename\s+(?:user\s+|member\s+)?(<@!?\d+>|@?[\w.-]+)\s+to\s+["']?([^"']+)["']?$/i.test(prompt);
    const isNicknameRequest = /(?:change|set|rename|update|remove|reset|clear|inspect|what\s+is)\s+(?:my\s+|[\w.-]+'s\s+)?(?:server\s+)?nickname/i.test(prompt) ||
      /(?:change|set|rename|update|remove|reset|clear)\s+(?:the\s+)?(?:server\s+)?nickname\s+(?:of|for)/i.test(prompt) ||
      isDirectRename;

    if (isNicknameRequest) {
      const isMyNickname = /(?:my\s+(?:server\s+)?nickname|nickname\s+for\s+me|rename\s+me\s+to)/i.test(prompt);
      const isRemoval = /(?:remove|reset|clear)\s+(?:[\w.-]+'s\s+|my\s+)?(?:server\s+)?nickname/i.test(prompt) ||
        /(?:remove|reset|clear)\s+(?:the\s+)?(?:server\s+)?nickname\s+(?:of|for)/i.test(prompt);
      const isInspection = /(?:what\s+is|show|inspect|check|view|get)\s+(?:[\w.-]+'s\s+|my\s+)?(?:current\s+)?(?:server\s+)?nickname/i.test(prompt) ||
        /(?:what\s+is|show|inspect|check|view|get)\s+(?:the\s+)?(?:current\s+)?(?:server\s+)?nickname\s+(?:of|for)/i.test(prompt);

      let targetMember = isMyNickname ? 'me' : null;
      if (!targetMember) {
        const directMatch = prompt.match(/^rename\s+(?:user\s+|member\s+)?(<@!?\d+>|@?[\w.-]+)\s+to\s+/i);
        const memberMatch = prompt.match(/(?:change|set|rename|update|remove|reset|clear|inspect|what\s+is)\s+(<@!?\d+>|@?[\w.-]+)['’]s\s+(?:server\s+)?nickname/i) ||
                            prompt.match(/(?:nickname\s+of\s+(?:the\s+member\s+)?(?:i\s+just\s+mentioned|(?<target><@!?\d+>|@?[\w.-]+)))/i) ||
                            prompt.match(/(?:nickname\s+(?:of|for)\s+(?<target><@!?\d+>|@?[\w.-]+))/i);
        if (directMatch) {
          const cand = directMatch[1].replace(/^@/, '');
          if (!/^channel$|^this|^role$|^server$/i.test(cand) && !cand.startsWith('#')) {
            targetMember = cand;
          }
        } else if (memberMatch) {
          targetMember = (memberMatch.groups?.target || memberMatch[1]).replace(/^@/, '');
        }
      }

      let newNickname = null;
      if (!isRemoval && !isInspection) {
        const nickMatch = prompt.match(/(?:to|as)\s+["']?([^"']+)["']?$/i) ||
                          prompt.match(/(?:to|as)\s+([a-zA-Z0-9_\s-]+?)(?:\s+in\s+this\s+server|$)/i);
        if (nickMatch) {
          newNickname = nickMatch[1].trim();
        }
      }

      if (isRemoval) {
        // Enforce remove_nickname action
        const existingRemIdx = actions.findIndex(a => a.action === 'remove_nickname' || a.action === 'change_nickname');
        if (existingRemIdx >= 0) {
          actions[existingRemIdx] = {
            action: 'remove_nickname',
            targetMember: targetMember || actions[existingRemIdx].targetMember || 'me'
          };
        } else if (targetMember) {
          actions.push({ action: 'remove_nickname', targetMember });
        }
      } else if (isInspection) {
        const existingInspIdx = actions.findIndex(a => a.action === 'inspect_nickname');
        if (existingInspIdx >= 0) {
          actions[existingInspIdx] = {
            action: 'inspect_nickname',
            targetMember: targetMember || actions[existingInspIdx].targetMember || 'me'
          };
        } else if (targetMember) {
          actions.push({ action: 'inspect_nickname', targetMember });
        }
      } else {
        // Nickname replacement: MUST have target and replacement nickname
        if (!newNickname) {
          // If user asked to change nickname without specifying replacement value, do not wipe it!
          errors.push('No replacement nickname specified. Please provide the new nickname to set (e.g. "Rename Alex to Night Owl").');
        } else {
          const existingNickIdx = actions.findIndex(a => a.action === 'change_nickname');
          if (existingNickIdx >= 0) {
            const act = { ...actions[existingNickIdx] };
            if (targetMember && (!act.targetMember || act.targetMember === 'current')) {
              act.targetMember = targetMember;
            }
            act.nickname = newNickname;
            actions[existingNickIdx] = act;
          } else if (targetMember) {
            actions.push({
              action: 'change_nickname',
              targetMember,
              nickname: newNickname
            });
          }
        }
      }
    }

    // =========================================================================
    // 5. MULTI-STEP DEPENDENCY COMPLETION & ORDERING
    // =========================================================================
    // Pattern: "Create a private moderator channel and give the moderator role access"
    const privateChannelWithRoleMatch = prompt.match(/^create\s+(?:a\s+)?private\s+([a-zA-Z0-9_-]+)\s+channel\s+and\s+(?:give|grant)\s+(?:the\s+)?([a-zA-Z0-9_\s-]+)\s+role\s+access/i);
    if (privateChannelWithRoleMatch) {
      const chName = privateChannelWithRoleMatch[1].toLowerCase();
      const roleName = privateChannelWithRoleMatch[2].trim();
      const hasCreateCh = actions.some(a => a.action === 'create_channel' && a.name?.toLowerCase() === chName);
      const hasPerm = actions.some(a => a.action === 'set_channel_permission' && a.targetChannel?.toLowerCase() === chName);

      if (!hasCreateCh) {
        actions.unshift({
          action: 'create_channel',
          name: chName,
          isPrivate: true,
          allowedRoles: [roleName]
        });
      }
      if (!hasPerm) {
        actions.push({
          action: 'set_channel_permission',
          targetChannel: chName,
          targetRoleOrMember: roleName,
          allow: ['ViewChannel', 'SendMessages']
        });
      }
    }

    // Pattern: "Create a role called VIP and assign it to Alex"
    const createRoleAndAssignMatch = prompt.match(/^create\s+(?:a\s+)?role\s+(?:called|named)\s+([a-zA-Z0-9_\s-]+)\s+and\s+(?:assign\s+it\s+to|give\s+it\s+to)\s+(<@!?\d+>|@?[\w.-]+)/i);
    if (createRoleAndAssignMatch) {
      const roleName = createRoleAndAssignMatch[1].trim();
      const targetMember = createRoleAndAssignMatch[2].trim().replace(/^@/, '');
      const hasCreateRole = actions.some(a => a.action === 'create_role' && a.name?.toLowerCase() === roleName.toLowerCase());
      const hasAssign = actions.some(a => a.action === 'assign_role' && (a.targetMember === targetMember || a.targetMember === `@${targetMember}`));

      if (!hasCreateRole) {
        actions.unshift({
          action: 'create_role',
          name: roleName
        });
      }
      if (!hasAssign) {
        actions.push({
          action: 'assign_role',
          targetRole: roleName,
          targetMember
        });
      }
    }

    // =========================================================================
    // 6. NEGATIVE CONSTRAINTS ENFORCEMENT
    // =========================================================================
    const negativeConstraints = [];

    // Channel exclusions: "except #general", "do not delete announcements", "leave #general alone", "don't touch #general"
    const channelExclusionMatches = [
      ...prompt.matchAll(/(?:do\s+not|don't|except|leave)\s+(?:delete|modify|touch)?\s*(?:#?([a-zA-Z0-9_-]+)|<#(\d+)>)(?:\s+alone)?/gi)
    ];
    for (const match of channelExclusionMatches) {
      const raw = match[2] || match[1];
      if (raw && !/^(any|all|every|the|this|a)$/i.test(raw)) {
        negativeConstraints.push({ type: 'channel', target: raw.toLowerCase().replace(/^#/, '') });
      }
    }

    // Role exclusions: "except role Moderator", "do not touch the Admin role"
    const roleExclusionMatches = [
      ...prompt.matchAll(/(?:do\s+not|don't|except)\s+(?:touch|delete|modify)?\s*(?:the\s+)?role\s+@?([a-zA-Z0-9_\s-]+)/gi)
    ];
    for (const match of roleExclusionMatches) {
      const raw = match[1]?.trim();
      if (raw && !/^(any|all|every|the)$/i.test(raw)) {
        negativeConstraints.push({ type: 'role', target: raw.toLowerCase().replace(/^@/, '') });
      }
    }

    for (const constraint of negativeConstraints) {
      const forbiddenAction = actions.find(a => {
        const actionTarget = String(a.targetChannel || a.targetRole || a.targetMember || a.targetRef || a.name || '').toLowerCase().replace(/^[#@]/, '');
        return actionTarget === constraint.target;
      });
      if (forbiddenAction) {
        errors.push(`Negative constraint violation: Action "${forbiddenAction.action}" on target "${constraint.target}" was explicitly forbidden by user prompt.`);
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
