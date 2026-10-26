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
import { Logger } from './logger.js';

const logger = new Logger('Commands');
const planner = new Planner();
const intentRouter = new IntentRouter();
const modlogInterpreter = new ModlogInterpreter();

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
    )
];

/**
 * Slash command execution router.
 */
export async function handleCommandInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  if (!interaction.guild) {
    return await interaction.reply({
      content: 'Honey Bot administration commands must be run inside a Discord server, not in Direct Messages.',
      ephemeral: true
    }).catch(() => {});
  }

  const { commandName } = interaction;

  try {
    if (commandName === 'go') {
      await handleGoCommand(interaction);
    } else if (commandName === 'modlog') {
      await handleModlogCommand(interaction);
    } else if (commandName === 'diagnose' || commandName === 'diagnostics' || commandName === 'audit') {
      await handleDiagnoseCommand(interaction);
    } else if (commandName === 'undo') {
      await handleUndoCommand(interaction);
    } else if (commandName === 'help') {
      await handleHelpCommand(interaction);
    } else {
      logger.warn(`Unknown command received: ${commandName}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: `❌ Unknown command \`/${commandName}\`. Use \`/help\` or \`/go\` to interact with Honey Bot.`,
          ephemeral: true
        }).catch(() => {});
      }
    }
  } catch (err) {
    logger.error(`Error in handleCommandInteraction for /${commandName}`, { error: err.message, stack: err.stack });
    const content = `❌ **Error:** An error occurred while executing \`/${commandName}\`: ${err.message}`;
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

    const guild = interaction.guild;
    const member = interaction.member;

    // Create lightweight execution context and workflow tracker
    const executionContext = new ExecutionContext(interaction, executionId);
    const workflow = new TaskWorkflow(executionId, userPrompt, executionContext);

    logger.info(`Received /go command [${executionId}]`, { user: interaction.user?.tag, prompt: userPrompt });

    // Immutable Security Policy Gate: Pre-flight prompt inspection
    try {
      SecurityGate.evaluatePromptSecurity(userPrompt, interaction.user.id, guild);
    } catch (secErr) {
      isDone = true;
      logger.warn('Prompt rejected by Security Gate', { error: secErr.message });
      return await interaction.editReply({
        content: `🛑 **Security Refusal:** ${secErr.message}`
      });
    }

    // Hard safety timeout guard so interaction is never left stranded
    timeoutGuard = setTimeout(async () => {
      if (isDone) return;
      try {
        await interaction.editReply({
          content: '⏳ **Operation Timed Out:** The request took longer than expected to process. Please try again.',
          embeds: [],
          components: []
        });
      } catch {}
    }, 25000);

    // Phase 1: Intent Routing (Fast-path deterministic or single compact model call)
    const interpreted = await intentRouter.route(userPrompt, executionContext, workflow.budget);

    // Check if clarification is needed
    if (interpreted.clarificationNeeded) {
      isDone = true;
      clearTimeout(timeoutGuard);
      return await interaction.editReply({
        content: `❓ **Clarification Needed:**\n${interpreted.clarificationNeeded}\n\n*Please run \`/go\` again with more details.*`
      });
    }

    // Check if user requested the server dashboard
    if (interpreted.intent === 'open_dashboard') {
      isDone = true;
      clearTimeout(timeoutGuard);
      const dashboardPayload = await DashboardManager.buildDashboardPayload(guild, member, interaction.user, 'overview');
      return await interaction.editReply({
        content: '',
        embeds: dashboardPayload.embeds || [],
        components: dashboardPayload.components || []
      });
    }

    // Check if conversational / greeting / advice
    if (interpreted.conversationalResponse) {
      isDone = true;
      clearTimeout(timeoutGuard);
      const refinedContent = formatRefinedResponse(interpreted.conversationalResponse);
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

    // Phase 1.5: Deterministic Request-Completeness & Target-Safety Gate
    let actionsToVerify = [];
    if (interpreted.multiActions && interpreted.multiActions.length > 0) {
      actionsToVerify = interpreted.multiActions;
    } else if (interpreted.intent) {
      actionsToVerify = [{
        action: interpreted.intent,
        targetChannel: interpreted.targetRef,
        targetRole: interpreted.targetRef,
        targetMember: interpreted.targetRef,
        targetRef: interpreted.targetRef,
        ...interpreted.args
      }];
    }

    const checkResult = CompletenessChecker.verify(userPrompt, {
      thoughtProcess: interpreted.thought || 'Administrative operation',
      isHighImpact: Boolean(interpreted.isHighImpact),
      actions: actionsToVerify
    }, executionContext);

    if (!checkResult.valid) {
      isDone = true;
      clearTimeout(timeoutGuard);
      return await interaction.editReply({
        content: `⚠️ **Request Incomplete or Invalid:**\n${checkResult.errors.join('\n')}\n\n*Please specify the missing details or targets.*`
      });
    }

    const repairedPlan = checkResult.repairedPlan;
    if (repairedPlan.actions.length > 1) {
      interpreted.multiActions = repairedPlan.actions;
      interpreted.thought = repairedPlan.thoughtProcess;
      interpreted.isHighImpact = repairedPlan.isHighImpact;
    } else if (repairedPlan.actions.length === 1) {
      delete interpreted.multiActions;
      const act = repairedPlan.actions[0];
      interpreted.intent = act.action;
      if (act.action === 'assign_role' || act.action === 'remove_role') {
        interpreted.targetRef = act.targetMember || act.targetRole || act.targetRef;
      } else {
        interpreted.targetRef = act.targetRole || act.targetChannel || act.targetMember || act.targetRef;
      }
      interpreted.args = { ...act };
    }

    // Phase 2: Check if multi-step complex plan or single-step direct operation
    if (interpreted.multiActions && interpreted.multiActions.length > 0) {
      // Multi-step path: create plan and execute
      const plan = {
        thoughtProcess: interpreted.thought,
        clarificationNeeded: null,
        isHighImpact: interpreted.isHighImpact,
        actions: interpreted.multiActions
      };

      const userAuth = checkUserAuthorization(member, plan.actions);
      if (!userAuth.authorized) {
        isDone = true;
        clearTimeout(timeoutGuard);
        return await interaction.editReply({ content: `🛑 **Unauthorized:** ${userAuth.reason}` });
      }

      const botAuth = checkBotPermissions(guild, plan.actions);
      if (!botAuth.capable) {
        isDone = true;
        clearTimeout(timeoutGuard);
        return await interaction.editReply({ content: `⚠️ **Bot Permission Error:** ${botAuth.reason}` });
      }

      // Immutable Security Gate check on entire planned action sequence
      try {
        SecurityGate.evaluateActionSequence(plan.actions, member, guild);
      } catch (secErr) {
        isDone = true;
        clearTimeout(timeoutGuard);
        return await interaction.editReply({ content: `🛑 **Security Refusal:** ${secErr.message}` });
      }

      if (plan.isHighImpact) {
        clearTimeout(timeoutGuard);
        const confirmed = await ConfirmationManager.requestConfirmation(interaction, plan);
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
        plan,
        actions: plan.actions,
        isHighImpact: plan.isHighImpact,
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

      const reportEmbed = Verifier.generateReportEmbed(plan, results, executionId);
      const summaryText = formatMultiActionSummary(results);
      return await interaction.editReply({
        content: summaryText,
        embeds: [reportEmbed],
        components: [],
        allowedMentions: ResponseService.getAllowedMentions()
      });
    }

    // Phase 3: Minimal Execution Path (Single-Resource Targeted Operation)
    const actionObj = {
      action: interpreted.intent,
      targetChannel: interpreted.targetRef,
      targetRole: interpreted.targetRef,
      targetMember: interpreted.targetRef,
      ...interpreted.args
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
      if (opResult.isAmbiguous) {
        return await interaction.editReply({
          content: `❓ **Clarification Needed:**\n${opResult.error}\n\n*Please specify the user ID or exact mention.*`,
          embeds: [],
          components: []
        });
      }
      const errorEmbed = createErrorEmbed(new Error(opResult.error || 'Operation failed'), executionId);
      return await interaction.editReply({ content: '', embeds: [errorEmbed], components: [] });
    }

    // Format concise outcome message (premium minimal UX with verified smart mentions)
    const outcomeMessage = formatSingleOutcome(interpreted.intent, opResult, {
      ...interpreted.args,
      ...opResult,
      targetRef: interpreted.targetRef,
      name: interpreted.args?.name
    });

    const resultEmbeds = opResult.embeds || (opResult.embed ? [opResult.embed] : []);
    const replyMsg = await interaction.editReply({
      content: outcomeMessage,
      embeds: resultEmbeds,
      components: [],
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
      if (!conf || !conf.channelId) {
        return await interaction.editReply({
          content: 'No mod-log channel is configured for this server.'
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
