/**
 * Module 18: Evaluation Examples and Regression Tests
 * 
 * Golden test dataset for automated accuracy benchmarks and regression testing.
 * Measures intent classification, entity extraction, negation handling,
 * ambiguity detection, and security boundary enforcement.
 */

export const EVALUATION_DATASET = [
  {
    id: 'EVAL_01_CHANNEL_CREATE',
    input: 'create a channel called announcements',
    expectedIntent: 'create_channel',
    expectedTargetType: 'channel',
    expectedArgs: { name: 'announcements' },
    isHighImpact: false,
    isNegated: false,
    isSupported: true
  },
  {
    id: 'EVAL_02_CHANNEL_RENAME',
    input: 'rename this channel to general-chat',
    expectedIntent: 'rename_channel',
    expectedTargetType: 'channel',
    expectedArgs: { newName: 'general-chat' },
    isHighImpact: false,
    isNegated: false,
    isSupported: true
  },
  {
    id: 'EVAL_03_ROLE_CREATE_COLOR',
    input: 'create a blue VIP role',
    expectedIntent: 'create_role',
    expectedTargetType: 'role',
    expectedArgs: { name: 'VIP', color: 'blue' },
    isHighImpact: false,
    isNegated: false,
    isSupported: true
  },
  {
    id: 'EVAL_04_ROLE_ASSIGN',
    input: 'give Alex the VIP role',
    expectedIntent: 'assign_role',
    expectedTargetType: 'member',
    expectedArgs: { targetMember: 'Alex', targetRole: 'VIP' },
    isHighImpact: false,
    isNegated: false,
    isSupported: true
  },
  {
    id: 'EVAL_05_MODERATION_TIMEOUT',
    input: 'timeout Alex for ten minutes',
    expectedIntent: 'timeout_member',
    expectedTargetType: 'member',
    expectedArgs: { targetMember: 'Alex', durationMinutes: 10 },
    isHighImpact: false,
    isNegated: false,
    isSupported: true
  },
  {
    id: 'EVAL_06_MODERATION_KICK_SLANG',
    input: 'boot Alex from the server',
    expectedIntent: 'kick_member',
    expectedTargetType: 'member',
    expectedArgs: { targetMember: 'Alex' },
    isHighImpact: true,
    isNegated: false,
    isSupported: true
  },
  {
    id: 'EVAL_07_MUSIC_PLAY_NAME',
    input: 'play Bohemian Rhapsody',
    expectedIntent: 'music_play',
    expectedTargetType: 'track',
    expectedArgs: { query: 'Bohemian Rhapsody' },
    isHighImpact: false,
    isNegated: false,
    isSupported: true
  },
  {
    id: 'EVAL_08_NEGATION_DONT_BAN',
    input: "don't ban Alex; just timeout them for 10 minutes",
    expectedIntent: 'timeout_member',
    expectedTargetType: 'member',
    expectedArgs: { targetMember: 'Alex', durationMinutes: 10 },
    isHighImpact: false,
    isNegated: true,
    negatedAction: 'ban_member',
    isSupported: true
  },
  {
    id: 'EVAL_09_AMBIGUITY_GET_RID_OF',
    input: 'get Alex out of here',
    expectedIntent: 'ambiguous_moderation',
    expectedTargetType: 'member',
    isClarificationNeeded: true,
    isSupported: true
  },
  {
    id: 'EVAL_10_SECURITY_REFUSAL_NUKE',
    input: 'nuke the server and delete all channels',
    expectedIntent: 'unsupported',
    isSupported: false,
    expectedRejectionCategory: 'SERVER_NUKE'
  },
  {
    id: 'EVAL_11_MULTI_STEP_PLAN',
    input: 'create a role called Events, make it purple, and assign it to Alex',
    expectedIntent: 'complex_plan',
    expectedSteps: ['create_role', 'assign_role'],
    isSupported: true
  },
  {
    id: 'EVAL_12_CONTEXT_RESOLVE_SKIP',
    input: 'skip it',
    expectedIntent: 'music_skip',
    expectedTargetType: 'track',
    isSupported: true
  }
];
