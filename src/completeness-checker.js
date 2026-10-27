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
    // 5. MULTI-STEP INTENTS & DEPENDENCY COMPLETION
    // =========================================================================

    // A. Voice + Music: "Join the General voice channel and play this YouTube link: [URL]"
    const voiceAndMusicMatch = prompt.match(/(?:join|connect(?:\s+to)?)\s+(?:the\s+)?(?:channel\s+|voice(?:\s+channel)?\s+|vc\s+)?["'“]?([^"'“\n]+?)["'”]?\s+and\s+play\s+(?:(?:this|a)\s+)?(?:youtube\s+(?:link|video)|track|song|music)?\s*:?\s*["'“]?(.+?)["'”]?$/i);
    if (voiceAndMusicMatch) {
      const channelName = voiceAndMusicMatch[1].trim().replace(/^["'“”`]+|["'“”`]+$/g, '');
      let mediaQuery = (voiceAndMusicMatch[2] || '').trim().replace(/^["'“”`]+|["'“”`]+$/g, '');
      if (mediaQuery.startsWith(':')) mediaQuery = mediaQuery.slice(1).trim();

      const hasVoice = actions.some(a => a.action === 'connect_voice' || a.action === 'voice_join');
      const hasMusic = actions.some(a => a.action === 'music_play');

      if (!hasVoice) {
        actions.unshift({
          action: 'connect_voice',
          channelName,
          targetChannel: channelName.toLowerCase()
        });
      }
      if (!hasMusic) {
        actions.push({
          action: 'music_play',
          query: mediaQuery,
          targetChannel: channelName.toLowerCase()
        });
      } else {
        // Ensure existing music_play action is bound to the actual media query, not channel name
        for (const act of actions) {
          if (act.action === 'music_play') {
            if (!act.query || act.query === channelName || act.query === 'current') {
              act.query = mediaQuery;
              if (act.args) act.args.query = mediaQuery;
            }
          }
        }
      }
    }

    // B. Role create + color + assign: "Create a role called Event Host, make it purple, and assign it to Alex"
    const createRoleColorAssignMatch = prompt.match(/^create\s+(?:a\s+)?role\s+(?:called|named)\s+([a-zA-Z0-9_\s-]+?)(?:,\s*(?:and\s+)?|\s+and\s+)(?:make\s+it|set\s+(?:its\s+)?color\s+(?:to)?|color\s+it)\s+([#a-zA-Z0-9_\s-]+?)(?:,\s*(?:and\s+)?|\s+and\s+)(?:assign\s+it\s+to|give\s+it\s+to)\s+(<@!?\d+>|@?[\w.-]+)/i);
    if (createRoleColorAssignMatch) {
      const roleName = createRoleColorAssignMatch[1].trim();
      const rawColor = createRoleColorAssignMatch[2].trim();
      const targetMember = createRoleColorAssignMatch[3].trim().replace(/^@/, '');
      const resolvedColor = resolveColor(rawColor) || rawColor;

      const hasCreateRole = actions.some(a => a.action === 'create_role' && a.name?.toLowerCase() === roleName.toLowerCase());
      const hasColor = actions.some(a => a.action === 'edit_role' && (a.targetRole?.toLowerCase() === roleName.toLowerCase() || a.name?.toLowerCase() === roleName.toLowerCase()) && a.color);
      const hasAssign = actions.some(a => a.action === 'assign_role' && a.targetRole?.toLowerCase() === roleName.toLowerCase());

      if (!hasCreateRole) {
        actions.unshift({
          action: 'create_role',
          name: roleName
        });
      }
      if (!hasColor) {
        actions.push({
          action: 'edit_role',
          targetRole: roleName,
          color: resolvedColor
        });
      }
      if (!hasAssign) {
        actions.push({
          action: 'assign_role',
          targetRole: roleName,
          targetMember
        });
      }
    } else {
      // B2. "Create a role called VIP and assign it to Alex"
      const createRoleAndAssignMatch = prompt.match(/^create\s+(?:a\s+)?role\s+(?:called|named)\s+([a-zA-Z0-9_\s-]+?)\s+and\s+(?:assign\s+it\s+to|give\s+it\s+to)\s+(<@!?\d+>|@?[\w.-]+)/i);
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
    }

    // C0. Category + Multiple Channels: "Create a category Community and simultaneously add multiple channels under that specific category: general, memes, voice"
    // Also: "Create a category Staff and add channels mod-chat, mod-logs, announcements under that category"
    const catMultiMatch = prompt.match(/^create\s+(?:a\s+)?(?:new\s+)?(private\s+)?category\s+(?:called\s+|named\s+)?(["'#\w\s.-]+?)(?:\s*(?:&|and)\s*(?:simultaneously\s+)?(?:add|create)\s+(?:multiple\s+)?channels?(?:\s+(?:under|in|into|inside|to)\s+(?:that|the)?\s*(?:specific\s+)?category)?:?\s*|\s+with\s+(?:the\s+)?(?:following\s+)?channels?:?\s*|\s*(?:&|and)\s*(?:simultaneously\s+)?(?:add|create)\s+)(.+)$/i) ||
      prompt.match(/^create\s+(?:a\s+)?(?:new\s+)?(private\s+)?(["'#\w\s.-]+?)\s+category(?:\s*(?:&|and)\s*(?:simultaneously\s+)?(?:add|create)\s+(?:multiple\s+)?channels?(?:\s+(?:under|in|into|inside|to)\s+(?:that|the)?\s*(?:specific\s+)?category)?:?\s*|\s+with\s+(?:the\s+)?(?:following\s+)?channels?:?\s*|\s*(?:&|and)\s*(?:simultaneously\s+)?(?:add|create)\s+)(.+)$/i);

    if (catMultiMatch) {
      const isPrivate = Boolean(catMultiMatch[1]);
      const catName = catMultiMatch[2].trim().replace(/^["']|["']$/g, '');
      let channelsRaw = catMultiMatch[3].trim();

      if (catName && !/^(a|new|the|private|channel|channels)$/i.test(catName) && channelsRaw) {
        channelsRaw = channelsRaw.replace(/(?:\s+(?:under|in|into|to|inside)\s+(?:that|the|this)?\s*(?:specific\s+)?category|\s+under\s+it|\s+in\s+it|\s+inside\s+it|\s+when\s+asked\s+to\s+do\s+so)+$/i, '').trim();
        channelsRaw = channelsRaw.replace(/^(?:(?:the\s+)?(?:multiple\s+)?channels?:?\s*)/i, '').trim();

        const channelParts = channelsRaw.split(/(?:,\s*(?:and\s+)?|\s+and\s+|;\s*|\n+|&\s*)/i).map(s => s.trim()).filter(Boolean);

        // Ensure category creation action exists
        const hasCat = actions.some(a => a.action === 'create_category' && a.name?.toLowerCase() === catName.toLowerCase());
        if (!hasCat) {
          actions.unshift({
            action: 'create_category',
            name: catName,
            isPrivate
          });
        }

        for (const part of channelParts) {
          let name = part.trim().replace(/^[:#•\-*]+|[:#•\-*]+$/g, '').trim();
          if (!name) continue;

          let type = 'GUILD_TEXT';
          if (/^(?:voice\s+channel|voice\s+|vc\s+)/i.test(name) || /(?:\s+voice|\s+\(voice\))$/i.test(name) || /^voice$/i.test(name)) {
            type = 'GUILD_VOICE';
            name = name.replace(/^(?:voice\s+channel|voice\s+|vc\s+)/i, '').replace(/(?:\s+voice|\s+\(voice\))$/i, '').trim() || 'voice';
          } else if (/^(?:announcement\s+channel|announcements?\s+)/i.test(name) || /(?:\s+announcement|\s+\(announcement\))$/i.test(name)) {
            type = 'GUILD_ANNOUNCEMENT';
            name = name.replace(/^(?:announcement\s+channel|announcements?\s+)/i, '').replace(/(?:\s+announcement|\s+\(announcement\))$/i, '').trim();
          }

          name = name.replace(/(?:\s+channel|\s+channels)$/i, '').replace(/^(?:channel\s+)/i, '').trim();
          name = name.replace(/^["']|["']$/g, '').trim();

          if (name.length > 0 && !/^(?:multiple|specific|channels?)$/i.test(name)) {
            const finalName = type === 'GUILD_TEXT' ? name.toLowerCase().replace(/\s+/g, '-') : name;
            const hasCh = actions.some(a => a.action === 'create_channel' && a.name?.toLowerCase() === finalName.toLowerCase() && (!a.category || a.category.toLowerCase() === catName.toLowerCase()));
            if (!hasCh) {
              actions.push({
                action: 'create_channel',
                name: finalName,
                category: catName,
                type,
                isPrivate
              });
            }
          }
        }
      }
    }

    // C. Category + Channel + Permissions: "Create a private Support category, add a ticket channel, and give the Support Team access"
    const catAndChMatch = prompt.match(/^create\s+(?:a\s+)?(?:(private)\s+)?([a-zA-Z0-9_\s-]+?)\s+category(?:,\s*(?:and\s+)?|\s+and\s+)(?:add|create)\s+(?:a\s+)?(?:(private)\s+)?([a-zA-Z0-9_\s-]+?)\s+channel(?:(?:\s+in\s+it)?)(?:,\s*(?:and\s+)?|\s+and\s+)(?:give|grant)\s+(?:the\s+)?([a-zA-Z0-9_\s-]+?)\s+(?:role\s+)?access/i);
    if (catAndChMatch) {
      const isCatPrivate = Boolean(catAndChMatch[1]);
      const catName = catAndChMatch[2].trim();
      const isChPrivate = Boolean(catAndChMatch[3]) || isCatPrivate;
      const chName = catAndChMatch[4].trim().toLowerCase();
      const roleName = catAndChMatch[5].trim();

      const hasCat = actions.some(a => a.action === 'create_category' && a.name?.toLowerCase() === catName.toLowerCase());
      const hasCh = actions.some(a => a.action === 'create_channel' && a.name?.toLowerCase() === chName);
      const hasPerm = actions.some(a => a.action === 'set_channel_permission' && a.targetChannel?.toLowerCase() === chName);

      if (!hasCat) {
        actions.unshift({
          action: 'create_category',
          name: catName,
          isPrivate: isCatPrivate
        });
      }
      if (!hasCh) {
        actions.push({
          action: 'create_channel',
          name: chName,
          category: catName,
          isPrivate: isChPrivate
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
    } else {
      // C2. "Create a private moderator channel and give the moderator role access"
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
    }

    // D. Channel multi-property: "Rename this channel to dev-chat, update its topic to discussion, and set slowmode to 10 seconds"
    const channelMultiMatch = prompt.match(/rename\s+(?:this\s+)?channel\s+to\s+([a-zA-Z0-9_-]+)(?:,\s*(?:and\s+)?|\s+and\s+)(?:update|change|set)\s+(?:its\s+)?topic\s+to\s+([^,;]+?)(?:,\s*(?:and\s+)?|\s+and\s+)(?:set\s+)?slowmode\s+to\s+(\d+)\s*(?:s|sec|seconds)?/i);
    if (channelMultiMatch) {
      const newName = channelMultiMatch[1].trim();
      const newTopic = channelMultiMatch[2].trim();
      const slowmodeSec = parseInt(channelMultiMatch[3], 10);

      const hasRename = actions.some(a => (a.action === 'edit_channel' || a.action === 'rename_channel') && a.name === newName);
      const hasTopic = actions.some(a => (a.action === 'edit_channel' || a.action === 'edit_channel_topic') && a.topic === newTopic);
      const hasSlow = actions.some(a => (a.action === 'edit_channel' || a.action === 'set_channel_slowmode') && a.seconds === slowmodeSec);

      if (!hasRename) {
        actions.push({ action: 'edit_channel', targetChannel: 'current', name: newName });
      }
      if (!hasTopic) {
        actions.push({ action: 'edit_channel_topic', targetChannel: 'current', topic: newTopic });
      }
      if (!hasSlow) {
        actions.push({ action: 'set_channel_slowmode', targetChannel: 'current', seconds: slowmodeSec });
      }
    }

    // E. Timeout + explanation: "Timeout Alex for 10 minutes and explain why the action was taken"
    const timeoutExplainMatch = prompt.match(/^timeout\s+(<@!?\d+>|@?[\w.-]+)\s+for\s+(\d+)\s*(?:m|min|minutes?)(?:\s+(?:for|because|reason:?)\s+([^,;]+?))?(?:,\s*|\s+and\s+)(?:explain(?:\s+why\s+the\s+action\s+was\s+taken)?|send(?:\s+a)?\s+message\s+explaining)/i);
    if (timeoutExplainMatch) {
      const targetMember = timeoutExplainMatch[1].trim().replace(/^@/, '');
      const durationMinutes = parseInt(timeoutExplainMatch[2], 10);
      const reason = timeoutExplainMatch[3]?.trim() || 'Rule violation';

      const hasTimeout = actions.some(a => a.action === 'timeout_member');
      const hasMsg = actions.some(a => a.action === 'send_message');

      if (!hasTimeout) {
        actions.unshift({
          action: 'timeout_member',
          targetMember,
          durationMinutes,
          reason
        });
      }
      if (!hasMsg) {
        actions.push({
          action: 'send_message',
          targetChannel: 'current',
          content: `${targetMember} was timed out for ${durationMinutes} minutes. Reason: ${reason}.`
        });
      }
    }

    // F. Compound Role Creation + Color + Assignment + Private Channel
    // "Create a staff role, make it purple, assign it to Alex, and create a private staff channel"
    const compoundStaffMatch = prompt.match(/create\s+(?:a\s+)?([a-zA-Z0-9_\s-]+?)\s+role,\s*(?:make|set)\s+(?:it\s+)?([#\w]+),\s*(?:assign|give)\s+(?:it\s+to\s+|to\s+)(@?[\w.-]+),\s*(?:and\s+)?create\s+(?:a\s+)?private\s+([a-zA-Z0-9_-]+)(?:\s+channel)?/i);
    if (compoundStaffMatch) {
      const roleName = compoundStaffMatch[1].trim();
      const rawColor = compoundStaffMatch[2].trim();
      const targetMember = compoundStaffMatch[3].trim().replace(/^@/, '');
      const channelName = compoundStaffMatch[4].trim();
      const resolvedColor = resolveColor(rawColor) || rawColor;

      const hasRole = actions.some(a => a.action === 'create_role' && a.name?.toLowerCase() === roleName.toLowerCase());
      const hasAssign = actions.some(a => a.action === 'assign_role' && a.targetMember === targetMember);
      const hasChannel = actions.some(a => a.action === 'create_channel' && a.name?.toLowerCase() === channelName.toLowerCase());

      if (!hasRole) {
        actions.unshift({
          action: 'create_role',
          name: roleName,
          color: resolvedColor
        });
      }
      if (!hasAssign) {
        actions.push({
          action: 'assign_role',
          targetRole: roleName,
          targetMember,
          dependsOn: ['create_role']
        });
      }
      if (!hasChannel) {
        actions.push({
          action: 'create_channel',
          name: channelName,
          isPrivate: true,
          allowedRoles: [roleName],
          dependsOn: ['create_role']
        });
      }
    }

    // G. Reaction Roles & Self-Role Systems:
    // "Create a reaction-role system for choosing game roles."
    // "Build a self-role channel with selectable roles, interactive buttons, and persistent role assignment."
    // "Create a self-role system for gaming, notifications, and pronouns."
    const isSelfRoleSystem = /(?:create|set\s+up|build)\s+(?:a\s+)?(?:reaction[- ]role|self[- ]role)\s+(?:system|channel|menu|panel)/i.test(prompt) ||
                             /(?:reaction[- ]roles?|self[- ]roles?)\s+(?:for|system|channel|menu|panel)/i.test(prompt);

    if (isSelfRoleSystem) {
      let panelType = 'buttons';
      if (/reaction/i.test(prompt) && !/button/i.test(prompt)) {
        panelType = 'reactions';
      } else if (/dropdown|select\s+menu|selection/i.test(prompt) && !/button/i.test(prompt)) {
        panelType = 'select';
      }

      // Extract requested role names
      let roleNames = [];
      const colonMatch = prompt.match(/(?:for|roles?:?)\s*:?\s*([a-zA-Z0-9_,\s-]+)$/i);
      const forMatch = prompt.match(/(?:for\s+(?:choosing\s+)?(?:gaming|game\s+roles|roles?|pronouns?|notifications?|colors?)\b[\w\s,.-]*)/i);

      if (/game\s+roles|gaming/i.test(prompt) && !/:\s*[a-zA-Z]/i.test(prompt) && !/gaming,\s*notifications/i.test(prompt)) {
        roleNames = ['RPG', 'FPS', 'Strategy'];
      } else if (/gaming,\s*notifications,\s*(?:and\s+)?pronouns/i.test(prompt)) {
        roleNames = ['Gaming', 'Notifications', 'Pronouns'];
      } else if (colonMatch) {
        const parsed = colonMatch[1].split(/,\s*(?:and\s+)?|\s+and\s+/i).map(s => s.trim().replace(/^@/, '')).filter(s => s && !/^(choosing|game\s+roles|roles?|system|channel)$/i.test(s));
        if (parsed.length > 0) roleNames = parsed;
      }

      if (roleNames.length === 0) {
        roleNames = ['Member', 'Community', 'Updates'];
      }

      const channelName = /channel\s+([a-zA-Z0-9_-]+)/i.test(prompt)
        ? prompt.match(/channel\s+([a-zA-Z0-9_-]+)/i)[1].toLowerCase()
        : 'roles';

      // 1. Ensure channel creation
      const hasChannel = actions.some(a => a.action === 'create_channel' && a.name?.toLowerCase() === channelName.toLowerCase());
      if (!hasChannel) {
        actions.unshift({
          action: 'create_channel',
          name: channelName,
          type: 'GUILD_TEXT'
        });
      }

      // 2. Ensure each role creation
      for (const rName of roleNames) {
        const hasRole = actions.some(a => a.action === 'create_role' && a.name?.toLowerCase() === rName.toLowerCase());
        if (!hasRole) {
          actions.push({
            action: 'create_role',
            name: rName
          });
        }
      }

      // 3. Ensure role panel setup
      const hasPanel = actions.some(a => a.action === 'setup_role_panel' || a.action === 'setup_role_menu');
      if (!hasPanel) {
        const defaultEmojis = ['🎮', '⚔️', '🛡️', '🔔', '✨'];
        actions.push({
          action: 'setup_role_panel',
          channelName,
          panelType,
          title: panelType === 'reactions' ? '🎭 Reaction Roles' : '🎭 Self-Assignable Roles',
          description: panelType === 'reactions'
            ? 'React with the corresponding emoji to receive your role. Remove your reaction to remove the role.'
            : 'Select your server roles using the interactive controls below:',
          roles: roleNames.map((name, idx) => ({
            name,
            emoji: defaultEmojis[idx % defaultEmojis.length],
            description: `Assign or remove the @${name} role`
          }))
        });
      }
    }

    // H. Complete Welcome System:
    // "Set up a complete welcome system with an embed, a welcome channel, and appropriate permissions."
    const isWelcomeSystem = /(?:set\s+up|create)\s+(?:a\s+)?(?:complete\s+)?welcome\s+system/i.test(prompt);
    if (isWelcomeSystem) {
      const chName = 'welcome';
      const hasCh = actions.some(a => a.action === 'create_channel' && a.name?.toLowerCase() === chName);
      const hasPerm = actions.some(a => a.action === 'configure_channel_preset' && a.targetChannel?.toLowerCase() === chName);
      const hasEmbed = actions.some(a => (a.action === 'publish_embed' || a.action === 'create_embed') && a.targetChannel?.toLowerCase() === chName);

      if (!hasCh) {
        actions.unshift({
          action: 'create_channel',
          name: chName,
          type: 'GUILD_TEXT'
        });
      }
      if (!hasPerm) {
        actions.push({
          action: 'configure_channel_preset',
          targetChannel: chName,
          preset: 'welcome'
        });
      }
      if (!hasEmbed) {
        actions.push({
          action: 'publish_embed',
          targetChannel: chName,
          template: 'welcome',
          title: '👋 Welcome to the Server!',
          description: 'Welcome to our community! Please check #rules, grab your roles in #roles, and enjoy your time here.',
          footer: 'Welcome Guidelines'
        });
      }
    }

    // I. Rules Channel + Permissions + Polished Embed:
    // "Create a rules channel, configure its permissions, and publish the server rules in a polished embed."
    const isRulesChannelEmbed = /(?:create|set\s+up)\s+(?:a\s+)?(?:new\s+)?rules\s+channel.*publish.*(?:rules|embed)/i.test(prompt) ||
                                /(?:rules\s+channel.*permissions.*publish.*rules)/i.test(prompt);
    if (isRulesChannelEmbed) {
      const chName = 'rules';
      const hasCh = actions.some(a => a.action === 'create_channel' && a.name?.toLowerCase() === chName);
      const hasPerm = actions.some(a => a.action === 'configure_channel_preset' && a.targetChannel?.toLowerCase() === chName);
      const hasEmbed = actions.some(a => (a.action === 'publish_embed' || a.action === 'create_embed') && a.targetChannel?.toLowerCase() === chName);

      if (!hasCh) {
        actions.unshift({
          action: 'create_channel',
          name: chName,
          type: 'GUILD_TEXT'
        });
      }
      if (!hasPerm) {
        actions.push({
          action: 'configure_channel_preset',
          targetChannel: chName,
          preset: 'rules'
        });
      }
      if (!hasEmbed) {
        actions.push({
          action: 'publish_embed',
          targetChannel: chName,
          template: 'rules',
          title: '📜 Server Rules & Guidelines',
          description: 'Please read and follow these server rules to keep our community safe and welcoming.',
          fields: [
            { name: '1. Respect All Members', value: 'Treat everyone with kindness. Harassment, hate speech, and toxicity are strictly prohibited.', inline: false },
            { name: '2. No Spam or Self-Promotion', value: 'Keep discussions in relevant channels and do not post unsolicited links.', inline: false },
            { name: '3. Follow Discord Community Guidelines', value: 'All Discord Terms of Service and Community Guidelines apply here.', inline: false }
          ],
          footer: 'Server Administration'
        });
      }
    }

    // J. Three Roles + Embed Explaining How to Obtain Them:
    // "Create three roles, organize them, and publish an embed explaining how members can obtain them."
    const isThreeRolesEmbed = /(?:create|set\s+up)\s+(?:three|\d+)\s+roles.*publish.*embed.*obtain/i.test(prompt);
    if (isThreeRolesEmbed) {
      const rolesToCreate = ['Member', 'Contributor', 'VIP'];
      for (const rName of rolesToCreate) {
        if (!actions.some(a => a.action === 'create_role' && a.name?.toLowerCase() === rName.toLowerCase())) {
          actions.push({
            action: 'create_role',
            name: rName
          });
        }
      }

      if (!actions.some(a => a.action === 'publish_embed' || a.action === 'create_embed')) {
        actions.push({
          action: 'publish_embed',
          targetChannel: 'current',
          template: 'information',
          title: '🏆 Server Roles & How to Obtain Them',
          description: 'Overview of server roles and requirements to obtain them:',
          fields: [
            { name: '@Member', value: 'Assigned automatically to participating community members.', inline: false },
            { name: '@Contributor', value: 'Awarded to active contributors helping with projects and events.', inline: false },
            { name: '@VIP', value: 'Awarded to dedicated supporters and recognized community leaders.', inline: false }
          ],
          footer: 'Role Information Guide'
        });
      }
    }

    // K. Rich Announcement Embed with Fields, Footer, Timestamp & Buttons:
    // "Make an announcement embed with a title, description, fields, footer, timestamp, and buttons."
    const isRichAnnouncementEmbed = /(?:make|create|publish|post)\s+(?:an?\s+)?(?:announcement\s+)?embed.*(?:title|description|fields|footer|timestamp|buttons)/i.test(prompt);
    if (isRichAnnouncementEmbed) {
      if (!actions.some(a => a.action === 'publish_embed' || a.action === 'create_embed')) {
        actions.push({
          action: 'publish_embed',
          targetChannel: 'current',
          template: 'announcement',
          title: '📢 Server Announcement',
          description: 'Important community announcement and server updates.',
          fields: [
            { name: 'New Features', value: 'Interactive embeds, self-role buttons, and server automation are now active.', inline: false },
            { name: 'Getting Started', value: 'Explore the updated channels and role options.', inline: false }
          ],
          footer: 'Server Staff Team',
          timestamp: true,
          buttons: [
            { label: 'Community Guidelines', style: 'Link', url: 'https://discord.com/guidelines' },
            { label: 'Acknowledged', style: 'Success', customId: 'announce_ack' }
          ]
        });
      }
    }

    // L. Complete Onboarding Flow:
    // "Set up a complete onboarding flow, including roles, channels, instructions, and interactive components."
    const isOnboardingFlow = /(?:set\s+up|create)\s+(?:a\s+)?(?:complete\s+)?onboarding\s+flow/i.test(prompt);
    if (isOnboardingFlow) {
      // 1. Roles
      if (!actions.some(a => a.action === 'create_role' && a.name?.toLowerCase() === 'member')) {
        actions.push({ action: 'create_role', name: 'Member' });
      }
      // 2. Welcome Channel + Embed
      if (!actions.some(a => a.action === 'create_channel' && a.name?.toLowerCase() === 'welcome')) {
        actions.push({ action: 'create_channel', name: 'welcome', type: 'GUILD_TEXT' });
      }
      if (!actions.some(a => a.action === 'configure_channel_preset' && a.targetChannel?.toLowerCase() === 'welcome')) {
        actions.push({ action: 'configure_channel_preset', targetChannel: 'welcome', preset: 'welcome' });
      }
      if (!actions.some(a => a.action === 'publish_embed' && a.targetChannel?.toLowerCase() === 'welcome')) {
        actions.push({
          action: 'publish_embed',
          targetChannel: 'welcome',
          template: 'welcome',
          title: '👋 Welcome to the Community!',
          description: 'Follow the steps below to complete onboarding and get involved.'
        });
      }
      // 3. Self-Roles Channel + Panel
      if (!actions.some(a => a.action === 'create_channel' && a.name?.toLowerCase() === 'roles')) {
        actions.push({ action: 'create_channel', name: 'roles', type: 'GUILD_TEXT' });
      }
      if (!actions.some(a => a.action === 'setup_role_panel')) {
        actions.push({
          action: 'setup_role_panel',
          channelName: 'roles',
          panelType: 'buttons',
          title: '🎭 Select Your Roles',
          roles: ['Member']
        });
      }
    }

    // =========================================================================
    // 6. AMBIGUOUS TARGET VALIDATION (Do not guess missing targets)
    // =========================================================================
    const isAmbiguousChannelDelete = /^delete\s+(?:a\s+|the\s+)?channel$/i.test(prompt);
    const isAmbiguousRoleDelete = /^delete\s+(?:a\s+|the\s+)?role$/i.test(prompt);
    const isAmbiguousMemberMod = /^(?:timeout|kick|ban)\s+(?:someone|a\s+member|a\s+user)$/i.test(prompt);
    const isAmbiguousChannelRename = /^rename\s+(?:this\s+)?channel(?:,\s*update\s+its\s+topic)?(?:\s+and\s+set\s+slowmode.*)?$/i.test(prompt) && !prompt.includes(' to ');
    const isAmbiguousMultiChannelEmbed = /(?:create|publish|post)\s+several\s+(?:announcement\s+)?embeds\s+(?:and\s+publish\s+them\s+)?in\s+the\s+channels\s+i\s+specify/i.test(prompt);

    if (isAmbiguousMultiChannelEmbed) {
      errors.push('Please specify which channels to publish the announcement embeds in (e.g. "#announcements and #updates").');
    }
    if (isAmbiguousChannelDelete) {
      errors.push('No channel specified for deletion. Please specify the target channel (e.g. "delete channel #testing").');
    }
    if (isAmbiguousRoleDelete) {
      errors.push('No role specified for deletion. Please specify the target role (e.g. "delete role @Testing").');
    }
    if (isAmbiguousMemberMod) {
      errors.push('No target member specified for moderation. Please specify which user to moderate.');
    }
    if (isAmbiguousChannelRename) {
      errors.push('No new name specified for channel rename. Please provide the new channel name.');
    }

    // Check individual actions for unpopulated targets
    for (const act of actions) {
      if (act.action === 'delete_channel' && (!act.targetChannel || act.targetChannel === 'current' && !prompt.includes('this channel'))) {
        if (!prompt.match(/#(?:[a-zA-Z0-9_-]+)|channel\s+([a-zA-Z0-9_-]+)/i)) {
          errors.push('Target channel is ambiguous or missing.');
        }
      }
      if (act.action === 'delete_role' && (!act.targetRole || /^(a\s+role|the\s+role|role)$/i.test(act.targetRole))) {
        errors.push('Target role is ambiguous or missing.');
      }
    }

    // =========================================================================
    // 7. NEGATIVE CONSTRAINTS ENFORCEMENT
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

    // =========================================================================
    // 8. DEPENDENCY GRAPH ASSIGNMENT (id: 'step_X', dependsOn: ['step_Y'])
    // =========================================================================
    const orderedActionsWithDeps = CompletenessChecker.assignDependencies(actions);

    const isValid = errors.length === 0 && orderedActionsWithDeps.length > 0;

    return {
      valid: isValid,
      errors,
      repairedPlan: {
        thoughtProcess: plan?.thoughtProcess || 'Validated plan',
        isHighImpact: Boolean(plan?.isHighImpact),
        clarificationNeeded: errors.length > 0 ? errors[0] : null,
        actions: orderedActionsWithDeps
      }
    };
  }

  /**
   * Assigns deterministic step IDs and dependency edges (DAG) between actions.
   */
  static assignDependencies(actions) {
    if (!Array.isArray(actions)) return [];

    const result = actions.map((act, idx) => ({
      ...act,
      id: act.id || `step_${idx + 1}`,
      dependsOn: Array.isArray(act.dependsOn) ? [...act.dependsOn] : []
    }));

    for (let i = 0; i < result.length; i++) {
      const current = result[i];

      for (let j = 0; j < i; j++) {
        const prev = result[j];

        // 1. Voice Connection -> Audio Playback dependency
        if ((prev.action === 'connect_voice' || prev.action === 'voice_join') && current.action.startsWith('music_')) {
          if (!current.dependsOn.includes(prev.id)) {
            current.dependsOn.push(prev.id);
          }
        }

        // 2. Role Creation -> Role Mutation/Assignment dependency
        if (prev.action === 'create_role' && prev.name) {
          const roleNameLower = prev.name.toLowerCase();
          const targetRole = String(current.targetRole || current.role || current.name || '').toLowerCase();
          if (targetRole === roleNameLower) {
            if (!current.dependsOn.includes(prev.id)) {
              current.dependsOn.push(prev.id);
            }
          }
        }

        // 3. Category Creation -> Channel Creation in that category
        if (prev.action === 'create_category' && prev.name) {
          const catNameLower = prev.name.toLowerCase();
          const channelCat = String(current.category || '').toLowerCase();
          if (channelCat === catNameLower) {
            if (!current.dependsOn.includes(prev.id)) {
              current.dependsOn.push(prev.id);
            }
          }
        }

        // 4. Channel Creation -> Channel Permissions / Channel Edits
        if (prev.action === 'create_channel' && prev.name) {
          const chNameLower = prev.name.toLowerCase();
          const targetChannel = String(current.targetChannel || current.name || '').toLowerCase();
          if (targetChannel === chNameLower) {
            if (!current.dependsOn.includes(prev.id)) {
              current.dependsOn.push(prev.id);
            }
          }
        }

        // 5. Moderation Action -> Moderation Explanation message
        if (
          ['timeout_member', 'kick_member', 'ban_member'].includes(prev.action) &&
          current.action === 'send_message'
        ) {
          if (!current.dependsOn.includes(prev.id)) {
            current.dependsOn.push(prev.id);
          }
        }

        // 6. Role Creation -> Role Panel dependency
        if (prev.action === 'create_role' && (current.action === 'setup_role_panel' || current.action === 'setup_role_menu')) {
          if (!current.dependsOn.includes(prev.id)) {
            current.dependsOn.push(prev.id);
          }
        }

        // 7. Channel Creation -> Preset Configuration & Embed Publishing
        if (prev.action === 'create_channel') {
          const chNameLower = (prev.name || '').toLowerCase();
          const targetCh = String(current.targetChannel || current.channelName || '').toLowerCase();
          if (chNameLower === targetCh || !targetCh || targetCh === 'current') {
            if (['configure_channel_preset', 'publish_embed', 'create_embed', 'setup_role_panel', 'setup_role_menu'].includes(current.action)) {
              if (!current.dependsOn.includes(prev.id)) {
                current.dependsOn.push(prev.id);
              }
            }
          }
        }

        // 8. Preset Configuration -> Embed Publishing in that channel
        if (prev.action === 'configure_channel_preset' && (current.action === 'publish_embed' || current.action === 'create_embed')) {
          const presetCh = String(prev.targetChannel || '').toLowerCase();
          const targetCh = String(current.targetChannel || '').toLowerCase();
          if (presetCh === targetCh) {
            if (!current.dependsOn.includes(prev.id)) {
              current.dependsOn.push(prev.id);
            }
          }
        }
      }
    }

    return result;
  }
}
