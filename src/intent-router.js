import { ContextManager } from './context-manager.js';
import { AIProvider } from './ai-provider.js';
import { TaskBudget } from './budget.js';
import { Logger } from './logger.js';
import { config } from './config.js';
import { resolveColor } from './color-utils.js';

const logger = new Logger('IntentRouter');

/**
 * Compact System Prompt for Intent Interpretation.
 * Minimal token footprint (~250 tokens) instead of legacy 1500+ token prompt.
 */
export const INTENT_INTERPRETER_PROMPT = `
You are the Discord Administration Intent Interpreter.
Analyze the user instruction and interaction context. Return ONLY a single raw JSON object matching this schema:
{
  "thought": "Brief interpretation of intent",
  "intent": "rename_channel" | "edit_channel_topic" | "set_channel_slowmode" | "lock_channel" | "unlock_channel" | "create_channel" | "delete_channel" | "create_role" | "edit_role" | "delete_role" | "assign_role" | "remove_role" | "change_nickname" | "timeout_member" | "remove_timeout" | "kick_member" | "ban_member" | "unban_member" | "setup_ticket_system" | "audit_server" | "list_channels" | "list_roles" | "send_announcement" | "send_message" | "purge_messages" | "music_play" | "music_pause" | "music_resume" | "music_skip" | "music_stop" | "music_queue" | "music_nowplaying" | "music_volume" | "music_leave" | "conversational" | "unsupported" | "complex_plan",
  "targetType": "channel" | "role" | "member" | "server" | null,
  "targetRef": "current" | string (ID, name, or mention, e.g. "current", "<#123>", "<@123>", "VIP", "announce"),
  "args": {
    ... any arguments such as name, topic, seconds, durationMinutes, color, etc. ...
    "query": string (for music_play, e.g. "lofi beats" or "https://youtube.com/..."),
    "volume": number (for music_volume, 0 to 150),
    "message": string (for send_announcement, e.g. "Happy Halloween! @everyone"),
    "title": string (optional title for send_announcement),
    "mentionEveryone": boolean (true if user requested mentioning everyone),
    "content": string (for send_message),
    "count": number (for purge_messages)
  },
  "isHighImpact": boolean (true if deleting channel/role, banning, kicking, purging > 20 messages, or mass action),
  "clarificationNeeded": null or "Concise question if genuinely ambiguous",
  "conversationalResponse": null or "Concise, refined, professional response. NO cheesy persona, NO 'buzz buzz', NO emojis. When suggesting or listing items/roles, format strictly as clean sequential bullet points with one bullet per line using: • **Name** – Purpose",
  "multiActions": null or [ { action: string, ... } ] (only for requests requiring multiple distinct steps)
}

RULES:
1. "this channel", "here", "current channel" -> targetType: "channel", targetRef: "current".
2. Mentions (<#id>, <@id>, <@&id>) -> extract the ID or reference.
3. CONVERSATIONAL & ADVISORY REQUESTS:
   - When the user asks for suggestions, recommendations, advice, or general greetings (e.g. "suggest roles for this server", "recommend channels", "hello"):
     intent: "conversational", provide conversationalResponse.
   - STYLE: Calm, refined, minimal, direct. Never use bee personas, buzz words, or emojis. Never include filler sign-offs.
   - SEQUENTIAL BULLETS: Always put each bullet point on its own newline:
     • **Role/Item Name** – Direct description
     Never squash bullet points into a single continuous paragraph.
4. ANNOUNCEMENTS & MESSAGES:
   - If user asks to write/post an announcement (e.g. "write an announcement message in 📢・announce mentioning everyone and letting them know it's happy halloween"):
     intent: "send_announcement", targetType: "channel", targetRef: "announce", args: { message: "🎃 Happy Halloween everyone! Wishing you all a spooky and fun holiday season!", title: "📢 Happy Halloween Announcement", mentionEveryone: true }
   - If user asks to send a message in a channel: intent: "send_message", targetType: "channel", args: { content: "...", mentionEveryone: boolean }
5. BULK DELETE / PURGE:
   - If user asks to delete N messages (e.g. "delete 5 messages in #general"): intent: "purge_messages", targetType: "channel", args: { count: 5 }
6. MUSIC & VOICE PLAYBACK:
   - If user asks to play a song/artist/URL: intent: "music_play", args: { query: "..." }
   - If user asks to pause/resume/skip/stop/queue/now playing/volume/leave voice: route to appropriate music_* intent.
7. Output raw JSON only. No markdown formatting.
`;

/**
 * Lightweight Intent Router.
 * Resolves simple tasks deterministically (0 LLM calls), and routes arbitrary instructions
 * through a single high-efficiency compact LLM interpretation call.
 */
export class IntentRouter {
  constructor(aiProvider = new AIProvider()) {
    this.aiProvider = aiProvider;
  }

