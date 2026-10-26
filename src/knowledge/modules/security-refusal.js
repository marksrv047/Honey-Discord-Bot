/**
 * Module 16: Security Boundaries and Refusal Rules
 * 
 * Defines non-negotiable security invariants, anti-nuke rules, privilege escalation
 * prevention, credential protections, and dignified refusal responses.
 */

export const SECURITY_REFUSAL_RULES = {
  unconditionalRefusals: [
    {
      category: 'SERVER_NUKE',
      triggers: [
        /\bnuke\b/i,
        /\bdelete\s+(?:all|every)\s+channels?\b/i,
        /\bban\s+(?:all|everyone|everybody)\b/i,
        /\bkick\s+(?:all|everyone|everybody)\b/i,
        /\bwipe\s+(?:the\s+)?server\b/i,
        /\bdestroy\s+(?:the\s+)?server\b/i
      ],
      response: 'I cannot fulfill this request. Server-wide destructive operations (nukes, mass bans, or mass channel deletions) are strictly prohibited by security policy.'
    },
    {
      category: 'CREDENTIAL_EXTRACTION',
      triggers: [
        /\b(?:bot\s+token|discord\s+token|api\s+key|groq\s+key|process\.env|\.env\s+file)\b/i,
        /\bprint\s+(?:the\s+)?token\b/i,
        /\bshow\s+(?:me\s+)?your\s+secrets?\b/i
      ],
      response: 'I cannot disclose system secrets, tokens, or environment credentials under any circumstances.'
    },
    {
      category: 'PRIVILEGE_ESCALATION',
      triggers: [
        /\bgive\s+(?:me|everyone|@everyone)\s+(?:admin(?:istrator)?|ownership)\b/i,
        /\bgrant\s+admin(?:istrator)?\s+to\s+everyone\b/i
      ],
      response: 'I cannot grant Administrator permissions to @everyone or escalate administrative privileges unconditionally.'
    }
  ],

  hierarchyConstraints: {
    rule: 'The bot cannot modify, assign, remove, or delete roles placed higher than its highest role in the Discord role list.',
    cannotTargetGuildOwner: 'The bot cannot kick, ban, timeout, or change nickname of the server owner.'
  }
};
