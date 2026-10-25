import { AIProvider } from './ai-provider.js';
import { validatePlan } from './schemas.js';
import { UNSUPPORTED_DISCORD_OPERATIONS } from './capabilities.js';
import { Logger } from './logger.js';
import { config } from './config.js';

const logger = new Logger('Planner');

export class Planner {
  constructor() {
    this.aiProvider = new AIProvider();
  }

  /**
   * Translates natural language into a validated, deterministic action plan.
   */
  async createPlan(userPrompt, serverState) {
    // 1. Check for known unsupported Discord operations
    for (const unsupported of UNSUPPORTED_DISCORD_OPERATIONS) {
      if (unsupported.pattern.test(userPrompt)) {
        return {
          thoughtProcess: unsupported.reason,
          clarificationNeeded: null,
          isHighImpact: false,
          actions: []
        };
      }
    }

    let attempts = 0;
    const maxAttempts = config.ai.maxReplanningAttempts;
    let currentPrompt = userPrompt;

    while (attempts <= maxAttempts) {
      attempts++;
      logger.info(`Generating administrative plan (Attempt ${attempts}/${maxAttempts + 1})`, { prompt: userPrompt });

      const rawPlan = await this.aiProvider.planActions(currentPrompt, serverState);
      const validation = validatePlan(rawPlan);

      if (validation.success) {
        const plan = validation.data;

        // Determine if high-impact
        const hasDestructiveOps = plan.actions.some(a => 
          ['delete_channel', 'delete_role', 'ban_member', 'kick_member'].includes(a.action)
        );
        const isMassOperation = plan.actions.length >= config.safety.confirmationThreshold.maxActionsWithoutConfirm;

        plan.isHighImpact = Boolean(plan.isHighImpact || hasDestructiveOps || isMassOperation);

        logger.info('Plan validated successfully', {
          actionCount: plan.actions.length,
          isHighImpact: plan.isHighImpact
        });

        return plan;
      }

      logger.warn(`Plan validation failed on attempt ${attempts}`, {
        errors: validation.error.issues
      });

      if (attempts <= maxAttempts) {
        // Construct feedback for AI to repair plan
        currentPrompt = `${userPrompt}
CRITICAL FIX REQUIRED: Your previous output failed schema validation:
${JSON.stringify(validation.error.issues.map(i => `${i.path.join('.')}: ${i.message}`), null, 2)}
Please output a corrected plan matching the exact JSON schema.`;
      } else {
        throw new Error(`Failed to produce a valid administrative plan after ${maxAttempts + 1} attempts. Validation errors: ${validation.error.issues.map(i => i.message).join(', ')}`);
      }
    }
  }
}
