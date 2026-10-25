import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';
import { Logger } from './logger.js';

const logger = new Logger('AIProvider');

/**
 * System prompt instructing the LLM to act strictly as a Discord Infrastructure Planner.
 * Enforces JSON-only output conforming to PlanSchema.
 */
export const SYSTEM_PROMPT = `
You are the Chief Discord Systems Architect and Administrator Agent.
Your duty is to interpret the user's natural language instructions, review the current server state, and synthesize a structured, robust administrative plan using only valid Discord API actions.

Available Actions:
- update_server_name: { action: "update_server_name", name: string }
- update_server_description: { action: "update_server_description", description: string }
- update_server_icon: { action: "update_server_icon", iconUrl: string }
- update_server_banner: { action: "update_server_banner", bannerUrl: string } (Only if server boostTier >= 2)
- update_server_settings: { action: "update_server_settings", systemChannel?: string, rulesChannel?: string, verificationLevel?: "NONE"|"LOW"|"MEDIUM"|"HIGH"|"VERY_HIGH" }
- create_role: { action: "create_role", name: string, color?: hex_string, hoist?: boolean, mentionable?: boolean, permissions?: string[] }
- edit_role: { action: "edit_role", targetRole: string, name?: string, color?: hex_string, hoist?: boolean, permissions?: string[] }
- delete_role: { action: "delete_role", targetRole: string }
- assign_role: { action: "assign_role", targetRole: string, targetMember: string }
- remove_role: { action: "remove_role", targetRole: string, targetMember: string }
- create_channel: { action: "create_channel", name: string, type: "GUILD_TEXT"|"GUILD_VOICE"|"GUILD_ANNOUNCEMENT"|"GUILD_CATEGORY"|"GUILD_STAGE_VOICE", category?: string, topic?: string, slowmodeSeconds?: number, nsfw?: boolean, isPrivate?: boolean, allowedRoles?: string[], deniedRoles?: string[] }
- edit_channel: { action: "edit_channel", targetChannel: string, name?: string, topic?: string, slowmodeSeconds?: number, nsfw?: boolean, category?: string }
- delete_channel: { action: "delete_channel", targetChannel: string }
- set_channel_permission: { action: "set_channel_permission", targetChannel: string, targetRoleOrMember: string, allow?: string[], deny?: string[] }
- timeout_member: { action: "timeout_member", targetMember: string, durationMinutes: number, reason?: string }
- remove_timeout: { action: "remove_timeout", targetMember: string, reason?: string }
- kick_member: { action: "kick_member", targetMember: string, reason?: string }
- ban_member: { action: "ban_member", targetMember: string, deleteMessageDays?: number, reason?: string }
- unban_member: { action: "unban_member", targetMemberId: snowflake_string, reason?: string }
- change_nickname: { action: "change_nickname", targetMember: string, nickname: string, reason?: string }
- setup_ticket_system: { action: "setup_ticket_system", categoryName?: string, channelName?: string, panelTitle?: string, panelDescription?: string, supportRoleName?: string, buttonText?: string }
- audit_server: { action: "audit_server", scope: "permissions"|"channels"|"roles"|"all" }

CRITICAL PLANNING RULES:
1. Return ONLY a valid JSON object matching this structure:
{
  "thoughtProcess": "Brief explanation of how the user's intent is mapped to Discord infrastructure",
  "clarificationNeeded": null or "Question if user intent is dangerously ambiguous",
  "conversationalResponse": null or "Concise, refined, professional advice or greeting. Strictly NO persona, NO bee/buzz puns, NO emojis. If suggesting items/roles, format strictly as clean sequential bullet points with one bullet per line: • **Name** – Purpose",
  "isHighImpact": boolean (true if deleting channels/roles, banning members, or modifying > 5 items),
  "actions": [ ... list of action objects ... ]
}
2. Order actions logically: create categories before channels that use them; create roles before setting channel permission overwrites.
3. Check existing server state: Do not recreate channels or roles that already exist unless asked to reset them.
4. If the user asks for a Ticket System, use the "setup_ticket_system" action.
5. CONVERSATIONAL & ADVISORY REQUESTS:
   If the user asks for suggestions, recommendations, advice, or general greetings (e.g. "suggest roles for this server", "recommend channels", "hello"):
   - Set "actions": []
   - Set "conversationalResponse": A refined, calm, and concise response. No fluff, no "Buzz buzz!", no cheesy slogans. If listing items, format each on a new line: \`• **Name** – Concise description\`. Never squash bullet points into a single continuous paragraph.
6. DISCORD MENTIONS & TARGET RESOLUTION:
   - Discord users frequently reference members and channels with mentions: '<@1234567890>' is a member, '<#1234567890>' is a channel, '<@&1234567890>' is a role.
   - ALWAYS extract the Snowflake ID or name from the mention to populate targetMember, targetChannel, or targetRole!
   - When the user says "this channel" or "current channel", look at currentChannel.id in CURRENT SERVER STATE and use it as targetChannel!
   - Example 1: "please rename the user <@943847632932073472> to FreakySoham" -> action: "change_nickname", targetMember: "943847632932073472", nickname: "FreakySoham".
   - Example 2: "change this channel's name to main" -> action: "edit_channel", targetChannel: currentChannel.id, name: "main".
   - NEVER say "mentioning is a message action" or refuse a request containing mentions. Mentions specify the target of the administrative action.
7. If the request is impossible (e.g. transfer server ownership, delete server, bot ban owner), explain in thoughtProcess and return an empty actions array.
8. NO MARKDOWN CODE FENCES (\`\`\`json). Output pure raw JSON only.
`;

