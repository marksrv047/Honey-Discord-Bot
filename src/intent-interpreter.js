import { LinguisticNormalizer } from './linguistic-normalizer.js';
import { NegationDetector } from './knowledge/negation-detector.js';
import { ContextResolver } from './knowledge/context-resolver.js';
import { ClarificationEngine } from './knowledge/clarification-engine.js';
import { KnowledgeRetriever } from './knowledge/retrieval.js';
import { CompletenessChecker } from './completeness-checker.js';
import { OutcomeTracker, OutcomeStatus } from './outcome-tracker.js';
import { FailureDiagnostics, FailureCategory } from './failure-diagnostics.js';
import { SecurityGate } from './security-gate.js';
import { checkRoleHierarchy } from './permissions.js';
import { ACTION_DEFINITIONS } from './action-registry.js';
import { IntentRouter } from './intent-router.js';
import { Logger } from './logger.js';

const logger = new Logger('IntentInterpreter');

/**
 * Centralized Intent Interpretation Layer
 * 
 * Sits cleanly between raw user prompts and the execution engine.
 * Guarantees:
 * 1. Linguistic normalization (casing, spelling, British variants, polite prefixes, typos).
 * 2. Quoted text insulation (preserves payload text without interpreting as nested commands).
 * 3. Contextual anaphora resolution ("this channel", "that role", "its color").
 * 4. Target accuracy and complete parameter extraction.
 * 5. Strict canonical action plan construction conforming to authoritative registry.
 * 6. Explicit outcome tracking (PLANNED -> VALIDATED -> VERIFIED).
 * 7. Structured failure categorization.
 */
