/**
 * Negation and Correction Detector
 * 
 * Accurately identifies negated actions, cancellations, and corrections
 * to prevent the bot from executing operations simply because a keyword
 * appears in a negative clause (e.g. "Don't ban Alex, just timeout them").
 */
export class NegationDetector {
  /**
   * Analyzes an instruction for explicit negative constraints.
   * @param {string} prompt Raw user instruction
   * @returns {{ hasNegation: boolean, negatedClauses: string[], affirmativeClauses: string[], negatedKeywords: string[] }}
   */
  static analyze(prompt) {
    if (!prompt || typeof prompt !== 'string') {
      return { hasNegation: false, negatedClauses: [], affirmativeClauses: [], negatedKeywords: [] };
    }

    const clean = prompt.trim();
    // Split on contrastive conjunctions or semicolons: but, however, rather than, instead of, semicolon
    const segments = clean.split(/(?:;|\b(?:but\s+not|but\s+don't|but\s+do\s+not|instead\s+of|rather\s+than|without)\b)/i);

    const negatedClauses = [];
    const affirmativeClauses = [];
    const negatedKeywords = [];

    // Common negation regex patterns
    const negationPatterns = [
      /\b(?:don'?t|do\s+not|never|stop|cancel|avoid|refrain\s+from)\s+([a-zA-Z\s]+?)(?:[.,;]|$|\binstead\b|\bjust\b)/gi,
      /\b(?:delete\s+nothing|do\s+not\s+delete|don'?t\s+delete)\b/gi,
      /\b(?:don'?t\s+ban|do\s+not\s+ban)\b/gi,
      /\b(?:don'?t\s+kick|do\s+not\s+kick)\b/gi,
      /\b(?:don'?t\s+assign|do\s+not\s+assign)\b/gi
    ];

    for (const pattern of negationPatterns) {
      let match;
      while ((match = pattern.exec(clean)) !== null) {
        negatedClauses.push(match[0].trim());
        const targetWord = match[1] ? match[1].trim() : match[0].trim();
        negatedKeywords.push(targetWord.toLowerCase());
      }
    }

    // Check specific action negations
    const isBanNegated = /\b(?:don'?t|do\s+not|never)\s+(?:perm|permanently\s+)?ban\b/i.test(clean);
    const isKickNegated = /\b(?:don'?t|do\s+not|never)\s+kick\b/i.test(clean);
    const isDeleteNegated = /\b(?:don'?t|do\s+not|never)\s+delete\b/i.test(clean) || /\bdelete\s+nothing\b/i.test(clean);
    const isAssignNegated = /\b(?:don'?t|do\s+not|never)\s+assign\b/i.test(clean);

    return {
      hasNegation: negatedClauses.length > 0 || isBanNegated || isKickNegated || isDeleteNegated || isAssignNegated,
      negatedClauses,
      negatedKeywords,
      actionOverrides: {
        ban_member: isBanNegated ? 'FORBIDDEN' : 'ALLOWED',
        kick_member: isKickNegated ? 'FORBIDDEN' : 'ALLOWED',
        purge_messages: isDeleteNegated ? 'FORBIDDEN' : 'ALLOWED',
        delete_channel: isDeleteNegated ? 'FORBIDDEN' : 'ALLOWED',
        delete_role: isDeleteNegated ? 'FORBIDDEN' : 'ALLOWED',
        assign_role: isAssignNegated ? 'FORBIDDEN' : 'ALLOWED'
      }
    };
  }

  /**
   * Verifies if a prospective action is forbidden by explicit negation in the prompt.
   * @param {string} action Prospective action from intent router (e.g. 'ban_member')
   * @param {string} prompt Raw instruction
   */
  static isActionNegated(action, prompt) {
    const analysis = this.analyze(prompt);
    if (!analysis.hasNegation) return false;
    return analysis.actionOverrides[action] === 'FORBIDDEN';
  }
}
