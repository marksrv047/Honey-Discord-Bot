import { ContextManager } from './context-manager.js';
import { AIProvider } from './ai-provider.js';
import { TaskBudget } from './budget.js';
import { Logger } from './logger.js';
import { config } from './config.js';

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
  "intent": "rename_channel" | "edit_channel_topic" | "set_channel_slowmode" | "lock_channel" | "unlock_channel" | "create_channel" | "delete_channel" | "create_role" | "edit_role" | "delete_role" | "assign_role" | "remove_role" | "change_nickname" | "timeout_member" | "remove_timeout" | "kick_member" | "ban_member" | "unban_member" | "setup_ticket_system" | "audit_server" | "list_channels" | "list_roles" | "conversational" | "unsupported" | "complex_plan",
  "targetType": "channel" | "role" | "member" | "server" | null,
  "targetRef": "current" | string (ID, name, or mention, e.g. "current", "<#123>", "<@123>", "VIP"),
  "args": { ... any arguments such as name, topic, seconds, durationMinutes, color, etc. ... },
  "isHighImpact": boolean (true if deleting channel/role, banning, kicking, or mass action),
  "clarificationNeeded": null or "Concise question if genuinely ambiguous",
  "conversationalResponse": null or "Witty friendly honeybee response if chatting/greeting",
  "multiActions": null or [ { action: string, ... } ] (only for requests requiring multiple distinct steps)
}

RULES:
1. "this channel", "here", "current channel" -> targetType: "channel", targetRef: "current".
2. Mentions (<#id>, <@id>, <@&id>) -> extract the ID or reference.
3. Greetings ("hi", "hello") -> intent: "conversational", provide conversationalResponse.
4. Output raw JSON only. No markdown formatting.
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

    // =========================================================================
    // 1. DETERMINISTIC FAST PATH (0 LLM Calls, 0ms latency)
    // =========================================================================

    // A. Casual greetings / conversational
    if (/^(hi|hello|hey|yo|greetings|howdy|good\s+(morning|afternoon|evening))\b/i.test(trimmed) && trimmed.length < 25) {
      logger.info('Routed through fast-path: Conversational');
      return {
        intent: 'conversational',
        thought: 'User greeted the bot',
        conversationalResponse: "Bzz! 🍯 Hey there! I'm Honey, your autonomous Discord server architect. You can tell me to rename this channel, create roles, lock channels, or set up tickets. What can I do for you today?",
        isHighImpact: false
      };
    }

    // B. Explicit channel listing
    if (/^(show|list|get|display)\s+(all\s+)?channels?$/i.test(trimmed)) {
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
    if (/^(show|list|get|display)\s+(all\s+)?roles?$/i.test(trimmed)) {
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
    if (/^(audit\s+(server|permissions?)|server\s+audit)$/i.test(trimmed)) {
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
    const renameMatch = trimmed.match(/^rename\s+(this\s+channel|<#\d+>|#?[\w-]+)\s+to\s+([a-zA-Z0-9_-]+)$/i);
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
    const lockMatch = trimmed.match(/^lock\s+(this\s+channel|here|<#\d+>|#?[\w-]+)$/i);
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
    const unlockMatch = trimmed.match(/^unlock\s+(this\s+channel|here|<#\d+>|#?[\w-]+)$/i);
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
    const slowmodeMatch = trimmed.match(/^(?:set\s+)?slowmode\s+(?:to\s+)?(\d+)\s*(?:s|seconds?)?(?:\s+(?:on|in)\s+(this\s+channel|<#\d+>|#?[\w-]+))?$/i);
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
