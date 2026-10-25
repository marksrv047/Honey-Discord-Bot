import { TaskBudget } from './budget.js';
import { Logger } from './logger.js';

const logger = new Logger('ContextManager');

/**
 * Manages LLM context windows, compaction, and token safety margins.
 * Eliminates unnecessary full-server dumps from prompts.
 */
export class ContextManager {
  /**
   * Constructs the minimal, high-signal context required for the intent interpreter.
   * Total context payload is typically < 250 tokens instead of 7,000+ tokens.
   */
  static buildInterpretationContext(userPrompt, executionContext) {
    const compactCtx = executionContext.getCompactContext();
    const promptLower = userPrompt.toLowerCase();

    // Check if user explicitly asked for discovery or inventory
    const isDiscovery = /(list|show|all|enumerate|find every|browse)\b/i.test(userPrompt) &&
      /(channels?|roles?|members?)/i.test(userPrompt);

    // Context payload
    const context = {
      server: compactCtx.guild.name,
      currentChannel: compactCtx.currentChannel ? {
        id: compactCtx.currentChannel.id,
        name: compactCtx.currentChannel.name
      } : null,
      invokingUser: compactCtx.invokingUser.tag
    };

    // If the prompt mentions specific roles or channels that are already in cache, include only them!
    const guild = executionContext.guild;
    if (guild && !isDiscovery) {
      // Find any role mentioned in prompt
      const mentionedRoles = guild.roles.cache
        .filter(r => promptLower.includes(r.name.toLowerCase()) || promptLower.includes(r.id))
        .map(r => ({ id: r.id, name: r.name }))
        .slice(0, 5);

      if (mentionedRoles.length > 0) {
        context.relevantRoles = mentionedRoles;
      }

      // Find any channel mentioned in prompt (other than current)
      const mentionedChannels = guild.channels.cache
        .filter(c => c.id !== compactCtx.currentChannel?.id && 
          (promptLower.includes(c.name.toLowerCase()) || promptLower.includes(c.id)))
        .map(c => ({ id: c.id, name: c.name }))
        .slice(0, 5);

      if (mentionedChannels.length > 0) {
        context.relevantChannels = mentionedChannels;
      }
    }

    // Estimate tokens
    const estimatedTokens = TaskBudget.estimateTokens(context);
    logger.debug('Built compact interpretation context', { estimatedTokens });

    return {
      context,
      estimatedTokens,
      isDiscovery
    };
  }

  /**
   * Pre-flight context compaction:
   * If prompt + context exceeds budget limit, strips non-essential fields.
   */
  static compactIfNeeded(payload, maxTokens = 4000) {
    let tokens = TaskBudget.estimateTokens(payload);
    if (tokens <= maxTokens) return payload;

    logger.warn(`Context payload (${tokens} tokens) exceeds budget (${maxTokens} tokens). Compacting...`);

    const compacted = { ...payload };
    if (compacted.relevantChannels) delete compacted.relevantChannels;
    if (compacted.relevantRoles) delete compacted.relevantRoles;

    tokens = TaskBudget.estimateTokens(compacted);
    logger.info(`Compacted context down to ${tokens} tokens`);
    return compacted;
  }
}
