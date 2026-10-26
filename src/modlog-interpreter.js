import { AIProvider } from './ai-provider.js';
import { Logger } from './logger.js';

const logger = new Logger('ModlogInterpreter');

export const MODLOG_PROMPT = `
You are the Discord Moderation Log Configuration Interpreter.
Analyze the user request and determine the mod-log intent.
Return ONLY a raw JSON object matching this schema:
{
  "intent": "configure_channel" | "inspect_config" | "test_channel" | "enable_logging" | "disable_logging" | "troubleshoot_config" | "clarification_needed" | "unsupported",
  "targetChannel": string | "current" | null (ID, mention like <#123>, name like staff-logs, or "current"),
  "testAfterConfig": boolean (true if user also asked to test/verify the channel after setting it),
  "clarificationQuestion": string | null (question if intent is ambiguous or asks to delete channel),
  "explanation": "Brief explanation"
}

RULES:
1. "Set #staff-logs as log channel", "use this channel for logs", "move logs to #staff-logs" -> intent: "configure_channel".
2. "and test it", "and verify it works" -> testAfterConfig: true.
3. "Which channel is configured", "show config", "is logging enabled" -> intent: "inspect_config".
4. "Test the log channel", "verify logging works" -> intent: "test_channel".
5. "Enable logging", "turn logs on" -> intent: "enable_logging".
6. "Disable logging", "turn logs off" -> intent: "disable_logging".
7. "Delete the mod log channel" -> intent: "clarification_needed", clarificationQuestion: "Did you mean disable moderation log delivery, or delete the Discord channel itself? (Honey Bot does not delete channels through /modlog)."
8. Raw JSON only. No markdown.
`;

export class ModlogInterpreter {
  constructor(aiProvider = new AIProvider()) {
    this.aiProvider = aiProvider;
  }

  static async interpret(prompt, aiProvider) {
    const interpreter = new ModlogInterpreter(aiProvider);
    return interpreter.interpret(prompt);
  }

