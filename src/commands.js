import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { Planner } from './planner.js';
import { Executor } from './executor.js';
import { Verifier } from './verification.js';
import { ConfirmationManager } from './confirmations.js';
import { checkUserAuthorization, checkBotPermissions } from './permissions.js';
import { getGuildStateSnapshot } from './server-state.js';
import { ActionLedger, RecoveryEngine, RecoveryRegistry, createErrorEmbed } from './recovery.js';
import { ExecutionContext } from './execution-context.js';
import { IntentRouter } from './intent-router.js';
import { TaskWorkflow } from './task-workflow.js';
import { TaskQueue, TaskQueueState, TaskActionStatus } from './task-queue.js';
import { validateConfig, config } from './config.js';
import { SecurityGate, SecurityPolicyViolationError } from './security-gate.js';
import { HealthCheckEngine } from './health-check.js';
import { formatSingleOutcome, formatRefinedResponse, formatMultiActionSummary } from './format-response.js';
import { ResponseService } from './response-service.js';
import { ModLogService } from './mod-log.js';
import { ModlogInterpreter } from './modlog-interpreter.js';
import { TemporaryFeedback } from './temporary-feedback.js';
import { HelpManager } from './help.js';
import { DiagnosticService } from './diagnostic-service.js';
import { CompletenessChecker } from './completeness-checker.js';
import { DashboardManager } from './dashboard.js';
import { OnboardingManager } from './onboarding.js';
import { PermissionAuditService } from './permission-audit.js';
import { ExperienceStore } from './experience-store.js';
import { HoneypotService } from './honeypot-service.js';
import { IntentInterpreter } from './intent-interpreter.js';
import { defaultPendingTaskManager } from './pending-task-manager.js';
import { defaultConversationMemoryManager } from './conversation-memory.js';
import { defaultContextResolutionPipeline } from './context-resolution-pipeline.js';
import { Logger } from './logger.js';
import { globalLifecycle } from './bot-lifecycle.js';
import { globalCommandRegistry } from './command-registry.js';

const logger = new Logger('Commands');
const planner = new Planner();
const intentRouter = new IntentRouter();
const modlogInterpreter = new ModlogInterpreter();

/**
 * Builds user feedback action row for continuous learning.
 */
export function buildFeedbackRow(executionId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`feedback:up:${executionId}`)
      .setLabel('Helpful')
      .setEmoji('👍')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`feedback:down:${executionId}`)
      .setLabel('Report Issue')
      .setEmoji('👎')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Exactly five top-level slash command definitions for Discord registration.
 */
export const slashCommands = [
  // 1. Primary /go command
  new SlashCommandBuilder()
    .setName('go')
    .setDescription('Natural-language execution of supported Discord actions')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
      option
        .setName('prompt')
        .setDescription('Describe what you want to achieve in plain English')
        .setRequired(true)
    ),

  // 2. Moderation Logging /modlog command
  new SlashCommandBuilder()
    .setName('modlog')
    .setDescription('Natural-language configuration and management of moderation logging')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
      option
        .setName('prompt')
        .setDescription('Describe your logging configuration or inspection request in plain English')
        .setRequired(true)
    ),

  // 3. Diagnostics /diagnose command
  new SlashCommandBuilder()
    .setName('diagnose')
    .setDescription('Health checks, diagnostics, and supported safe repairs')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
      option
        .setName('prompt')
        .setDescription('Optional description of specific problem to diagnose')
        .setRequired(false)
    ),

  // 4. Safety /undo command
  new SlashCommandBuilder()
    .setName('undo')
    .setDescription('Reversal of supported, reversible actions')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
      option
        .setName('prompt')
        .setDescription('Optional description of what to undo')
        .setRequired(false)
    ),

  // 5. Help /help command
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('An approachable explanation of Honey Bot and how to use it')
    .addStringOption(option =>
      option
        .setName('prompt')
        .setDescription('Optional question about Honey Bot features or setup')
        .setRequired(false)
    ),

  // 6. Dedicated Honeypot /honeypot command
  new SlashCommandBuilder()
    .setName('honeypot')
    .setDescription('Configure, inspect, enable, disable, and safely test honeypot channels')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(subcommand =>
      subcommand
        .setName('setup')
        .setDescription('Begin an interactive configuration flow for a honeypot channel')
        .addChannelOption(option =>
          option
            .setName('channel')
            .setDescription('Optional text channel to configure as the honeypot')
            .setRequired(false)
        )
        .addStringOption(option =>
          option
            .setName('action')
            .setDescription('Setup action')
            .setRequired(false)
            .addChoices(
              { name: 'Create Dedicated #honeypot Channel', value: 'create_channel' },
              { name: 'Configure Existing Channel', value: 'configure_existing' }
            )
        )
        .addStringOption(option =>
          option
            .setName('mode')
            .setDescription('Enforcement mode')
            .setRequired(false)
            .addChoices(
              { name: 'Strict Instant-Kick Mode', value: 'strict' },
              { name: 'Monitored Mode', value: 'monitored' }
            )
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('enable')
        .setDescription('Enable honeypot enforcement in the configured channel')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('disable')
        .setDescription('Disable honeypot enforcement without deleting channel or logs')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('status')
        .setDescription('Show whether honeypot is configured, enabled, mode, and recent events')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('configure')
        .setDescription('Open interactive configuration panel to modify settings')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('test')
        .setDescription('Perform a non-destructive diagnostic check of honeypot configuration and permissions')
    )
];

// Register definitions with CommandRegistry
globalCommandRegistry.loadDefinitions(slashCommands);

/**
 * Slash command execution router.
 */
export async function handleCommandInteraction(interaction, options = {}) {
  if (!interaction.isChatInputCommand()) return;

  if (!interaction.guild) {
    return await interaction.reply({
      content: 'Honey Bot administration commands must be run inside a Discord server, not in Direct Messages.',
      ephemeral: true
    }).catch(() => {});
  }

  // 1. Lifecycle check: ensure application is serving commands
  const lifecycleState = globalLifecycle.getState();
  if (lifecycleState === 'FAILED') {
    const errorMsg = '❌ **Service Unavailable:** Honey Bot encountered an initialization failure and cannot process commands. Please notify server administrators.';
    if (!interaction.replied && !interaction.deferred) {
      if (typeof interaction.reply === 'function') {
        await interaction.reply({ content: errorMsg, ephemeral: true }).catch(() => {});
      }
    } else if (typeof interaction.editReply === 'function') {
      await interaction.editReply({ content: errorMsg }).catch(() => {});
    }
    return;
  }
  if (lifecycleState === 'BOOTING' || lifecycleState === 'VALIDATING_CONFIG') {
    const infoMsg = `⚠️ **Initializing:** Honey Bot is currently starting services (${lifecycleState}). Please try again in a moment.`;
    if (!interaction.replied && !interaction.deferred) {
      if (typeof interaction.reply === 'function') {
        await interaction.reply({ content: infoMsg, ephemeral: true }).catch(() => {});
      }
    } else if (typeof interaction.editReply === 'function') {
      await interaction.editReply({ content: infoMsg }).catch(() => {});
    }
    return;
  }

  const { commandName } = interaction;
  const handlerEntry = globalCommandRegistry.getHandler(commandName);

  if (!handlerEntry) {
    logger.warn(`Unknown command received: ${commandName}`);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: `❌ Unknown command \`/${commandName}\`. Available commands: \`/go\`, \`/modlog\`, \`/diagnose\`, \`/undo\`, \`/help\`, \`/honeypot\`.`,
        ephemeral: true
      }).catch(() => {});
    }
    return;
  }

  const executionId = Logger.generateExecutionId();
  const startTime = Date.now();
  const watchdog = options.watchdog || null;

  if (watchdog && typeof watchdog.recordInteractionStart === 'function') {
    watchdog.recordInteractionStart(interaction, executionId);
  }

  try {
    await handlerEntry.handler(interaction, { executionId, startTime });
    const durationMs = Date.now() - startTime;
    if (watchdog && typeof watchdog.recordInteractionComplete === 'function') {
      watchdog.recordInteractionComplete(interaction, executionId, durationMs, 'SUCCESS');
    }
  } catch (err) {
    const durationMs = Date.now() - startTime;
    if (watchdog && typeof watchdog.recordInteractionFailed === 'function') {
      watchdog.recordInteractionFailed(interaction, executionId, durationMs, err);
    }
    logger.error(`Error in handleCommandInteraction for /${commandName}`, { error: err.message, stack: err.stack });

    // Sanitize user-facing error - strip raw stack traces
    const safeError = Logger.redactSecrets(err.message || 'An unexpected error occurred.');
    const cleanMsg = safeError.replace(/(?:\r\n|\r|\n)\s*at\s+.*/g, '').trim();
    const content = `❌ **Error:** An error occurred while executing \`/${commandName}\`: ${cleanMsg}`;

    if (interaction.deferred && typeof interaction.editReply === 'function') {
      await interaction.editReply({ content, embeds: [], components: [] }).catch(async () => {
        if (typeof interaction.followUp === 'function') {
          await interaction.followUp({ content, ephemeral: true }).catch(() => {});
        }
      });
    } else if (!interaction.replied && typeof interaction.reply === 'function') {
      await interaction.reply({ content, ephemeral: true }).catch(() => {});
    }
  }
}

