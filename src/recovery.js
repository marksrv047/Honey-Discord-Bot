import { EmbedBuilder } from 'discord.js';
import { Logger } from './logger.js';

const logger = new Logger('Recovery');

/**
 * Creates a beautiful, user-friendly Discord embed explaining errors with actionable recommendations.
 */
/**
 * Creates an unmasked, highly informative Discord embed detailing the exact failure, limits, and resolution.
 * Zero generic error masking.
 */
export function createErrorEmbed(err, executionId = 'unknown') {
  const message = err?.message || String(err);
  let title = '❌ Execution Error';
  let category = 'System / API Failure';
  let explanation = message && message !== 'Error' ? message : 'An unspecified error occurred during execution.';
  let recommendation = 'Please check the error details above and retry.';

  // 1. AI Token, Quota, or Credit Limits
  if (message.includes('rate limit') || message.includes('429') || message.includes('RESOURCE_EXHAUSTED') || message.includes('tokens per minute') || message.includes('TPM') || message.includes('quota') || message.includes('token budget') || message.includes('credit')) {
    title = '⏳ AI Inference Rate Limit / Token Budget Exceeded';
    category = 'AI Provider Quota Exhaustion';
    explanation = message;
    recommendation = '• The free-tier AI inference window reached its temporary RPM/TPM limit or task budget.\n• Wait 30–60 seconds for the quota window to refresh, or break complex requests into smaller steps.\n• Run `/diagnostics` to inspect the active AI model and token consumption.';
  }
  // 2. Channel, Role, or Resource Not Found
  else if (message.includes('not found') || message.includes('Unknown Channel') || message.includes('Unknown Role') || message.includes('Unknown Member')) {
    title = '🔍 Resource Not Found';
    category = 'Target Resolution Failure';
    explanation = message;
    recommendation = '• If targeting a channel, mention it directly (e.g. #channel) or check for decorative emojis/middle dots.\n• If targeting a role, mention it (@Role) or check spelling.\n• Ensure Honey Bot has "View Channel" permissions if the channel is private.';
  }
  // 3. Out of Bounds: Length, Size, or Bounds Limits
  else if (message.includes('out of bounds') || message.includes('too large') || message.includes('2000') || message.includes('character limit') || message.includes('exceeding Discord')) {
    title = '📏 Parameter Limit / Out of Bounds';
    category = 'Discord API Bounds Restriction';
    explanation = message;
    recommendation = '• Messages: Must be ≤ 2,000 characters (split long text into multiple messages).\n• Embed descriptions: Must be ≤ 4,096 characters.\n• Slowmode: Must be between 0 and 21,600 seconds (6 hours).\n• Purge: Must be between 1 and 100 messages.\n• Nicknames: Must be ≤ 32 characters.';
  }
  // 4. JSON Formulation or AI Parsing Issue
  else if (message.includes('json_validate_failed') || message.includes('JSON') || message.includes('Failed to parse') || message.includes('structured object')) {
    title = '🧩 AI Formulation Error';
    category = 'LLM Output Parsing';
    explanation = `The AI model failed to produce a valid action plan: ${message}`;
    recommendation = 'Try rephrasing with clear, explicit action verbs (e.g. "Create role VIP with color #FFD700" or "Rename this channel to dev-chat").';
  }
  // 5. Discord Missing Permissions
  else if (message.includes('50013') || message.includes('Missing Permissions') || message.includes('Bot lacks required permissions')) {
    title = '🛑 Missing Discord Permissions';
    category = 'Discord Authorization Failure';
    explanation = message;
    recommendation = '• In Server Settings > Roles, check the permissions for the "Honey Bot" role.\n• In the specific channel settings > Permissions, verify Honey Bot has "Send Messages", "View Channel", and "Mention Everyone" allowed.';
  }
  // 6. Role Hierarchy Violation
  else if (message.includes('Hierarchy') || message.includes('higher than or equal')) {
    title = '🪜 Discord Role Hierarchy Error';
    category = 'Role Hierarchy Restriction';
    explanation = message;
    recommendation = 'In Server Settings > Roles, click and drag the "Honey Bot" role higher on the list than the role or member you are managing.';
  }
  // 7. Security Gate / Policy Refusal
  else if (message.includes('Security Policy Violation') || message.includes('Anti-Nuke') || message.includes('Prompt injection') || message.includes('Security Refusal') || message.includes('UNAUTHORIZED_ADMIN_GRANT')) {
    title = '🛡️ Security Gate Policy Refusal';
    category = 'Immutable Security Rule Enforcement';
    explanation = message;
    recommendation = 'This action is blocked by Honey Bot\'s immutable security policy. Mass destructions, server nukes, and unauthorized Administrator grants cannot be performed.';
  }
  // 8. User Authorization
  else if (message.includes('Access Denied') || message.includes('Unauthorized') || message.includes('Bot Permission Error')) {
    title = '🔒 User Access Restriction';
    category = 'Command Authorization';
    explanation = message;
    recommendation = 'Honey Bot administration commands require the Discord Administrator permission, and your role must be positioned strictly above the bot.';
  }

  return new EmbedBuilder()
    .setTitle(title)
    .setColor(0xE74C3C)
    .addFields(
      { name: '🔎 What Failed', value: `\`\`\`fix\n${explanation.slice(0, 1000)}\n\`\`\``, inline: false },
      { name: '🏷️ Category', value: category, inline: true },
      { name: '🆔 Execution ID', value: `\`${executionId}\``, inline: true },
      { name: '💡 Recommended Action', value: recommendation, inline: false }
    )
    .setFooter({ text: `Honey Admin Diagnostics • ${new Date().toLocaleTimeString()}` })
    .setTimestamp();
}

