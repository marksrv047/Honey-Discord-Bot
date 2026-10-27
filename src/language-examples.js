/**
 * Language Example Dataset v2.0.0 for Honey Bot Natural Language Understanding.
 * 
 * Versioned, maintainable repository of natural-language examples mapped to canonical intents.
 * Provides:
 * 1. Equivalent paraphrases across varying sentence styles.
 * 2. Informal English, contractions, and colloquialisms.
 * 3. Typo and dialect variants (e.g. British vs American English).
 * 4. Ambiguous queries requiring clarification.
 * 5. Negative examples that must NOT execute a mutation.
 * 6. Multi-action chained plans with dependencies.
 * 7. Regression cases derived from previously reported failures.
 */

export const DATASET_VERSION = '2.0.0';

export const LANGUAGE_EXAMPLE_DATASET = [
  // =========================================================================
  // 1. ROLE RECOLORING & EDITING (Paraphrases)
  // =========================================================================
  {
    id: 'ROLE-RECOLOR-01',
    intent: 'edit_role',
    canonicalAction: 'edit_role',
    phrasings: [
      'Make the role blue.',
      'Change its colour to blue.',
      'Recolour @Artist in blue.',
      'Set @Artist\'s role color to blue.',
      'Make @Artist blue.',
      'Change the Artist role to blue.',
      'Update @Artist color as #0000FF.'
    ],
    expectedTarget: '@Artist or recent context role',
    expectedArgs: { color: '#0000FF' },
    category: 'Roles & Permissions',
    notes: 'Handles British spelling "colour", preposition "in blue", and contextual "the role" / "its colour".'
  },
  {
    id: 'ROLE-RENAME-AND-COLOR-02',
    intent: 'edit_role',
    canonicalAction: 'edit_role',
    phrasings: [
      'Rename Moderator to Staff and make it dark red.',
      'Change the name of Moderator to Staff and recolor it dark red.',
      'Update role @Moderator: rename to Staff, set color to #8B0000.'
    ],
    expectedTarget: 'Moderator',
    expectedArgs: { name: 'Staff', color: '#8B0000' },
    multiAction: true,
    category: 'Roles & Permissions',
    notes: 'Requires preserving both rename and recolor operations.'
  },

  // =========================================================================
  // 2. MEMBER NICKNAME (Accurate targets & no accidental wipe)
  // =========================================================================
  {
    id: 'NICKNAME-CHANGE-01',
    intent: 'change_nickname',
    canonicalAction: 'change_nickname',
    phrasings: [
      'Change Alex\'s nick to Night Owl.',
      'Rename Alex to Night Owl on the server.',
      'I want Alex to show up as Night Owl.',
      'Make Alex\'s server nickname Night Owl.',
      'Set @Alex\'s nickname to "Night Owl".'
    ],
    expectedTarget: 'Alex',
    expectedArgs: { nickname: 'Night Owl' },
    category: 'Moderation & Member Safety',
    notes: 'Must extract new nickname and target without clearing the nickname.'
  },
  {
    id: 'NICKNAME-REMOVE-02',
    intent: 'remove_nickname',
    canonicalAction: 'remove_nickname',
    phrasings: [
      'Reset Alex\'s nickname.',
      'Remove Alex\'s server nickname.',
      'Clear nickname for @Alex.'
    ],
    expectedTarget: 'Alex',
    expectedArgs: {},
    category: 'Moderation & Member Safety',
    notes: 'Must distinguish removal from setting a blank nickname.'
  },

  // =========================================================================
  // 3. CHANNEL SLOWMODE & LOCKDOWN
  // =========================================================================
  {
    id: 'SLOWMODE-01',
    intent: 'set_channel_slowmode',
    canonicalAction: 'set_channel_slowmode',
    phrasings: [
      'Make general slower.',
      'Set slow mode to 10 seconds in #general.',
      'Slow down this channel to 10s.',
      'Put 10 seconds slowmode on #general.'
    ],
    expectedTarget: 'general',
    expectedArgs: { seconds: 10 },
    category: 'Channel Management'
  },
  {
    id: 'CHANNEL-LOCK-02',
    intent: 'lock_channel',
    canonicalAction: 'lock_channel',
    phrasings: [
      'Close this channel.',
      'Lock down #announcements.',
      'Lock this channel so members cannot send messages.',
      'Shut down the general chat for now.'
    ],
    expectedTarget: 'current or specified channel',
    expectedArgs: {},
    category: 'Channel Management'
  },

  // =========================================================================
  // 4. MODERATION (Timeouts, Kicks, Bans with reasons)
  // =========================================================================
  {
    id: 'TIMEOUT-01',
    intent: 'timeout_member',
    canonicalAction: 'timeout_member',
    phrasings: [
      'Timeout Alex for 10 minutes for spamming.',
      'Silence @Alex for 10m because of spam.',
      'Shush Alex for 10 mins: spamming links.',
      'Put Alex in timeout for ten minutes for spam.'
    ],
    expectedTarget: 'Alex',
    expectedArgs: { durationMinutes: 10, reason: 'spamming' },
    category: 'Moderation & Member Safety'
  },
  {
    id: 'KICK-02',
    intent: 'kick_member',
    canonicalAction: 'kick_member',
    phrasings: [
      'Kick Alex for repeated trolling.',
      'Boot @Alex from the server, reason: trolling.',
      'Yeet Alex out of the server for trolling.'
    ],
    expectedTarget: 'Alex',
    expectedArgs: { reason: 'repeated trolling' },
    category: 'Moderation & Member Safety'
  },

  // =========================================================================
  // 5. AMBIGUOUS EXAMPLES (Requiring Clarification)
  // =========================================================================
  {
    id: 'AMBIGUITY-01',
    intent: 'clarification',
    canonicalAction: 'clarification',
    phrasings: [
      'Get rid of Alex.',
      'Handle the problem user.',
      'Do something about the channel.',
      'Fix the permissions.'
    ],
    isAmbiguous: true,
    expectedClarification: 'Prompt lacks specific action or target.',
    category: 'Diagnostics & Recovery'
  },

  // =========================================================================
  // 6. NEGATIVE EXAMPLES (Must NOT execute mutations)
  // =========================================================================
  {
    id: 'NEGATIVE-01',
    intent: 'negated',
    canonicalAction: 'none',
    phrasings: [
      'Don\'t ban Alex, just warn him.',
      'Never delete the rules channel.',
      'Do not kick anyone.',
      'Delete nothing in #general.'
    ],
    isNegative: true,
    category: 'Diagnostics & Recovery',
    notes: 'Must not execute the negated action.'
  },
  {
    id: 'QUOTED-CONTENT-02',
    intent: 'send_announcement',
    canonicalAction: 'send_announcement',
    phrasings: [
      'Send an announcement saying "We will ban anyone who spams".',
      'Post in #announcements: "Do not delete roles without permission".'
    ],
    isPayloadQuoted: true,
    expectedAction: 'send_announcement',
    category: 'Messages & Embeds',
    notes: 'Text inside quotes ("ban anyone...") must be treated as message content, NOT an instruction to ban.'
  },

  // =========================================================================
  // 7. MULTI-ACTION CHAINED PLANS (Dependencies)
  // =========================================================================
  {
    id: 'MULTI-ACTION-01',
    intent: 'multi_action',
    canonicalAction: 'multi_action',
    phrasings: [
      'Create a role called VIP, make it gold, and assign it to Alex.',
      'Create category Community and add channels general, memes, voice under it.',
      'Lock #announcements and post an announcement about maintenance.'
    ],
    multiAction: true,
    category: 'Server Configuration',
    notes: 'Must construct ordered DAG plan where prerequisite steps precede dependent actions.'
  }
];

export class LanguageExampleDataset {
  static get VERSION() {
    return DATASET_VERSION;
  }

  static get version() {
    return DATASET_VERSION;
  }

  static getAllExamples() {
    return LANGUAGE_EXAMPLE_DATASET;
  }

  static getAll() {
    return LANGUAGE_EXAMPLE_DATASET;
  }

  /**
   * Retrieves relevant few-shot examples matching keywords in the prompt.
   * Keeps token consumption bounded (< 250 tokens).
   */
  static findRelevantExamples(prompt, limit = 2) {
    if (!prompt || typeof prompt !== 'string') return [];
    const clean = prompt.toLowerCase();
    const words = clean.split(/[\s,.;:!?]+/).filter(w => w.length > 2);

    const scored = LANGUAGE_EXAMPLE_DATASET.map(ex => {
      let score = 0;
      for (const phrase of ex.phrasings) {
        const pLower = phrase.toLowerCase();
        for (const w of words) {
          if (pLower.includes(w)) score += 10;
        }
      }
      return { example: ex, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.filter(s => s.score > 0).slice(0, limit).map(s => s.example);
  }
}
