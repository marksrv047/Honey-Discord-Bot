/**
 * Module 1: Core Language Understanding
 * 
 * Provides linguistic dictionaries, synonym tables, colloquialisms, typos,
 * contractions, speech-to-text corrections, and intent modifiers for everyday English.
 */

export const SLANG_AND_COLLOQUIALISMS = {
  // Moderation slang
  'boot': { canonical: 'kick', intent: 'kick_member', risk: 'HIGH' },
  'yeet': { canonical: 'kick', intent: 'kick_member', risk: 'HIGH' },
  'toss': { canonical: 'kick', intent: 'kick_member', risk: 'HIGH' },
  'shush': { canonical: 'timeout', intent: 'timeout_member', risk: 'MEDIUM' },
  'silence': { canonical: 'timeout', intent: 'timeout_member', risk: 'MEDIUM' },
  'gag': { canonical: 'timeout', intent: 'timeout_member', risk: 'MEDIUM' },
  'mute': { canonical: 'timeout', intent: 'timeout_member', risk: 'MEDIUM' },
  'expel': { canonical: 'ban', intent: 'ban_member', risk: 'HIGH' },
  'hammer': { canonical: 'ban', intent: 'ban_member', risk: 'HIGH' },
  'banhammer': { canonical: 'ban', intent: 'ban_member', risk: 'HIGH' },
  'get rid of': { canonical: 'kick_or_ban_or_timeout', intent: 'ambiguous_moderation', requiresClarification: true },
  
  // Channels and categories slang
  'make room': { canonical: 'create_channel', intent: 'create_channel', risk: 'LOW' },
  'nuke chat': { canonical: 'purge_messages', intent: 'purge_messages', risk: 'HIGH', note: 'Not a server nuke, channel clean' },
  'wipe chat': { canonical: 'purge_messages', intent: 'purge_messages', risk: 'HIGH' },
  'clear out': { canonical: 'purge_messages', intent: 'purge_messages', risk: 'HIGH' },
  'lockdown': { canonical: 'lock_channel', intent: 'lock_channel', risk: 'LOW' },
  'shut down channel': { canonical: 'lock_channel', intent: 'lock_channel', risk: 'LOW' },
  
  // Roles slang
  'badge': { canonical: 'role', intent: 'assign_role' },
  'tag': { canonical: 'role', intent: 'assign_role' },
  'promote to': { canonical: 'assign_role', intent: 'assign_role' },
  'demote from': { canonical: 'remove_role', intent: 'remove_role' },
  'strip of': { canonical: 'remove_role', intent: 'remove_role' },

  // Music slang
  'spin': { canonical: 'music_play', intent: 'music_play' },
  'blast': { canonical: 'music_play', intent: 'music_play' },
  'crank': { canonical: 'music_volume', intent: 'music_volume' },
  'bump': { canonical: 'music_play', intent: 'music_play' },
  'drop a beat': { canonical: 'music_play', intent: 'music_play' }
};

export const COMMON_TYPOS_AND_MISSPELLINGS = {
  'chnnel': 'channel',
  'channle': 'channel',
  'chanel': 'channel',
  'channal': 'channel',
  'tmeout': 'timeout',
  'timout': 'timeout',
  'time out': 'timeout',
  'time-out': 'timeout',
  'asigned': 'assigned',
  'asigne': 'assign',
  'asign': 'assign',
  'roel': 'role',
  'roleee': 'role',
  'prmissions': 'permissions',
  'permissons': 'permissions',
  'musick': 'music',
  'plya': 'play',
  'plaay': 'play',
  'messsage': 'message',
  'mesage': 'message',
  'anouncment': 'announcement',
  'anouncement': 'announcement',
  'catagory': 'category',
  'catgory': 'category',
  'diaagnose': 'diagnose',
  'diag': 'diagnose',
  'modlogg': 'modlog',
  'undoo': 'undo'
};

export const COMMON_CONTRACTIONS_AND_ABBREVIATIONS = {
  'pls': 'please',
  'plz': 'please',
  'wanna': 'want to',
  'gimme': 'give me',
  'dont': "don't",
  'cant': "can't",
  'wont': "won't",
  'msg': 'message',
  'msgs': 'messages',
  'mod': 'moderator',
  'mods': 'moderators',
  'admin': 'administrator',
  'admins': 'administrators',
  'temp': 'temporary',
  'perm': 'permanent',
  'ch': 'channel',
  'sec': 'seconds',
  'min': 'minutes',
  'mins': 'minutes',
  'hr': 'hours',
  'hrs': 'hours'
};