/**
 * Handles the primary /go command via the lightweight intent-driven path.
 */
async function handleGoCommand(interaction) {
  const executionId = Logger.generateExecutionId();
  let isDone = false;
  let timeoutGuard = null;

  try {
    // Always defer reply immediately to prevent 3000ms Discord interaction timeout
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply();
    }

    const userPrompt = interaction.options?.getString ? interaction.options.getString('prompt') : '';
    if (!userPrompt || !userPrompt.trim()) {
      isDone = true;
      return await interaction.editReply({
        content: '⚠️ Please provide an instruction for `/go` (e.g. `/go prompt: create #general`).'
      });
    }

    // Direct dashboard intent routing (0 Groq LLM calls)
    const cleanPrompt = userPrompt.trim().toLowerCase();
    if (/^(?:open\s+)?(?:server\s+)?(?:dashboard|settings|config(?:\s+center)?|control\s+panel)$/i.test(cleanPrompt)) {
      isDone = true;
      return await DashboardManager.openDashboard(interaction);
    }

    // Direct setup / onboarding routing (0 Groq LLM calls)
    if (
      /^(?:open\s+)?(?:bot\s+|server\s+|installation\s+|first[- ]run\s+)?(?:setup|onboarding|permissions?\s+setup|install(?:\s+guide)?|permission\s+check)$/i.test(cleanPrompt) ||
      /^(?:setup|onboarding|install\s+bot|bot\s+setup|server\s+setup|check\s+permissions?|reauthorize(?:\s+bot)?)$/i.test(cleanPrompt)
    ) {
      isDone = true;
      return await OnboardingManager.openSetupPanel(interaction);
    }

    const guild = interaction.guild;
    const member = interaction.member;

    // Create lightweight execution context and workflow tracker
    const executionContext = new ExecutionContext(interaction, executionId);

    // Build rich recent context from Layer A & Layer C
    if (guild && interaction.user) {
      executionContext.recentContext = defaultConversationMemoryManager.buildRecentContextSnapshot(
        guild.id,
        interaction.user.id,
        interaction.channel?.id
      );
    }

    // Context Resolution Pipeline: check pending tasks, answers to clarifications, corrections, and pronouns
    let activeUserPrompt = userPrompt;
    const resolution = await defaultContextResolutionPipeline.resolve(userPrompt, {
      guild,
      member,
      user: interaction.user,
      channel: interaction.channel,
      interaction,
      executionContext
    });

    if (resolution.handled) {
      isDone = true;
      if (timeoutGuard) clearTimeout(timeoutGuard);
      return await interaction.editReply({
        content: resolution.message || '',
        embeds: resolution.result?.embeds || (resolution.result?.embed ? [resolution.result.embed] : []),
        components: []
      });
    }

    if (resolution.resolvedPrompt) {
      activeUserPrompt = resolution.resolvedPrompt;
    }

    const workflow = new TaskWorkflow(executionId, activeUserPrompt, executionContext);

    logger.info(`Received /go command [${executionId}]`, { user: interaction.user?.tag, prompt: activeUserPrompt });

    // Hard safety timeout guard so interaction is never left stranded
    timeoutGuard = setTimeout(async () => {
      if (isDone) return;
      isDone = true;
      if (watchdog && typeof watchdog.recordInteractionFailed === 'function') {
        watchdog.recordInteractionFailed(interaction, executionId, 25000, new Error('Operation timed out after 25s'));
      }
      try {
        await interaction.editReply({
          content: '⏳ **Operation Timed Out:** The request took longer than expected to process. Please try again.',
          embeds: [],
          components: []
        });
      } catch {}
    }, 25000);

    // Phase 1: Intent Interpretation, Linguistic Normalization & Security Gate
    const interpretation = await IntentInterpreter.interpret(activeUserPrompt, executionContext, {
      routerInstance: intentRouter
    });

    if (interpretation.isRefused) {
      isDone = true;
      clearTimeout(timeoutGuard);
      return await interaction.editReply({
        content: `🛑 **Security Refusal:** ${interpretation.failure?.error || 'Operation rejected by Security Gate.'}`
      });
    }

    if (interpretation.isNegated) {
      isDone = true;
      clearTimeout(timeoutGuard);
      return await interaction.editReply({
        content: `🛑 **Instruction Cancelled:** ${interpretation.failure?.error || 'Operation was cancelled due to negative instruction.'}`
      });
    }

    if (interpretation.clarificationQuestion) {
      isDone = true;
      clearTimeout(timeoutGuard);

      // Create structured pending task in Layer B
      if (guild && interaction.user) {
        defaultPendingTaskManager.createTask({
          guildId: guild.id,
          userId: interaction.user.id,
          channelId: interaction.channel?.id,
          action: interpretation.intendedAction || 'clarification_pending',
          targetName: interpretation.targetName || null,
          collectedParams: interpretation.collectedParams || {},
          missingParams: interpretation.missingParams?.length ? interpretation.missingParams : ['details'],
          clarificationQuestion: interpretation.clarificationQuestion,
          constraints: {
            isHighImpact: Boolean(interpretation.isHighImpact),
            originalPrompt: activeUserPrompt
          }
        });

        defaultConversationMemoryManager.recordBotResponse(
          guild.id,
          interaction.user.id,
          interaction.channel?.id,
          interpretation.clarificationQuestion,
          { clarificationQuestion: interpretation.clarificationQuestion }
        );
      }

      return await interaction.editReply({
        content: `❓ **Clarification Needed:**\n${interpretation.clarificationQuestion}\n\n*Please reply with the missing information.*`
      });
    }

    if (interpretation.conversationalResponse) {
      isDone = true;
      clearTimeout(timeoutGuard);
      const refinedContent = formatRefinedResponse(interpretation.conversationalResponse);
      const chunks = ResponseService.splitMessage(refinedContent, 2000);
      await interaction.editReply({
        content: chunks[0] || '',
        embeds: [],
        components: []
      });
      for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({ content: chunks[i] }).catch(() => {});
      }
      return;
    }

    if (interpretation.specialIntent === 'open_dashboard') {
      isDone = true;
      clearTimeout(timeoutGuard);
      const dashboardPayload = await DashboardManager.buildDashboardPayload(guild, member, interaction.user, 'overview');
      return await interaction.editReply({
        content: '',
        embeds: dashboardPayload.embeds || [],
        components: dashboardPayload.components || []
      });
    }

    if (interpretation.specialIntent === 'open_setup') {
      isDone = true;
      clearTimeout(timeoutGuard);
      return await OnboardingManager.openSetupPanel(interaction);
    }

    if (!interpretation.success) {
      isDone = true;
      clearTimeout(timeoutGuard);
      const errMsg = interpretation.failure?.error || 'Request invalid or incomplete.';
      return await interaction.editReply({
        content: `⚠️ **Request Incomplete or Invalid:**\n${errMsg}\n\n*Please specify the missing details or targets.*`
      });
    }

    const { plan } = interpretation;
    const isMultiAction = Array.isArray(plan.actions) && plan.actions.length > 1;

    // Phase 2: Check if multi-step complex plan or single-step direct operation
    if (isMultiAction) {
      // Multi-step path: create plan and execute
      const multiPlan = {
        thoughtProcess: plan.thoughtProcess,
        clarificationNeeded: null,
        isHighImpact: Boolean(interpretation.isHighImpact),
        actions: plan.actions
      };

      const userAuth = checkUserAuthorization(member, multiPlan.actions);
      if (!userAuth.authorized) {
        isDone = true;
        clearTimeout(timeoutGuard);
        return await interaction.editReply({ content: `🛑 **Unauthorized:** ${userAuth.reason}` });
      }

      const botAuth = checkBotPermissions(guild, multiPlan.actions);
      if (!botAuth.capable) {
        isDone = true;
        clearTimeout(timeoutGuard);
        return await interaction.editReply({ content: `⚠️ **Bot Permission Error:** ${botAuth.reason}` });
      }

      // Immutable Security Gate check on entire planned action sequence
      try {
        SecurityGate.evaluateActionSequence(multiPlan.actions, member, guild);
      } catch (secErr) {
        isDone = true;
        clearTimeout(timeoutGuard);
        return await interaction.editReply({ content: `🛑 **Security Refusal:** ${secErr.message}` });
      }

      if (multiPlan.isHighImpact) {
        clearTimeout(timeoutGuard);
        const confirmed = await ConfirmationManager.requestConfirmation(interaction, multiPlan);
        if (!confirmed) {
          isDone = true;
          return;
        }
      }

      // Enqueue task into persistent dependency-aware TaskQueue
      const queuedTask = TaskQueue.createTask({
        guildId: guild.id,
        userId: interaction.user.id,
        interactionId: interaction.id,
        userPrompt,
        plan: multiPlan,
        actions: multiPlan.actions,
        isHighImpact: multiPlan.isHighImpact,
        correlationId: executionId
      });

      const executedTask = await TaskQueue.executeTask(queuedTask.taskId, {
        guild,
        member,
        executor: Executor,
        verifier: Verifier,
        onProgress: async (progress) => {
          if (progress.status === 'running' && progress.currentStep <= progress.totalSteps) {
            const stepAction = progress.currentAction;
            const actionTitle = stepAction?.title || stepAction?.action || `Step ${progress.currentStep}`;
            const progressContent = `**Working on your request**\n• Step ${progress.currentStep} of ${progress.totalSteps}: ${actionTitle}...`;
            try {
              await interaction.editReply({
                content: progressContent,
                embeds: [],
                components: []
              });
            } catch (err) {
              if (err.code !== 10062 && err.code !== 10015) {
                logger.warn('Progress update failed', { error: err.message });
              }
            }
          }
        }
      });

      isDone = true;
      clearTimeout(timeoutGuard);

      const results = executedTask.actions.map(act => ({
        action: act.action,
        status: act.status === TaskActionStatus.SUCCEEDED ? 'COMPLETED' : (act.status === TaskActionStatus.SKIPPED ? 'SKIPPED' : 'FAILED'),
        verificationStatus: act.status === TaskActionStatus.SUCCEEDED ? 'passed' : 'failed',
        intendedChange: `Execute ${act.action}`,
        observedOutcome: act.result?.details || act.error || '',
        verified: act.status === TaskActionStatus.SUCCEEDED,
        details: act.result?.details || act.error || '',
        target: act.target
      }));

      // Centralized mod-log recording for multi-action plan
      for (const res of results) {
        await ModLogService.logAction(guild, {
          action: res.action,
          actor: interaction.user,
          target: res.target || res.action,
          reason: plan.thoughtProcess || 'Multi-action plan',
          outcome: res.status === 'COMPLETED' ? 'succeeded' : 'failed',
          failureReason: res.details,
          executionId,
          source: '/go'
        }).catch(() => {});
      }

      const allSucceeded = results.every(r => r.verified);
      const someSucceeded = results.some(r => r.verified);
      const multiOutcome = allSucceeded ? 'succeeded' : (someSucceeded ? 'partially_completed' : 'failed');

      const reportEmbed = Verifier.generateReportEmbed(plan, results, executionId);
      const summaryText = formatMultiActionSummary(results);
      const feedbackRow = buildFeedbackRow(executionId);

      ExperienceStore.recordExecution({
        executionId,
        guildId: guild.id,
        userId: interaction.user.id,
        userPrompt,
        normalizedIntent: 'multi_action',
        plan,
        capabilities: plan.actions.map(a => a.action),
        outcome: multiOutcome,
        verificationEvidence: summaryText,
        latencyMs: Date.now() - (executionContext.startTime || Date.now())
      });

      return await interaction.editReply({
        content: summaryText,
        embeds: [reportEmbed],
        components: [feedbackRow],
        allowedMentions: ResponseService.getAllowedMentions()
      });
    }

    // Phase 3: Minimal Execution Path (Single-Resource Targeted Operation)
    const actionObj = plan.actions[0] || {};
    const targetRef = actionObj.targetRole || actionObj.targetChannel || actionObj.targetMember || actionObj.targetRef || '';
    const interpreted = {
      intent: actionObj.action,
      targetRef,
      args: { ...actionObj },
      thought: plan.thoughtProcess,
      isHighImpact: Boolean(interpretation.isHighImpact)
    };

    // Pre-execution authorization check
    const userAuth = checkUserAuthorization(member, [actionObj]);
    if (!userAuth.authorized) {
      isDone = true;
      clearTimeout(timeoutGuard);
      await ModLogService.logAction(guild, {
        action: interpreted.intent,
        actor: interaction.user,
        target: interpreted.targetRef,
        reason: interpreted.args?.reason || 'No reason provided',
        outcome: 'denied',
        failureReason: userAuth.reason,
        executionId,
        source: '/go'
      }).catch(() => {});
      return await interaction.editReply({ content: `🛑 **Unauthorized:** ${userAuth.reason}` });
    }

    const botAuth = checkBotPermissions(guild, [actionObj]);
    if (!botAuth.capable) {
      isDone = true;
      clearTimeout(timeoutGuard);
      await ModLogService.logAction(guild, {
        action: interpreted.intent,
        actor: interaction.user,
        target: interpreted.targetRef,
        reason: interpreted.args?.reason || 'No reason provided',
        outcome: 'failed',
        failureReason: botAuth.reason,
        executionId,
        source: '/go'
      }).catch(() => {});
      return await interaction.editReply({ content: `⚠️ **Bot Permission Error:** ${botAuth.reason}` });
    }

    // Immutable Security Gate check on targeted action
    try {
      SecurityGate.evaluateActionSequence([actionObj], member, guild);
    } catch (secErr) {
      isDone = true;
      clearTimeout(timeoutGuard);
      await ModLogService.logAction(guild, {
        action: interpreted.intent,
        actor: interaction.user,
        target: interpreted.targetRef,
        reason: interpreted.args?.reason || 'No reason provided',
        outcome: 'denied',
        failureReason: `Security Gate refusal: ${secErr.message}`,
        executionId,
        source: '/go'
      }).catch(() => {});
      return await interaction.editReply({ content: `🛑 **Security Refusal:** ${secErr.message}` });
    }

    // High-impact confirmation check
    if (interpreted.isHighImpact) {
      clearTimeout(timeoutGuard);
      const confirmed = await ConfirmationManager.requestConfirmation(interaction, {
        thoughtProcess: interpreted.thought,
        actions: [actionObj]
      });
      if (!confirmed) {
        isDone = true;
        await ModLogService.logAction(guild, {
          action: interpreted.intent,
          actor: interaction.user,
          target: interpreted.targetRef,
          reason: interpreted.args?.reason || 'No reason provided',
          outcome: 'denied',
          failureReason: 'Confirmation rejected by user',
          executionId,
          source: '/go'
        }).catch(() => {});
        return;
      }
    }

    // Execute directly without full-server discovery
    const opResult = await Executor.executeIntent(guild, interpreted, executionContext, executionId);

    isDone = true;
    clearTimeout(timeoutGuard);

    // Centralized mod-log recording for single action
    await ModLogService.logAction(guild, {
      action: interpreted.intent,
      actor: interaction.user,
      target: interpreted.targetRef,
      reason: interpreted.args?.reason || 'No reason provided',
      duration: interpreted.args?.durationMinutes,
      count: interpreted.args?.count,
      outcome: opResult.success ? 'succeeded' : 'failed',
      failureReason: opResult.error,
      executionId,
      source: '/go'
    }).catch(() => {});

    if (opResult.success) {
      executionContext.targetCache.set('last_action', {
        action: interpreted.intent,
        targetRef: interpreted.targetRef,
        ...interpreted.args
      });
    }

    if (!opResult.success) {
      ExperienceStore.recordExecution({
        executionId,
        guildId: guild.id,
        userId: interaction.user.id,
        userPrompt,
        normalizedIntent: interpreted.intent,
        plan: { actions: [actionObj] },
        capabilities: [interpreted.intent],
        outcome: 'failed',
        errorMessage: opResult.error,
        verificationEvidence: opResult.error,
        latencyMs: Date.now() - (executionContext.startTime || Date.now())
      });

      if (opResult.isAmbiguous) {
        return await interaction.editReply({
          content: `❓ **Clarification Needed:**\n${opResult.error}\n\n*Please specify the user ID or exact mention.*`,
          embeds: [],
          components: []
        });
      }
      const errorEmbed = createErrorEmbed(new Error(opResult.error || 'Operation failed'), executionId);
      const feedbackRow = buildFeedbackRow(executionId);
      return await interaction.editReply({ content: '', embeds: [errorEmbed], components: [feedbackRow] });
    }

    // Format concise outcome message (premium minimal UX with verified smart mentions)
    const outcomeMessage = formatSingleOutcome(interpreted.intent, opResult, {
      ...interpreted.args,
      ...opResult,
      targetRef: interpreted.targetRef,
      name: interpreted.args?.name
    });

    ExperienceStore.recordExecution({
      executionId,
      guildId: guild.id,
      userId: interaction.user.id,
      userPrompt,
      normalizedIntent: interpreted.intent,
      plan: { actions: [actionObj] },
      capabilities: [interpreted.intent],
      outcome: 'succeeded',
      verificationEvidence: outcomeMessage,
      latencyMs: Date.now() - (executionContext.startTime || Date.now())
    });

    if (opResult.success && guild) {
      if (interpreted.intent === 'create_role') {
        defaultConversationMemoryManager.recordEntity(guild.id, 'role', {
          id: opResult.resourceId,
          name: interpreted.args?.name || interpreted.targetRef,
          color: interpreted.args?.color
        });
      } else if (interpreted.intent === 'create_channel') {
        defaultConversationMemoryManager.recordEntity(guild.id, 'channel', {
          id: opResult.resourceId,
          name: interpreted.args?.name || interpreted.targetRef
        });
      }
      defaultConversationMemoryManager.recordAction(guild.id, {
        action: interpreted.intent,
        targetRef: interpreted.targetRef,
        outcome: 'succeeded'
      });
      defaultConversationMemoryManager.recordBotResponse(
        guild.id,
        interaction.user.id,
        interaction.channel?.id,
        outcomeMessage,
        { action: interpreted.intent, outcome: 'succeeded' }
      );
    }

    const resultEmbeds = opResult.embeds || (opResult.embed ? [opResult.embed] : []);
    const feedbackRow = buildFeedbackRow(executionId);
    const replyMsg = await interaction.editReply({
      content: outcomeMessage,
      embeds: resultEmbeds,
      components: [feedbackRow],
      allowedMentions: ResponseService.getAllowedMentions()
    }).catch(async (editErr) => {
      // If the interaction message was deleted in a bulk purge, post directly to channel
      if (editErr?.code === 10008 || editErr?.message?.includes('Unknown Message')) {
        return await interaction.channel?.send({
          content: outcomeMessage,
          allowedMentions: ResponseService.getAllowedMentions()
        }).catch(() => null);
      }
      return null;
    });

    // If purge was successful, schedule auto-deletion of bot confirmation after 7 seconds
    if (interpreted.intent === 'purge_messages' && opResult.success && replyMsg) {
      TemporaryFeedback.scheduleDeletion(replyMsg, 7000);
    }

  } catch (err) {
    isDone = true;
    if (timeoutGuard) clearTimeout(timeoutGuard);
    logger.error(`Error in /go command [${executionId}]`, { error: err.message, stack: err.stack });
    const errorEmbed = createErrorEmbed(err, executionId);
    if (interaction.deferred) {
      await interaction.editReply({
        content: '',
        embeds: [errorEmbed],
        components: []
      }).catch(async () => {
        await interaction.followUp({ embeds: [errorEmbed], ephemeral: true }).catch(() => {});
      });
    } else if (!interaction.replied) {
      await interaction.reply({ embeds: [errorEmbed], ephemeral: true }).catch(() => {});
    }
  } finally {
    if (isDone && timeoutGuard) clearTimeout(timeoutGuard);
  }
}

