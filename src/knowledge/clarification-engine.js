import { CLARIFICATION_RULES } from './modules/clarification-confirmation.js';
import { classifyModerationIntent } from './modules/moderation-safety.js';

/**
 * Clarification Engine
 * 
 * Determines when the bot should proceed with execution vs when it should pause
 * to ask a single, concise question. Prevents destructive guessing.
 */
export class ClarificationEngine {
  /**
   * Evaluates whether a prompt and intent requires clarification.
   * @param {string} prompt Raw user instruction
   * @param {object} parsedIntent Preliminary intent data
   * @param {object} guildContext Guild context (members, channels, roles)
   * @returns {{ needsClarification: boolean, question: string | null, reason: string | null }}
   */
  static evaluate(prompt, parsedIntent = {}, guildContext = {}) {
    if (!prompt || typeof prompt !== 'string') {
      return { needsClarification: false, question: null, reason: null };
    }

    const clean = prompt.trim();

    // 1. Check Moderation Ambiguity ("get rid of Alex", "remove Alex from the server")
    const modIntent = classifyModerationIntent(clean);
    if (modIntent && modIntent.requiresClarification) {
      return {
        needsClarification: true,
        question: modIntent.clarificationQuestion,
        reason: 'AMBIGUOUS_MODERATION_ACTION'
      };
    }

    // 2. Missing Essential Parameter for Mutative Operations
    if (parsedIntent.intent === 'create_role' && (!parsedIntent.args?.name || parsedIntent.args.name.trim() === '')) {
      return {
        needsClarification: true,
        question: 'What name would you like to give to the new role?',
        reason: 'MISSING_ROLE_NAME'
      };
    }

    if (parsedIntent.intent === 'create_channel' && (!parsedIntent.args?.name || parsedIntent.args.name.trim() === '')) {
      return {
        needsClarification: true,
        question: 'What name would you like for the new channel?',
        reason: 'MISSING_CHANNEL_NAME'
      };
    }

    if (parsedIntent.intent === 'delete_role' && (!parsedIntent.targetRef && !parsedIntent.args?.targetRole)) {
      return {
        needsClarification: true,
        question: 'Which role would you like to delete?',
        reason: 'MISSING_TARGET_ROLE'
      };
    }

    // 3. Ambiguous Multiple Member Matches in Guild
    if (guildContext.memberMatches && guildContext.memberMatches.length > 1) {
      const candidates = guildContext.memberMatches.slice(0, 2);
      return {
        needsClarification: true,
        question: `I found multiple members matching that name. Did you mean ${candidates[0].tag} (${candidates[0].id}) or ${candidates[1].tag} (${candidates[1].id})?`,
        reason: 'MULTIPLE_MEMBER_MATCHES'
      };
    }

    // Default: Clear enough to proceed or safe defaults apply
    return {
      needsClarification: false,
      question: null,
      reason: null
    };
  }

  /**
   * Formats a single concise question string.
   */
  static formatQuestion(question) {
    return CLARIFICATION_RULES.formatSingleQuestion(question);
  }
}
