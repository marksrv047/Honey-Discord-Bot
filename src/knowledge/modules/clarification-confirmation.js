/**
 * Module 13: Clarification and Confirmation
 * 
 * Rules for when the bot must execute immediately vs when it must pause to ask
 * a single concise clarification question or request high-impact confirmation.
 */

export const CLARIFICATION_RULES = {
  ambiguityConditions: [
    {
      condition: 'MULTIPLE_MEMBER_MATCHES',
      description: 'Multiple guild members share identical or similar display names.',
      action: 'ASK_CLARIFICATION',
      questionTemplate: 'I found multiple members matching "{name}". Did you mean {candidate1} ({id1}) or {candidate2} ({id2})?'
    },
    {
      condition: 'SEVERITY_AMBIGUITY',
      description: 'Phrasing like "get Alex out of here" or "remove Alex" could mean either a temporary kick or a permanent ban.',
      action: 'ASK_CLARIFICATION',
      questionTemplate: 'Would you like to kick, permanently ban, or temporarily timeout {target}?'
    },
    {
      condition: 'MISSING_ESSENTIAL_PARAMETER',
      description: 'An action requires a specific parameter that has no safe default (e.g. role name for create_role, or timeout duration when unspecified).',
      action: 'ASK_CLARIFICATION',
      questionTemplate: 'What {paramName} would you like to set for {action}?'
    },
    {
      condition: 'MULTIPLE_TRACK_MATCHES',
      description: 'A music search query returns multiple divergent top results with distinct artists.',
      action: 'PLAY_HIGHEST_CONFIDENCE_OR_ASK'
    }
  ],

  highImpactActions: [
    'delete_channel',
    'delete_category',
    'delete_role',
    'ban_member',
    'purge_messages' // when count > 20
  ],

  formatSingleQuestion(question) {
    if (!question) return null;
    return question.trim().replace(/\s*\?*$/, '?');
  }
};