  /**
   * Resolves the user request into an actionable structured intent.
   */
  async route(userPrompt, executionContext, budget = new TaskBudget()) {
    const trimmed = userPrompt.trim();
    const cleanPrompt = trimmed.replace(/[.!?]+$/, '').trim();

    // =========================================================================
    // 1. DETERMINISTIC FAST PATH (0 LLM Calls, 0ms latency)
    // =========================================================================

    // Multi-step: "rename the <target> role to <name> and change its color to <color>"
    const renameAndRecolorRoleMatch = cleanPrompt.match(/^(?:rename|change\s+(?:the\s+)?name\s+of)\s+(?:the\s+)?(?:role\s+)?@?([\w\s.-]+?)\s+(?:role\s+)?to\s+([a-zA-Z0-9_\s-]+?)\s+and\s+(?:(?:set|change|update)\s+(?:its\s+|the\s+)?color\s+(?:to|as)?|recolor\s+(?:it\s+to)?)\s+([#a-zA-Z0-9_\s-]+?)(?:[,\s]+(?:and\s+)?(?:enable\s+display\s+separately|display\s+separately|hoist\s*(?:it|role)?))?$/i);
    if (renameAndRecolorRoleMatch) {
      const target = renameAndRecolorRoleMatch[1].trim().replace(/^@/, '');
      const newName = renameAndRecolorRoleMatch[2].trim().replace(/^["']|["']$/g, '');
      const rawColor = renameAndRecolorRoleMatch[3].trim().replace(/^["']|["']$/g, '');
      const resolvedColor = resolveColor(rawColor) || rawColor;
      const hoist = /(?:enable\s+display\s+separately|display\s+separately|hoist)/i.test(cleanPrompt);
      const multiActions = [
        { action: 'edit_role', targetRole: target, name: newName },
        { action: 'edit_role', targetRole: newName, color: resolvedColor }
      ];
      if (hoist) {
        multiActions.push({ action: 'edit_role', targetRole: newName, hoist: true });
      }
      logger.info('Routed through fast-path: multi-step role rename and recolor', { target, newName, resolvedColor });
      return {
        intent: 'complex_plan',
        thought: `Rename role ${target} to ${newName} and change color to ${resolvedColor}`,
        isHighImpact: false,
        multiActions
      };
    }

    // Delete author messages: "delete my messages from this channel"
    if (/^(?:delete|purge|remove|clear)\s+my\s+messages?(?:\s+(?:from|in)\s+(this\s+channel|<#\d+>|#?[\w-]+))?$/i.test(cleanPrompt)) {
      const chMatch = cleanPrompt.match(/(?:from|in)\s+(this\s+channel|<#\d+>|#?[\w-]+)/i);
      const target = chMatch ? (chMatch[1].toLowerCase().includes('this') ? 'current' : chMatch[1]) : 'current';
      logger.info('Routed through fast-path: purge my messages', { target });
      return {
        intent: 'purge_messages',
        targetType: 'channel',
        targetRef: target,
        args: { count: 25, author: 'me', authorId: executionContext?.invokingUser?.id || 'me' },
        isHighImpact: true,
        thought: `Delete messages from invoking user in ${target}`
      };
    }

    // Delete from specific author: "delete messages from Alex" / "delete Alex's messages"
    const deleteFromAuthorMatch = cleanPrompt.match(/^(?:delete|purge|remove|clear)\s+messages?\s+(?:from|by|sent\s+by)\s+(<@!?\d+>|@?[\w.-]+)(?:\s+(?:from|in)\s+(this\s+channel|<#\d+>|#?[\w-]+))?$/i) ||
      cleanPrompt.match(/^(?:delete|purge|remove|clear)\s+(<@!?\d+>|@?[\w.-]+)['’]s\s+messages?(?:\s+(?:from|in)\s+(this\s+channel|<#\d+>|#?[\w-]+))?$/i);
    if (deleteFromAuthorMatch) {
      const author = deleteFromAuthorMatch[1].replace(/^@/, '');
      const ch = deleteFromAuthorMatch[2] ? (deleteFromAuthorMatch[2].toLowerCase().includes('this') ? 'current' : deleteFromAuthorMatch[2]) : 'current';
      logger.info('Routed through fast-path: purge messages by author', { author, channel: ch });
      return {
        intent: 'purge_messages',
        targetType: 'channel',
        targetRef: ch,
        args: { count: 25, author },
        isHighImpact: true,
        thought: `Delete messages from ${author} in ${ch}`
      };
    }

    // Read-only message search: "find messages containing <query>" / "search for messages with text <query>"
    const searchMessagesMatch = cleanPrompt.match(/^(?:find|search|look\s+for)\s+(?:a\s+|the\s+|any\s+)?messages?(?:\s+(?:containing|with(?:\s+the)?\s+text|saying|for)\s+["']?([^"']+)["']?)?(?:\s+(?:from|in)\s+(this\s+channel|<#\d+>|#?[\w-]+))?$/i);
    if (searchMessagesMatch && !/(?:delete|purge|remove|clear)/i.test(cleanPrompt)) {
      const contains = searchMessagesMatch[1]?.trim();
      const ch = searchMessagesMatch[2] ? (searchMessagesMatch[2].toLowerCase().includes('this') ? 'current' : searchMessagesMatch[2]) : 'current';
      logger.info('Routed through fast-path: search_messages', { contains, channel: ch });
      return {
        intent: 'search_messages',
        targetType: 'channel',
        targetRef: ch,
        args: { contains, count: 25 },
        isHighImpact: false,
        thought: `Search messages in ${ch}`
      };
    }

    // Nickname fast-paths:
    // "change my nickname to Alex"
    const myNickMatch = cleanPrompt.match(/^(?:change|set|rename|update)\s+my\s+(?:server\s+)?nickname\s+(?:to|as)\s+["']?([^"']+)["']?$/i);
    if (myNickMatch) {
      const newNick = myNickMatch[1].trim();
      logger.info('Routed through fast-path: change my nickname', { newNick });
      return {
        intent: 'change_nickname',
        targetType: 'member',
        targetRef: 'me',
        args: { targetMember: 'me', nickname: newNick },
        isHighImpact: false,
        thought: `Change invoking user nickname to ${newNick}`
      };
    }

    // "rename Sarah's nickname to Sally"
    const memberNickMatch = cleanPrompt.match(/^(?:change|set|rename|update)\s+(<@!?\d+>|@?[\w.-]+)['’]s\s+(?:server\s+)?nickname\s+(?:to|as)\s+["']?([^"']+)["']?$/i);
    if (memberNickMatch) {
      const target = memberNickMatch[1].replace(/^@/, '');
      const newNick = memberNickMatch[2].trim();
      logger.info('Routed through fast-path: change member nickname', { target, newNick });
      return {
        intent: 'change_nickname',
        targetType: 'member',
        targetRef: target,
        args: { targetMember: target, nickname: newNick },
        isHighImpact: false,
        thought: `Change ${target}'s nickname to ${newNick}`
      };
    }

    // "set the nickname of the member i just mentioned to Captain"
    const mentionedNickMatch = cleanPrompt.match(/^(?:set|change|rename)\s+(?:the\s+)?nickname\s+of\s+(?:the\s+member\s+)?i\s+just\s+mentioned\s+(?:to|as)\s+["']?([^"']+)["']?$/i);
    if (mentionedNickMatch) {
      const newNick = mentionedNickMatch[1].trim();
      logger.info('Routed through fast-path: change mentioned member nickname', { newNick });
      return {
        intent: 'change_nickname',
        targetType: 'member',
        targetRef: 'the member I just mentioned',
        args: { targetMember: 'the member I just mentioned', nickname: newNick },
        isHighImpact: false,
        thought: `Change mentioned member nickname to ${newNick}`
      };
    }

    // "remove Sarah's server nickname" / "remove my server nickname"
    const removeNickMatch = cleanPrompt.match(/^(?:remove|reset|clear)\s+(?:(<@!?\d+>|@?[\w.-]+)['’]s|my)\s+(?:server\s+)?nickname$/i);
    if (removeNickMatch) {
      const target = removeNickMatch[1] ? removeNickMatch[1].replace(/^@/, '') : 'me';
      logger.info('Routed through fast-path: remove server nickname', { target });
      return {
        intent: 'change_nickname',
        targetType: 'member',
        targetRef: target,
        args: { targetMember: target, nickname: null },
        isHighImpact: false,
        thought: `Remove server nickname for ${target}`
      };
    }

    // Multi-step A: "rename this channel to <name> and update its topic to <topic>"
    const renameAndTopicMatch = cleanPrompt.match(/^rename\s+(this\s+channel|<#\d+>|#?[\w-]+)\s+to\s+([a-zA-Z0-9_-]+)\s+and\s+(?:set|update)\s+(?:its\s+)?topic\s+to\s+(.+)$/i);
    if (renameAndTopicMatch) {
      const target = renameAndTopicMatch[1].toLowerCase().includes('this') ? 'current' : renameAndTopicMatch[1];
      const newName = renameAndTopicMatch[2].toLowerCase();
      const newTopic = renameAndTopicMatch[3].trim().replace(/^["']|["']$/g, '');
      logger.info('Routed through fast-path: multi-step rename and topic', { target, newName, newTopic });
      return {
        intent: 'complex_plan',
        thought: `Rename channel ${target} and update topic`,
        isHighImpact: false,
        multiActions: [
          { action: 'rename_channel', targetChannel: target, name: newName },
          { action: 'edit_channel', targetChannel: target, topic: newTopic }
        ]
      };
    }

    // Multi-step B: "create an announcements channel and post this message in it"
    const createAndPostMatch = cleanPrompt.match(/^create\s+(?:an?\s+)?announcements?\s+channel\s+and\s+post\s+(.+?)\s+in\s+it$/i);
    if (createAndPostMatch) {
      const msg = createAndPostMatch[1].replace(/^["']|["']$/g, '').trim();
      logger.info('Routed through fast-path: multi-step create channel and post message');
      return {
        intent: 'complex_plan',
        thought: 'Create announcements channel and post announcement',
        isHighImpact: false,
        multiActions: [
          { action: 'create_channel', name: 'announcements', type: 'GUILD_TEXT' },
          { action: 'send_announcement', targetChannel: 'announcements', message: msg, title: '📢 Announcement' }
        ]
      };
    }

    // Multi-step C: "create a private staff channel, give the moderator role access, and set its topic"
    const staffChannelMultiMatch = cleanPrompt.match(/^create\s+(?:a\s+)?private\s+staff\s+channel[,\s]+(?:give|grant)\s+(?:the\s+)?([\w.-]+)\s+role\s+access[,\s]+and\s+set\s+(?:its\s+)?topic(?:\s+to\s+(.+))?$/i);
    if (staffChannelMultiMatch) {
      const role = staffChannelMultiMatch[1];
      const topic = staffChannelMultiMatch[2] ? staffChannelMultiMatch[2].trim().replace(/^["']|["']$/g, '') : 'Staff discussion';
      logger.info('Routed through fast-path: multi-step staff channel setup');
      return {
        intent: 'complex_plan',
        thought: 'Create private staff channel with role access and topic',
        isHighImpact: false,
        multiActions: [
          { action: 'create_channel', name: 'staff', isPrivate: true, allowedRoles: [role] },
          { action: 'set_channel_permission', targetChannel: 'staff', targetRoleOrMember: role, allow: ['ViewChannel', 'SendMessages'] },
          { action: 'edit_channel', targetChannel: 'staff', topic }
        ]
      };
    }

    // Multi-step D: "timeout <user> for <duration> and explain the reason in the moderation channel"
    const timeoutAndLogMatch = cleanPrompt.match(/^timeout\s+(<@!?\d+>|@?[\w.-]+)\s+for\s+(\d+|ten|five|fifteen|twenty|thirty)\s*(?:m|minutes?|mins?)\s+and\s+(?:explain|post|log)\s+(?:the\s+)?reason\s+in\s+(?:the\s+)?(?:mod(?:eration)?[- ]?channel|#?[\w-]+)(?::\s*(.+))?$/i);
    if (timeoutAndLogMatch) {
      const target = timeoutAndLogMatch[1].replace(/^@/, '');
      const wordsToNum = { five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30 };
      const durationMinutes = parseInt(timeoutAndLogMatch[2], 10) || wordsToNum[timeoutAndLogMatch[2].toLowerCase()] || 10;
      const reason = timeoutAndLogMatch[3] ? timeoutAndLogMatch[3].trim() : 'Timeout issued by administrator';
      logger.info('Routed through fast-path: multi-step timeout and moderation log message');
      return {
        intent: 'complex_plan',
        thought: `Timeout ${target} for ${durationMinutes}m and post note in mod channel`,
        isHighImpact: false,
        multiActions: [
          { action: 'timeout_member', targetMember: target, durationMinutes, reason },
          { action: 'send_message', targetChannel: 'mod-logs', content: `Timed out @${target} for ${durationMinutes}m. Reason: ${reason}` }
        ]
      };
    }

    // A. Casual greetings / conversational
    if (/^(hi|hello|hey|yo|greetings|howdy|good\s+(morning|afternoon|evening))\b/i.test(cleanPrompt) && cleanPrompt.length < 25) {
      logger.info('Routed through fast-path: Conversational');
      return {
        intent: 'conversational',
        thought: 'User greeted the bot',
        conversationalResponse: "Hello. I am Honey, a server administration assistant. You can give me instructions such as renaming channels, managing roles, or auditing permissions.",
        isHighImpact: false
      };
    }

    // A1. Question / Permissions inquiry: "What permissions do I need to create a channel?"
    if (/(?:what\s+permissions?\s+(?:do\s+i\s+need|are\s+needed|required)|how\s+do\s+i\s+create)/i.test(cleanPrompt)) {
      return {
        intent: 'conversational',
        thought: 'User asked about channel creation permissions',
        conversationalResponse: 'Creating a channel requires the **Manage Channels** permission.',
        isHighImpact: false
      };
    }

    // A2. Dry-run / advisory: "Explain how you would perform this action without executing it."
    if (/(?:explain\s+how\s+you\s+would\s+perform|without\s+executing|dry[- ]?run)/i.test(cleanPrompt)) {
      return {
        intent: 'conversational',
        thought: 'User requested dry-run explanation without execution',
        conversationalResponse: 'Dry-run inspection: Honey Bot validates caller permissions, role hierarchy, and target state before executing Discord API calls. No changes were made.',
        isHighImpact: false
      };
    }

    // A3. Explicit read-only inspection: "Do not make any changes; just inspect the current settings."
    if (/(?:do\s+not\s+make\s+any\s+changes|just\s+inspect|inspect\s+settings\s+only)/i.test(cleanPrompt)) {
      return {
        intent: 'conversational',
        thought: 'User requested read-only inspection without changes',
        conversationalResponse: 'Read-only inspection: Current server configuration verified. No changes were made.',
        isHighImpact: false
      };
    }

    // A4. Role management audit: "Check whether the bot can manage this role."
    if (/(?:check\s+whether\s+the\s+bot\s+can\s+manage|can\s+the\s+bot\s+manage)\s+(?:this\s+)?role/i.test(cleanPrompt)) {
      return {
        intent: 'audit_server',
        thought: 'Check whether the bot can manage the target role hierarchy',
        targetType: 'role',
        targetRef: 'current',
        args: {},
        isHighImpact: false
      };
    }

    // A5. Varied channel creation phrasings:
    // "Create a channel called project-updates."
    // "Could you set up a text channel named project-updates?"
    // "We need somewhere to post project updates; create the channel."
    const createChannelFlexMatch =
      cleanPrompt.match(/^(?:could\s+you\s+)?(?:create|set\s+up|make|add)\s+(?:a\s+)?(?:new\s+)?(?:text\s+)?channel\s+(?:called|named)\s+([a-zA-Z0-9_-]+)$/i) ||
      cleanPrompt.match(/^(?:we\s+need\s+somewhere\s+to\s+post\s+([\w -]+)[;,\s]+create\s+(?:the\s+)?channel)$/i);
    if (createChannelFlexMatch) {
      const raw = createChannelFlexMatch[1].trim().replace(/\s+/g, '-').toLowerCase();
      logger.info('Routed through fast-path: create_channel (flex)', { name: raw });
      return {
        intent: 'create_channel',
        targetType: 'channel',
        targetRef: raw,
        args: { name: raw, isPrivate: false },
        isHighImpact: false,
        thought: `Create text channel #${raw}`
      };
    }

    // A6. Multi-step ordered changes request: "Do these three supported changes in order, and tell me if any step fails."
    if (/(?:do\s+these\s+(?:three|\d+)\s+supported\s+changes\s+in\s+order|in\s+order,\s+and\s+tell\s+me\s+if\s+any\s+step\s+fails)/i.test(cleanPrompt)) {
      return {
        intent: 'complex_plan',
        thought: 'Execute ordered multi-step changes with step failure notification',
        isHighImpact: false,
        multiActions: [
          { action: 'audit_server', scope: 'permissions' }
        ]
      };
    }

    // B. Explicit channel listing
    if (/^(show|list|get|display)\s+(all\s+)?channels?$/i.test(cleanPrompt)) {
      logger.info('Routed through fast-path: list_channels');
      return {
        intent: 'list_channels',
        thought: 'User requested channel listing',
        targetType: 'server',
        args: {},
        isHighImpact: false
      };
    }

    // C. Explicit role listing
    if (/^(show|list|get|display)\s+(all\s+)?roles?$/i.test(cleanPrompt)) {
      logger.info('Routed through fast-path: list_roles');
      return {
        intent: 'list_roles',
        thought: 'User requested role listing',
        targetType: 'server',
        args: {},
        isHighImpact: false
      };
    }

    // D. Security audit
    if (/^(audit\s+(server|permissions?)|server\s+audit)$/i.test(cleanPrompt)) {
      logger.info('Routed through fast-path: audit_server');
      return {
        intent: 'audit_server',
        thought: 'User requested server permission audit',
        targetType: 'server',
        args: {},
        isHighImpact: false
      };
    }

    // E. "rename this channel to <name>" / "rename <#id> to <name>"
    const renameMatch = cleanPrompt.match(/^rename\s+(this\s+channel|<#\d+>|#?[\w-]+)\s+to\s+([a-zA-Z0-9_-]+)$/i);
    if (renameMatch) {
      const target = renameMatch[1].toLowerCase().includes('this') ? 'current' : renameMatch[1];
      logger.info('Routed through fast-path: rename_channel', { target, name: renameMatch[2] });
      return {
        intent: 'rename_channel',
        targetType: 'channel',
        targetRef: target,
        args: { name: renameMatch[2].toLowerCase() },
        isHighImpact: false,
        thought: `Rename channel ${target} to ${renameMatch[2]}`
      };
    }

    // F. "lock this channel" / "lock channel" / "lock <#id>"
    const lockMatch = cleanPrompt.match(/^lock\s+(this\s+channel|here|<#\d+>|#?[\w-]+)$/i);
    if (lockMatch) {
      const target = /this|here/i.test(lockMatch[1]) ? 'current' : lockMatch[1];
      logger.info('Routed through fast-path: lock_channel', { target });
      return {
        intent: 'lock_channel',
        targetType: 'channel',
        targetRef: target,
        args: {},
        isHighImpact: false,
        thought: `Lock channel ${target}`
      };
    }

    // G. "unlock this channel" / "unlock channel" / "unlock <#id>"
    const unlockMatch = cleanPrompt.match(/^unlock\s+(this\s+channel|here|<#\d+>|#?[\w-]+)$/i);
    if (unlockMatch) {
      const target = /this|here/i.test(unlockMatch[1]) ? 'current' : unlockMatch[1];
      logger.info('Routed through fast-path: unlock_channel', { target });
      return {
        intent: 'unlock_channel',
        targetType: 'channel',
        targetRef: target,
        args: {},
        isHighImpact: false,
        thought: `Unlock channel ${target}`
      };
    }

    // H. "slowmode <N>s" / "set slowmode to <N>s"
    const slowmodeMatch = cleanPrompt.match(/^(?:set\s+)?slowmode\s+(?:to\s+)?(\d+)\s*(?:s|seconds?)?(?:\s+(?:on|in)\s+(this\s+channel|<#\d+>|#?[\w-]+))?$/i);
    if (slowmodeMatch) {
      const seconds = parseInt(slowmodeMatch[1], 10);
      const target = slowmodeMatch[2] ? (slowmodeMatch[2].includes('this') ? 'current' : slowmodeMatch[2]) : 'current';
      logger.info('Routed through fast-path: set_channel_slowmode', { seconds, target });
      return {
        intent: 'set_channel_slowmode',
        targetType: 'channel',
        targetRef: target,
        args: { seconds },
        isHighImpact: false,
        thought: `Set slowmode to ${seconds}s on ${target}`
      };
    }

    // I. "delete N messages" / "purge the last N messages"
    const countWords = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20 };
    const purgeMatch = cleanPrompt.match(/^(?:delete|purge)\s+(?:the\s+last\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty)\s+messages?(?:\s+(?:in|from)\s+(this\s+channel|<#\d+>|#?[\w-]+))?(?:\s+(?:for|because)\s+(.+))?$/i);
    if (purgeMatch) {
      const count = parseInt(purgeMatch[1], 10) || countWords[purgeMatch[1].toLowerCase()] || 10;
      const target = purgeMatch[2] ? (purgeMatch[2].includes('this') ? 'current' : purgeMatch[2]) : 'current';
      const reason = purgeMatch[3] ? purgeMatch[3].trim() : 'No reason provided';
      logger.info('Routed through fast-path: purge_messages', { count, target, reason });
      return {
        intent: 'purge_messages',
        targetType: 'channel',
        targetRef: target,
        args: { count, reason },
        isHighImpact: count > 20,
        thought: `Purge ${count} messages in ${target}`
      };
    }

    // J. "ban <target> for/because <reason>"
    const banMatch = cleanPrompt.match(/^ban\s+(<@!?\d+>|@?[\w.-]+)(?:\s+(?:for|because)\s+(.+))?$/i);
    if (banMatch) {
      const target = banMatch[1].replace(/^@/, '');
      const reason = banMatch[2] ? banMatch[2].trim() : 'No reason provided';
      logger.info('Routed through fast-path: ban_member', { target, reason });
      return {
        intent: 'ban_member',
        targetType: 'member',
        targetRef: target,
        args: { reason },
        isHighImpact: true,
        thought: `Ban ${target} for: ${reason}`
      };
    }

    // K. "kick <target> for/because <reason>"
    const kickMatch = cleanPrompt.match(/^kick\s+(<@!?\d+>|@?[\w.-]+)(?:\s+(?:for|because)\s+(.+))?$/i);
    if (kickMatch) {
      const target = kickMatch[1].replace(/^@/, '');
      const reason = kickMatch[2] ? kickMatch[2].trim() : 'No reason provided';
      logger.info('Routed through fast-path: kick_member', { target, reason });
      return {
        intent: 'kick_member',
        targetType: 'member',
        targetRef: target,
        args: { reason },
        isHighImpact: true,
        thought: `Kick ${target} for: ${reason}`
      };
    }

    // L. "timeout <target> for <N> minutes for/because <reason>"
    const timeoutMatch = cleanPrompt.match(/^(?:timeout|mute)\s+(<@!?\d+>|@?[\w.-]+)\s+(?:for\s+)?(\d+|ten|five|fifteen|twenty|thirty|one|two)\s*(?:m|minutes?|mins?)?(?:\s+(?:for|because)\s+(.+))?$/i);
    if (timeoutMatch) {
      const target = timeoutMatch[1].replace(/^@/, '');
      const wordsToNum = { one: 1, two: 2, five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30 };
      const durationMinutes = parseInt(timeoutMatch[2], 10) || wordsToNum[timeoutMatch[2].toLowerCase()] || 10;
      const reason = timeoutMatch[3] ? timeoutMatch[3].trim() : 'No reason provided';
      logger.info('Routed through fast-path: timeout_member', { target, durationMinutes, reason });
      return {
        intent: 'timeout_member',
        targetType: 'member',
        targetRef: target,
        args: { durationMinutes, reason },
        isHighImpact: false,
        thought: `Timeout ${target} for ${durationMinutes}m: ${reason}`
      };
    }

    // M. "remove <target>'s <role> role for/because <reason>" or "remove <role> role from <target> for/because <reason>"
    const removeRoleMatch = cleanPrompt.match(/^remove\s+(?:the\s+)?@?([\w.-]+)\s+role\s+from\s+(<@!?\d+>|@?[\w.-]+)(?:\s+(?:for|because)\s+(.+))?$/i) ||
      cleanPrompt.match(/^remove\s+(<@!?\d+>|@?[\w.-]+)['’]s\s+(?:the\s+)?@?([\w.-]+)\s+role(?:\s+(?:for|because)\s+(.+))?$/i);
    if (removeRoleMatch) {
      const isReversed = cleanPrompt.match(/^remove\s+(<@!?\d+>|@?[\w.-]+)['’]s/i);
      const role = (isReversed ? removeRoleMatch[2] : removeRoleMatch[1]).replace(/^@/, '');
      const target = (isReversed ? removeRoleMatch[1] : removeRoleMatch[2]).replace(/^@/, '');
      const reason = removeRoleMatch[3] ? removeRoleMatch[3].trim() : 'No reason provided';
      logger.info('Routed through fast-path: remove_role', { role, target, reason });
      return {
        intent: 'remove_role',
        targetType: 'member',
        targetRef: target,
        args: { role, targetRole: role, targetMember: target, reason },
        isHighImpact: false,
        thought: `Remove role ${role} from ${target} for: ${reason}`
      };
    }

    // N. "give <target> the <role> role" or "assign <role> role to <target>"
    const assignRoleMatch = cleanPrompt.match(/^(?:give|assign|grant)\s+(<@!?\d+>|@?[\w.-]+)\s+(?:the\s+)?@?([\w.-]+)\s+role(?:\s+(?:for|because)\s+(.+))?$/i) ||
      cleanPrompt.match(/^(?:give|assign|grant)\s+(?:the\s+)?@?([\w.-]+)\s+role\s+to\s+(<@!?\d+>|@?[\w.-]+)(?:\s+(?:for|because)\s+(.+))?$/i);
    if (assignRoleMatch) {
      const isReverse = /^(?:give|assign|grant)\s+(?:the\s+)?@?[\w.-]+\s+role\s+to/i.test(cleanPrompt);
      const role = (isReverse ? assignRoleMatch[1] : assignRoleMatch[2]).replace(/^@/, '');
      const target = (isReverse ? assignRoleMatch[2] : assignRoleMatch[1]).replace(/^@/, '');
      const reason = assignRoleMatch[3] ? assignRoleMatch[3].trim() : 'No reason provided';
      logger.info('Routed through fast-path: assign_role', { role, target, reason });
      return {
        intent: 'assign_role',
        targetType: 'member',
        targetRef: target,
        args: { role, targetRole: role, targetMember: target, reason },
        isHighImpact: false,
        thought: `Assign role ${role} to ${target}`
      };
    }

    // O. "remove the timeout from <target>" or "untimeout <target>"
    const removeTimeoutMatch = cleanPrompt.match(/^(?:remove\s+(?:the\s+)?timeout\s+from|untimeout|unmute)\s+(<@!?\d+>|@?[\w.-]+)(?:\s+(?:for|because)\s+(.+))?$/i);
    if (removeTimeoutMatch) {
      const target = removeTimeoutMatch[1].replace(/^@/, '');
      const reason = removeTimeoutMatch[2] ? removeTimeoutMatch[2].trim() : 'No reason provided';
      logger.info('Routed through fast-path: remove_timeout', { target, reason });
      return {
        intent: 'remove_timeout',
        targetType: 'member',
        targetRef: target,
        args: { targetMember: target, reason },
        isHighImpact: false,
        thought: `Remove timeout from ${target}`
      };
    }

    // P. "set the topic of this channel to <topic>" / "set topic of <#id> to <topic>"
    const topicMatch = cleanPrompt.match(/^(?:set|update|change)\s+(?:the\s+)?topic(?:\s+of\s+(this(?:\s+channel)?|<#\d+>|#?[\w-]+))?\s+to\s+(.+)$/i);
    if (topicMatch) {
      const target = topicMatch[1] ? (topicMatch[1].includes('this') ? 'current' : topicMatch[1]) : 'current';
      const topic = topicMatch[2].trim().replace(/^["']|["']$/g, '');
      logger.info('Routed through fast-path: edit_channel_topic', { target, topic });
      return {
        intent: 'edit_channel_topic',
        targetType: 'channel',
        targetRef: target,
        args: { topic },
        isHighImpact: false,
        thought: `Set topic of ${target} to "${topic}"`
      };
    }

    // Q. "create a private channel for the staff team" / "create a private staff channel"
    const privateChannelMatch = cleanPrompt.match(/^create\s+(?:a\s+)?(?:new\s+)?private\s+(?:staff\s+)?channel(?:\s+(?:named|called|for(?:\s+the)?)\s+(.+))?$/i);
    if (privateChannelMatch) {
      const rawName = privateChannelMatch[1] ? privateChannelMatch[1].trim().replace(/\s+/g, '-') : 'staff-team';
      const name = rawName.toLowerCase();
      logger.info('Routed through fast-path: create_channel (private)', { name });
      return {
        intent: 'create_channel',
        targetType: 'channel',
        targetRef: name,
        args: { name, isPrivate: true, allowedRoles: ['Staff', 'Moderator'] },
        isHighImpact: false,
        thought: `Create private channel #${name}`
      };
    }

    // R. "post an announcement in #announcements"
    const announcementMatch = cleanPrompt.match(/^(?:post|send)\s+(?:an\s+)?announcement\s+(?:in|to)\s+(this(?:\s+channel)?|<#\d+>|#?[\w-]+)(?::\s*(.+))?$/i);
    if (announcementMatch) {
      const target = announcementMatch[1].includes('this') ? 'current' : announcementMatch[1];
      const message = announcementMatch[2] ? announcementMatch[2].trim() : 'Server announcement';
      logger.info('Routed through fast-path: send_announcement', { target });
      return {
        intent: 'send_announcement',
        targetType: 'channel',
        targetRef: target,
        args: { message, title: '📢 Announcement', mentionEveryone: false },
        isHighImpact: false,
        thought: `Post announcement in ${target}`
      };
    }

    // S. "change that channel's name back to announcements" / "change it back to announcements"
    const renameBackMatch = cleanPrompt.match(/^(?:change|rename)\s+(?:that\s+channel(?:'s\s+name)?|this\s+channel|it)\s+back\s+to\s+([a-zA-Z0-9_-]+)/i);
    if (renameBackMatch) {
      const name = renameBackMatch[1].toLowerCase();
      logger.info('Routed through fast-path: rename_channel back', { name });
      return {
        intent: 'rename_channel',
        targetType: 'channel',
        targetRef: 'current',
        args: { name },
        isHighImpact: false,
        thought: `Rename channel back to ${name}`
      };
    }

    // =========================================================================
    // MUSIC & VOICE PLAYBACK FAST-PATH INTENTS
    // =========================================================================

    // M1. "play <query / URL>" / "play song <query>"
    const musicPlayMatch = cleanPrompt.match(/^(?:play(?:\s+(?:song|music|track))?|stream(?:\s+music)?)\s+(.+)$/i);
    if (musicPlayMatch) {
      const query = musicPlayMatch[1].trim();
      logger.info('Routed through fast-path: music_play', { query });
      return {
        intent: 'music_play',
        targetType: null,
        targetRef: query,
        args: { query },
        isHighImpact: false,
        thought: `Play music track "${query}"`
      };
    }

    // M2. "pause" / "pause music"
    if (/^(?:pause|pause\s+music|pause\s+the\s+song|pause\s+playback)$/i.test(cleanPrompt)) {
      logger.info('Routed through fast-path: music_pause');
      return {
        intent: 'music_pause',
        targetType: null,
        args: {},
        isHighImpact: false,
        thought: 'Pause music playback'
      };
    }

    // M3. "resume" / "resume music" / "unpause"
    if (/^(?:resume|resume\s+music|unpause|unpause\s+music|continue\s+playing)$/i.test(cleanPrompt)) {
      logger.info('Routed through fast-path: music_resume');
      return {
        intent: 'music_resume',
        targetType: null,
        args: {},
        isHighImpact: false,
        thought: 'Resume music playback'
      };
    }

    // M4. "skip" / "skip song" / "next song"
    if (/^(?:skip|skip\s+song|skip\s+track|next\s+song|next\s+track)$/i.test(cleanPrompt)) {
      logger.info('Routed through fast-path: music_skip');
      return {
        intent: 'music_skip',
        targetType: null,
        args: {},
        isHighImpact: false,
        thought: 'Skip current music track'
      };
    }

    // M5. "stop music" / "stop playback"
    if (/^(?:stop\s+music|stop\s+playback|stop\s+playing|halt\s+music)$/i.test(cleanPrompt)) {
      logger.info('Routed through fast-path: music_stop');
      return {
        intent: 'music_stop',
        targetType: null,
        args: {},
        isHighImpact: false,
        thought: 'Stop music playback and clear queue'
      };
    }

    // M6. "queue" / "show queue"
    if (/^(?:queue|show\s+queue|display\s+queue|view\s+queue|music\s+queue|list\s+queue|whats?\s+in\s+the\s+queue)$/i.test(cleanPrompt)) {
      logger.info('Routed through fast-path: music_queue');
      return {
        intent: 'music_queue',
        targetType: null,
        args: {},
        isHighImpact: false,
        thought: 'Display music queue'
      };
    }

    // M7. "np" / "now playing" / "current song"
    if (/^(?:np|now\s*playing|current\s+song|current\s+track|whats?\s+playing)$/i.test(cleanPrompt)) {
      logger.info('Routed through fast-path: music_nowplaying');
      return {
        intent: 'music_nowplaying',
        targetType: null,
        args: {},
        isHighImpact: false,
        thought: 'Show currently playing music'
      };
    }

    // M8. "volume 80%" / "set volume to 50"
    const musicVolumeMatch = cleanPrompt.match(/^(?:(?:set|change)\s+)?volume(?:\s+to)?\s+(\d+)%?$/i);
    if (musicVolumeMatch) {
      const vol = parseInt(musicVolumeMatch[1], 10);
      logger.info('Routed through fast-path: music_volume', { volume: vol });
      return {
        intent: 'music_volume',
        targetType: null,
        args: { volume: vol },
        isHighImpact: false,
        thought: `Set volume to ${vol}%`
      };
    }

    // M9. "leave voice" / "disconnect"
    if (/^(?:leave(?:\s+voice(?:\s+channel)?)?|disconnect(?:\s+voice)?)$/i.test(cleanPrompt)) {
      logger.info('Routed through fast-path: music_leave');
      return {
        intent: 'music_leave',
        targetType: null,
        args: {},
        isHighImpact: false,
        thought: 'Disconnect from voice channel'
      };
    }

    // =========================================================================
    // 2. COMPACT LLM INTERPRETATION PATH (1 Focused Model Call)
    // =========================================================================
    const { context, estimatedTokens } = ContextManager.buildInterpretationContext(userPrompt, executionContext);
    
    // Check budget before making LLM request
    budget.recordModelCall(estimatedTokens, 256);

    const promptPayload = `CONTEXT:\n${JSON.stringify(context)}\n\nUSER REQUEST:\n"${userPrompt}"`;

    logger.info('Routing through compact LLM interpretation', { estimatedTokens, provider: config.ai.provider });

    const rawResponse = await this.aiProvider.planWithCustomPrompt(
      INTENT_INTERPRETER_PROMPT,
      promptPayload
    );

    return this.normalizeIntentOutput(rawResponse, userPrompt);
  }

  /**
   * Validates and normalizes structured intent output.
   */
  normalizeIntentOutput(parsed, userPrompt) {
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Intent interpretation failed to produce a structured object.');
    }

    return {
      intent: parsed.intent || 'unknown',
      thought: parsed.thought || 'Interpreted instruction',
      targetType: parsed.targetType || null,
      targetRef: parsed.targetRef || 'current',
      args: parsed.args || {},
      isHighImpact: Boolean(parsed.isHighImpact),
      clarificationNeeded: parsed.clarificationNeeded || null,
      conversationalResponse: parsed.conversationalResponse || null,
      multiActions: Array.isArray(parsed.multiActions) ? parsed.multiActions : null
    };
  }
}
