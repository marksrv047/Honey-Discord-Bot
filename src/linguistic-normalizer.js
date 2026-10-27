/**
 * Linguistic Normalizer for Honey Bot Natural Language Understanding.
 * 
 * Pre-processes, normalizes, and sanitizes user instructions:
 * 1. Isolates quoted text so payload content is never treated as nested commands.
 * 2. Normalizes polite prefixes ("could you please", "would you mind", "can you", "i'd like to").
 * 3. Normalizes contractions ("don't" -> "do not", "can't" -> "cannot", "pls"/"plz" -> "please", "wanna" -> "want to").
 * 4. Normalizes common spelling errors and British/Commonwealth variants ("colour" -> "color", "recolour" -> "recolor", "slow mode" -> "slowmode", "chnnl" -> "channel").
 * 5. Maps common Discord slang and terminology ("vc" -> "voice channel", "perms" -> "permissions", "nick" -> "nickname").
 * 6. Strips extraneous punctuation while preserving Discord mentions (<@...>, <#...>, <@&...>).
 */

export const BRITISH_SPELLINGS = {
  'colour': 'color',
  'colours': 'colors',
  'coloured': 'colored',
  'colouring': 'coloring',
  'recolour': 'recolor',
  'recoloured': 'recolored',
  'recolouring': 'recoloring',
  'grey': 'gray',
  'favourite': 'favorite',
  'favourites': 'favorites',
  'behaviour': 'behavior',
  'customise': 'customize',
  'customised': 'customized',
  'customising': 'customizing',
  'organise': 'organize',
  'organised': 'organized',
  'prioritise': 'prioritize',
  'synchronise': 'synchronize'
};

export const COMMON_TYPOS = {
  'chnnel': 'channel',
  'channle': 'channel',
  'chanel': 'channel',
  'channal': 'channel',
  'chnnl': 'channel',
  'catagory': 'category',
  'catgory': 'category',
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
  'diaagnose': 'diagnose',
  'diag': 'diagnose',
  'modlogg': 'modlog',
  'undoo': 'undo',
  'slow mode': 'slowmode',
  'slow-mode': 'slowmode',
  'nick name': 'nickname',
  'nichname': 'nickname',
  'un ban': 'unban',
  'un-ban': 'unban',
  'modarator': 'moderator',
  'modderator': 'moderator'
};

export const CONTRACTIONS_AND_SLANG = {
  'pls': 'please',
  'plz': 'please',
  'wanna': 'want to',
  'gimme': 'give me',
  'dont': 'do not',
  "don't": 'do not',
  'cant': 'cannot',
  "can't": 'cannot',
  'wont': 'will not',
  "won't": 'will not',
  'msg': 'message',
  'msgs': 'messages',
  'mod': 'moderator',
  'mods': 'moderators',
  'admin': 'administrator',
  'admins': 'administrators',
  'temp': 'temporary',
  'perm': 'permanent',
  'perms': 'permissions',
  'ch': 'channel',
  'vc': 'voice channel',
  'nick': 'nickname'
};

