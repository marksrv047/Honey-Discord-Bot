import { CAPABILITY_REGISTRY } from '../capabilities.js';
import { UniversalIntentSchema, validateIntent } from './schema.js';

// Module Imports
import * as CoreLanguage from './modules/core-language.js';
import * as CommandInterpretation from './modules/command-interpretation.js';
import * as ServerChannels from './modules/server-channels.js';
import * as MemberRoles from './modules/member-roles.js';
import * as ModerationSafety from './modules/moderation-safety.js';
import * as PermissionsAccess from './modules/permissions-access.js';
import * as MessageSearchManagement from './modules/message-search-management.js';
import * as LoggingAudit from './modules/logging-audit.js';
import * as MusicVoice from './modules/music-voice.js';
import * as DashboardConfiguration from './modules/dashboard-configuration.js';
import * as DiagnosticsTroubleshooting from './modules/diagnostics-troubleshooting.js';
import * as MultiStepPlanning from './modules/multi-step-planning.js';
import * as ClarificationConfirmation from './modules/clarification-confirmation.js';
import * as ErrorRecoveryUndo from './modules/error-recovery-undo.js';
import * as ContextResolution from './modules/context-resolution.js';
import * as SecurityRefusal from './modules/security-refusal.js';
import * as ExampleLibrary from './modules/example-library.js';
import * as EvaluationRegression from './modules/evaluation-regression.js';

export const KNOWLEDGE_BASE_VERSION = '1.0.0';

/**
 * Universal Knowledge Base Engine
 * Unifies all 18 knowledge modules and bridges natural-language understanding
 * to authoritative registered capabilities in CAPABILITY_REGISTRY.
 */
export class KnowledgeBase {
  static get version() {
    return KNOWLEDGE_BASE_VERSION;
  }

  static get modules() {
    return {
      coreLanguage: CoreLanguage,
      commandInterpretation: CommandInterpretation,
      serverChannels: ServerChannels,
      memberRoles: MemberRoles,
      moderationSafety: ModerationSafety,
      permissionsAccess: PermissionsAccess,
      messageSearchManagement: MessageSearchManagement,
      loggingAudit: LoggingAudit,
      musicVoice: MusicVoice,
      dashboardConfiguration: DashboardConfiguration,
      diagnosticsTroubleshooting: DiagnosticsTroubleshooting,
      multiStepPlanning: MultiStepPlanning,
      clarificationConfirmation: ClarificationConfirmation,
      errorRecoveryUndo: ErrorRecoveryUndo,
      contextResolution: ContextResolution,
      securityRefusal: SecurityRefusal,
      exampleLibrary: ExampleLibrary,
      evaluationRegression: EvaluationRegression
    };
  }

  /**
   * Introspects registered capabilities directly from CAPABILITY_REGISTRY.
   */
  static getRegisteredCapabilities() {
    return Object.keys(CAPABILITY_REGISTRY);
  }

  /**
   * Retrieves full specification for a capability action.
   */
  static getCapability(actionName) {
    return CAPABILITY_REGISTRY[actionName] || null;
  }

  /**
   * Returns authoritative example library count.
   */
  static getExampleCount() {
    return ExampleLibrary.EXAMPLE_LIBRARY.length;
  }

  /**
   * Returns evaluation dataset count.
   */
  static getEvaluationCount() {
    return EvaluationRegression.EVALUATION_DATASET.length;
  }

  /**
   * Validates an intent object against Universal Intent Schema.
   */
  static validate(intent) {
    return validateIntent(intent);
  }
}

export {
  UniversalIntentSchema,
  validateIntent,
  CoreLanguage,
  CommandInterpretation,
  ServerChannels,
  MemberRoles,
  ModerationSafety,
  PermissionsAccess,
  MessageSearchManagement,
  LoggingAudit,
  MusicVoice,
  DashboardConfiguration,
  DiagnosticsTroubleshooting,
  MultiStepPlanning,
  ClarificationConfirmation,
  ErrorRecoveryUndo,
  ContextResolution,
  SecurityRefusal,
  ExampleLibrary,
  EvaluationRegression
};