export const SPEECH_TO_TEXT_CORRECTIONS = [
  { pattern: /\bband\s+(@?\w+)/i, correction: 'ban $1', reason: 'Common microphone transcription error for ban' },
  { pattern: /\bmod\s+log\b/i, correction: 'modlog', reason: 'Speech-to-text separates compound words' },
  { pattern: /\bvoice\s+chat\b/i, correction: 'voice channel', reason: 'Spoken term maps to Discord voice channel' },
  { pattern: /\bgeneral\s+chat\b/i, correction: '#general', reason: 'Spoken term maps to text channel' },
  { pattern: /\btime\s+out\b/i, correction: 'timeout', reason: 'Spoken term maps to timeout action' },
  { pattern: /\bbee\s+ip\b/i, correction: 'VIP', reason: 'Acoustic confusion for VIP' }
];

export const INTENT_MODIFIERS = {
  quantifiers: {
    'all': { effect: 'apply_to_all_matches', scope: 'BROAD' },
    'every': { effect: 'apply_to_all_matches', scope: 'BROAD' },
    'only': { effect: 'restrict_to_filter', scope: 'NARROW' },
    'except': { effect: 'exclude_following_targets', scope: 'EXCEPTION' },
    'except for': { effect: 'exclude_following_targets', scope: 'EXCEPTION' }
  },
  temporals: {
    'latest': { effect: 'order_descending_limit_1' },
    'last': { effect: 'order_descending_limit_1' },
    'previous': { effect: 'relative_offset_minus_1' },
    'oldest': { effect: 'order_ascending_limit_1' },
    'temporary': { effect: 'requires_duration', defaultMinutes: 60 },
    'permanent': { effect: 'unbounded_duration' },
    'for an hour': { effect: 'set_duration', minutes: 60 },
    'until tomorrow': { effect: 'set_duration', minutes: 1440 }
  },
  relational: {
    'again': { effect: 'repeat_last_action' },
    'instead': { effect: 'replace_previous_parameter' },
    'also': { effect: 'append_additional_action' },
    'rather than': { effect: 'replace_target' }
  },
  negation: {
    "don't": { effect: 'cancel_or_forbid_action' },
    'do not': { effect: 'cancel_or_forbid_action' },
    'never': { effect: 'cancel_or_forbid_action' },
    'cancel': { effect: 'abort_requested_task' },
    'stop': { effect: 'interrupt_current_operation' }
  },
  reversal: {
    'undo': { effect: 'trigger_action_reversal' },
    'restore': { effect: 'trigger_state_restoration' },
    'revert': { effect: 'trigger_action_reversal' }
  },
  visibility: {
    'quietly': { effect: 'suppress_announcements_or_notifications' },
    'privately': { effect: 'restrict_visibility_to_staff' },
    'without notifying': { effect: 'suppress_user_dms' }
  },
  sequencing: {
    'then': { effect: 'sequential_chain' },
    'after that': { effect: 'sequential_chain' },
    'before': { effect: 'inverted_sequential_chain' },
    'once that is done': { effect: 'sequential_chain' }
  }
};

/**
 * Normalizes input text by fixing common typos, expanding contractions,
 * and applying speech-to-text corrections.
 */
export function normalizeEverydayEnglish(text) {
  if (!text || typeof text !== 'string') return '';
  let result = text.trim();

  // Apply speech-to-text corrections
  for (const { pattern, correction } of SPEECH_TO_TEXT_CORRECTIONS) {
    result = result.replace(pattern, correction);
  }

  // Token-level normalization
  const words = result.split(/\s+/);
  const normalizedWords = words.map(w => {
    const cleanWord = w.toLowerCase().replace(/^[^\w#@]+|[^\w#@]+$/g, '');
    if (COMMON_CONTRACTIONS_AND_ABBREVIATIONS[cleanWord]) {
      return COMMON_CONTRACTIONS_AND_ABBREVIATIONS[cleanWord];
    }
    if (COMMON_TYPOS_AND_MISSPELLINGS[cleanWord]) {
      return COMMON_TYPOS_AND_MISSPELLINGS[cleanWord];
    }
    return w;
  });

  return normalizedWords.join(' ');
}