/**
 * Classifies Discord API errors into actionable categories.
 */
export function classifyDiscordError(err) {
  const code = err.code || err.status;
  const message = err.message || '';

  if (code === 50013 || message.includes('Missing Permissions')) {
    return {
      type: 'PERMISSION_ERROR',
      retryable: false,
      userMessage: 'Discord rejected the action: Bot lacks required permissions or role hierarchy is too low.'
    };
  }

  if (code === 50035 || message.includes('Invalid Form Body')) {
    return {
      type: 'VALIDATION_ERROR',
      retryable: false,
      userMessage: `Invalid parameter sent to Discord API: ${message}`
    };
  }

  if (code === 429 || message.includes('rate limit')) {
    return {
      type: 'RATE_LIMIT',
      retryable: true,
      userMessage: 'Discord rate limit hit. Request will backoff and retry safely.'
    };
  }

  if (code === 10003 || message.includes('Unknown Channel')) {
    return {
      type: 'RESOURCE_NOT_FOUND',
      retryable: false,
      userMessage: 'The target channel does not exist or was deleted.'
    };
  }

  if (code === 10011 || message.includes('Unknown Role')) {
    return {
      type: 'RESOURCE_NOT_FOUND',
      retryable: false,
      userMessage: 'The target role does not exist or was deleted.'
    };
  }

  return {
    type: 'UNKNOWN_ERROR',
    retryable: false,
    userMessage: message || 'An unexpected error occurred during execution.'
  };
}

/**
 * Audit ledger for rollback tracking.
 * Stores created resources per execution ID so users can safely undo bot actions.
 */
export class ActionLedger {
  static history = new Map(); // executionId -> Array of created resources

  static recordCreatedResource(executionId, type, id, name) {
    if (!this.history.has(executionId)) {
      this.history.set(executionId, []);
    }
    this.history.get(executionId).push({ type, id, name, timestamp: Date.now() });
  }

  static getCreatedResources(executionId) {
    return this.history.get(executionId) || [];
  }

  static getLastExecution(guildId) {
    // Returns the most recent execution with created resources
    const entries = Array.from(this.history.entries()).reverse();
    return entries.length > 0 ? entries[0] : null;
  }

  /**
   * Safely rolls back resources created in a specific execution.
   */
  static async rollbackExecution(guild, executionId) {
    const resources = this.history.get(executionId);
    if (!resources || resources.length === 0) {
      return { success: false, message: 'No created resources found for this execution to undo.' };
    }

    const report = [];

    for (const res of [...resources].reverse()) {
      try {
        if (res.type === 'channel') {
          const ch = guild.channels.cache.get(res.id);
          if (ch) {
            await ch.delete('Rollback of execution ' + executionId);
            report.push(`Deleted channel #${res.name}`);
          }
        } else if (res.type === 'role') {
          const role = guild.roles.cache.get(res.id);
          if (role) {
            await role.delete('Rollback of execution ' + executionId);
            report.push(`Deleted role @${res.name}`);
          }
        }
      } catch (err) {
        logger.error(`Failed to rollback resource ${res.name}`, { error: err.message });
        report.push(`Failed to delete ${res.type} ${res.name}: ${err.message}`);
      }
    }

    this.history.delete(executionId);
    return { success: true, report };
  }
}
