import dotenv from 'dotenv';
dotenv.config();

/**
 * Validates and exports system configuration.
 * Strictly guarantees ZERO-COST operation for AI providers.
 */
export const config = {
  // Discord credentials
  discord: {
    token: process.env.DISCORD_TOKEN || '',
    clientId: process.env.DISCORD_CLIENT_ID || '',
    guildId: process.env.DISCORD_GUILD_ID || '', // Optional: if provided, deploys guild-specific commands instantly
  },

  // Zero-cost AI provider configuration
  ai: {
    // Active provider: 'gemini' (Google AI Studio Free Tier), 'groq' (Groq Free Tier), or 'ollama' (Local)
    provider: (process.env.AI_PROVIDER || 'gemini').toLowerCase(),

    // Google Gemini Free Tier (from https://aistudio.google.com/ - No CC required)
    gemini: {
      apiKey: process.env.GEMINI_API_KEY || '',
      model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    },

    // Groq Free Tier (from https://console.groq.com/ - Generous free RPM/RPD)
    groq: {
      apiKey: process.env.GROQ_API_KEY || '',
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    },

    // Ollama (100% Free, Local, Offline, Unlimited)
    ollama: {
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      model: process.env.OLLAMA_MODEL || 'llama3.1:8b',
    },

    // Hard safety rules
    strictZeroCost: true, // Never allow fallback to paid endpoints
    maxReplanningAttempts: 2,
    requestTimeoutMs: 30000,
  },

  // Execution safety thresholds
  safety: {
    confirmationThreshold: {
      deleteOperations: true,      // Any delete_channel, delete_role requires confirmation
      destructiveMemberOps: true,  // ban_member or kick_member requires confirmation
      maxActionsWithoutConfirm: 10 // > 10 mutations in a single prompt triggers confirmation preview
    },
    actionDelayMs: 350,            // Safe spacing between REST calls to prevent Discord 429
    maxRetries: 2,                 // Bounded retries for transient errors
  }
};

/**
 * Validates configuration and returns diagnostic status.
 */
export function validateConfig() {
  const issues = [];

  if (!config.discord.token) {
    issues.push('Missing DISCORD_TOKEN in environment (.env).');
  }
  if (!config.discord.clientId) {
    issues.push('Missing DISCORD_CLIENT_ID in environment (.env).');
  }

  if (config.ai.provider === 'gemini' && !config.ai.gemini.apiKey) {
    issues.push('AI_PROVIDER is set to "gemini" but GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/');
  } else if (config.ai.provider === 'groq' && !config.ai.groq.apiKey) {
    issues.push('AI_PROVIDER is set to "groq" but GROQ_API_KEY is not set. Get a free key at https://console.groq.com/');
  }

  return {
    valid: issues.length === 0,
    issues,
    activeProvider: config.ai.provider,
  };
}
