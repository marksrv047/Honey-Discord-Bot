import { z } from 'zod';
import { CAPABILITY_REGISTRY } from '../capabilities.js';

/**
 * Universal Natural-Language Intent Schema
 * 
 * Provides a rigorous, validated structured schema for every interpreted user instruction.
 * Distinguishes explicit vs inferred parameters, identifies candidate capabilities,
 * records uncertainty, prerequisites, risk levels, and confirmation needs.
 */

export const IntentCategoryEnum = z.enum([
  'MESSAGING',
  'ROLES',
  'CHANNELS',
  'CATEGORIES',
  'MODERATION',
  'PERMISSIONS',
  'LOGGING',
  'MUSIC',
  'DASHBOARD',
  'DIAGNOSTICS',
  'PLANNING',
  'CONVERSATIONAL',
  'UNSUPPORTED'
]);

export const RiskClassificationEnum = z.enum([
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL'
]);

export const TargetTypeEnum = z.enum([
  'channel',
  'role',
  'member',
  'message',
  'server',
  'track',
  'category',
  'policy',
  'none'
]);

export const TargetEntitySchema = z.object({
  type: TargetTypeEnum.default('none'),
  rawRef: z.string().optional().describe('Raw reference from prompt e.g. "current", "#general", "@Alex", "VIP"'),
  resolvedId: z.string().optional().describe('Resolved Discord snowflake ID if available'),
  resolvedName: z.string().optional().describe('Normalized entity name')
});

export const ParameterValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.record(z.any())
]);

export const UniversalIntentSchema = z.object({
  // 1. High-level classification
  intentCategory: IntentCategoryEnum,
  requestedOutcome: z.string().describe('Clear, human-readable summary of what the user wants achieved'),
  
  // 2. Candidate capabilities mapped to CAPABILITY_REGISTRY
  candidateCapabilities: z.array(z.string()).describe('Action IDs from CAPABILITY_REGISTRY, e.g. ["create_role", "assign_role"]'),
  primaryAction: z.string().describe('The primary resolved action or capability ID'),
  
  // 3. Target entities
  target: TargetEntitySchema.default({ type: 'none' }),
  secondaryTargets: z.array(TargetEntitySchema).optional().default([]),
  
  // 4. Explicit vs inferred parameters
  explicitParameters: z.record(ParameterValueSchema).default({}).describe('Parameters directly stated by the user'),
  inferredParameters: z.record(ParameterValueSchema).default({}).describe('Parameters deduced from context, defaults, or server state'),
  
  // 5. Constraints, durations, limits, and search queries
  durationMinutes: z.number().nullable().optional(),
  limitCount: z.number().nullable().optional(),
  searchQuery: z.string().nullable().optional(),
  filterConditions: z.record(z.any()).optional().default({}),
  
  // 6. Permissions and prerequisites
  requiredBotPermissions: z.array(z.string()).default([]),
  requiredUserPermissions: z.array(z.string()).default([]),
  prerequisiteActions: z.array(z.string()).default([]),
  actionOrder: z.array(z.string()).default([]),
  
  // 7. Ambiguity, uncertainty, and clarification
  confidence: z.number().min(0).max(1).default(1.0).describe('Confidence score in intent interpretation (0.0 to 1.0)'),
  isAmbiguous: z.boolean().default(false),
  missingInformation: z.array(z.string()).default([]),
  clarificationQuestion: z.string().nullable().optional().describe('Concise clarification question if ambiguous'),
  
  // 8. Negation and corrections
  isNegated: z.boolean().default(false).describe('True if the action was explicitly negated or cancelled'),
  negatedAction: z.string().nullable().optional().describe('The specific action that was cancelled or forbidden'),
  
  // 9. Risk and confirmation
  riskClassification: RiskClassificationEnum.default('LOW'),
  requiresConfirmation: z.boolean().default(false),
  confirmationReason: z.string().nullable().optional(),
  
  // 10. Execution and verification
  expectedOutcome: z.string().describe('Expected state transformation upon successful execution'),
  verificationMethod: z.string().default('STATE_CHECK'),
  isReversible: z.boolean().default(true),
  
  // 11. Support status
  isSupported: z.boolean().default(true),
  unsupportedReason: z.string().nullable().optional()
});

/**
 * Validates a structured intent against the Universal Intent Schema.
 * Ensures any referenced capabilities exist in the authoritative CAPABILITY_REGISTRY
 * or represent recognized non-execution categories (conversational, unsupported).
 */
export function validateIntent(intentData) {
  const result = UniversalIntentSchema.safeParse(intentData);
  if (!result.success) {
    return {
      valid: false,
      errors: result.error.errors,
      data: null
    };
  }

  // Cross-reference candidate capabilities against CAPABILITY_REGISTRY
  const data = result.data;
  if (data.isSupported && data.intentCategory !== 'CONVERSATIONAL' && data.intentCategory !== 'UNSUPPORTED') {
    for (const cap of data.candidateCapabilities) {
      if (!CAPABILITY_REGISTRY[cap] && cap !== 'complex_plan' && cap !== 'open_dashboard' && cap !== 'audit_server') {
        return {
          valid: false,
          errors: [{ message: `Capability "${cap}" is not registered in CAPABILITY_REGISTRY` }],
          data: null
        };
      }
    }
  }

  return {
    valid: true,
    errors: [],
    data
  };
}
