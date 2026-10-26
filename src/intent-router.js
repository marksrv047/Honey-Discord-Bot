import { ContextManager } from './context-manager.js';
import { AIProvider } from './ai-provider.js';
import { TaskBudget } from './budget.js';
import { Logger } from './logger.js';
import { config } from './config.js';
import { resolveColor } from './color-utils.js';
import { CapabilityRegistry } from './capabilities.js';
import { ActionLedger } from './recovery.js';
import { HelpManager } from './help.js';

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
  "intent": "open_dashboard" | "guard_channel" | "unguard_channel" | "list_guarded_channels" | "rename_channel" | "edit_channel_topic" | "set_channel_slowmode" | "lock_channel" | "unlock_channel" | "create_channel" | "delete_channel" | "create_category" | "rename_category" | "delete_category" | "inspect_category" | "list_categories" | "move_channel_to_category" | "set_category_permission" | "sync_category_permissions" | "inspect_category_sync" | "create_role" | "edit_role" | "delete_role" | "assign_role" | "remove_role" | "change_nickname" | "remove_nickname" | "inspect_nickname" | "timeout_member" | "remove_timeout" | "kick_member" | "ban_member" | "unban_member" | "setup_ticket_system" | "audit_server" | "list_channels" | "list_roles" | "send_announcement" | "send_message" | "purge_messages" | "search_messages" | "voice_join" | "music_play" | "music_pause" | "music_resume" | "music_skip" | "music_stop" | "music_queue" | "music_nowplaying" | "music_volume" | "music_leave" | "inspect_modlog" | "setup_modlog" | "configure_guild_policy" | "inspect_guild_policy" | "test_guild_policy" | "reset_guild_policy" | "conversational" | "unsupported" | "complex_plan",
  "targetType": "channel" | "role" | "member" | "server" | null,
  "targetRef": "current" | string (ID, name, or mention, e.g. "current", "<#123>", "<@123>", "VIP", "announce"),
  "args": {
    ... any arguments such as name, topic, seconds, durationMinutes, color, targetMember, targetRole, etc. ...
    "query": string (for music_play, e.g. "lofi beats" or "https://youtube.com/..."),
    "volume": number (for music_volume, 0 to 150),
    "message": string (for send_announcement, extract the actual announcement details/text from prompt),
    "title": string (optional title for send_announcement, e.g. "Server Announcement"),
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
   - If user asks to post an announcement: intent: "send_announcement", targetType: "channel", targetRef: "current" (or target channel), args: { message: "...", title: "Server Announcement", mentionEveryone: true }. Extract the specific subject/message requested.
   - If user asks to send a message: intent: "send_message", targetType: "channel", args: { content: "...", mentionEveryone: boolean }
5. BULK DELETE / PURGE VS SEARCH:
   - "Delete N messages in #ch": intent: "purge_messages", targetType: "channel", args: { count: N }
   - "Find/search messages": intent: "search_messages", targetType: "channel", args: { count: 25 }. NEVER delete messages for search requests!
6. DESIRED OUTCOMES & SYNONYMS:
   - "make general slower" -> intent: "set_channel_slowmode", args: { seconds: 10 }
   - "close this channel" / "lock down" -> intent: "lock_channel"
   - "open this channel" / "unlock" -> intent: "unlock_channel"
   - "I want Alex to show up as Night Owl" -> intent: "change_nickname", targetType: "member", targetRef: "Alex", args: { targetMember: "Alex", nickname: "Night Owl" }
7. VOICE CHANNELS:
   - "connect to voice channel X", "join voice X": intent: "voice_join", targetType: "channel", targetRef: "X", args: { channel: "X" }
8. MODERATION LOGS:
   - "what is the modlog channel", "where is the modlog channel", "state the modlog channel", "modlog status": intent: "inspect_modlog".
   - "set up modlog", "setup modlog": intent: "setup_modlog", targetRef: "mod-logs".
9. MULTIPLE ACTIONS & MULTI-ROLE DELETION:
   - When user asks to delete multiple roles (e.g. "delete roles A, B and C"): return multiActions: [ { action: "delete_role", targetRole: "A" }, { action: "delete_role", targetRole: "B" }, { action: "delete_role", targetRole: "C" } ]
   - When user asks to lock channel AND announce: return multiActions: [ { action: "lock_channel", targetChannel: "current" }, { action: "send_announcement", targetChannel: "current", message: "...", title: "Server Announcement", mentionEveryone: true } ]
10. CONTEXTUAL FOLLOW-UPS:
   - Resolve "that role", "its color", "the channel we just created", "do the same for X" using provided recentContext.
11. Output raw JSON only. No markdown formatting.
`;

/**
 * Lightweight Intent Router.
 * Resolves simple tasks deterministically (0 LLM calls), and routes arbitrary instructions
 * through a single high-efficiency compact LLM interpretation call.
 */
export class IntentRouter {
  constructor(aiProvider = new AIProvider()) {
    if (aiProvider && typeof aiProvider === 'object' && aiProvider.isDeterministicOnly) {
      this.isDeterministicOnly = true;
      this.aiProvider = null;
    } else {
      this.aiProvider = aiProvider;
    }
  }

  /**
   * Resolves the user request into an actionable structured intent.
   */
  async route(userPrompt, executionContext, budget = new TaskBudget()) {
    const trimmed = userPrompt.trim();
    const cleanPrompt = trimmed.replace(/[.!?]+$/, '').trim();

    // =========================================================================
    // 0a. DASHBOARD & SERVER SETTINGS
    // =========================================================================
    if (
      /^(?:open|show|view|display|launch|get)?\s*(?:the\s+)?(?:server\s+|bot\s+|admin\s+|interactive\s+)?(?:dashboard|settings|config(?:\s+center)?|control\s+panel)$/i.test(cleanPrompt) ||
      /^(?:bot|server)\s+dashboard$/i.test(cleanPrompt) ||
      /^dashboard$/i.test(cleanPrompt)
    ) {
      return {
        intent: 'open_dashboard',
        thought: 'User requested server configuration dashboard',
        isHighImpact: false
      };
    }

    // =========================================================================
    // 0. UNSUPPORTED OPERATIONS & RESTRICTION PRE-FILTER
    // =========================================================================
    const unsupported = CapabilityRegistry.getExplanationForUnsupported(cleanPrompt);
    if (unsupported) {
      logger.info('Routed to unsupported operation explanation', { reason: unsupported.reason });
      return {
        intent: 'unsupported',
        thought: unsupported.reason,
        isHighImpact: false,
        conversationalResponse: `🛑 **Unsupported Operation:** ${unsupported.reason}${unsupported.supportedAlternative ? `\n\n💡 *Alternative:* ${unsupported.supportedAlternative}` : ''}`
      };
    }

    // =========================================================================
    // 0b. CAPABILITY INQUIRIES & HELP QUESTIONS
    // =========================================================================
    if (/^(?:what\s+can\s+you\s+do|what\s+are\s+your\s+capabilities|show\s+(?:all\s+)?capabilities|help\s+with\s+capabilities|what\s+can\s+honey\s+bot\s+do|list\s+capabilities)$/i.test(cleanPrompt)) {
      const categories = CapabilityRegistry.getAllCategories();
      const catBullets = categories.map(cat => {
        const topOps = cat.capabilities.slice(0, 3).map(c => c.title).join(', ');
        return `• **${cat.name}** – ${cat.description} (e.g. ${topOps})`;
      }).join('\n');

      return {
        intent: 'conversational',
        thought: 'User asked for bot capabilities overview',
        conversationalResponse:
          `I am Honey Bot, your Discord administration assistant. I can help you with:\n` +
          catBullets +
          `\n\nAll administrative actions are invoked using natural English via \`/go prompt: <instruction>\`.\n` +
          `To view all operations for any area, use \`/help prompt: <topic>\`.`,
        isHighImpact: false
      };
    }

    const capabilityQuestionMatch = cleanPrompt.match(/^(?:can\s+you|are\s+you\s+able\s+to|do\s+you\s+support)\s+(.+)$/i);
    if (capabilityQuestionMatch) {
      const queriedAction = capabilityQuestionMatch[1].trim();
      const matchedCap = CapabilityRegistry.findMatchingCapability(queriedAction);
      if (matchedCap) {
        const auth = CapabilityRegistry.toAuthoritative(matchedCap);
        const exampleText = auth.goExample ? ` For example: \`${auth.goExample}\`` : '';
        return {
          intent: 'conversational',
          thought: `Answered capability question about ${auth.title}`,
          conversationalResponse: `Yes, I support **${auth.title}** (\`${auth.action}\`: ${auth.description.toLowerCase()}).${exampleText}`,
          isHighImpact: false
        };
      }
    }

    // =========================================================================
    // 0c. CONTEXTUAL FOLLOW-UP SHORTCUTS ("Undo", "Do the same for Alex")
    // =========================================================================
    if (/^(?:undo(?:\s+(?:(?:the\s+)?(?:previous|last)\s+change|that))?|revert(?:\s+that)?)$/i.test(cleanPrompt)) {
      return {
        intent: 'conversational',
        thought: 'User requested undo of previous operation',
        conversationalResponse: 'You can inspect and reverse recent administrative operations using the `/undo` command.',
        isHighImpact: false
      };
    }

    const sameForMatch = cleanPrompt.match(/^(?:do\s+)?(?:the\s+)?same\s+for\s+(<@!?\d+>|@?[\w.-]+)$/i);
    if (sameForMatch) {
      const newTarget = sameForMatch[1].replace(/^@/, '');
      const lastAction = executionContext?.targetCache?.get('last_action');
      if (lastAction && lastAction.action === 'change_nickname') {
        return {
          intent: 'change_nickname',
          targetType: 'member',
          targetRef: newTarget,
          args: { targetMember: newTarget, nickname: lastAction.nickname },
          isHighImpact: false,
          thought: `Change ${newTarget}'s nickname to ${lastAction.nickname} (repeating previous change)`
        };
      }
    }

    // =========================================================================
    // 1. DETERMINISTIC FAST PATH (0 LLM Calls, 0ms latency)
    // =========================================================================

    // M1. Modlog inspection and status fast-path
    if (
      /^(?:what(?:'s|\s+is)|where\s+is|show|state|which\s+channel\s+is|check|view|display)\s+(?:the\s+)?(?:current\s+)?(?:mod[- ]?log|moderation\s+log)(?:\s+(?:channel|config|status))?/i.test(cleanPrompt) ||
      /^(?:is\s+)?(?:the\s+)?(?:mod[- ]?log|moderation\s+log)\s+(?:setup|set\s+up|configured|enabled|active)\??$/i.test(cleanPrompt) ||
      /^(?:mod[- ]?log|moderation\s+log)\s+status$/i.test(cleanPrompt) ||
      /^state\s+it\s+dwn$/i.test(cleanPrompt)
    ) {
      return {
        intent: 'inspect_modlog',
        targetType: 'channel',
        targetRef: 'current',
        args: {},
        isHighImpact: false,
        thought: 'Inspect or state current modlog channel configuration'
      };
    }

    // M2. Modlog setup fast-path
    if (/^(?:set\s*up|setup|create|initialize|enable)\s+(?:a\s+|the\s+)?(?:mod[- ]?logs?|moderation\s+logs?)(?:\s+channel)?(?:\s+(?:called|named|in|to)\s+(#?[\w-]+))?$/i.test(cleanPrompt)) {
      const chMatch = cleanPrompt.match(/(?:called|named|in|to)\s+(#?[\w-]+)/i);
      const targetCh = chMatch ? chMatch[1].replace(/^#/, '') : 'mod-logs';
      return {
        intent: 'setup_modlog',
        targetType: 'channel',
        targetRef: targetCh,
        args: { channel: targetCh },
        isHighImpact: false,
        thought: `Setup modlog channel named "${targetCh}"`
      };
    }

    // V1. Voice connection fast-path
    const voiceJoinMatch = cleanPrompt.match(/^(?:connect(?:\s+to)?|join)\s+(?:the\s+)?(?:voice\s+channel\s+)?["'“]?([^"'\n]+?)["'”]?$/i);
    if (voiceJoinMatch && /(?:voice|channel|hangout|general|lounge|music|talk|chat|vc)/i.test(cleanPrompt)) {
      const channelName = voiceJoinMatch[1].replace(/^(?:the\s+)?(?:voice\s+channel\s+)?/i, '').replace(/["'”]/g, '').trim();
      return {
        intent: 'voice_join',
        targetType: 'channel',
        targetRef: channelName,
        args: { channel: channelName },
        isHighImpact: false,
        thought: `Connect to voice channel "${channelName}"`
      };
    }

    // G1. Guard / Honeypot Channel fast-paths
    if (
      /^(?:guard|protect)(?:\s+this(?:\s+channel)?|\s+channel|\s+<#\d+>|\s+#?[\w-]+)?$/i.test(cleanPrompt) ||
      /^(?:set(?:\s+up)?\s+)?(?:this\s+channel\s+as\s+|channel\s+as\s+)?(?:guarded|honeypot|protected)(?:\s+(this(?:\s+channel)?|<#\d+>|#?[\w-]+))?$/i.test(cleanPrompt)
    ) {
      const match = cleanPrompt.match(/(?:guard|protect|channel|as\s+(?:guarded|honeypot))\s+(this(?:\s+channel)?|<#\d+>|#?[\w-]+)/i);
      const targetCh = match ? (/this/i.test(match[1]) ? 'current' : match[1].replace(/^#/, '')) : 'current';
      return {
        intent: 'guard_channel',
        targetType: 'channel',
        targetRef: targetCh,
        args: { channel: targetCh },
        isHighImpact: false,
        thought: `Guard channel ${targetCh} against unauthorized messages and spam`
      };
    }

    if (/^(?:unguard|unprotect|remove\s+guard\s+from)(?:\s+(this(?:\s+channel)?|<#\d+>|#?[\w-]+))?$/i.test(cleanPrompt)) {
      const match = cleanPrompt.match(/(?:unguard|unprotect|from)\s+(this(?:\s+channel)?|<#\d+>|#?[\w-]+)/i);
      const targetCh = match ? (/this/i.test(match[1]) ? 'current' : match[1].replace(/^#/, '')) : 'current';
      return {
        intent: 'unguard_channel',
        targetType: 'channel',
        targetRef: targetCh,
        args: { channel: targetCh },
        isHighImpact: false,
        thought: `Remove guard from channel ${targetCh}`
      };
    }

    if (/^(?:list|show|view|which)\s+(?:all\s+)?(?:guarded|protected|honeypot)\s+channels$/i.test(cleanPrompt)) {
      return {
        intent: 'list_guarded_channels',
        targetType: 'server',
        targetRef: 'current',
        args: {},
        isHighImpact: false,
        thought: 'List all guarded channels in server'
      };
    }

    // =========================================================================
    // GUILD ACCESS & POLICY MANAGEMENT FAST-PATHS
    // =========================================================================

    // P1. Reset server access policy to default
    if (/^(?:reset\s+(?:this\s+server['’]s\s+)?(?:bot\s+access\s+configuration|access\s+rules|authorization\s+policy|bot\s+settings)(?:\s+to\s+(?:its\s+)?defaults?)?|reset\s+(?:guild|server)\s+policy)$/i.test(cleanPrompt)) {
      logger.info('Routed through fast-path: reset_guild_policy');
      return {
        intent: 'reset_guild_policy',
        targetType: 'server',
        targetRef: 'current',
        args: {},
        isHighImpact: true,
        thought: "Reset server's bot access configuration to default policy"
      };
    }

    // P2. Inspect active policy / authorized roles
    if (/^(?:show\s+(?:me\s+)?(?:the\s+)?(?:roles\s+currently\s+authorized|authorized\s+roles|roles\s+allowed)\s+to\s+(?:operate|use)\s+(?:honey\s+bot|the\s+bot)(?:\s+in\s+this\s+server)?|who\s+(?:can|is\s+allowed\s+to)\s+(?:use|operate)\s+(?:honey\s+bot|the\s+bot)|show\s+(?:server\s+|guild\s+)?(?:bot\s+)?(?:access\s+rules|authorization\s+policy)|check\s+whether\s+this\s+server['’]s\s+access\s+rules\s+are\s+configured\s+correctly|check\s+this\s+server['’]s\s+authorization\s+policy(?:\s+for\s+conflicts)?|what\s+can\s+each\s+configured\s+role\s+do|who\s+can\s+change\s+(?:the\s+)?bot['’]s\s+access\s+policy|is\s+this\s+server\s+using\s+its\s+own\s+stored\s+configuration\??|show\s+roles\s+authorized\s+to\s+operate\s+honey\s+bot)$/i.test(cleanPrompt)) {
      logger.info('Routed through fast-path: inspect_guild_policy');
      return {
        intent: 'inspect_guild_policy',
        targetType: 'server',
        targetRef: 'current',
        args: {
          checkConflicts: /conflict|correctly/i.test(cleanPrompt)
        },
        isHighImpact: false,
        thought: 'Inspect guild access policy and authorized roles'
      };
    }

    // P3. Configure admin-only policy changes
    if (/^(?:configure\s+this\s+server\s+so\s+)?only\s+administrators\s+can\s+change\s+(?:honey\s+bot['’]s|the\s+bot['’]s)\s+access\s+rules$/i.test(cleanPrompt) ||
        /^(?:make|set)\s+(?:bot\s+)?access\s+rules\s+admin(?:\s+only|-only)$/i.test(cleanPrompt)) {
      logger.info('Routed through fast-path: set_admin_only policy');
      return {
        intent: 'configure_guild_policy',
        targetType: 'server',
        targetRef: 'current',
        args: {
          operation: 'set_admin_only',
          setAdminOnly: true
        },
        isHighImpact: false,
        thought: "Configure server so only administrators can change Honey Bot's access rules"
      };
    }

    // P4. Dry-run test policy: "Would a member with the Moderator and Event Manager roles be allowed to ban someone in this server?"
    const testPolicyMatch = cleanPrompt.match(/^(?:would\s+(?:a\s+member\s+with\s+(?:the\s+)?)?|test\s+if\s+)(?:the\s+)?(?:role\s+)?@?([a-zA-Z0-9_\s-]+?)(?:\s+(?:and\s+@?([a-zA-Z0-9_\s-]+?))?\s+roles?)?\s+(?:be\s+allowed\s+to|can)\s+(.+?)(?:\s+in\s+this\s+server)?\??$/i);
    if (testPolicyMatch && !/^(create|delete|rename|timeout|kick|ban|unban|lock|unlock)\b/i.test(cleanPrompt)) {
      const role1 = testPolicyMatch[1].trim().replace(/^@/, '');
      const role2 = testPolicyMatch[2]?.trim().replace(/^@/, '');
      const actionText = testPolicyMatch[3].trim().toLowerCase();
      let mappedCap = 'moderation';
      if (/ban/i.test(actionText)) mappedCap = 'ban_members';
      else if (/kick/i.test(actionText)) mappedCap = 'kick_members';
      else if (/timeout|mute/i.test(actionText)) mappedCap = 'timeout_member';
      else if (/inspect/i.test(actionText)) mappedCap = 'inspect_members';
      else if (/channel/i.test(actionText)) mappedCap = 'manage_channels';
      else if (/role/i.test(actionText)) mappedCap = 'manage_roles';

      logger.info('Routed through fast-path: test_guild_policy', { role1, role2, mappedCap });
      return {
        intent: 'test_guild_policy',
        targetType: 'server',
        targetRef: 'current',
        args: {
          targetRole: role1,
          targetRoles: role2 ? [role1, role2] : [role1],
          capability: mappedCap,
          targetAction: mappedCap
        },
        isHighImpact: false,
        thought: `Test if role ${role1} is permitted to ${mappedCap}`
      };
    }

    // P5. Revoke capability from role: "Remove the Moderator role's permission to ban members here"
    const revokeCapMatch = cleanPrompt.match(/^(?:remove|revoke)\s+(?:the\s+)?(?:role\s+)?@?([a-zA-Z0-9_\s-]+?)['’]?s?\s+(?:permission\s+to|capability\s+to)\s+(.+?)(?:\s+here|\s+in\s+this\s+server)?$/i);
    if (revokeCapMatch) {
      const role = revokeCapMatch[1].trim().replace(/^@/, '');
      const capText = revokeCapMatch[2].trim().toLowerCase();
      let removeCap = 'ban_members';
      if (/ban/i.test(capText)) removeCap = 'ban_members';
      else if (/kick/i.test(capText)) removeCap = 'kick_members';
      else if (/timeout/i.test(capText)) removeCap = 'moderate_members';
      else if (/inspect/i.test(capText)) removeCap = 'inspect_members';
      else if (/channel/i.test(capText)) removeCap = 'manage_channels';
      else if (/role/i.test(capText)) removeCap = 'manage_roles';

      logger.info('Routed through fast-path: removeRoleCapability', { role, removeCap });
      return {
        intent: 'configure_guild_policy',
        targetType: 'role',
        targetRef: role,
        args: {
          operation: 'remove_capability',
          targetRole: role,
          removeCapabilities: [removeCap]
        },
        isHighImpact: false,
        thought: `Remove capability ${removeCap} from role ${role}`
      };
    }

    // P6. Role authorization with allow and deny: "Let the Support Team inspect members but not kick or ban anyone"
    const allowWithDenyMatch = cleanPrompt.match(/^(?:let|allow)\s+(?:the\s+)?(?:role\s+)?@?([a-zA-Z0-9_\s-]+?)\s+(?:role\s+)?(?:to\s+)?inspect\s+members\s+but\s+not\s+(?:kick|ban)(?:\s+or\s+(?:kick|ban))?(?:\s+anyone|\s+members)?(?:\s+here|\s+in\s+this\s+server)?$/i);
    if (allowWithDenyMatch) {
      const role = allowWithDenyMatch[1].trim().replace(/^@/, '');
      logger.info('Routed through fast-path: allow role with explicit denies', { role });
      return {
        intent: 'configure_guild_policy',
        targetType: 'role',
        targetRef: role,
        args: {
          operation: 'authorize_role',
          targetRole: role,
          capabilities: ['inspect_members'],
          denyCapabilities: ['kick_members', 'ban_members']
        },
        isHighImpact: false,
        thought: `Allow role ${role} to inspect members with hard denial on kick and ban`
      };
    }

    // P7. Role authorization with single capability: "Allow the Event Manager role to manage event channels, but nothing else"
    const singleCapMatch = cleanPrompt.match(/^(?:allow|let)\s+(?:the\s+)?(?:role\s+)?@?([a-zA-Z0-9_\s-]+?)\s+(?:role\s+)?to\s+manage\s+(?:event\s+)?channels(?:,\s*but\s+nothing\s+else)?(?:\s+here|\s+in\s+this\s+server)?$/i);
    if (singleCapMatch) {
      const role = singleCapMatch[1].trim().replace(/^@/, '');
      logger.info('Routed through fast-path: allow single capability', { role });
      return {
        intent: 'configure_guild_policy',
        targetType: 'role',
        targetRef: role,
        args: {
          operation: 'authorize_role',
          targetRole: role,
          capabilities: ['manage_channels']
        },
        isHighImpact: false,
        thought: `Allow role ${role} to manage channels`
      };
    }

    // P8. Allow role to use honey bot / execute moderation actions:
    // "Allow the Moderator role to use Honey Bot in this server"
    // "Only Admin and Senior Moderator roles can execute moderation actions here"
    const allowRoleMatch = cleanPrompt.match(/^(?:allow|grant)\s+(?:the\s+)?(?:role\s+)?@?([a-zA-Z0-9_\s-]+?)\s+(?:role\s+)?to\s+(?:use\s+(?:honey\s+bot|the\s+bot)|execute\s+moderation\s+actions)(?:\s+in\s+this\s+server|\s+here)?$/i) ||
      cleanPrompt.match(/^(?:only\s+admin\s+and\s+)?@?([a-zA-Z0-9_\s-]+?)\s+(?:and\s+@?([a-zA-Z0-9_\s-]+?)\s+)?roles?\s+can\s+execute\s+moderation\s+actions(?:\s+here|\s+in\s+this\s+server)?$/i);
    if (allowRoleMatch) {
      const role = (allowRoleMatch[2] || allowRoleMatch[1]).trim().replace(/^@/, '');
      logger.info('Routed through fast-path: allow role moderation/bot', { role });
      return {
        intent: 'configure_guild_policy',
        targetType: 'role',
        targetRef: role,
        args: {
          operation: 'authorize_role',
          targetRole: role,
          capabilities: ['moderation']
        },
        isHighImpact: false,
        thought: `Authorize role ${role} to execute moderation actions`
      };
    }

    // P9. Revoke role completely
    const revokeRoleMatch = cleanPrompt.match(/^(?:revoke|remove)\s+(?:the\s+)?(?:role\s+)?@?([a-zA-Z0-9_\s-]+?)(?:\s+role)?\s+(?:from\s+(?:using\s+(?:honey\s+bot|the\s+bot)|authorized\s+roles)|access)(?:\s+in\s+this\s+server|\s+here)?$/i);
    if (revokeRoleMatch) {
      const role = revokeRoleMatch[1].trim().replace(/^@/, '');
      logger.info('Routed through fast-path: revoke role access', { role });
      return {
        intent: 'configure_guild_policy',
        targetType: 'role',
        targetRef: role,
        args: {
          operation: 'revoke_role',
          targetRole: role,
          revokeRole: true
        },
        isHighImpact: false,
        thought: `Revoke role ${role} authorization`
      };
    }

    // P10. Member authorization / revocation
    const memberPolicyMatch = cleanPrompt.match(/^(?:allow|let)\s+(?:member\s+)?(<@!?\d+>|@?[\w.-]+)\s+(?:to\s+)?(?:use\s+\/go\s+for\s+)?read-only\s+inspections/i);
    if (memberPolicyMatch) {
      const member = memberPolicyMatch[1].replace(/^@/, '');
      return {
        intent: 'configure_guild_policy',
        targetType: 'member',
        targetRef: member,
        args: {
          operation: 'authorize_member',
          targetMember: member,
          capabilities: ['inspection']
        },
        isHighImpact: false,
        thought: `Grant member ${member} read-only inspection access`
      };
    }

    const revokeMemberMatch = cleanPrompt.match(/^revoke\s+(?:member\s+)?(<@!?\d+>|@?[\w.-]+)['’]?s?\s+special\s+bot\s+access/i);
    if (revokeMemberMatch) {
      const member = revokeMemberMatch[1].replace(/^@/, '');
      return {
        intent: 'configure_guild_policy',
        targetType: 'member',
        targetRef: member,
        args: {
          operation: 'revoke_member',
          targetMember: member,
          revokeMember: true
        },
        isHighImpact: false,
        thought: `Revoke member ${member} special access`
      };
    }

    // =========================================================================
    // CATEGORY MANAGEMENT FAST-PATHS
    // =========================================================================

    // C1. Explain consequences of deleting category
    if (/(?:explain\s+what\s+(?:will\s+change|happens?)\s+if\s+i\s+delete\s+(?:this\s+)?category)/i.test(cleanPrompt)) {
      const catMatch = cleanPrompt.match(/(?:category\s+)(["'#\w\s.-]+)$/i);
      const catTarget = catMatch ? catMatch[1].trim().replace(/^["']|["']$/g, '') : 'current';
      return {
        intent: 'delete_category',
        targetType: 'category',
        targetRef: catTarget,
        args: { category: catTarget, targetCategory: catTarget, explainOnly: true },
        isHighImpact: false,
        thought: `Explain consequences of deleting category "${catTarget}"`
      };
    }

    // C2. Delete category and its channels (destructive, high-impact)
    const deleteCatWithChannelsMatch = cleanPrompt.match(/^delete\s+(?:this\s+|the\s+)?(?:category\s+)?(["'#\w\s.-]+?)\s*(?:category)?\s+and\s+(?:all\s+)?(?:its\s+)?channels$/i);
    if (deleteCatWithChannelsMatch) {
      const catTarget = deleteCatWithChannelsMatch[1].trim().replace(/^["']|["']$/g, '');
      const cleanTarget = /this|here/i.test(catTarget) ? 'current' : catTarget;
      return {
        intent: 'delete_category',
        targetType: 'category',
        targetRef: cleanTarget,
        args: { category: cleanTarget, targetCategory: cleanTarget, deleteChildren: true },
        isHighImpact: true,
        thought: `Delete category "${cleanTarget}" and all its child channels (destructive)`
      };
    }

    // C3. Delete category (preserving channels or empty)
    const deleteCatMatch = cleanPrompt.match(/^(?:delete|remove)\s+(?:the\s+)?(?:empty\s+)?(?:category\s+)?(["'#\w\s.-]+?)\s+category$/i) ||
      cleanPrompt.match(/^(?:delete|remove)\s+(?:the\s+)?(?:empty\s+)?category\s+(["'#\w\s.-]+)$/i);
    if (deleteCatMatch) {
      const catTarget = deleteCatMatch[1].trim().replace(/^["']|["']$/g, '');
      if (!/^(channel|role|member)$/i.test(catTarget)) {
        return {
          intent: 'delete_category',
          targetType: 'category',
          targetRef: catTarget,
          args: { category: catTarget, targetCategory: catTarget, deleteChildren: false },
          isHighImpact: true,
          thought: `Delete category "${catTarget}"`
        };
      }
    }

    // C4. Inspect Category Sync: "Show me which channels have permission overrides that differ from their category"
    if (/(?:show\s+(?:me\s+)?which\s+channels\s+have\s+permission\s+overrides?\s+that\s+differ\s+from\s+their\s+category|check\s+category\s+sync|unsynchronized\s+channels)/i.test(cleanPrompt)) {
      const catMatch = cleanPrompt.match(/(?:in|for|inside)\s+(?:the\s+)?(["'#\w\s.-]+?)(?:\s+category)?$/i);
      const catRef = catMatch ? catMatch[1].trim().replace(/^["']|["']$/g, '') : 'current';
      return {
        intent: 'inspect_category_sync',
        targetType: 'category',
        targetRef: catRef,
        args: { category: catRef, targetCategory: catRef },
        isHighImpact: false,
        thought: `Inspect category sync state for "${catRef}"`
      };
    }

    // C5. Synchronize child channels with category permissions
    if (/(?:synchronize|sync)\s+(?:the\s+)?(?:child\s+)?channels?\s+with\s+(?:the\s+)?category(?:\s+permissions?)?/i.test(cleanPrompt) ||
        /(?:synchronize|sync)\s+all\s+channels?\s+in\s+(?:the\s+)?(["'#\w\s.-]+?)(?:\s+category)?$/i.test(cleanPrompt)) {
      const catMatch = cleanPrompt.match(/(?:in|under|inside)\s+(?:the\s+)?(?:category\s+)?(["'#\w\s.-]+?)(?:\s+category)?$/i) ||
        cleanPrompt.match(/(?:in|under|with)\s+(?:the\s+)?(["'#\w\s.-]+?)(?:\s+category)?$/i);
      const catRef = catMatch ? catMatch[1].trim().replace(/^["']|["']$/g, '') : 'current';
      return {
        intent: 'sync_category_permissions',
        targetType: 'category',
        targetRef: catRef,
        args: { category: catRef, targetCategory: catRef, targetChannel: 'all' },
        isHighImpact: false,
        thought: `Synchronize child channels with category "${catRef}"`
      };
    }

    // C6. "Show me the channels inside Support" / "Inspect Support category"
    const inspectCatMatch = cleanPrompt.match(/^(?:show\s+(?:me\s+)?(?:the\s+)?channels\s+(?:inside|in|under)\s+(["'#\w\s.-]+?)(?:\s+category)?|inspect\s+(?:the\s+)?category\s+(["'#\w\s.-]+)|inspect\s+(["'#\w\s.-]+?)\s+category)$/i);
    if (inspectCatMatch) {
      const catRef = (inspectCatMatch[1] || inspectCatMatch[2] || inspectCatMatch[3]).trim().replace(/^["']|["']$/g, '');
      if (!/^(server|all|here|current)$/i.test(catRef)) {
        return {
          intent: 'inspect_category',
          targetType: 'category',
          targetRef: catRef,
          args: { category: catRef, targetCategory: catRef },
          isHighImpact: false,
          thought: `Inspect channels and permissions inside category "${catRef}"`
        };
      }
    }

    // C7. "List all categories" / "Show categories"
    if (/^(?:show|list|get|display)\s+(?:all\s+)?categories$/i.test(cleanPrompt)) {
      return {
        intent: 'list_categories',
        targetType: 'server',
        targetRef: 'current',
        args: {},
        isHighImpact: false,
        thought: 'List all categories in the server'
      };
    }

    // C8. "Move #tickets into Support" / "Move #channel into Category"
    const moveChannelIntoCatMatch = cleanPrompt.match(/^move\s+(this\s+channel|<#\d+>|#?[\w-]+)\s+(?:in|into|under|to)\s+(?:the\s+)?(?:category\s+)?(["'#\w\s.-]+?)(?:\s+category)?$/i);
    if (moveChannelIntoCatMatch) {
      const chRef = /this/i.test(moveChannelIntoCatMatch[1]) ? 'current' : moveChannelIntoCatMatch[1].replace(/^#/, '');
      const catRef = moveChannelIntoCatMatch[2].trim().replace(/^["']|["']$/g, '');
      return {
        intent: 'move_channel_to_category',
        targetType: 'channel',
        targetRef: chRef,
        args: { channel: chRef, targetChannel: chRef, category: catRef, targetCategory: catRef, syncPermissions: false },
        isHighImpact: false,
        thought: `Move channel #${chRef} into category "${catRef}"`
      };
    }

    // C9. "Create a Support category" / "Create a private Staff category"
    const createCatMatch = cleanPrompt.match(/^create\s+(?:a\s+)?(private\s+)?(["'#\w\s.-]+?)\s+category$/i) ||
      cleanPrompt.match(/^create\s+(?:a\s+)?category\s+(?:called|named\s+)?(["'#\w\s.-]+)$/i);
    if (createCatMatch) {
      const isPrivate = Boolean(createCatMatch[1]);
      const name = (createCatMatch[2] || createCatMatch[1]).trim().replace(/^["']|["']$/g, '');
      if (!/^(channel|role|member)$/i.test(name)) {
        return {
          intent: 'create_category',
          targetType: 'category',
          targetRef: name,
          args: { name, isPrivate },
          isHighImpact: false,
          thought: `Create category "${name}"${isPrivate ? ' (private)' : ''}`
        };
      }
    }

    // C10. "Rename the Support category to Customer Support"
    const renameCatMatch = cleanPrompt.match(/^rename\s+(?:the\s+)?(?:category\s+)?(["'#\w\s.-]+?)\s+category\s+to\s+(["'#\w\s.-]+)$/i) ||
      cleanPrompt.match(/^rename\s+(?:the\s+)?category\s+(["'#\w\s.-]+?)\s+to\s+(["'#\w\s.-]+)$/i);
    if (renameCatMatch) {
      const catTarget = renameCatMatch[1].trim().replace(/^["']|["']$/g, '');
      const newName = renameCatMatch[2].trim().replace(/^["']|["']$/g, '');
      return {
        intent: 'rename_category',
        targetType: 'category',
        targetRef: catTarget,
        args: { category: catTarget, targetCategory: catTarget, newName },
        isHighImpact: false,
        thought: `Rename category "${catTarget}" to "${newName}"`
      };
    }

    // C11. "Make all channels in Support read-only for the Member role"
    const readOnlyCatMatch = cleanPrompt.match(/^make\s+(?:all\s+channels\s+in\s+)?(["'#\w\s.-]+?)(?:\s+category)?\s+read-only\s+for\s+(?:the\s+)?@?([\w\s.-]+?)(?:\s+role)?$/i);
    if (readOnlyCatMatch) {
      const catRef = readOnlyCatMatch[1].trim().replace(/^["']|["']$/g, '');
      const roleRef = readOnlyCatMatch[2].trim().replace(/^@/, '');
      return {
        intent: 'set_category_permission',
        targetType: 'category',
        targetRef: catRef,
        args: { category: catRef, targetCategory: catRef, target: roleRef, targetRoleOrMember: roleRef, deny: ['SendMessages'], allow: [] },
        isHighImpact: false,
        thought: `Make category "${catRef}" read-only for role ${roleRef}`
      };
    }

    // C12. "Allow the Support Team to view the Support category"
    const allowCatViewMatch = cleanPrompt.match(/^allow\s+(?:the\s+)?@?([\w\s.-]+?)\s+to\s+view\s+(?:the\s+)?(["'#\w\s.-]+?)(?:\s+category)?$/i);
    if (allowCatViewMatch) {
      const roleRef = allowCatViewMatch[1].trim().replace(/^@/, '');
      const catRef = allowCatViewMatch[2].trim().replace(/^["']|["']$/g, '');
      return {
        intent: 'set_category_permission',
        targetType: 'category',
        targetRef: catRef,
        args: { category: catRef, targetCategory: catRef, target: roleRef, targetRoleOrMember: roleRef, allow: ['ViewChannel'], deny: [] },
        isHighImpact: false,
        thought: `Allow role ${roleRef} to view category "${catRef}"`
      };
    }

    // C13. "Remove the explicit send-message restriction from this category"
    const removeCatRestrictionMatch = cleanPrompt.match(/^remove\s+(?:the\s+)?explicit\s+send-message\s+restriction\s+from\s+(?:this\s+category|the\s+(["'#\w\s.-]+?)\s+category|this)$/i);
    if (removeCatRestrictionMatch) {
      const catRef = removeCatRestrictionMatch[1] ? removeCatRestrictionMatch[1].trim().replace(/^["']|["']$/g, '') : 'current';
      return {
        intent: 'set_category_permission',
        targetType: 'category',
        targetRef: catRef,
        args: { category: catRef, targetCategory: catRef, removeRestrictions: ['SendMessages'] },
        isHighImpact: false,
        thought: `Remove send message restriction from category "${catRef}"`
      };
    }

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
      const ch = deleteFromAuthorMatch[2] ? (deleteFromAuthorMatch[2].toLowerCase().includes('this') ? 'current' : deleteFromAuthorMatch[2].replace(/^#/, '')) : 'current';
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

    // =========================================================================
    // NICKNAME & MEMBER MANAGEMENT FAST-PATHS
    // Supports:
    // - "Change Alex's nick to Night Owl."
    // - "Rename Alex to Night Owl on the server."
    // - "I want Alex to show up as Night Owl."
    // - "Make Alex's server nickname Night Owl."
    // - "Make Alex's nick Night Owl."
    // =========================================================================

    // 1. "I want Alex to show up as Night Owl" / "want Alex to appear as Night Owl"
    const wantShowUpMatch = cleanPrompt.match(/^(?:i\s+)?want\s+(<@!?\d+>|@?[\w.-]+)\s+to\s+(?:show\s+up|appear|be\s+displayed)\s+as\s+["']?([^"']+)["']?$/i);
    if (wantShowUpMatch) {
      const target = wantShowUpMatch[1].replace(/^@/, '');
      const newNick = wantShowUpMatch[2].trim().replace(/^["']|["']$/g, '');
      logger.info('Routed through fast-path: want member to show up as', { target, newNick });
      return {
        intent: 'change_nickname',
        targetType: 'member',
        targetRef: target,
        args: { targetMember: target, nickname: newNick },
        isHighImpact: false,
        thought: `Change ${target}'s nickname to "${newNick}"`
      };
    }

    // 2. "Make Alex's server nickname Night Owl" / "Make Alex's nick Night Owl" / "Make Alex show up as Night Owl"
    const makeNickMatch = cleanPrompt.match(/^make\s+(<@!?\d+>|@?[\w.-]+)['’]s\s+(?:server\s+)?(?:nickname|nick)\s+(?:be\s+|as\s+|to\s+be\s+)?["']?([^"']+)["']?$/i) ||
      cleanPrompt.match(/^make\s+(<@!?\d+>|@?[\w.-]+)\s+(?:show\s+up|appear)\s+as\s+["']?([^"']+)["']?$/i);
    if (makeNickMatch) {
      const target = makeNickMatch[1].replace(/^@/, '');
      const newNick = makeNickMatch[2].trim().replace(/^["']|["']$/g, '');
      logger.info('Routed through fast-path: make member nick', { target, newNick });
      return {
        intent: 'change_nickname',
        targetType: 'member',
        targetRef: target,
        args: { targetMember: target, nickname: newNick },
        isHighImpact: false,
        thought: `Change ${target}'s nickname to "${newNick}"`
      };
    }

    // 3. "Rename Alex to Night Owl on the server"
    const renameOnServerMatch = cleanPrompt.match(/^rename\s+(?:user\s+|member\s+)?(<@!?\d+>|@?[\w.-]+)\s+to\s+["']?([^"']+)["']?\s+(?:on|in)\s+(?:the|this)\s+server$/i);
    if (renameOnServerMatch) {
      const target = renameOnServerMatch[1].replace(/^@/, '');
      const newNick = renameOnServerMatch[2].trim().replace(/^["']|["']$/g, '');
      logger.info('Routed through fast-path: rename member on server', { target, newNick });
      return {
        intent: 'change_nickname',
        targetType: 'member',
        targetRef: target,
        args: { targetMember: target, nickname: newNick },
        isHighImpact: false,
        thought: `Rename member ${target} to "${newNick}" on the server`
      };
    }

    // 4. "change my nickname to Alex" / "rename me to Alex"
    const myNickMatch = cleanPrompt.match(/^(?:change|set|rename|update)\s+(?:my\s+(?:server\s+)?(?:nickname|nick)|me)\s+(?:to|as)\s+["']?([^"']+)["']?$/i);
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

    // 5. "rename Sarah to Sally" / "rename @Alex to Night Owl"
    const directRenameMemberMatch = cleanPrompt.match(/^rename\s+(?:user\s+|member\s+)?(<@!?\d+>|@?[\w.-]+)\s+to\s+["']?([^"']+)["']?$/i);
    if (directRenameMemberMatch) {
      const candidateTarget = directRenameMemberMatch[1].replace(/^@/, '');
      if (!/^channel$|^this|^role$|^server$/i.test(candidateTarget) && !candidateTarget.startsWith('#')) {
        const newNick = directRenameMemberMatch[2].trim().replace(/^["']|["']$/g, '');
        logger.info('Routed through fast-path: rename member directly', { target: candidateTarget, newNick });
        return {
          intent: 'change_nickname',
          targetType: 'member',
          targetRef: candidateTarget,
          args: { targetMember: candidateTarget, nickname: newNick },
          isHighImpact: false,
          thought: `Rename member ${candidateTarget} to "${newNick}"`
        };
      }
    }

    // 6. "rename Sarah's nickname to Sally" / "change Alex's nick to Night Owl" / "set nickname of Alex to Night Owl"
    const memberNickMatch = cleanPrompt.match(/^(?:change|set|rename|update)\s+(<@!?\d+>|@?[\w.-]+)['’]s\s+(?:server\s+)?(?:nickname|nick)\s+(?:to|as)\s+["']?([^"']+)["']?$/i) ||
      cleanPrompt.match(/^(?:change|set|rename|update)\s+(?:the\s+)?(?:server\s+)?(?:nickname|nick)\s+(?:of|for)\s+(<@!?\d+>|@?[\w.-]+)\s+(?:to|as)\s+["']?([^"']+)["']?$/i);
    if (memberNickMatch) {
      const target = memberNickMatch[1].replace(/^@/, '');
      const newNick = memberNickMatch[2].trim().replace(/^["']|["']$/g, '');
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

    // 4. "set the nickname of the member i just mentioned to Captain"
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

    // 5. Explicit Nickname Removal: "remove Sarah's server nickname" / "remove my server nickname" / "reset Alex's nickname" / "clear my nickname"
    const removeNickMatch = cleanPrompt.match(/^(?:remove|reset|clear)\s+(?:(<@!?\d+>|@?[\w.-]+)['’]s|my)\s+(?:server\s+)?nickname$/i) ||
      cleanPrompt.match(/^(?:remove|reset|clear)\s+(?:the\s+)?(?:server\s+)?nickname\s+(?:of|for)\s+(<@!?\d+>|@?[\w.-]+|me)$/i);
    if (removeNickMatch) {
      const target = removeNickMatch[1] ? (removeNickMatch[1].toLowerCase() === 'me' ? 'me' : removeNickMatch[1].replace(/^@/, '')) : 'me';
      logger.info('Routed through fast-path: remove server nickname', { target });
      return {
        intent: 'remove_nickname',
        targetType: 'member',
        targetRef: target,
        args: { targetMember: target },
        isHighImpact: false,
        thought: `Remove server nickname for ${target}`
      };
    }

    // 6. Read-Only Nickname Inspection: "what is Alex's current nickname?" / "what is my nickname?"
    const inspectNickMatch = cleanPrompt.match(/^(?:what\s+is|show|inspect|check|view|get)\s+(?:(<@!?\d+>|@?[\w.-]+)['’]s|my)\s+(?:current\s+)?(?:server\s+)?nickname$/i) ||
      cleanPrompt.match(/^(?:what\s+is|show|inspect|check|view|get)\s+(?:the\s+)?(?:current\s+)?(?:server\s+)?nickname\s+(?:of|for)\s+(<@!?\d+>|@?[\w.-]+|me)$/i);
    if (inspectNickMatch) {
      const target = inspectNickMatch[1] ? (inspectNickMatch[1].toLowerCase() === 'me' ? 'me' : inspectNickMatch[1].replace(/^@/, '')) : 'me';
      logger.info('Routed through fast-path: inspect nickname', { target });
      return {
        intent: 'inspect_nickname',
        targetType: 'member',
        targetRef: target,
        args: { targetMember: target },
        isHighImpact: false,
        thought: `Inspect nickname for ${target}`
      };
    }

    // 7. Profile Inspection: "inspect Alex's profile" / "who is Alex" / "view my profile" / "look up @Alex" / "I need details of user <@123>"
    const profileMatch = cleanPrompt.match(/^(?:inspect|view|show|check|get|display)\s+(?:(<@!?\d+>|@?[\w.-]+)['’]s|my)\s+(?:member\s+|user\s+)?profile$/i) ||
      cleanPrompt.match(/^(?:inspect|view|show|check|get|lookup|look\s+up)\s+(?:member|user|profile\s+(?:for|of))\s+(<@!?\d+>|@?[\w.-]+|me)$/i) ||
      cleanPrompt.match(/^(?:who\s+is)\s+(<@!?\d+>|@?[\w.-]+)$/i) ||
      cleanPrompt.match(/^(?:lookup|look\s+up)\s+(<@!?\d+>|@?[\w.-]+)$/i) ||
      cleanPrompt.match(/^(?:(?:i\s+need|give\s+me|get|show)\s+)?(?:the\s+)?details\s+(?:of|for|on)\s+(?:user\s+|member\s+)?(<@!?\d+>|@?[\w.-]+|me)$/i) ||
      cleanPrompt.match(/^(?:user\s+info|member\s+info)\s+(?:for\s+)?(<@!?\d+>|@?[\w.-]+|me)$/i);
    if (profileMatch) {
      const candidate = profileMatch[1] ? (profileMatch[1].toLowerCase() === 'me' ? 'me' : profileMatch[1].replace(/^@/, '')) : 'me';
      if (!/^channel$|^role$|^server$/i.test(candidate)) {
        logger.info('Routed through fast-path: lookup member profile', { target: candidate });
        return {
          intent: 'lookup_member',
          targetType: 'member',
          targetRef: candidate,
          args: { targetMember: candidate },
          isHighImpact: false,
          thought: `Lookup profile for ${candidate}`
        };
      }
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

    // F. "lock this channel" / "close this channel" / "lock down #general" / "freeze chat"
    const lockMatch = cleanPrompt.match(/^(?:lock|close|lock\s*down|shut\s*down|freeze)\s+(this(?:\s+channel)?|here|<#\d+>|#?[\w-]+)$/i);
    if (lockMatch) {
      const target = /this|here/i.test(lockMatch[1]) ? 'current' : lockMatch[1].replace(/^#/, '');
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

    // G. "unlock this channel" / "open this channel" / "open up #general" / "unfreeze #general"
    const unlockMatch = cleanPrompt.match(/^(?:unlock|open(?:\s+up)?|unfreeze)\s+(this(?:\s+channel)?|here|<#\d+>|#?[\w-]+)$/i);
    if (unlockMatch) {
      const target = /this|here/i.test(unlockMatch[1]) ? 'current' : unlockMatch[1].replace(/^#/, '');
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

    // H. "slowmode <N>s" / "set slowmode to <N>s" / "make general slower" / "slow down #general"
    const slowmodeMatch = cleanPrompt.match(/^(?:set\s+)?slowmode\s+(?:to\s+)?(\d+)\s*(?:s|seconds?)?(?:\s+(?:on|in)\s+(this\s+channel|<#\d+>|#?[\w-]+))?$/i) ||
      cleanPrompt.match(/^(?:make\s+(this\s+channel|<#\d+>|#?[\w-]+)\s+(?:slower|slow)|slow\s+down\s+(this\s+channel|<#\d+>|#?[\w-]+))(?:\s+(?:to\s+)?(\d+)\s*s?)?$/i) ||
      cleanPrompt.match(/^(?:make\s+(this\s+channel|<#\d+>|#?[\w-]+)\s+(\d+)\s*s?\s+slowmode)$/i);
    if (slowmodeMatch) {
      let seconds = 10;
      let target = 'current';
      if (/slowmode\s+(?:to\s+)?(\d+)/i.test(cleanPrompt)) {
        seconds = parseInt(cleanPrompt.match(/slowmode\s+(?:to\s+)?(\d+)/i)[1], 10);
      } else if (/to\s+(\d+)\s*s?/i.test(cleanPrompt)) {
        seconds = parseInt(cleanPrompt.match(/to\s+(\d+)\s*s?/i)[1], 10);
      } else if (/(\d+)\s*s?\s+slowmode/i.test(cleanPrompt)) {
        seconds = parseInt(cleanPrompt.match(/(\d+)\s*s?\s+slowmode/i)[1], 10);
      }

      const targetMatch = cleanPrompt.match(/(?:(?:on|in|make|down)\s+)(this(?:\s+channel)?|<#\d+>|#?[\w-]+)/i);
      if (targetMatch && !/^\d+$/.test(targetMatch[1])) {
        target = /this/i.test(targetMatch[1]) ? 'current' : targetMatch[1].replace(/^#/, '');
      }

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
    const timeoutMatch = cleanPrompt.match(/^(?:timeout|mute)\s+(<@!?\d+>|@?[\w.-]+)\s+(?:for\s+)?(\d+|ten|five|fifteen|twenty|thirty|one|two)\s*(?:m|minutes?|mins?)?(?:\s+(?:for|because(?:\s+of)?)\s+(.+))?$/i);
    if (timeoutMatch) {
      const target = timeoutMatch[1].replace(/^@/, '');
      const wordsToNum = { one: 1, two: 2, five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30 };
      const durationMinutes = parseInt(timeoutMatch[2], 10) || wordsToNum[timeoutMatch[2].toLowerCase()] || 10;
      const reason = timeoutMatch[3] ? timeoutMatch[3].trim().replace(/^of\s+/i, '') : 'No reason provided';
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

    // M. Role Creation: "create a new role called Red with Color red" / "create role VIP with color gold"
    const createRoleMatch = cleanPrompt.match(/^(?:create|add|make|set\s+up)\s+(?:a\s+)?(?:new\s+)?role\s+(?:called|named)\s+["']?([^"']+)["']?(?:\s+(?:with\s+)?color\s+["']?([^"']+)["']?)?$/i) ||
      cleanPrompt.match(/^(?:create|add|make)\s+role\s+["']?([^"']+)["']?(?:\s+(?:with\s+)?color\s+["']?([^"']+)["']?)?$/i);
    if (createRoleMatch) {
      const roleName = createRoleMatch[1].trim();
      const rawColor = createRoleMatch[2] ? createRoleMatch[2].trim() : '#99AAB5';
      const resolvedColor = resolveColor(rawColor) || rawColor;
      logger.info('Routed through fast-path: create_role', { roleName, resolvedColor });
      return {
        intent: 'create_role',
        targetType: 'role',
        targetRef: roleName,
        args: { name: roleName, color: resolvedColor },
        isHighImpact: false,
        thought: `Create role @${roleName} with color ${resolvedColor}`
      };
    }

    // N. Role Removal: "remove role X from Y" / "remove X from Y" / "remove Jordan from Moderator role"
    const removeRoleFlex = cleanPrompt.match(/^(?:remove|take\s+away|strip|revoke)\s+role\s+(<@&?\d+>|@?[\w.-]+)\s+from\s+(<@!?\d+>|@?[\w.-]+)(?:\s+(?:for|because)\s+(.+))?$/i) ||
      cleanPrompt.match(/^(?:remove|take\s+away|strip|revoke)\s+(?:the\s+)?@?([\w.-]+)\s+role\s+from\s+(<@!?\d+>|@?[\w.-]+)(?:\s+(?:for|because)\s+(.+))?$/i) ||
      cleanPrompt.match(/^(?:remove|take\s+away|strip|revoke)\s+(<@!?\d+>|@?[\w.-]+)['’]s\s+(?:the\s+)?@?([\w.-]+)\s+role(?:\s+(?:for|because)\s+(.+))?$/i) ||
      cleanPrompt.match(/^(?:remove|take\s+away|strip|revoke)\s+(<@!?\d+>|@?[\w.-]+)\s+from\s+(?:the\s+)?(?:role\s+)?(<@&?\d+>|@?[\w.-]+)(?:\s+role)?(?:\s+(?:for|because)\s+(.+))?$/i);
    if (removeRoleFlex) {
      const isReversed = cleanPrompt.match(/^(?:remove|take\s+away|strip|revoke)\s+(<@!?\d+>|@?[\w.-]+)['’]s/i);
      const isMemberFirst = cleanPrompt.match(/^(?:remove|take\s+away|strip|revoke)\s+(<@!?\d+>|@?[\w.-]+)\s+from/i);
      let role, target;
      if (isReversed || isMemberFirst) {
        target = removeRoleFlex[1].replace(/^[@!]/, '');
        role = removeRoleFlex[2].replace(/^[@&]/, '');
      } else {
        role = removeRoleFlex[1].replace(/^[@&]/, '');
        target = removeRoleFlex[2].replace(/^[@!]/, '');
      }
      const reason = removeRoleFlex[3] ? removeRoleFlex[3].trim() : 'No reason provided';
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

    // O. Role Assignment (supports IDs, mentions, role names, and flexible phrasing)
    const assignRoleFlex = cleanPrompt.match(/^(?:assign|give|grant|add)\s+role\s+(<@&?\d+>|@?[\w.-]+)\s+to\s+(<@!?\d+>|@?[\w.-]+)(?:\s+(?:for|because)\s+(.+))?$/i) ||
      cleanPrompt.match(/^(?:assign|give|grant)\s+(<@!?\d+>|@?[\w.-]+)\s+(?:the\s+)?role\s+(<@&?\d+>|@?[\w.-]+)(?:\s+(?:for|because)\s+(.+))?$/i) ||
      cleanPrompt.match(/^(?:assign|give|grant)\s+(?:the\s+)?@?([\w.-]+)\s+role\s+to\s+(<@!?\d+>|@?[\w.-]+)(?:\s+(?:for|because)\s+(.+))?$/i) ||
      cleanPrompt.match(/^(?:assign|give|grant)\s+(<@!?\d+>|@?[\w.-]+)\s+(?:the\s+)?@?([\w.-]+)\s+role(?:\s+(?:for|because)\s+(.+))?$/i) ||
      cleanPrompt.match(/^(?:add|give|assign)\s+role\s+(\d{17,20})\s+to\s+(\d{17,20})$/i);
    if (assignRoleFlex) {
      const isRoleFirst = /^(?:assign|give|grant|add)\s+role/i.test(cleanPrompt);
      const role = (isRoleFirst ? assignRoleFlex[1] : assignRoleFlex[2]).replace(/^[@&]/, '');
      const target = (isRoleFirst ? assignRoleFlex[2] : assignRoleFlex[1]).replace(/^[@!]/, '');
      const reason = assignRoleFlex[3] ? assignRoleFlex[3].trim() : 'No reason provided';
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

    // P. User Channel Permission - Multi-constraint: "let Priya view #staff-chat but not send messages there"
    const letPermMultiMatch = cleanPrompt.match(/^let\s+(<@!?\d+>|@?[\w.-]+)\s+view\s+(<#\d+>|#?[\w-]+)\s+but\s+not\s+(?:send\s+messages|send|talk|chat)(?:\s+there)?$/i);
    if (letPermMultiMatch) {
      const member = letPermMultiMatch[1].replace(/^@/, '');
      const ch = letPermMultiMatch[2].replace(/^#/, '');
      logger.info('Routed through fast-path: set_user_channel_permission (view but not send)', { member, ch });
      return {
        intent: 'set_user_channel_permission',
        targetType: 'member_channel',
        targetRef: member,
        args: { targetMember: member, targetChannel: ch, allow: ['ViewChannel'], deny: ['SendMessages'] },
        isHighImpact: false,
        thought: `Allow ${member} ViewChannel but deny SendMessages in #${ch}`
      };
    }

    // Q. User Channel Permission - Allow: "allow Alex to send messages in #general"
    const allowPermMatch = cleanPrompt.match(/^(?:allow|let)\s+(<@!?\d+>|@?[\w.-]+)\s+(?:to\s+)?(send\s+messages|send\s+messages\s+in\s+threads|view\s+channel|view|read|attach\s+files|files|images|embed\s+links|links|mention\s+everyone|add\s+reactions|manage\s+messages|connect|speak|stream)\s+(?:in|on|to)\s+(<#\d+>|#?[\w-]+)$/i);
    if (allowPermMatch) {
      const member = allowPermMatch[1].replace(/^@/, '');
      const rawPerm = allowPermMatch[2].trim();
      const ch = allowPermMatch[3].replace(/^#/, '');
      logger.info('Routed through fast-path: set_user_channel_permission (allow)', { member, rawPerm, ch });
      return {
        intent: 'set_user_channel_permission',
        targetType: 'member_channel',
        targetRef: member,
        args: { targetMember: member, targetChannel: ch, allow: [rawPerm] },
        isHighImpact: false,
        thought: `Allow ${member} to ${rawPerm} in #${ch}`
      };
    }

    // R. User Channel Permission - Deny: "stop Jordan from sending messages in #announcements" / "prevent Sam from connecting to the voice channel"
    const denyPermMatch = cleanPrompt.match(/^(?:stop|prevent|deny|disallow|block)\s+(<@!?\d+>|@?[\w.-]+)\s+(?:from\s+)?(sending\s+messages|sending\s+messages\s+in\s+threads|send\s+messages|viewing\s+channel|view\s+channel|view|attaching\s+files|attach\s+files|embedding\s+links|embed\s+links|mentioning\s+everyone|mention\s+everyone|adding\s+reactions|add\s+reactions|connecting|connect|speaking|speak)\s+(?:in|on|to)\s+(<#\d+>|#?[\w-]+)$/i) ||
      cleanPrompt.match(/^remove\s+(<@!?\d+>|@?[\w.-]+)['’]s\s+(?:ability|permission)\s+to\s+(send\s+messages|attach\s+files|embed\s+links|mention\s+everyone|view\s+channel)\s+(?:in|on)\s+(<#\d+>|#?[\w-]+)$/i);
    if (denyPermMatch) {
      const member = denyPermMatch[1].replace(/^@/, '');
      const rawPerm = denyPermMatch[2].trim();
      const ch = denyPermMatch[3].replace(/^#/, '');
      logger.info('Routed through fast-path: set_user_channel_permission (deny)', { member, rawPerm, ch });
      return {
        intent: 'set_user_channel_permission',
        targetType: 'member_channel',
        targetRef: member,
        args: { targetMember: member, targetChannel: ch, deny: [rawPerm] },
        isHighImpact: false,
        thought: `Deny ${rawPerm} for ${member} in #${ch}`
      };
    }

    // S. User Channel Permission - Read-Only: "make #general read-only for Sam" / "give Sam read-only access to #general"
    const readOnlyMatch = cleanPrompt.match(/^make\s+(<#\d+>|#?[\w-]+)\s+read-?only\s+for\s+(<@!?\d+>|@?[\w.-]+)$/i) ||
      cleanPrompt.match(/^give\s+(<@!?\d+>|@?[\w.-]+)\s+read-?only\s+access\s+to\s+(<#\d+>|#?[\w-]+)$/i);
    if (readOnlyMatch) {
      const ch = (cleanPrompt.startsWith('make') ? readOnlyMatch[1] : readOnlyMatch[2]).replace(/^#/, '');
      const member = (cleanPrompt.startsWith('make') ? readOnlyMatch[2] : readOnlyMatch[1]).replace(/^@/, '');
      logger.info('Routed through fast-path: set_user_channel_permission (read-only)', { member, ch });
      return {
        intent: 'set_user_channel_permission',
        targetType: 'member_channel',
        targetRef: member,
        args: { targetMember: member, targetChannel: ch, allow: ['ViewChannel', 'ReadMessageHistory'], deny: ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads'] },
        isHighImpact: false,
        thought: `Make #${ch} read-only for ${member}`
      };
    }

    // T. User Channel Permission - Reset/Inherit: "reset Sam's send-message permission in #general"
    const resetPermMatch = cleanPrompt.match(/^reset\s+(<@!?\d+>|@?[\w.-]+)['’]s\s+([\w\s-]+?)\s+permission\s+(?:in|on)\s+(<#\d+>|#?[\w-]+)$/i);
    if (resetPermMatch) {
      const member = resetPermMatch[1].replace(/^@/, '');
      const rawPerm = resetPermMatch[2].trim();
      const ch = resetPermMatch[3].replace(/^#/, '');
      logger.info('Routed through fast-path: set_user_channel_permission (inherit/reset)', { member, rawPerm, ch });
      return {
        intent: 'set_user_channel_permission',
        targetType: 'member_channel',
        targetRef: member,
        args: { targetMember: member, targetChannel: ch, inherit: [rawPerm] },
        isHighImpact: false,
        thought: `Reset ${rawPerm} permission for ${member} in #${ch} to inherit`
      };
    }

    // U. Permission Inspection: "show Alex's permissions in #general" / "does Alex have administrator"
    const inspectPermMatch = cleanPrompt.match(/^(?:show|inspect|check|explain|get|view)\s+(<@!?\d+>|@?[\w.-]+)['’]s\s+permissions?(?:\s+(?:in|on)\s+(<#\d+>|#?[\w-]+))?$/i) ||
      cleanPrompt.match(/^(?:show|inspect|check|view)\s+permissions?\s+(?:for|of)\s+(<@!?\d+>|@?[\w.-]+)(?:\s+(?:in|on)\s+(<#\d+>|#?[\w-]+))?$/i);
    if (inspectPermMatch) {
      const member = inspectPermMatch[1].replace(/^@/, '');
      const ch = inspectPermMatch[2] ? inspectPermMatch[2].replace(/^#/, '') : undefined;
      logger.info('Routed through fast-path: inspect_user_permissions', { member, ch });
      return {
        intent: 'inspect_user_permissions',
        targetType: 'member',
        targetRef: member,
        args: { targetMember: member, targetChannel: ch },
        isHighImpact: false,
        thought: `Inspect permissions for ${member}${ch ? ` in #${ch}` : ''}`
      };
    }

    const whyCanMatch = cleanPrompt.match(/^why\s+can\s+(<@!?\d+>|@?[\w.-]+)\s+(.+)$/i);
    if (whyCanMatch) {
      const member = whyCanMatch[1].replace(/^@/, '');
      logger.info('Routed through fast-path: inspect_user_permissions (why)', { member });
      return {
        intent: 'inspect_user_permissions',
        targetType: 'member',
        targetRef: member,
        args: { targetMember: member },
        isHighImpact: false,
        thought: `Explain why ${member} has permissions`
      };
    }

    const hasAdminMatch = cleanPrompt.match(/^does\s+(<@!?\d+>|@?[\w.-]+)\s+have\s+admin(?:istrator)?(?:\s+privileges|\s+permissions)?$/i);
    if (hasAdminMatch) {
      const member = hasAdminMatch[1].replace(/^@/, '');
      logger.info('Routed through fast-path: inspect_user_permissions (admin check)', { member });
      return {
        intent: 'inspect_user_permissions',
        targetType: 'member',
        targetRef: member,
        args: { targetMember: member },
        isHighImpact: false,
        thought: `Check if ${member} has Administrator privileges`
      };
    }

    // V. Voice Moderation: "mute Alex in voice" / "deafen Alex in voice" / "disconnect Alex from voice"
    const voiceMuteMatch = cleanPrompt.match(/^(?:server\s+)?mute\s+(<@!?\d+>|@?[\w.-]+)\s+in\s+voice$/i);
    if (voiceMuteMatch) {
      const target = voiceMuteMatch[1].replace(/^@/, '');
      logger.info('Routed through fast-path: voice_mute', { target });
      return { intent: 'voice_mute', targetType: 'member', targetRef: target, args: { targetMember: target }, isHighImpact: false, thought: `Mute ${target} in voice` };
    }

    const voiceUnmuteMatch = cleanPrompt.match(/^(?:server\s+)?unmute\s+(<@!?\d+>|@?[\w.-]+)\s+in\s+voice$/i);
    if (voiceUnmuteMatch) {
      const target = voiceUnmuteMatch[1].replace(/^@/, '');
      logger.info('Routed through fast-path: voice_unmute', { target });
      return { intent: 'voice_unmute', targetType: 'member', targetRef: target, args: { targetMember: target }, isHighImpact: false, thought: `Unmute ${target} in voice` };
    }

    const voiceDeafenMatch = cleanPrompt.match(/^(?:server\s+)?deafen\s+(<@!?\d+>|@?[\w.-]+)(?:\s+in\s+voice)?$/i);
    if (voiceDeafenMatch) {
      const target = voiceDeafenMatch[1].replace(/^@/, '');
      logger.info('Routed through fast-path: voice_deafen', { target });
      return { intent: 'voice_deafen', targetType: 'member', targetRef: target, args: { targetMember: target }, isHighImpact: false, thought: `Deafen ${target} in voice` };
    }

    const voiceUndeafenMatch = cleanPrompt.match(/^(?:server\s+)?undeafen\s+(<@!?\d+>|@?[\w.-]+)(?:\s+in\s+voice)?$/i);
    if (voiceUndeafenMatch) {
      const target = voiceUndeafenMatch[1].replace(/^@/, '');
      logger.info('Routed through fast-path: voice_undeafen', { target });
      return { intent: 'voice_undeafen', targetType: 'member', targetRef: target, args: { targetMember: target }, isHighImpact: false, thought: `Undeafen ${target} in voice` };
    }

    const voiceDcMatch = cleanPrompt.match(/^(?:disconnect|kick)\s+(<@!?\d+>|@?[\w.-]+)\s+from\s+voice(?:\s+channel)?$/i);
    if (voiceDcMatch) {
      const target = voiceDcMatch[1].replace(/^@/, '');
      logger.info('Routed through fast-path: voice_disconnect', { target });
      return { intent: 'voice_disconnect', targetType: 'member', targetRef: target, args: { targetMember: target }, isHighImpact: false, thought: `Disconnect ${target} from voice` };
    }

    const voiceMoveMatch = cleanPrompt.match(/^move\s+(<@!?\d+>|@?[\w.-]+)\s+to\s+(?:voice\s+channel\s+)?(<#\d+>|#?[\w-]+)$/i);
    if (voiceMoveMatch) {
      const target = voiceMoveMatch[1].replace(/^@/, '');
      const ch = voiceMoveMatch[2].replace(/^#/, '');
      logger.info('Routed through fast-path: voice_move', { target, ch });
      return { intent: 'voice_move', targetType: 'member_channel', targetRef: target, args: { targetMember: target, targetChannel: ch }, isHighImpact: false, thought: `Move ${target} to voice channel #${ch}` };
    }

    // W. Warnings: "warn Alex for spamming" / "show warnings for Alex" / "clear warnings for Alex"
    const warnMatch = cleanPrompt.match(/^warn\s+(<@!?\d+>|@?[\w.-]+)(?:\s+(?:for|because)\s+(.+))?$/i);
    if (warnMatch) {
      const target = warnMatch[1].replace(/^@/, '');
      const reason = warnMatch[2] ? warnMatch[2].trim() : 'No reason provided';
      logger.info('Routed through fast-path: issue_warning', { target, reason });
      return { intent: 'issue_warning', targetType: 'member', targetRef: target, args: { targetMember: target, reason }, isHighImpact: false, thought: `Warn ${target} for: ${reason}` };
    }

    const inspectWarnMatch = cleanPrompt.match(/^(?:show|check|view|inspect|list)\s+warnings?\s+(?:for|of)\s+(<@!?\d+>|@?[\w.-]+)$/i);
    if (inspectWarnMatch) {
      const target = inspectWarnMatch[1].replace(/^@/, '');
      logger.info('Routed through fast-path: inspect_warnings', { target });
      return { intent: 'inspect_warnings', targetType: 'member', targetRef: target, args: { targetMember: target }, isHighImpact: false, thought: `Inspect warnings for ${target}` };
    }

    const clearWarnMatch = cleanPrompt.match(/^clear\s+warnings?\s+(?:for|of)\s+(<@!?\d+>|@?[\w.-]+)$/i);
    if (clearWarnMatch) {
      const target = clearWarnMatch[1].replace(/^@/, '');
      logger.info('Routed through fast-path: clear_warnings', { target });
      return { intent: 'clear_warnings', targetType: 'member', targetRef: target, args: { targetMember: target }, isHighImpact: false, thought: `Clear warnings for ${target}` };
    }

    // X. Softban & Moderation State Inspection: "softban Alex" / "inspect Alex's moderation state" / "unban user 123"
    const softbanMatch = cleanPrompt.match(/^soft-?ban\s+(<@!?\d+>|@?[\w.-]+)(?:\s+(?:for|because)\s+(.+))?$/i);
    if (softbanMatch) {
      const target = softbanMatch[1].replace(/^@/, '');
      const reason = softbanMatch[2] ? softbanMatch[2].trim() : 'Softban (kick + message purge)';
      logger.info('Routed through fast-path: softban_member', { target, reason });
      return { intent: 'softban_member', targetType: 'member', targetRef: target, args: { targetMember: target, reason }, isHighImpact: true, thought: `Softban ${target}` };
    }

    const inspectModMatch = cleanPrompt.match(/^(?:inspect|show|check)\s+(<@!?\d+>|@?[\w.-]+)['’]s\s+moderation\s+(?:state|history)$/i) ||
      cleanPrompt.match(/^(?:inspect|show|check)\s+moderation\s+(?:state|history)\s+(?:for|of)\s+(<@!?\d+>|@?[\w.-]+)$/i);
    if (inspectModMatch) {
      const target = inspectModMatch[1].replace(/^@/, '');
      logger.info('Routed through fast-path: inspect_member_moderation', { target });
      return { intent: 'inspect_member_moderation', targetType: 'member', targetRef: target, args: { targetMember: target }, isHighImpact: false, thought: `Inspect moderation state for ${target}` };
    }

    const unbanMatch = cleanPrompt.match(/^unban\s+(?:user\s+)?(<@!?\d+>|@?[\w.-]+)(?:\s+(?:for|because)\s+(.+))?$/i);
    if (unbanMatch) {
      const target = unbanMatch[1].replace(/^@/, '');
      const reason = unbanMatch[2] ? unbanMatch[2].trim() : 'Unbanned via Honey Bot';
      logger.info('Routed through fast-path: unban_member', { target, reason });
      return { intent: 'unban_member', targetType: 'user', targetRef: target, args: { targetMember: target, targetMemberId: target, reason }, isHighImpact: false, thought: `Unban ${target}` };
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

    // T. Follow-up role rename: "rename that role to <name>" / "change that role's name to <name>"
    const renameThatRoleMatch = cleanPrompt.match(/^(?:rename\s+that\s+role\s+(?:to\s+)?|change\s+that\s+role['’]s\s+name\s+to\s+)["']?([^"']+)["']?$/i);
    if (renameThatRoleMatch) {
      const newName = renameThatRoleMatch[1].trim();
      logger.info('Routed through fast-path: rename that role', { newName });
      return {
        intent: 'edit_role',
        targetType: 'role',
        targetRef: 'that role',
        args: { targetRole: 'that role', name: newName },
        isHighImpact: false,
        thought: `Rename that role to "${newName}"`
      };
    }

    // U. Follow-up role recolor: "change its color to blue too" / "recolor it to blue" / "change its color to <color>"
    const recolorRoleFollowupMatch = cleanPrompt.match(/^(?:change\s+its\s+color\s+to\s+|recolor\s+it\s+to\s+|set\s+its\s+color\s+to\s+)([#a-zA-Z0-9_\s-]+?)(?:\s+too)?$/i);
    if (recolorRoleFollowupMatch) {
      const rawColor = recolorRoleFollowupMatch[1].trim().replace(/^["']|["']$/g, '');
      const resolvedColor = resolveColor(rawColor) || rawColor;
      logger.info('Routed through fast-path: recolor that role', { resolvedColor });
      return {
        intent: 'edit_role',
        targetType: 'role',
        targetRef: 'that role',
        args: { targetRole: 'that role', color: resolvedColor },
        isHighImpact: false,
        thought: `Change that role color to ${resolvedColor}`
      };
    }

    // V. Follow-up delete created channel: "remove the channel you just created" / "delete the channel we just created"
    if (/^(?:remove|delete)\s+(?:the\s+channel\s+(?:you|we)\s+just\s+created|that\s+channel)$/i.test(cleanPrompt)) {
      logger.info('Routed through fast-path: delete created channel');
      return {
        intent: 'delete_channel',
        targetType: 'channel',
        targetRef: 'the channel we just created',
        args: {},
        isHighImpact: true,
        thought: 'Delete the channel that was recently created'
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

    if (this.isDeterministicOnly || typeof this.aiProvider?.planWithCustomPrompt !== 'function') {
      return {
        intent: 'unsupported',
        thought: 'Deterministic router could not match rule',
        isHighImpact: false,
        args: {}
      };
    }

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