export const POLITE_PREFIX_PATTERNS = [
  /^(?:hey\s+(?:honey(?:\s+bot)?|bot)[,:\s]+)?(?:could\s+you\s+(?:please\s+)?|would\s+you\s+(?:mind\s+|please\s+)?|can\s+you\s+(?:please\s+)?|please\s+(?:can\s+you\s+)?|i\s+would\s+like\s+you\s+to\s+|i'd\s+like\s+you\s+to\s+|i\s+want\s+you\s+to\s+|i\s+need\s+you\s+to\s+|go\s+ahead\s+and\s+|be\s+so\s+kind\s+as\s+to\s+|kindly\s+|please\s+go\s+ahead\s+and\s+|just\s+|do\s+me\s+a\s+favor\s+and\s+)/i,
  /^(?:honey[,:\s]+)/i
];

export class LinguisticNormalizer {
  /**
   * Pre-processes raw user prompt:
   * Extracts and preserves quoted text, normalizes spelling, contractions, and prefixes.
   * 
   * @param {string} prompt Raw instruction
   * @returns {{
   *   originalPrompt: string,
   *   normalizedPrompt: string,
   *   cleanPrompt: string,
   *   quotes: string[],
   *   hasNegation: boolean,
   *   restoredPrompt: string
   * }}
   */
  static normalize(prompt) {
    if (!prompt || typeof prompt !== 'string') {
      return {
        originalPrompt: '',
        normalizedPrompt: '',
        cleanPrompt: '',
        quotes: [],
        hasNegation: false,
        restoredPrompt: ''
      };
    }

    const originalPrompt = prompt.trim();
    const quotes = [];

    // 1. Extract and preserve quoted strings ("...", '...', “...”, ‘...’)
    let masked = originalPrompt.replace(/(["'“”‘’])(.*?)\1/g, (match, quoteChar, innerText) => {
      const idx = quotes.length;
      quotes.push(innerText);
      return `__QUOTE_${idx}__`;
    });

    // 2. Strip trailing sentence punctuation
    masked = masked.replace(/[.!?]+$/, '').trim();

    // 3. Remove polite conversational prefixes
    for (const prefixPattern of POLITE_PREFIX_PATTERNS) {
      masked = masked.replace(prefixPattern, '').trim();
    }

    // 4. Tokenize and replace British spellings, typos, and contractions
    // Preserve Discord mentions (<@123>, <#123>, <@&123>) and __QUOTE_X__ tokens
    const tokens = masked.split(/(\s+|[<@&#!:]+\d+>|__QUOTE_\d+__|[,;])/);

    const normalizedTokens = tokens.map(token => {
      if (!token || /^\s+$/.test(token) || token.startsWith('__QUOTE_') || token.startsWith('<')) {
        return token;
      }

      const lower = token.toLowerCase();

      // Check British spellings
      if (BRITISH_SPELLINGS[lower]) {
        return BRITISH_SPELLINGS[lower];
      }

      // Check common typos
      if (COMMON_TYPOS[lower]) {
        return COMMON_TYPOS[lower];
      }

      // Check contractions and slang
      if (CONTRACTIONS_AND_SLANG[lower]) {
        return CONTRACTIONS_AND_SLANG[lower];
      }

      return token;
    });

    let normalizedPrompt = normalizedTokens.join('').replace(/\s{2,}/g, ' ').trim();

    // 5. Restore quotes into restoredPrompt
    const restoredPrompt = normalizedPrompt.replace(/__QUOTE_(\d+)__/g, (m, idx) => {
      return `"${quotes[parseInt(idx, 10)] ?? ''}"`;
    });

    // 6. Clean version for pattern matching (all quotes intact, normalized spaces)
    const cleanPrompt = restoredPrompt.replace(/[.!?]+$/, '').trim();

    // Check for explicit negation
    const hasNegation = /\b(?:do\s+not|don'?t|never|delete\s+nothing|cancel|stop)\b/i.test(cleanPrompt);

    return {
      originalPrompt,
      normalizedPrompt,
      maskedPrompt: normalizedPrompt,
      cleanPrompt,
      quotes,
      hasNegation,
      restoredPrompt
    };
  }

  /**
   * Isolates quoted text and returns masked prompt and quotes list.
   */
  static isolateQuotes(prompt) {
    const norm = this.normalize(prompt);
    return {
      cleanPrompt: norm.normalizedPrompt,
      quotes: norm.quotes
    };
  }

  /**
   * Helper to restore a placeholder string with original quoted content.
   */
  static restoreQuotes(text, quotes = []) {
    if (!text || typeof text !== 'string') return text;
    return text.replace(/__QUOTE_(\d+)__/g, (m, idx) => {
      return quotes[parseInt(idx, 10)] ?? '';
    });
  }
}