/**
 * Handles the /modlog command for natural-language moderation log management.
 */
async function handleModlogCommand(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply();
    }
    const guild = interaction.guild;
    const member = interaction.member;
    const prompt = interaction.options?.getString ? interaction.options.getString('prompt') : '';

    // 1. Authorization check: Administrator or ManageGuild or Guild Owner
    const isAuthorized = member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.permissions.has(PermissionFlagsBits.ManageGuild) ||
      member.id === guild.ownerId;

    if (!isAuthorized) {
      return await interaction.editReply({
        content: 'Unauthorized: Moderation log configuration requires Administrator or Manage Server permissions.'
      });
    }

  // 2. Natural language interpretation
  const interpreted = await modlogInterpreter.interpret(prompt);

  // Check out-of-scope requests (e.g. general moderation mutations that belong to /go)
  if (interpreted.intent === 'out_of_scope') {
    return await interaction.editReply({
      content: interpreted.explanation || 'This request belongs to /go. /modlog is specifically for configuring, verifying, testing, and troubleshooting moderation logging.'
    });
  }

  // Check clarification
  if (interpreted.intent === 'clarification_needed') {
    return await interaction.editReply({
      content: interpreted.clarificationQuestion
    });
  }

  // 3. Dispatch operation
  switch (interpreted.intent) {
    case 'inspect_config': {
      const conf = ModLogService.getConfig(guild.id);
      if (!conf || (!conf.channelId && !conf.honeypotLogChannelId && !conf.botLogChannelId)) {
        return await interaction.editReply({
          content: 'No mod-log channel is configured for this server.'
        });
      }

      if (conf.honeypotLogChannelId || conf.botLogChannelId) {
        const modCh = (conf.modLogChannelId || conf.channelId) ? ResponseService.formatChannelMention(conf.modLogChannelId || conf.channelId, conf.modLogChannelName || conf.channelName) : 'Not configured';
        const hpCh = conf.honeypotLogChannelId ? ResponseService.formatChannelMention(conf.honeypotLogChannelId, conf.honeypotLogChannelName) : 'Not configured';
        const botCh = conf.botLogChannelId ? ResponseService.formatChannelMention(conf.botLogChannelId, conf.botLogChannelName) : 'Not configured';

        const embed = new EmbedBuilder()
          .setTitle('Logging Architecture Configuration')
          .setColor(0xE5A93C)
          .setDescription(`Honey Bot Three-Channel Logging configuration for **${guild.name}**:`)
          .addFields(
            { name: '1. Moderation Logs (#mod-logs)', value: `• Destination: ${modCh}\n• Policy: Permanent moderation audit trail\n• Status: ${conf.enabled ? 'Active' : 'Disabled'}`, inline: false },
            { name: '2. Honeypot Logs (#honeypot-logs)', value: `• Destination: ${hpCh}\n• Retention: ${conf.honeypotRetentionHours || 24} hours (Automatic cleanup)\n• Status: ${conf.honeypotLogChannelId ? 'Active' : 'Not configured'}`, inline: false },
            { name: '3. Bot Operations (#bot-logs)', value: `• Destination: ${botCh}\n• Scope: Operations, server changes, health alerts\n• Status: ${conf.botLogChannelId ? 'Active' : 'Not configured'}`, inline: false }
          )
          .setTimestamp();

        return await interaction.editReply({
          embeds: [embed],
          allowedMentions: ResponseService.getAllowedMentions()
        });
      }

      if (!conf.enabled) {
        return await interaction.editReply({
          content: 'Mod logging is disabled for this server. The previous channel configuration has been preserved.',
          allowedMentions: ResponseService.getAllowedMentions()
        });
      }

      const chMention = ResponseService.formatChannelMention(conf.channelId, conf.channelName);
      let msg = `Mod logging is configured for ${chMention}. The channel is accessible and delivery is enabled.`;
      if (conf.lastDeliveryFailure) {
        msg += ` Note: Last delivery failure: ${conf.lastDeliveryFailure.error}`;
      }
      return await interaction.editReply({
        content: msg,
        allowedMentions: ResponseService.getAllowedMentions()
      });
    }

    case 'configure_honeypot_channel': {
      let hpTargetRef = interpreted.targetChannel;
      if (hpTargetRef === 'current' || !hpTargetRef) {
        hpTargetRef = interaction.channelId;
      }
      const hpRes = await ModLogService.setHoneypotLogChannel(guild, hpTargetRef, interaction.user.tag);
      if (!hpRes.success) {
        return await interaction.editReply({
          content: `Couldn't configure honeypot-log channel: ${hpRes.error}`,
          allowedMentions: ResponseService.getAllowedMentions()
        });
      }
      const hpMention = ResponseService.formatChannelMention(hpRes.channel?.id, hpRes.channel?.name);
      return await interaction.editReply({
        content: `Honeypot security logging configured for ${hpMention}. Temporary evidence will be retained for ${hpRes.config.honeypotRetentionHours || 24} hours.`,
        allowedMentions: ResponseService.getAllowedMentions()
      });
    }

    case 'configure_bot_channel': {
      let botTargetRef = interpreted.targetChannel;
      if (botTargetRef === 'current' || !botTargetRef) {
        botTargetRef = interaction.channelId;
      }
      const botRes = await ModLogService.setBotLogChannel(guild, botTargetRef, interaction.user.tag);
      if (!botRes.success) {
        return await interaction.editReply({
          content: `Couldn't configure bot-log channel: ${botRes.error}`,
          allowedMentions: ResponseService.getAllowedMentions()
        });
      }
      const botMention = ResponseService.formatChannelMention(botRes.channel?.id, botRes.channel?.name);
      return await interaction.editReply({
        content: `Bot operations logging configured for ${botMention}. Routine resource changes and system health alerts will be recorded here.`,
        allowedMentions: ResponseService.getAllowedMentions()
      });
    }

    case 'configure_honeypot_retention': {
      const retRes = ModLogService.setHoneypotRetention(guild.id, interpreted.retentionHours, interaction.user.tag);
      return await interaction.editReply({
        content: `Honeypot log retention set to ${retRes.retentionHours} hours. Expired security evidence will be automatically cleaned up while permanent moderation logs are preserved.`,
        allowedMentions: ResponseService.getAllowedMentions()
      });
    }

    case 'test_all_channels': {
      const allRes = await ModLogService.testAllChannels(guild);
      const conf = ModLogService.getConfig(guild.id);
      const modStatus = allRes.results.moderation.success ? '✅ Verified Operational' : `❌ ${allRes.results.moderation.error || 'Failed'}`;
      const hpStatus = conf.honeypotLogChannelId ? (allRes.results.honeypot.success ? '✅ Verified Operational' : `❌ ${allRes.results.honeypot.error}`) : '⚠️ Unconfigured';
      const botStatus = conf.botLogChannelId ? (allRes.results.botOperations.success ? '✅ Verified Operational' : `❌ ${allRes.results.botOperations.error}`) : '⚠️ Unconfigured';

      const embed = new EmbedBuilder()
        .setTitle('Three-Channel Logging Test Results')
        .setColor(allRes.success ? 0x2ECC71 : 0xE74C3C)
        .addFields(
          { name: '1. Moderation Logs (#mod-logs)', value: `• Destination: ${conf.modLogChannelId || conf.channelId ? `<#${conf.modLogChannelId || conf.channelId}>` : 'None'}\n• Result: ${modStatus}`, inline: false },
          { name: '2. Honeypot Logs (#honeypot-logs)', value: `• Destination: ${conf.honeypotLogChannelId ? `<#${conf.honeypotLogChannelId}>` : 'None'}\n• Result: ${hpStatus}`, inline: false },
          { name: '3. Bot Operations (#bot-logs)', value: `• Destination: ${conf.botLogChannelId ? `<#${conf.botLogChannelId}>` : 'None'}\n• Result: ${botStatus}`, inline: false }
        )
        .setTimestamp();

      return await interaction.editReply({
        embeds: [embed],
        allowedMentions: ResponseService.getAllowedMentions()
      });
    }

    case 'setup_logging': {
      const targetRef = interpreted.targetChannel;
      const res = await ModLogService.setupModlogs(guild, {
        channelName: targetRef || 'mod-logs',
        createIfMissing: true,
        userTagOrId: interaction.user.tag,
        testDelivery: true
      });

      if (!res.success) {
        return await interaction.editReply({
          content: `Couldn't complete mod-logs setup: ${res.error}`,
          allowedMentions: ResponseService.getAllowedMentions()
        });
      }

      const chMention = ResponseService.formatChannelMention(res.channel?.id, res.channel?.name);
      return await interaction.editReply({
        content: `Mod logging is configured for ${chMention}. The channel was created/verified, and the test entry was delivered.`,
        allowedMentions: ResponseService.getAllowedMentions()
      });
    }

    case 'update_filter': {
      const updates = {};
      if (interpreted.filterEvents) updates.filterEvents = interpreted.filterEvents;
      if (interpreted.logSuccess !== undefined) updates.logSuccess = interpreted.logSuccess;
      if (interpreted.logFailed !== undefined) updates.logFailed = interpreted.logFailed;
      if (interpreted.logDenied !== undefined) updates.logDenied = interpreted.logDenied;

      const res = ModLogService.updatePreferences(guild.id, updates, interaction.user.tag);
      const conf = res.config;
      const chMention = conf.channelId ? ResponseService.formatChannelMention(conf.channelId, conf.channelName) : 'none';
      let details = `Updated moderation log preferences for this server.\n• **Destination:** ${chMention}\n• **Filter Events:** ${conf.preferences.filterEvents.join(', ')}\n• **Log Success:** ${conf.preferences.logSuccess}\n• **Log Failed:** ${conf.preferences.logFailed}\n• **Log Denied:** ${conf.preferences.logDenied}\n• **Revision:** ${conf.revision}`;

      return await interaction.editReply({
        content: details,
        allowedMentions: ResponseService.getAllowedMentions()
      });
    }

    case 'configure_channel': {
      let targetRef = interpreted.targetChannel;
      if (targetRef === 'current' || !targetRef) {
        targetRef = interaction.channelId;
      }

      const res = await ModLogService.setLogChannel(guild, targetRef, interaction.user.tag);
      if (!res.success) {
        return await interaction.editReply({
          content: `Couldn't configure mod-log channel: ${res.error}`,
          allowedMentions: ResponseService.getAllowedMentions()
        });
      }

      const chMention = ResponseService.formatChannelMention(res.channel?.id, res.channel?.name);
      if (interpreted.testAfterConfig) {
        const testRes = await ModLogService.testLogChannel(guild);
        if (testRes.success) {
          return await interaction.editReply({
            content: `Mod logging is configured for ${chMention}. The channel is accessible, and the test entry was delivered.`,
            allowedMentions: ResponseService.getAllowedMentions()
          });
        } else {
          return await interaction.editReply({
            content: `The channel was updated, but delivery could not be verified. The saved configuration is ${chMention}.`,
            allowedMentions: ResponseService.getAllowedMentions()
          });
        }
      }

      return await interaction.editReply({
        content: `Mod logging is configured for ${chMention}.`,
        allowedMentions: ResponseService.getAllowedMentions()
      });
    }

    case 'test_channel': {
      const conf = ModLogService.getConfig(guild.id);
      if (!conf || !conf.channelId) {
        return await interaction.editReply({
          content: 'No mod-log channel is configured for this server.',
          allowedMentions: ResponseService.getAllowedMentions()
        });
      }

      const testRes = await ModLogService.testLogChannel(guild);
      const chMention = ResponseService.formatChannelMention(testRes.channel?.id || conf.channelId, testRes.channel?.name || conf.channelName);
      if (testRes.success) {
        return await interaction.editReply({
          content: `Mod logging is configured for ${chMention}. The channel is accessible, and the test entry was delivered.`,
          allowedMentions: ResponseService.getAllowedMentions()
        });
      } else {
        if (testRes.error?.includes('SendMessages') || testRes.error?.includes('permission')) {
          return await interaction.editReply({
            content: `The configured channel is ${chMention}, but Honey Bot cannot send messages there. Grant the bot Send Messages permission and try again.`,
            allowedMentions: ResponseService.getAllowedMentions()
          });
        }
        return await interaction.editReply({
          content: `Moderation log test failed: ${testRes.error}`,
          allowedMentions: ResponseService.getAllowedMentions()
        });
      }
    }

    case 'enable_logging': {
      const res = await ModLogService.enableLogging(guild, interaction.user.tag);
      if (res.success) {
        const chMention = ResponseService.formatChannelMention(res.channel?.id, res.channel?.name);
        return await interaction.editReply({
          content: `Mod logging is configured for ${chMention}. Delivery is enabled.`,
          allowedMentions: ResponseService.getAllowedMentions()
        });
      } else {
        return await interaction.editReply({
          content: `Couldn't enable logging: ${res.error}`,
          allowedMentions: ResponseService.getAllowedMentions()
        });
      }
    }

    case 'disable_logging': {
      ModLogService.disableLogging(guild.id, interaction.user.tag);
      return await interaction.editReply({
        content: 'Mod logging is disabled for this server. The previous channel configuration has been preserved.',
        allowedMentions: ResponseService.getAllowedMentions()
      });
    }

    case 'troubleshoot_config': {
      const report = await ModLogService.troubleshoot(guild, {
        autoRepair: Boolean(interpreted.repair),
        userTagOrId: interaction.user.tag
      });
      if (interpreted.repair || (report.findings && report.findings.length > 0) || report.pendingCount > 0) {
        const embed = ResponseService.buildModlogReportEmbed(report, guild);
        return await interaction.editReply({
          content: '',
          embeds: [embed],
          allowedMentions: ResponseService.getAllowedMentions()
        });
      }
      return await interaction.editReply({
        content: report.userMessage,
        allowedMentions: ResponseService.getAllowedMentions()
      });
    }

      default: {
        return await interaction.editReply({
          content: 'Could not resolve the mod-log request. You can say "set #channel as log channel", "which channel is configured", "test logging", or "disable logging".',
          allowedMentions: ResponseService.getAllowedMentions()
        });
      }
    }
  } catch (err) {
    logger.error('Error in /modlog command', { error: err.message, stack: err.stack });
    const msg = `❌ **Modlog Error:** ${err.message}`;
    if (interaction.deferred) {
      await interaction.editReply({ content: msg, embeds: [], components: [] }).catch(() => {});
    } else if (!interaction.replied) {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
}

// Register all top-level slash commands with the authoritative CommandRegistry
globalCommandRegistry.registerHandler('go', handleGoCommand, {
  category: 'Administration',
  description: 'Natural-language execution of supported Discord actions',
  timeoutMs: 25000
});

globalCommandRegistry.registerHandler('modlog', handleModlogCommand, {
  category: 'Logging',
  description: 'Natural-language configuration and management of moderation logging',
  timeoutMs: 15000
});

globalCommandRegistry.registerHandler('diagnose', handleDiagnoseCommand, {
  category: 'Maintenance',
  description: 'Health checks, diagnostics, and supported safe repairs',
  timeoutMs: 15000,
  aliases: ['diagnostics', 'audit']
});

globalCommandRegistry.registerHandler('undo', handleUndoCommand, {
  category: 'Safety',
  description: 'Reversal of supported, reversible actions',
  timeoutMs: 15000
});

globalCommandRegistry.registerHandler('help', handleHelpCommand, {
  category: 'Utility',
  description: 'An approachable explanation of Honey Bot and how to use it',
  timeoutMs: 15000
});

globalCommandRegistry.registerHandler('honeypot', handleHoneypotCommand, {
  category: 'Security',
  description: 'Configure, inspect, enable, disable, and safely test honeypot channels',
  timeoutMs: 15000
});

/**
 * Handles the /diagnose command.
 * Flexible, natural-language-driven system diagnostics, model discovery, and safe repairs.
 */
async function handleDiagnoseCommand(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
    }
    const prompt = interaction.options?.getString ? interaction.options.getString('prompt') : null;

    if (prompt && /(?:setup|onboarding|permissions?|install|auth|reauth|oauth)/i.test(prompt)) {
      return await OnboardingManager.openSetupPanel(interaction);
    }

    const result = await DiagnosticService.diagnose(prompt, {
      client: interaction.client,
      guild: interaction.guild,
      member: interaction.member,
      user: interaction.user
    });

    if (result.checks && Object.keys(result.checks).length > 1) {
      const embed = ResponseService.buildDiagnosticEmbed(result, result.correlationId);
      return await interaction.editReply({
        content: '',
        embeds: [embed],
        allowedMentions: ResponseService.getAllowedMentions()
      });
    }

    await interaction.editReply({
      content: result.response,
      allowedMentions: ResponseService.getAllowedMentions()
    });
  } catch (err) {
    logger.error('Error in /diagnose command', { error: err.message, stack: err.stack });
    const msg = `❌ **Diagnostic Error:** ${err.message}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: msg, embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
}

/**
 * Handles the /undo command.
 */
async function handleUndoCommand(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply();
    }

    const guild = interaction.guild;
    const member = interaction.member;
    const prompt = interaction.options?.getString ? interaction.options.getString('prompt') : null;
    const recoveryExecutionId = Logger.generateExecutionId();

  // 1. Target Selection via RecoveryEngine
  const selection = RecoveryEngine.selectTarget(guild.id, prompt, interaction.user);

  // If clarification needed (ambiguity detected)
  if (selection.isAmbiguous) {
    return await interaction.editReply({
      content: selection.clarificationQuestion
    });
  }

  // If listing recent actions
  if (selection.isList) {
    return await interaction.editReply({
      content: selection.text
    });
  }

  // If selection failed with error (e.g. cross-guild error, not found)
  if (selection.error) {
    return await interaction.editReply({
      content: selection.error
    });
  }

  // 2. Handle Multi-Action Plan Recovery
  if (selection.multiActionPlan) {
    const actions = selection.multiActionPlan;
    // Check authorizations & anti-nuke
    for (const act of actions) {
      const auth = RecoveryEngine.checkAuthorization(member, guild, act);
      if (!auth.authorized) {
        return await interaction.editReply({
          content: auth.reason || "I can't perform this recovery with the current permissions."
        });
      }
      const antiNuke = RecoveryEngine.checkAntiNuke(act, guild, member);
      if (!antiNuke.safe) {
        return await interaction.editReply({
          content: antiNuke.reason
        });
      }
    }

    // Consequential confirmation for multi-action recovery
    const confirmed = await ConfirmationManager.requestConfirmation(interaction, {
      thoughtProcess: `Reverse all actions from execution ${selection.executionId}`,
      actions: actions.map(a => ({
        action: `undo_${a.action}`,
        target: a.targetName || a.name || a.targetId
      }))
    });
    if (!confirmed) return;

    // Re-verify authorization upon confirmation
    for (const act of actions) {
      const auth = RecoveryEngine.checkAuthorization(member, guild, act);
      if (!auth.authorized) {
        return await interaction.editReply({
          content: "I can't perform this recovery with the current permissions."
        });
      }
    }

    const multiRes = await RecoveryEngine.executeMultiStepRecovery(guild, actions, interaction.user, recoveryExecutionId);
    return await interaction.editReply({
      content: multiRes.message
    });
  }

  const candidate = selection.candidate;
  if (!candidate) {
    return await interaction.editReply({
      content: 'No recent actions found in this server to undo.'
    });
  }

  // 3. Authorization check on candidate
  const auth = RecoveryEngine.checkAuthorization(member, guild, candidate);
  if (!auth.authorized) {
    await ModLogService.logAction(guild, {
      action: 'undo_recovery',
      actor: interaction.user,
      target: candidate.targetName || candidate.name || candidate.targetId || candidate.action,
      reason: `Unauthorized recovery attempt for ${candidate.action}`,
      outcome: 'denied',
      failureReason: auth.reason,
      executionId: recoveryExecutionId,
      source: '/undo'
    }).catch(() => {});

    return await interaction.editReply({
      content: auth.reason || "I can't perform this recovery with the current permissions."
    });
  }

  // 4. Immutable anti-nuke check
  const antiNuke = RecoveryEngine.checkAntiNuke(candidate, guild, member);
  if (!antiNuke.safe) {
    await ModLogService.logAction(guild, {
      action: 'undo_recovery',
      actor: interaction.user,
      target: candidate.targetName || candidate.name || candidate.targetId || candidate.action,
      reason: `Anti-nuke policy refusal for ${candidate.action}`,
      outcome: 'denied',
      failureReason: antiNuke.reason,
      executionId: recoveryExecutionId,
      source: '/undo'
    }).catch(() => {});

    return await interaction.editReply({
      content: antiNuke.reason
    });
  }

  // 5. Check if confirmation required (e.g. deleting created channel or role)
  const handler = RecoveryRegistry.getHandler(candidate.action || candidate.type);
  if (handler?.requiresConfirmation && candidate.recoveryStatus !== 'succeeded') {
    const inverseName = candidate.action === 'create_channel' ? 'delete_channel' : (candidate.action === 'create_role' ? 'delete_role' : `undo_${candidate.action}`);
    const confirmed = await ConfirmationManager.requestConfirmation(interaction, {
      thoughtProcess: `Reverse ${candidate.action} and remove created resource ${candidate.targetName || candidate.name || ''}`,
      actions: [{
        action: inverseName,
        targetChannel: candidate.targetId,
        targetRole: candidate.targetId
      }]
    });
    if (!confirmed) return;

    // Re-verify authorization upon confirmation
    const reAuth = RecoveryEngine.checkAuthorization(member, guild, candidate);
    if (!reAuth.authorized) {
      return await interaction.editReply({
        content: "I can't perform this recovery with the current permissions."
      });
    }
  }

    // 6. Execute Recovery
    const result = await RecoveryEngine.executeRecovery(guild, candidate, interaction.user, recoveryExecutionId);
    return await interaction.editReply({
      content: result.message,
      allowedMentions: ResponseService.getAllowedMentions()
    });
  } catch (err) {
    logger.error('Error in /undo command', { error: err.message, stack: err.stack });
    const msg = `❌ **Undo Error:** ${err.message}`;
    if (interaction.deferred) {
      await interaction.editReply({ content: msg, embeds: [], components: [] }).catch(() => {});
    } else if (!interaction.replied) {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
}

// Register all top-level slash commands with the authoritative CommandRegistry
globalCommandRegistry.registerHandler('go', handleGoCommand, {
  category: 'Administration',
  description: 'Natural-language execution of supported Discord actions',
  timeoutMs: 25000
});

globalCommandRegistry.registerHandler('modlog', handleModlogCommand, {
  category: 'Logging',
  description: 'Natural-language configuration and management of moderation logging',
  timeoutMs: 15000
});

globalCommandRegistry.registerHandler('diagnose', handleDiagnoseCommand, {
  category: 'Maintenance',
  description: 'Health checks, diagnostics, and supported safe repairs',
  timeoutMs: 15000,
  aliases: ['diagnostics', 'audit']
});

globalCommandRegistry.registerHandler('undo', handleUndoCommand, {
  category: 'Safety',
  description: 'Reversal of supported, reversible actions',
  timeoutMs: 15000
});

globalCommandRegistry.registerHandler('help', handleHelpCommand, {
  category: 'Utility',
  description: 'An approachable explanation of Honey Bot and how to use it',
  timeoutMs: 15000
});

globalCommandRegistry.registerHandler('honeypot', handleHoneypotCommand, {
  category: 'Security',
  description: 'Configure, inspect, enable, disable, and safely test honeypot channels',
  timeoutMs: 15000
});

/**
 * Handles the /help command.
 */
async function handleHelpCommand(interaction) {
  try {
    const prompt = interaction.options?.getString ? interaction.options.getString('prompt') : null;

    if (!prompt || !prompt.trim()) {
      const embed = HelpManager.createHelpEmbed();
      const openDashRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('dash:open:overview')
          .setLabel('Open Server Dashboard')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('📊')
      );
      if (interaction.deferred) {
        return await interaction.editReply({
          embeds: [embed],
          components: [openDashRow],
          allowedMentions: ResponseService.getAllowedMentions()
        });
      }
      return await interaction.reply({
        embeds: [embed],
        components: [openDashRow],
        allowedMentions: ResponseService.getAllowedMentions()
      });
    }

    // Direct dashboard routing via /help prompt: dashboard
    if (/^(?:open\s+)?(?:server\s+)?(?:dashboard|settings|config(?:\s+center)?|control\s+panel)$/i.test(prompt.trim())) {
      return await DashboardManager.openDashboard(interaction);
    }

    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply();
    }
    const answer = await HelpManager.answerQuestion(prompt);
    const chunks = ResponseService.splitMessage(answer, 2000);
    await interaction.editReply({
      content: chunks[0],
      allowedMentions: ResponseService.getAllowedMentions()
    });
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp({
        content: chunks[i],
        allowedMentions: ResponseService.getAllowedMentions()
      }).catch(() => {});
    }
  } catch (err) {
    logger.error('Error in /help command', { error: err.message, stack: err.stack });
    const msg = `❌ **Help Error:** ${err.message}`;
    if (interaction.deferred) {
      await interaction.editReply({ content: msg, embeds: [], components: [] }).catch(() => {});
    } else if (!interaction.replied) {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
}

// Register all top-level slash commands with the authoritative CommandRegistry
globalCommandRegistry.registerHandler('go', handleGoCommand, {
  category: 'Administration',
  description: 'Natural-language execution of supported Discord actions',
  timeoutMs: 25000
});

globalCommandRegistry.registerHandler('modlog', handleModlogCommand, {
  category: 'Logging',
  description: 'Natural-language configuration and management of moderation logging',
  timeoutMs: 15000
});

globalCommandRegistry.registerHandler('diagnose', handleDiagnoseCommand, {
  category: 'Maintenance',
  description: 'Health checks, diagnostics, and supported safe repairs',
  timeoutMs: 15000,
  aliases: ['diagnostics', 'audit']
});

globalCommandRegistry.registerHandler('undo', handleUndoCommand, {
  category: 'Safety',
  description: 'Reversal of supported, reversible actions',
  timeoutMs: 15000
});

globalCommandRegistry.registerHandler('help', handleHelpCommand, {
  category: 'Utility',
  description: 'An approachable explanation of Honey Bot and how to use it',
  timeoutMs: 15000
});

globalCommandRegistry.registerHandler('honeypot', handleHoneypotCommand, {
  category: 'Security',
  description: 'Configure, inspect, enable, disable, and safely test honeypot channels',
  timeoutMs: 15000
});

/**
 * Handles the /honeypot slash command and its subcommands:
 * setup, enable, disable, status, configure, test.
 */
export async function handleHoneypotCommand(interaction) {
  try {
    const guild = interaction.guild;
    const member = interaction.member;

    // Authorization Check: Administrator or ManageGuild
    const isAuthorized = member && (
      member.id === guild.ownerId ||
      member.permissions?.has(PermissionFlagsBits.Administrator) ||
      member.permissions?.has(PermissionFlagsBits.ManageGuild)
    );

    if (!isAuthorized) {
      const msg = '⛔ **Access Denied:** Only server administrators can configure or manage honeypot protection.';
      if (interaction.deferred) {
        return await interaction.editReply({ content: msg });
      }
      return await interaction.reply({ content: msg, ephemeral: true });
    }

    const subcommand = interaction.options?.getSubcommand ? interaction.options.getSubcommand() : 'status';

    // 1. /honeypot status
    if (subcommand === 'status') {
      const config = HoneypotService.getConfig(guild.id);
      const embed = HoneypotService.buildStatusEmbed(guild, config);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`honeypot:toggle_active:${guild.id}`)
          .setLabel(config.enabled ? 'Disable' : 'Enable')
          .setStyle(config.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`honeypot:refresh:${guild.id}`)
          .setLabel('Configure')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('⚙️'),
        new ButtonBuilder()
          .setCustomId(`honeypot:test:${guild.id}`)
          .setLabel('Test')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('🩺')
      );

      if (interaction.deferred) {
        return await interaction.editReply({ embeds: [embed], components: [row] });
      }
      return await interaction.reply({ embeds: [embed], components: [row] });
    }

    // 2. /honeypot configure
    if (subcommand === 'configure') {
      const payload = HoneypotService.buildConfigurationPanelPayload(guild, member);
      if (interaction.deferred) {
        return await interaction.editReply(payload);
      }
      return await interaction.reply(payload);
    }

    // 3. /honeypot setup
    if (subcommand === 'setup') {
      const selectedChannel = interaction.options?.getChannel ? interaction.options.getChannel('channel') : null;
      const action = interaction.options?.getString ? interaction.options.getString('action') : null;
      const mode = interaction.options?.getString ? interaction.options.getString('mode') : null;

      const isStrictModeRequested = mode === 'strict';
      const shouldCreateChannel = action === 'create_channel' || (!selectedChannel && !HoneypotService.getConfig(guild.id).channelId);

      const setupRes = await HoneypotService.setupHoneypot(guild, {
        channelId: selectedChannel?.id || null,
        createChannel: shouldCreateChannel,
        strictMode: false // Pending explicit confirmation if strict requested
      });

      if (isStrictModeRequested) {
        const warningEmbed = HoneypotService.buildStrictWarningEmbed(guild);
        const confirmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`honeypot:confirm_strict:${guild.id}`)
            .setLabel('Confirm & Activate Strict Mode')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('⚠️'),
          new ButtonBuilder()
            .setCustomId(`honeypot:cancel_strict:${guild.id}`)
            .setLabel('Cancel / Monitored Only')
            .setStyle(ButtonStyle.Secondary)
        );

        if (interaction.deferred) {
          return await interaction.editReply({
            content: `✅ Honeypot channel configured (${setupRes.details}).\n⚠️ **Action Required to Activate Strict Mode:**`,
            embeds: [warningEmbed],
            components: [confirmRow]
          });
        }
        return await interaction.reply({
          content: `✅ Honeypot channel configured (${setupRes.details}).\n⚠️ **Action Required to Activate Strict Mode:**`,
          embeds: [warningEmbed],
          components: [confirmRow]
        });
      }

      const payload = HoneypotService.buildConfigurationPanelPayload(guild, member);
      if (interaction.deferred) {
        return await interaction.editReply(payload);
      }
      return await interaction.reply(payload);
    }

    // 4. /honeypot enable
    if (subcommand === 'enable') {
      const enableRes = await HoneypotService.enableHoneypot(guild, interaction.user);
      if (!enableRes.success && enableRes.requiresConfirmation) {
        const warningEmbed = HoneypotService.buildStrictWarningEmbed(guild);
        const confirmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`honeypot:confirm_strict:${guild.id}`)
            .setLabel('Confirm & Activate Strict Mode')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('⚠️'),
          new ButtonBuilder()
            .setCustomId(`honeypot:cancel_strict:${guild.id}`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
        );

        if (interaction.deferred) {
          return await interaction.editReply({ embeds: [warningEmbed], components: [confirmRow] });
        }
        return await interaction.reply({ embeds: [warningEmbed], components: [confirmRow] });
      }

      if (!enableRes.success) {
        const msg = `❌ **Could Not Enable Honeypot:** ${enableRes.error}`;
        if (interaction.deferred) {
          return await interaction.editReply({ content: msg });
        }
        return await interaction.reply({ content: msg, ephemeral: true });
      }

      const payload = HoneypotService.buildConfigurationPanelPayload(guild, member);
      if (interaction.deferred) {
        return await interaction.editReply({ content: `✅ ${enableRes.details}`, ...payload });
      }
      return await interaction.reply({ content: `✅ ${enableRes.details}`, ...payload });
    }

    // 5. /honeypot disable
    if (subcommand === 'disable') {
      const disableRes = await HoneypotService.disableHoneypot(guild);
      const payload = HoneypotService.buildConfigurationPanelPayload(guild, member);
      if (interaction.deferred) {
        return await interaction.editReply({ content: `✅ ${disableRes.details}`, ...payload });
      }
      return await interaction.reply({ content: `✅ ${disableRes.details}`, ...payload });
    }

    // 6. /honeypot test
    if (subcommand === 'test') {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply();
      }
      const testRes = await HoneypotService.runDiagnosticTest(guild, interaction.user);
      return await interaction.editReply({ embeds: [testRes.embed] });
    }
  } catch (err) {
    logger.error('Error in /honeypot command', { error: err.message, stack: err.stack });
    const msg = `❌ **Honeypot Command Error:** ${err.message}`;
    if (interaction.deferred) {
      await interaction.editReply({ content: msg, embeds: [], components: [] }).catch(() => {});
    } else if (!interaction.replied) {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
}

// Register all top-level slash commands with the authoritative CommandRegistry
globalCommandRegistry.registerHandler('go', handleGoCommand, {
  category: 'Administration',
  description: 'Natural-language execution of supported Discord actions',
  timeoutMs: 25000
});

globalCommandRegistry.registerHandler('modlog', handleModlogCommand, {
  category: 'Logging',
  description: 'Natural-language configuration and management of moderation logging',
  timeoutMs: 15000
});

globalCommandRegistry.registerHandler('diagnose', handleDiagnoseCommand, {
  category: 'Maintenance',
  description: 'Health checks, diagnostics, and supported safe repairs',
  timeoutMs: 15000,
  aliases: ['diagnostics', 'audit']
});

globalCommandRegistry.registerHandler('undo', handleUndoCommand, {
  category: 'Safety',
  description: 'Reversal of supported, reversible actions',
  timeoutMs: 15000
});

globalCommandRegistry.registerHandler('help', handleHelpCommand, {
  category: 'Utility',
  description: 'An approachable explanation of Honey Bot and how to use it',
  timeoutMs: 15000
});

globalCommandRegistry.registerHandler('honeypot', handleHoneypotCommand, {
  category: 'Security',
  description: 'Configure, inspect, enable, disable, and safely test honeypot channels',
  timeoutMs: 15000
});