export class IntentInterpreter {
  /**
   * Interprets and normalizes a user instruction into a validated canonical action plan.
   * 
   * @param {string} rawPrompt Raw natural-language user prompt
   * @param {object} executionContext ExecutionContext with guild, member, user, recentContext
   * @param {object} options Options (isDeterministicOnly, routerInstance)
   * @returns {Promise<{
   *   success: boolean,
   *   stage: string,
   *   plan: object | null,
   *   outcomes: OutcomeTracker | null,
   *   clarificationQuestion: string | null,
   *   isNegated: boolean,
   *   isRefused: boolean,
   *   failure: object | null,
   *   conversationalResponse: string | null
   * }>}
   */
  static async interpret(rawPrompt, executionContext = {}, options = {}) {
    const guild = executionContext.guild;
    const member = executionContext.invokingMember || executionContext.member;
    const guildId = guild?.id || executionContext.guildId;

    // 1. Linguistic Normalization & Quoted Content Protection
    const norm = LinguisticNormalizer.normalize(rawPrompt);
    const activePrompt = norm.cleanPrompt;

    logger.debug(`Interpreting prompt`, { raw: rawPrompt, normalized: activePrompt });

    // 2. Check Explicit Negation ("don't delete", "never kick", "delete nothing", "do not ban")
    const negation = NegationDetector.analyze(activePrompt);
    if (negation.hasNegation && !/(?:instead|but\s+(?:please|can\s+you|just)|rather\s+than)/i.test(activePrompt)) {
      if (/^(?:do\s+not|don'?t|never|delete\s+nothing|stop|cancel)\b/i.test(activePrompt)) {
        return {
          success: false,
          stage: 'negated',
          isNegated: true,
          plan: null,
          outcomes: null,
          failure: FailureDiagnostics.categorize(`The instruction was explicitly cancelled or forbidden by negative directive.`, { stage: 'negated' }),
          clarificationQuestion: null,
          conversationalResponse: null
        };
      }
    }

    // 3. Context Reference Resolution ("this channel", "that role", "its color")
    const contextResolution = ContextResolver.resolve(
      activePrompt,
      executionContext.recentContext || {},
      guildId
    );
    const resolvedPrompt = contextResolution.isContextual ? contextResolution.resolvedPrompt : activePrompt;

    // 4. Pre-flight Security Gate Check
    if (guild && member) {
      try {
        SecurityGate.evaluatePromptSecurity(resolvedPrompt, member.id || member.user?.id, guild);
      } catch (secErr) {
        logger.warn('Prompt blocked by SecurityGate', { error: secErr.message });
        return {
          success: false,
          stage: 'security_refusal',
          isRefused: true,
          plan: null,
          outcomes: null,
          failure: FailureDiagnostics.categorize(secErr, { stage: 'security_refusal' }),
          clarificationQuestion: null,
          conversationalResponse: null
        };
      }
    }

    // 5. Intent Routing (Deterministic Fast-Paths or Compact LLM Call)
    const router = options.routerInstance || new IntentRouter({ isDeterministicOnly: options.isDeterministicOnly });
    let routed = null;

    try {
      routed = await router.route(resolvedPrompt, executionContext);
    } catch (routeErr) {
      logger.error('Intent routing error', { error: routeErr.message });
      return {
        success: false,
        stage: 'routing_error',
        plan: null,
        outcomes: null,
        failure: FailureDiagnostics.categorize(routeErr, { stage: 'routing_error' }),
        clarificationQuestion: null,
        conversationalResponse: null
      };
    }

    // 6. Conversational / Advisory Response
    if (routed.conversationalResponse) {
      return {
        success: true,
        stage: 'conversational',
        conversationalResponse: routed.conversationalResponse,
        plan: null,
        outcomes: null,
        clarificationQuestion: null,
        failure: null
      };
    }

    // 6b. Interactive System Panels (Dashboard & Setup)
    if (routed.intent === 'open_dashboard' || routed.intent === 'open_setup') {
      return {
        success: true,
        stage: routed.intent,
        specialIntent: routed.intent,
        plan: null,
        outcomes: null,
        clarificationQuestion: null,
        conversationalResponse: null,
        failure: null
      };
    }

    // 7. Clarification Check
    if (routed.clarificationNeeded) {
      return {
        success: false,
        stage: 'clarification',
        clarificationQuestion: routed.clarificationNeeded,
        intendedAction: routed.intent,
        targetName: routed.targetRef || routed.args?.name || null,
        collectedParams: routed.args || {},
        missingParams: routed.missingParams || [],
        plan: null,
        outcomes: null,
        failure: FailureDiagnostics.categorize('Clarification needed', {
          stage: 'clarification',
          question: routed.clarificationNeeded
        }),
        conversationalResponse: null
      };
    }

    const clarificationCheck = ClarificationEngine.evaluate(resolvedPrompt, routed, executionContext);
    if (clarificationCheck.needsClarification) {
      const missingParams = [];
      if (clarificationCheck.reason === 'MISSING_ROLE_NAME' || clarificationCheck.reason === 'MISSING_CHANNEL_NAME') missingParams.push('name');
      if (clarificationCheck.reason === 'MISSING_TARGET_ROLE') missingParams.push('targetRole');
      if (clarificationCheck.reason === 'AMBIGUOUS_MODERATION_ACTION') missingParams.push('actionChoice');
      if (clarificationCheck.missingParam) missingParams.push(clarificationCheck.missingParam);

      return {
        success: false,
        stage: 'clarification',
        clarificationQuestion: clarificationCheck.question,
        intendedAction: routed.intent,
        targetName: routed.targetRef || routed.args?.name || null,
        collectedParams: routed.args || {},
        missingParams,
        plan: null,
        outcomes: null,
        failure: FailureDiagnostics.categorize('Clarification needed', {
          stage: 'clarification',
          question: clarificationCheck.question
        }),
        conversationalResponse: null
      };
    }

    // 8. Assemble Preliminary Action Sequence
    let preliminaryActions = [];
    if (routed.multiActions && Array.isArray(routed.multiActions) && routed.multiActions.length > 0) {
      preliminaryActions = routed.multiActions;
    } else if (routed.intent && routed.intent !== 'unsupported') {
      preliminaryActions = [{
        action: routed.intent,
        targetRole: routed.targetType === 'role' ? routed.targetRef : routed.args?.targetRole,
        targetChannel: routed.targetType === 'channel' ? routed.targetRef : routed.args?.targetChannel,
        targetMember: routed.targetType === 'member' ? routed.targetRef : routed.args?.targetMember,
        targetRef: routed.targetRef,
        ...routed.args
      }];
    }

    // 9. Completeness & Target Accuracy Invariants
    const checkResult = CompletenessChecker.verify(resolvedPrompt, {
      thoughtProcess: routed.thought || 'Administrative operation',
      isHighImpact: Boolean(routed.isHighImpact),
      actions: preliminaryActions
    }, executionContext);

    if (!checkResult.valid && checkResult.errors && checkResult.errors.length > 0) {
      return {
        success: false,
        stage: 'validation_error',
        plan: null,
        outcomes: null,
        failure: FailureDiagnostics.categorize(checkResult.errors.join('; '), { stage: 'validation_error' }),
        clarificationQuestion: checkResult.errors[0],
        conversationalResponse: null
      };
    }

    const finalActions = checkResult.repairedPlan?.actions || preliminaryActions;

    // 10. Check Negation Constraints Against Every Action
    for (const act of finalActions) {
      if (NegationDetector.isActionNegated(act.action, activePrompt)) {
        return {
          success: false,
          stage: 'negated',
          isNegated: true,
          plan: null,
          outcomes: null,
          failure: FailureDiagnostics.categorize(`The action "${act.action}" was explicitly forbidden by your instruction.`, { stage: 'negated' }),
          clarificationQuestion: null,
          conversationalResponse: null
        };
      }
    }

    // 11. Validate Actions Against Authoritative Registry
    for (const act of finalActions) {
      const def = ACTION_DEFINITIONS[act.action];
      if (!def && act.action !== 'search_messages') {
        logger.warn(`Unregistered capability action detected: ${act.action}`);
      }
    }

    // 12. Pre-Check Role Hierarchy If Mutating Roles/Members
    if (guild && member) {
      for (const act of finalActions) {
        if (act.action.includes('role') || act.action === 'change_nickname' || act.action.includes('timeout') || act.action === 'kick_member' || act.action === 'ban_member') {
          const target = act.targetRole || act.targetMember || act.role || act.target;
          if (target && target !== 'current') {
            const hierarchy = checkRoleHierarchy(guild, act, target);
            if (hierarchy.valid === false) {
              return {
                success: false,
                stage: 'permission_denied',
                plan: null,
                outcomes: null,
                failure: FailureDiagnostics.categorize(hierarchy.reason, { stage: 'permission_denied' }),
                clarificationQuestion: null,
                conversationalResponse: null
              };
            }
          }
        }
      }
    }

    // 13. Initialize Outcome Tracking (PLANNED -> VALIDATED)
    const outcomes = new OutcomeTracker(`task_${Date.now()}`, resolvedPrompt);
    outcomes.initializePlan(finalActions);
    outcomes.markAllValidated();

    return {
      success: true,
      stage: 'ready_to_execute',
      activePrompt: resolvedPrompt,
      isHighImpact: Boolean(routed.isHighImpact || checkResult.repairedPlan?.isHighImpact),
      plan: {
        thoughtProcess: checkResult.repairedPlan?.thoughtProcess || routed.thought || `Execute ${finalActions.length} actions`,
        actions: finalActions
      },
      outcomes,
      clarificationQuestion: null,
      conversationalResponse: null,
      failure: null
    };
  }
}
