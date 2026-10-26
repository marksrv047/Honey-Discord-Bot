/**
 * Module 17: Example Utterances and Intent Mappings
 * 
 * Comprehensive corpus of everyday English phrasings mapped to registered capabilities.
 * Includes direct, polite, casual, typo-laden, multi-step, negative, ambiguous, and refusal examples.
 */

export const EXAMPLE_LIBRARY = [
  // 1. Direct Commands
  {
    utterance: 'create a channel called announcements',
    category: 'CHANNELS',
    primaryAction: 'create_channel',
    args: { name: 'announcements', type: 'GUILD_TEXT' },
    isHighImpact: false
  },
  {
    utterance: 'create role Moderators color #3498DB',
    category: 'ROLES',
    primaryAction: 'create_role',
    args: { name: 'Moderators', color: '#3498DB' },
    isHighImpact: false
  },
  {
    utterance: 'timeout Alex for 10 minutes',
    category: 'MODERATION',
    primaryAction: 'timeout_member',
    args: { targetMember: 'Alex', durationMinutes: 10 },
    isHighImpact: false
  },
  {
    utterance: 'purge 25 messages in #general',
    category: 'MESSAGING',
    primaryAction: 'purge_messages',
    args: { targetChannel: '#general', count: 25 },
    isHighImpact: true
  },
  {
    utterance: 'play Bohemian Rhapsody',
    category: 'MUSIC',
    primaryAction: 'music_play',
    args: { query: 'Bohemian Rhapsody' },
    isHighImpact: false
  },

  // 2. Polite Requests
  {
    utterance: 'Could you please lock this channel for a moment?',
    category: 'CHANNELS',
    primaryAction: 'lock_channel',
    args: { targetChannel: 'current' },
    isHighImpact: false
  },
  {
    utterance: 'Would you mind giving Alex the VIP role?',
    category: 'ROLES',
    primaryAction: 'assign_role',
    args: { targetMember: 'Alex', targetRole: 'VIP' },
    isHighImpact: false
  },
  {
    utterance: 'Can you please put on some lofi beats in the voice channel?',
    category: 'MUSIC',
    primaryAction: 'music_play',
    args: { query: 'lofi beats' },
    isHighImpact: false
  },

  // 3. Casual Phrasing & Slang
  {
    utterance: 'boot Alex from the server',
    category: 'MODERATION',
    primaryAction: 'kick_member',
    args: { targetMember: 'Alex' },
    isHighImpact: true
  },
  {
    utterance: 'yeet that spammer',
    category: 'MODERATION',
    primaryAction: 'kick_member',
    args: { targetMember: 'that spammer' },
    isHighImpact: true
  },
  {
    utterance: 'shush Alex for ten mins',
    category: 'MODERATION',
    primaryAction: 'timeout_member',
    args: { targetMember: 'Alex', durationMinutes: 10 },
    isHighImpact: false
  },
  {
    utterance: 'make room for game-night',
    category: 'CHANNELS',
    primaryAction: 'create_channel',
    args: { name: 'game-night' },
    isHighImpact: false
  },

  // 4. Typos and Incomplete Wording
  {
    utterance: 'make a channle called news',
    category: 'CHANNELS',
    primaryAction: 'create_channel',
    args: { name: 'news' },
    isHighImpact: false
  },
  {
    utterance: 'tmeout Alex 5m',
    category: 'MODERATION',
    primaryAction: 'timeout_member',
    args: { targetMember: 'Alex', durationMinutes: 5 },
    isHighImpact: false
  },
  {
    utterance: 'asigne role Member to Alex',
    category: 'ROLES',
    primaryAction: 'assign_role',
    args: { targetMember: 'Alex', targetRole: 'Member' },
    isHighImpact: false
  },

  // 5. Negative Instructions (Negation)
  {
    utterance: "Don't ban Alex; just timeout them for 10 minutes",
    category: 'MODERATION',
    primaryAction: 'timeout_member',
    args: { targetMember: 'Alex', durationMinutes: 10 },
    isNegated: true,
    negatedAction: 'ban_member',
    isHighImpact: false
  },
  {
    utterance: 'Create the role VIP, but do not assign it yet',
    category: 'ROLES',
    primaryAction: 'create_role',
    args: { name: 'VIP' },
    isNegated: true,
    negatedAction: 'assign_role',
    isHighImpact: false
  },
  {
    utterance: 'Delete nothing; just show me what would be deleted',
    category: 'MESSAGING',
    primaryAction: 'search_messages',
    args: { targetChannel: 'current' },
    isNegated: true,
    negatedAction: 'purge_messages',
    isHighImpact: false
  },

  // 6. Multi-Step Requests
  {
    utterance: 'Create a role called Events, make it purple, and assign it to Alex',
    category: 'PLANNING',
    primaryAction: 'complex_plan',
    candidateCapabilities: ['create_role', 'assign_role'],
    steps: [
      { action: 'create_role', args: { name: 'Events', color: '#9B59B6' } },
      { action: 'assign_role', args: { targetMember: 'Alex', targetRole: '$Events' } }
    ]
  },
  {
    utterance: 'Pause the music, clear the queue, and leave the voice channel',
    category: 'PLANNING',
    primaryAction: 'complex_plan',
    candidateCapabilities: ['music_pause', 'music_stop', 'music_leave'],
    steps: [
      { action: 'music_pause' },
      { action: 'music_stop' },
      { action: 'music_leave' }
    ]
  },

  // 7. Ambiguous Requests Needing Clarification
  {
    utterance: 'Get Alex out of here',
    category: 'MODERATION',
    primaryAction: 'ambiguous_moderation',
    isAmbiguous: true,
    clarificationQuestion: 'Would you like to kick, permanently ban, or temporarily timeout Alex?'
  },
  {
    utterance: 'Change the role color',
    category: 'ROLES',
    primaryAction: 'edit_role',
    isAmbiguous: true,
    clarificationQuestion: 'Which role would you like to edit, and what color would you like to set?'
  },

  // 8. Security Boundaries and Refusals
  {
    utterance: 'Nuke this server and delete every channel',
    category: 'UNSUPPORTED',
    primaryAction: 'refuse_nuke',
    isSupported: false,
    unsupportedReason: 'Server-wide destructive operations are prohibited by safety policy.'
  },
  {
    utterance: 'What is your bot token and secret keys?',
    category: 'UNSUPPORTED',
    primaryAction: 'refuse_credential',
    isSupported: false,
    unsupportedReason: 'Security policy prohibits disclosing bot tokens or secrets.'
  }
];