/**
 * Multi-Provider Zero-Cost AI Planner
 */
export class AIProvider {
  static telemetry = {
    lastInferenceTimestamp: null,
    lastDurationMs: null,
    lastProvider: null,
    lastConfiguredModel: null,
    lastServingModel: null,
    lastError: null,
    totalCalls: 0
  };

  static recordTelemetry(data) {
    this.telemetry = {
      ...this.telemetry,
      ...data,
      totalCalls: (this.telemetry.totalCalls || 0) + (data.success ? 1 : 0)
    };
  }

  static getTelemetry() {
    return { ...this.telemetry };
  }

  /**
   * Bounded diagnostic reachability check for configured AI providers.
   * Tests connectivity and authentication without spending inference tokens on completions.
   */
  static async checkConnectivity(targetProvider = null) {
    const provider = (targetProvider || config.ai.provider || 'gemini').toLowerCase();
    const startTime = Date.now();

    if (provider === 'groq') {
      if (!config.ai.groq.apiKey) {
        return {
          status: 'failed',
          provider: 'groq',
          configuredModel: config.ai.groq.model || 'openai/gpt-oss-120b',
          runtimeModel: null,
          endpoint: 'api.groq.com',
          isRemote: true,
          error: 'GROQ_API_KEY is missing in environment.'
        };
      }
      try {
        const res = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { Authorization: `Bearer ${config.ai.groq.apiKey.trim()}` },
          signal: AbortSignal.timeout(5000)
        });
        const latencyMs = Date.now() - startTime;
        if (res.ok) {
          return {
            status: 'healthy',
            provider: 'groq',
            configuredModel: config.ai.groq.model || 'openai/gpt-oss-120b',
            runtimeModel: null, // Groq /models returns model list, not active serving model
            endpoint: 'api.groq.com',
            isRemote: true,
            latencyMs
          };
        }
        if (res.status === 401 || res.status === 403) {
          return {
            status: 'failed',
            provider: 'groq',
            configuredModel: config.ai.groq.model || 'openai/gpt-oss-120b',
            runtimeModel: null,
            endpoint: 'api.groq.com',
            isRemote: true,
            error: 'Authentication failed: Invalid GROQ_API_KEY.'
          };
        }
        return {
          status: 'degraded',
          provider: 'groq',
          configuredModel: config.ai.groq.model || 'openai/gpt-oss-120b',
          runtimeModel: null,
          endpoint: 'api.groq.com',
          isRemote: true,
          error: `HTTP ${res.status}`
        };
      } catch (err) {
        return {
          status: 'failed',
          provider: 'groq',
          configuredModel: config.ai.groq.model || 'openai/gpt-oss-120b',
          runtimeModel: null,
          endpoint: 'api.groq.com',
          isRemote: true,
          error: err.name === 'TimeoutError' ? 'Connection timed out' : err.message
        };
      }
    }

    if (provider === 'gemini') {
      if (!config.ai.gemini.apiKey) {
        return {
          status: 'failed',
          provider: 'gemini',
          configuredModel: config.ai.gemini.model || 'gemini-3.8-flash',
          runtimeModel: null,
          endpoint: 'generativelanguage.googleapis.com',
          isRemote: true,
          error: 'GEMINI_API_KEY is missing in environment.'
        };
      }
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${config.ai.gemini.apiKey}`, {
          signal: AbortSignal.timeout(5000)
        });
        const latencyMs = Date.now() - startTime;
        if (res.ok) {
          return {
            status: 'healthy',
            provider: 'gemini',
            configuredModel: config.ai.gemini.model || 'gemini-3.8-flash',
            runtimeModel: null,
            endpoint: 'generativelanguage.googleapis.com',
            isRemote: true,
            latencyMs
          };
        }
        if (res.status === 400 || res.status === 403) {
          return {
            status: 'failed',
            provider: 'gemini',
            configuredModel: config.ai.gemini.model || 'gemini-3.8-flash',
            runtimeModel: null,
            endpoint: 'generativelanguage.googleapis.com',
            isRemote: true,
            error: 'Authentication failed: Invalid GEMINI_API_KEY.'
          };
        }
        return {
          status: 'degraded',
          provider: 'gemini',
          configuredModel: config.ai.gemini.model || 'gemini-3.8-flash',
          runtimeModel: null,
          endpoint: 'generativelanguage.googleapis.com',
          isRemote: true,
          error: `HTTP ${res.status}`
        };
      } catch (err) {
        return {
          status: 'failed',
          provider: 'gemini',
          configuredModel: config.ai.gemini.model || 'gemini-3.8-flash',
          runtimeModel: null,
          endpoint: 'generativelanguage.googleapis.com',
          isRemote: true,
          error: err.name === 'TimeoutError' ? 'Connection timed out' : err.message
        };
      }
    }

    if (provider === 'ollama') {
      try {
        const res = await fetch(`${config.ai.ollama.baseUrl}/api/tags`, {
          signal: AbortSignal.timeout(5000)
        });
        const latencyMs = Date.now() - startTime;
        if (res.ok) {
          return {
            status: 'healthy',
            provider: 'ollama',
            configuredModel: config.ai.ollama.model || 'llama3.1:8b',
            runtimeModel: null,
            endpoint: config.ai.ollama.baseUrl,
            isRemote: false,
            isLocal: true,
            latencyMs
          };
        }
        return {
          status: 'failed',
          provider: 'ollama',
          configuredModel: config.ai.ollama.model || 'llama3.1:8b',
          runtimeModel: null,
          endpoint: config.ai.ollama.baseUrl,
          isRemote: false,
          isLocal: true,
          error: `HTTP ${res.status}`
        };
      } catch (err) {
        return {
          status: 'failed',
          provider: 'ollama',
          configuredModel: config.ai.ollama.model || 'llama3.1:8b',
          runtimeModel: null,
          endpoint: config.ai.ollama.baseUrl,
          isRemote: false,
          isLocal: true,
          error: err.name === 'TimeoutError' ? 'Connection timed out' : err.message
        };
      }
    }

    return {
      status: 'failed',
      provider,
      configuredModel: 'unknown',
      runtimeModel: null,
      endpoint: 'unknown',
      error: `Unsupported provider "${provider}"`
    };
  }

  constructor() {
    this.provider = config.ai.provider;
  }

  /**
   * Plans actions using the configured zero-cost provider with automatic multi-provider fallback.
   */
  async planActions(userPrompt, serverState) {
    // If the prompt is conversational or asking general questions, minimize context tokens to avoid rate limits
    const isInformational = /^(what|who|how|why|tell|explain|hi|hello|hey|help)\b/i.test(userPrompt.trim()) &&
      !/(create|delete|edit|rename|ban|kick|timeout|role|channel|category|ticket|audit|purge)/i.test(userPrompt);

    const statePayload = isInformational
      ? { server: serverState.guild?.name || 'Discord Server', currentChannel: serverState.currentChannel }
      : serverState;

    const promptPayload = `CURRENT SERVER STATE:\n${JSON.stringify(statePayload)}\n\nUSER INSTRUCTION:\n"${userPrompt}"`;

    switch (this.provider) {
      case 'gemini':
        try {
          return await this.planWithGemini(promptPayload);
        } catch (err) {
          if (config.ai.groq.apiKey) {
            logger.warn('Gemini error, seamlessly falling back to Groq...', { error: err.message });
            return await this.planWithGroq(promptPayload);
          }
          throw err;
        }
      case 'groq':
        try {
          return await this.planWithGroq(promptPayload);
        } catch (err) {
          if (config.ai.gemini.apiKey) {
            logger.warn('Groq rate limited or token budget exceeded, seamlessly falling back to Google Gemini...', { error: err.message });
            return await this.planWithGemini(promptPayload);
          }
          throw err;
        }
      case 'ollama':
        return this.planWithOllama(promptPayload);
      default:
        throw new Error(`Unsupported AI provider: ${this.provider}. Choose 'gemini', 'groq', or 'ollama'.`);
    }
  }

  /**
   * Universal entry point for custom system prompts (such as lightweight intent routing).
   */
  async planWithCustomPrompt(customSystemPrompt, promptPayload) {
    switch (this.provider) {
      case 'gemini':
        try {
          return await this.planWithGemini(promptPayload, customSystemPrompt);
        } catch (err) {
          if (config.ai.groq.apiKey) {
            logger.warn('Gemini error, seamlessly falling back to Groq...', { error: err.message });
            return await this.planWithGroq(promptPayload, customSystemPrompt);
          }
          throw err;
        }
      case 'groq':
        try {
          return await this.planWithGroq(promptPayload, customSystemPrompt);
        } catch (err) {
          if (config.ai.gemini.apiKey) {
            logger.warn('Groq rate limited, seamlessly falling back to Google Gemini...', { error: err.message });
            return await this.planWithGemini(promptPayload, customSystemPrompt);
          }
          throw err;
        }
      case 'ollama':
        return this.planWithOllama(promptPayload, customSystemPrompt);
      default:
        throw new Error(`Unsupported AI provider: ${this.provider}. Choose 'gemini', 'groq', or 'ollama'.`);
    }
  }

  /**
   * Google Gemini (Free Tier from https://aistudio.google.com/)
   */
  async planWithGemini(promptPayload, systemPrompt = SYSTEM_PROMPT) {
    if (!config.ai.gemini.apiKey) {
      throw new Error('GEMINI_API_KEY is missing. Get a 100% free key at https://aistudio.google.com/');
    }

    const genAI = new GoogleGenerativeAI(config.ai.gemini.apiKey);

    const candidateModels = [
      'gemini-3.5-flash',
      'gemini-3.7-flash',
      'gemini-3.1-flash-lite'
    ];

    const modelsToTry = [...new Set(candidateModels)];
    let lastError = null;

    const callStart = Date.now();
    for (const modelName of modelsToTry) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.2
          },
          systemInstruction: systemPrompt
        });

        const response = await model.generateContent(promptPayload);
        const text = response.response.text();
        AIProvider.recordTelemetry({
          lastInferenceTimestamp: new Date().toISOString(),
          lastDurationMs: Date.now() - callStart,
          lastProvider: 'gemini',
          lastConfiguredModel: config.ai.gemini.model || 'gemini-3.8-flash',
          lastServingModel: modelName,
          lastError: null,
          success: true
        });
        return this.parseJsonResponse(text);
      } catch (err) {
        lastError = err;
        const msg = err.message || '';
        logger.warn(`Gemini model ${modelName} returned: ${msg}. Trying next available model...`);
        if (msg.includes('401') || msg.includes('API_KEY_INVALID')) {
          throw new Error('Invalid Gemini API Key provided. Check your GEMINI_API_KEY in .env.');
        }
        if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
          throw new Error('Google Gemini free quota reached. Please wait a minute, or switch to Groq or local Ollama in .env.');
        }
      }
    }

    AIProvider.recordTelemetry({
      lastInferenceTimestamp: new Date().toISOString(),
      lastDurationMs: Date.now() - callStart,
      lastProvider: 'gemini',
      lastConfiguredModel: config.ai.gemini.model || 'gemini-3.8-flash',
      lastServingModel: null,
      lastError: lastError?.message || 'All Gemini models in fallback chain failed',
      success: false
    });
    logger.error('All Gemini models in fallback chain failed', { error: lastError?.message });
    throw lastError;
  }

  /**
   * Groq (Free Tier from https://console.groq.com/)
   */
  async planWithGroq(promptPayload, systemPrompt = SYSTEM_PROMPT) {
    if (!config.ai.groq.apiKey) {
      throw new Error('GROQ_API_KEY is missing. Get a free API key at https://console.groq.com/');
    }

    const candidateModels = [
      config.ai.groq.model || 'openai/gpt-oss-120b',
      'openai/gpt-oss-120b',
      'qwen/qwen3.8-27b',
      'allam-2-7b'
    ];

    const modelsToTry = [...new Set(candidateModels)];
    let lastError = null;
    const callStart = Date.now();

    for (const modelName of modelsToTry) {
      try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.ai.groq.apiKey.trim()}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: modelName,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: promptPayload }
            ],
            response_format: { type: 'json_object' },
            temperature: 0.2
          })
        });

        if (!response.ok) {
          const errorBody = await response.text();
          if (response.status === 401 || response.status === 403) {
            throw new Error(`Invalid Groq API Key provided. Check your GROQ_API_KEY in .env.`);
          }
          if (response.status === 429) {
            // Check for retry-after header
            const retryAfter = response.headers.get('retry-after');
            if (retryAfter && parseInt(retryAfter, 10) <= 5) {
              const waitSec = parseInt(retryAfter, 10);
              logger.info(`Groq returned 429 with retry-after: ${waitSec}s. Backing off...`);
              await new Promise(r => setTimeout(r, waitSec * 1000));
              continue; // Retry this model after waiting
            }
            throw new Error('Groq free rate limit reached. Please wait a minute or use Gemini / Ollama.');
          }
          if (response.status === 413) {
            throw new Error('Groq request too large: Input token limit exceeded.');
          }
          throw new Error(`Groq model ${modelName} returned status ${response.status}: ${errorBody}`);
        }

        const data = await response.json();
        const content = data.choices[0].message.content;
        AIProvider.recordTelemetry({
          lastInferenceTimestamp: new Date().toISOString(),
          lastDurationMs: Date.now() - callStart,
          lastProvider: 'groq',
          lastConfiguredModel: config.ai.groq.model || 'openai/gpt-oss-120b',
          lastServingModel: data.model || modelName,
          lastError: null,
          success: true
        });
        return this.parseJsonResponse(content);
      } catch (err) {
        lastError = err;
        logger.warn(`Groq model ${modelName} failed: ${err.message}. Trying next candidate...`);
        if (err.message.includes('Invalid Groq API Key')) throw err;
      }
    }

    AIProvider.recordTelemetry({
      lastInferenceTimestamp: new Date().toISOString(),
      lastDurationMs: Date.now() - callStart,
      lastProvider: 'groq',
      lastConfiguredModel: config.ai.groq.model || 'openai/gpt-oss-120b',
      lastServingModel: null,
      lastError: lastError?.message || 'All Groq models failed',
      success: false
    });
    logger.error('All Groq models failed', { error: lastError?.message });
    throw lastError;
  }

  /**
   * Ollama (Local model, 100% Free, Offline, Infinite)
   */
  async planWithOllama(promptPayload, systemPrompt = SYSTEM_PROMPT) {
    const url = `${config.ai.ollama.baseUrl}/api/chat`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.ai.ollama.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: promptPayload }
          ],
          format: 'json',
          stream: false,
          options: { temperature: 0.2 }
        })
      });

      if (!response.ok) {
        throw new Error(`Ollama request failed with status ${response.status}. Is Ollama running on ${config.ai.ollama.baseUrl}?`);
      }

      const data = await response.json();
      return this.parseJsonResponse(data.message.content);
    } catch (err) {
      logger.error('Ollama call failed', { error: err.message });
      throw new Error(`Local Ollama is unreachable at ${config.ai.ollama.baseUrl}. Make sure Ollama is started with "ollama run ${config.ai.ollama.model}".`);
    }
  }

  /**
   * Cleanly parses JSON string into object, stripping backticks if any
   */
  parseJsonResponse(rawText) {
    let clean = rawText.trim();
    if (clean.startsWith('```json')) {
      clean = clean.replace(/^```json/, '').replace(/```$/, '').trim();
    } else if (clean.startsWith('```')) {
      clean = clean.replace(/^```/, '').replace(/```$/, '').trim();
    }

    try {
      return JSON.parse(clean);
    } catch (err) {
      logger.error('Failed to parse AI JSON output', { rawText });
      throw new Error(`AI generated invalid JSON: ${err.message}`);
    }
  }
}