  /**
   * Resolves a free-form modlog prompt into a structured intent.
   * Uses deterministic fast-path for routine requests (0 LLM tokens),
   * and compact model interpretation for varied natural language.
   */
  async interpret(prompt) {
    const trimmed = String(prompt || '').trim();
    const cleanPrompt = trimmed.replace(/[.!?]+$/, '').trim();

    // 1. Out-of-scope administrative/moderation commands directed to /modlog
    const isModMutation = /^(?:ban|kick|timeout|mute|untimeout|unmute|purge|delete\s+\d+\s+messages?|create\s+role|rename\s+channel)\b/i.test(cleanPrompt);
    const mentionsLogging = /(?:mod[- ]?log|logging|log|logged|why|appear|record)/i.test(cleanPrompt);
    if (isModMutation && !mentionsLogging) {
      return {
        intent: 'out_of_scope',
        targetChannel: null,
        testAfterConfig: false,
        clarificationQuestion: null,
        explanation: 'This request belongs to /go. /modlog is specifically for configuring, verifying, testing, and troubleshooting moderation logging.'
      };
    }

    // 2. Setup requests
    if (/(?:set\s*up|initialize)\s+(?:the\s+)?moderation\s+log\s+for\s+this\s+server/i.test(cleanPrompt)) {
      return {
        intent: 'configure_channel',
        targetChannel: 'mod-logs',
        createIfMissing: true,
        testAfterConfig: true,
        clarificationQuestion: null
      };
    }

    if (/(?:set\s*up|create|initialize)\s+(?:the\s+)?(?:mod[- ]?logs?|moderation\s+logs?)(?:\s+channel)?(?:\s+in\s+this\s+server)?/i.test(cleanPrompt) ||
        /create\s+(?:a\s+)?(?:mod[- ]?logs?|moderation\s+logs?)\s+channel/i.test(cleanPrompt)) {
      const channelMatch = cleanPrompt.match(/(?:called|named|to|in)\s+(#?[\w-]+)/i);
      const specifiedName = channelMatch ? channelMatch[1].replace(/^#/, '') : 'mod-logs';
      return {
        intent: 'setup_logging',
        targetChannel: specifiedName,
        createIfMissing: true,
        testAfterConfig: true,
        clarificationQuestion: null
      };
    }

    // 2b. Event filter and preferences updates
    if (/(?:log\s+permission\s+changes|log\s+category\s+modifications|also\s+log|include\s+(?:permissions?|categories)|record\s+permission\s+changes)/i.test(cleanPrompt)) {
      return {
        intent: 'update_filter',
        filterEvents: ['moderation', 'roles', 'channels', 'categories', 'permissions', 'policy'],
        clarificationQuestion: null
      };
    }

    if (/(?:stop\s+logging\s+successful\s+actions|only\s+log\s+failed|keep\s+failed\s+actions\s+and\s+denied)/i.test(cleanPrompt)) {
      return {
        intent: 'update_filter',
        logSuccess: false,
        logFailed: true,
        logDenied: true,
        clarificationQuestion: null
      };
    }

    // 2c. Ambiguity check for "delete ... channel"
    if (/delete\s+(?:the\s+)?(?:mod[- ]?log|logging)\s+channel/i.test(cleanPrompt)) {
      return {
        intent: 'clarification_needed',
        targetChannel: null,
        testAfterConfig: false,
        clarificationQuestion: 'Did you mean to disable moderation log delivery, or delete the Discord channel itself? (Honey Bot does not delete channels through /modlog).'
      };
    }

    // 3. Troubleshooting & Safe Repairs
    if (/(?:(?:check\s+)?why\s+(?:the\s+)?(?:last\s+)?(?:moderation\s+)?(?:entry|action)\s+(?:wasn['’]?t\s+logged|was\s+not\s+delivered)|why\s+(?:are\s+)?logs\s+not\s+appearing|why\s+aren['’]t\s+moderation\s+reports\s+appearing|check\s+(?:the\s+)?configuration\s+and\s+repair|repair\s+anything|fix\s+(?:the\s+)?(?:mod[- ]?log|logging)|troubleshoot|find\s+out\s+what('s|\s+is)\s+wrong|check\s+permissions)/i.test(cleanPrompt)) {
      const wantsRepair = /(?:repair|fix)/i.test(cleanPrompt);
      return {
        intent: 'troubleshoot_config',
        targetChannel: null,
        testAfterConfig: false,
        repair: wantsRepair,
        clarificationQuestion: null
      };
    }

    if (/(?:retry\s+(?:the\s+)?pending\s+log|deliver\s+pending\s+logs?|flush\s+pending\s+logs?)/i.test(cleanPrompt)) {
      return {
        intent: 'troubleshoot_config',
        targetChannel: null,
        testAfterConfig: false,
        repair: true,
        clarificationQuestion: null
      };
    }

    // 4. Inspection
    if (/^(which\s+channel|show|what('s|\s+is)|get|view|display)\s+(is\s+)?(the\s+)?(current\s+)?(?:mod[- ]?log|logging)(?:\s+(?:channel|config|status))?/i.test(cleanPrompt) ||
        /^(?:is|tell\s+me\s+whether)\s+logging\s+is\s+enabled/i.test(cleanPrompt) ||
        /^which\s+channel\s+is\s+(?:currently\s+)?configured/i.test(cleanPrompt) ||
        /^mod[- ]?log\s+status$/i.test(cleanPrompt) ||
        /check\s+whether\s+.*(?:recorded|logged)/i.test(cleanPrompt) ||
        /explain\s+(?:the\s+)?(?:current\s+)?(?:logging\s+)?config/i.test(cleanPrompt) ||
        /show\s+me\s+(?:the\s+)?current\s+logging\s+configuration/i.test(cleanPrompt)) {
      return {
        intent: 'inspect_config',
        targetChannel: null,
        testAfterConfig: false,
        clarificationQuestion: null
      };
    }

    // 5. Testing & Verification
    if (/^(?:check\s+whether\s+logging\s+is\s+working|test\s+whether\s+moderation\s+logs\s+are\s+working|send\s+a\s+test\s+entry|check\s+whether\s+you\s+can\s+send\s+embeds|test\s+(?:the\s+)?(?:mod[- ]?log|logging)\s*(?:channel)?|check\s+whether\s+you\s+can\s+send\s+messages|verify\s+(?:the\s+)?(?:current\s+)?(?:logging\s+)?config(?:uration)?|verify\s+that\s+(?:all\s+)?(?:moderation\s+)?actions\s+are\s+being\s+recorded)/i.test(cleanPrompt)) {
      return {
        intent: 'test_channel',
        targetChannel: null,
        testAfterConfig: false,
        clarificationQuestion: null
      };
    }

    // 6. Disablement
    if (/^(?:disable|turn\s+off|stop|deactivate)\s+(?:the\s+)?(?:mod[- ]?log(?:ging)?|moderation\s+log(?:ging)?)(?:\s+for\s+this\s+server)?$/i.test(cleanPrompt)) {
      return {
        intent: 'disable_logging',
        targetChannel: null,
        testAfterConfig: false,
        clarificationQuestion: null
      };
    }

    // 7. Enablement
    if (/^(?:enable|turn\s+on|activate)\s+(?:the\s+)?(?:mod[- ]?log(?:ging)?|moderation\s+log(?:ging)?)/i.test(cleanPrompt) ||
        /^(?:turn\s+logging\s+back\s+on|enable\s+logging\s+again)/i.test(cleanPrompt)) {
      return {
        intent: 'enable_logging',
        targetChannel: null,
        testAfterConfig: false,
        clarificationQuestion: null
      };
    }

    // 8. Configuration with channel
    const configMatch = cleanPrompt.match(/(?:set|use|make|move\s+(?:moderation\s+)?(?:the\s+)?logs\s+to|switch\s+to|change\s+(?:the\s+)?log\s+channel\s+to)\s+(this(?:\s+channel)?|here|<#\d+>|#?[\w-]+)(?:\s+(?:as|for)\s+(?:the\s+)?(?:mod[- ]?log|moderation\s+log|moderation\s+reports)(?:\s+channel)?)?(?:[,\s]+(?:and|then)\s+(?:test|verify)\s+it(?:\s+and\s+tell\s+me\s+whether\s+everything\s+works)?)?/i);
    if (configMatch) {
      const channelRef = /this|here/i.test(configMatch[1]) ? 'current' : configMatch[1];
      const testRequested = /(?:test|verify|whether\s+everything\s+works|for\s+moderation\s+reports)/i.test(cleanPrompt);
      return {
        intent: 'configure_channel',
        targetChannel: channelRef,
        testAfterConfig: testRequested,
        clarificationQuestion: null
      };
    }

    // Fallback: Compact LLM Interpretation
    try {
      logger.info('Interpreting modlog prompt via LLM', { prompt: trimmed });
      const raw = await this.aiProvider.planWithCustomPrompt(MODLOG_PROMPT, `USER PROMPT:\n"${trimmed}"`);
      return {
        intent: raw.intent || 'inspect_config',
        targetChannel: raw.targetChannel || null,
        testAfterConfig: Boolean(raw.testAfterConfig),
        repair: Boolean(raw.repair),
        clarificationQuestion: raw.clarificationQuestion || null,
        explanation: raw.explanation || null
      };
    } catch (err) {
      logger.warn('LLM interpretation failed, falling back to inspection', { error: err.message });
      return {
        intent: 'inspect_config',
        targetChannel: null,
        testAfterConfig: false,
        clarificationQuestion: null
      };
    }
  }
}
