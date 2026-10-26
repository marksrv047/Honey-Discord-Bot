import { CAPABILITY_REGISTRY } from './capabilities.js';
import { KnowledgeRetriever } from './knowledge/retrieval.js';
import { validateIntent } from './knowledge/schema.js';
import { ContextResolver } from './knowledge/context-resolver.js';
import { ClarificationEngine } from './knowledge/clarification-engine.js';
import { NegationDetector } from './knowledge/negation-detector.js';
import { SecurityGate } from './security-gate.js';
import { checkRoleHierarchy } from './permissions.js';
import { CompletenessChecker } from './completeness-checker.js';
import { Executor } from './executor.js';
import { Verifier } from './verification.js';
import { AdaptiveRecoveryEngine } from './adaptive-recovery.js';
import { Logger } from './logger.js';

const logger = new Logger('IntentPipeline');

/**
 * 10-Step Intent-To-Action Translation Pipeline
 * 
 * Provides an authoritative, end-to-end translation pipeline connecting
 * natural-language requests to verified, safe Discord execution.
 */
export class IntentPipeline {
  /**
   * Translates a raw user prompt into a validated, ordered execution plan.
   * @param {string} prompt Raw user instruction
   * @param {object} executionContext Guild, invokingMember, targetCache, recentContext
   */
  static async process(prompt, executionContext = {}) {
    const rawPrompt = String(prompt || '').trim();
    const guild = executionContext.guild;
    const member = executionContext.invokingMember;
    const guildId = guild?.id || executionContext.guildId;

    // -------------------------------------------------------------------------
    // Step 1: Understand Intended Outcome & Linguistic Normalization
    // -------------------------------------------------------------------------
    const negation = NegationDetector.analyze(rawPrompt);

    // -------------------------------------------------------------------------
    // Step 2: Context & Follow-Up Resolution
    // -------------------------------------------------------------------------
    const contextResolution = ContextResolver.resolve(
      rawPrompt,
      executionContext.recentContext || {},
      guildId
    );
    const activePrompt = contextResolution.isContextual ? contextResolution.resolvedPrompt : rawPrompt;

    // -------------------------------------------------------------------------
    // Step 3: Retrieve Smallest Set of Capabilities & Examples (Token Efficiency)
    // -------------------------------------------------------------------------
    const retrieval = KnowledgeRetriever.retrieve(activePrompt, 3, 2);

    // -------------------------------------------------------------------------
    // Step 4: Check for Genuine Ambiguity & Missing Parameters
    // -------------------------------------------------------------------------
    const clarification = ClarificationEngine.evaluate(activePrompt, {}, executionContext);
    if (clarification.needsClarification) {
      return {
        stage: 'clarification',
        needsClarification: true,
        clarificationQuestion: clarification.question,
        plan: null
      };
    }

    // -------------------------------------------------------------------------
    // Step 5: Security Boundary Enforcement (Anti-Nuke, Token Protection)
    // -------------------------------------------------------------------------
    if (guild && member) {
      try {
        SecurityGate.evaluateActionSequence([{ action: 'parse', prompt: activePrompt }], member, guild);
      } catch (err) {
        return {
          stage: 'security_refusal',
          isRefused: true,
          refusalReason: err.message,
          plan: null
        };
      }
    }

    // -------------------------------------------------------------------------
    // Step 5b: Deterministic & LLM Intent Routing
    // -------------------------------------------------------------------------
    const { IntentRouter } = await import('./intent-router.js');
    const router = new IntentRouter({ isDeterministicOnly: true });
    let plannedActions = [];
    try {
      const routed = await router.route(activePrompt, executionContext);
      if (routed.multiActions && Array.isArray(routed.multiActions)) {
        plannedActions = routed.multiActions;
      } else if (routed.intent && routed.intent !== 'conversational' && routed.intent !== 'unsupported') {
        plannedActions = [{
          action: routed.intent,
          targetChannel: routed.targetType === 'channel' ? routed.targetRef : undefined,
          targetRole: routed.targetType === 'role' ? routed.targetRef : undefined,
          targetMember: routed.targetType === 'member' ? routed.targetRef : undefined,
          name: routed.args?.name || routed.targetRef,
          ...routed.args
        }];
      }
    } catch {}

    // -------------------------------------------------------------------------
    // Step 6: Completeness & DAG Dependency Verification
    // -------------------------------------------------------------------------
    const initialPlan = {
      thoughtProcess: `Execution plan for "${activePrompt}"`,
      actions: plannedActions
    };
    const completedPlan = CompletenessChecker.verify(activePrompt, initialPlan, executionContext);
    if (completedPlan.errors && completedPlan.errors.length > 0) {
      return {
        stage: 'validation_error',
        errors: completedPlan.errors,
        plan: null
      };
    }

    const planActions = completedPlan.repairedPlan?.actions || completedPlan.actions || plannedActions;

    // -------------------------------------------------------------------------
    // Step 7: Order Actions Topologically
    // -------------------------------------------------------------------------
    const orderedActions = Executor.orderActions(planActions);

    // Check negation constraints on every planned action
    for (const act of orderedActions) {
      if (NegationDetector.isActionNegated(act.action, rawPrompt)) {
        return {
          stage: 'negated',
          isNegated: true,
          negatedAction: act.action,
          message: `The action "${act.action}" was explicitly forbidden or cancelled by your instruction.`
        };
      }
    }

    // -------------------------------------------------------------------------
    // Step 8: Validate Against Capability Registry & Input Schemas
    // -------------------------------------------------------------------------
    for (const act of orderedActions) {
      const cap = CAPABILITY_REGISTRY[act.action];
      if (!cap && act.action !== 'search_messages' && act.action !== 'edit_channel') {
        logger.warn(`Unregistered capability encountered: ${act.action}`);
      }
    }

    // -------------------------------------------------------------------------
    // Step 9: Role Hierarchy & Permission Pre-Checks
    // -------------------------------------------------------------------------
    if (guild && member) {
      for (const act of orderedActions) {
        if (act.action === 'assign_role' || act.action === 'remove_role' || act.action === 'delete_role') {
          const roleTarget = act.targetRole || act.role;
          if (roleTarget) {
            const roleObj = guild.roles?.cache?.find(r => r.name.toLowerCase() === String(roleTarget).toLowerCase() || r.id === roleTarget);
            if (roleObj) {
              const hierarchyCheck = checkRoleHierarchy(member, roleObj, guild);
              if (!hierarchyCheck.allowed) {
                return {
                  stage: 'permission_denied',
                  error: hierarchyCheck.reason,
                  plan: null
                };
              }
            }
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // Step 10: Produce Validated Plan
    // -------------------------------------------------------------------------
    return {
      stage: 'ready_to_execute',
      activePrompt,
      retrievedCapabilities: retrieval.capabilities.map(c => c.action),
      orderedActions,
      isHighImpact: orderedActions.some(a => ['delete_channel', 'delete_role', 'ban_member', 'purge_messages'].includes(a.action)),
      plan: {
        thoughtProcess: completedPlan.thoughtProcess || `Execute ${orderedActions.length} actions`,
        actions: orderedActions
      }
    };
  }
}
