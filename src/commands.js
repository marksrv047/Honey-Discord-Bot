import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { Planner } from './planner.js';
import { Executor } from './executor.js';
import { Verifier } from './verification.js';
import { ConfirmationManager } from './confirmations.js';
import { checkUserAuthorization, checkBotPermissions } from './permissions.js';
import { getGuildStateSnapshot } from './server-state.js';
import { ActionLedger, createErrorEmbed } from './recovery.js';
import { ExecutionContext } from './execution-context.js';
import { IntentRouter } from './intent-router.js';
import { TaskWorkflow } from './task-workflow.js';
import { validateConfig, config } from './config.js';
import { SecurityGate, SecurityPolicyViolationError } from './security-gate.js';
import { HealthCheckEngine } from './health-check.js';
import { formatSingleOutcome } from './format-response.js';
import { Logger } from './logger.js';

const logger = new Logger('Commands');
const planner = new Planner();
const intentRouter = new IntentRouter();

/**
 * Slash command definitions for Discord registration.
 */
export const slashCommands = [
  // Primary /go command
  new SlashCommandBuilder()
    .setName('go')
    .setDescription('Autonomous AI Discord Administration Agent')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
      option
        .setName('prompt')
        .setDescription('Describe what you want to achieve in plain English')
        .setRequired(true)
    ),

  // Safety /undo command
  new SlashCommandBuilder()
    .setName('undo')
    .setDescription('Reverts the most recent administrative plan executed by the bot')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // Diagnostics command
  new SlashCommandBuilder()
    .setName('diagnostics')
    .setDescription('Inspects AI provider status, zero-cost guarantee, and Discord permissions')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // Comprehensive self-audit and health diagnostics command
  new SlashCommandBuilder()
    .setName('audit')
    .setDescription('Runs comprehensive self-audit and health diagnostics across all subsystems')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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

  if (commandName === 'go') {
    await handleGoCommand(interaction);
  } else if (commandName === 'undo') {
    await handleUndoCommand(interaction);
  } else if (commandName === 'diagnostics' || commandName === 'audit') {
    await handleAuditCommand(interaction);
  }
}

/**
 * Handles the primary /go command via the lightweight intent-driven path.
 */
async function handleGoCommand(interaction) {
  // Always defer reply immediately to prevent 3000ms Discord interaction timeout
  await interaction.deferReply();

  const userPrompt = interaction.options.getString('prompt');
  const guild = interaction.guild;
  const member = interaction.member;
  const executionId = Logger.generateExecutionId();

  // Create lightweight execution context and workflow tracker
  const executionContext = new ExecutionContext(interaction, executionId);
  const workflow = new TaskWorkflow(executionId, userPrompt, executionContext);

  logger.info(`Received /go command [${executionId}]`, { user: interaction.user.tag, prompt: userPrompt });

  // Immutable Security Policy Gate: Pre-flight prompt inspection
  try {
    SecurityGate.evaluatePromptSecurity(userPrompt, interaction.user.id, guild);
  } catch (secErr) {
    logger.warn('Prompt rejected by Security Gate', { error: secErr.message });
    return await interaction.editReply({
      content: `🛑 **Security Refusal:** ${secErr.message}`
    });
  }

  // Hard safety timeout guard so interaction is never left stranded
  let isDone = false;
  const timeoutGuard = setTimeout(async () => {
    if (isDone) return;
    try {
      await interaction.editReply({
        content: '⏳ **Operation Timed Out:** The request took longer than expected to process. Please try again.',
        embeds: [],
        components: []
      });
    } catch {}
  }, 25000);

  try {
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

    // Check if conversational / greeting
    if (interpreted.conversationalResponse) {
      isDone = true;
      clearTimeout(timeoutGuard);
      return await interaction.editReply({
        content: interpreted.conversationalResponse,
        embeds: [],
        components: []
      });
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

      const results = await Executor.executePlan(guild, plan, executionId, member);
      isDone = true;
      clearTimeout(timeoutGuard);
      const reportEmbed = Verifier.generateReportEmbed(plan, results, executionId);
      return await interaction.editReply({ content: '', embeds: [reportEmbed], components: [] });
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
      return await interaction.editReply({ content: `🛑 **Unauthorized:** ${userAuth.reason}` });
    }

    const botAuth = checkBotPermissions(guild, [actionObj]);
    if (!botAuth.capable) {
      isDone = true;
      clearTimeout(timeoutGuard);
      return await interaction.editReply({ content: `⚠️ **Bot Permission Error:** ${botAuth.reason}` });
    }

    // Immutable Security Gate check on targeted action
    try {
      SecurityGate.evaluateActionSequence([actionObj], member, guild);
    } catch (secErr) {
      isDone = true;
      clearTimeout(timeoutGuard);
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
        return;
      }
    }

    // Execute directly without full-server discovery
    const opResult = await Executor.executeIntent(guild, interpreted, executionContext, executionId);

    isDone = true;
    clearTimeout(timeoutGuard);

    if (!opResult.success) {
      const errorEmbed = createErrorEmbed(new Error(opResult.error || 'Operation failed'), executionId);
      return await interaction.editReply({ content: '', embeds: [errorEmbed], components: [] });
    }

    // Format concise outcome message (premium minimal UX)
    const outcomeMessage = formatSingleOutcome(interpreted.intent, opResult, {
      ...interpreted.args,
      targetRef: interpreted.targetRef,
      name: interpreted.args?.name
    });

    await interaction.editReply({
      content: outcomeMessage,
      embeds: [],
      components: []
    }).catch(async (editErr) => {
      // If the interaction message was deleted in a bulk purge, post directly to channel
      if (editErr?.code === 10008 || editErr?.message?.includes('Unknown Message')) {
        await interaction.channel?.send(outcomeMessage).catch(() => {});
      }
    });

  } catch (err) {
    isDone = true;
    clearTimeout(timeoutGuard);
    logger.error(`Error in /go command [${executionId}]`, { error: err.message, stack: err.stack });
    const errorEmbed = createErrorEmbed(err, executionId);
    await interaction.editReply({
      content: '',
      embeds: [errorEmbed],
      components: []
    }).catch(async () => {
      await interaction.followUp({ embeds: [errorEmbed], ephemeral: true }).catch(() => {});
    });
  }
}

/**
 * Handles the /undo command.
 */
async function handleUndoCommand(interaction) {
  await interaction.deferReply();

  const guild = interaction.guild;
  const lastEntry = ActionLedger.getLastExecution(guild.id);

  if (!lastEntry) {
    return await interaction.editReply({
      content: 'No recent created channels or roles found in this session to undo.'
    });
  }

  const [executionId, resources] = lastEntry;
  const result = await ActionLedger.rollbackExecution(guild, executionId);

  if (result.success) {
    const embed = new EmbedBuilder()
      .setTitle('Rollback Successful')
      .setDescription(`Execution \`${executionId}\` has been reversed.\n\n` + result.report.map(r => `• ${r}`).join('\n'))
      .setColor(0x5865F2);

    await interaction.editReply({ embeds: [embed] });
  } else {
    await interaction.editReply(`Rollback failed: ${result.message}`);
  }
}

/**
 * Handles the /audit and /diagnostics commands.
 * Runs comprehensive, read-only health checks across all subsystems.
 */
async function handleAuditCommand(interaction) {
  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  const executionId = Logger.generateExecutionId();

  const engine = new HealthCheckEngine({
    client: interaction.client,
    guild: interaction.guild
  });

  const report = await engine.runAllChecks();

  const color = report.overallStatus === 'healthy' ? 0x2ECC71 : (report.overallStatus === 'degraded' ? 0xE67E22 : 0xED4245);

  const embed = new EmbedBuilder()
    .setTitle('System Health & Self-Audit Report')
    .setColor(color)
    .setDescription(
      `Status: **${report.overallStatus.toUpperCase()}** (${report.durationMs}ms)\n` +
      `Summary: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.inconclusive + report.summary.skipped} skipped/inconclusive.`
    )
    .addFields(
      {
        name: 'Subsystem Checks',
        value:
          `• Application: ${report.categories.application.filter(c => c.status === 'passed').length}/${report.categories.application.length}\n` +
          `• Code Health: ${report.categories.code.filter(c => c.status === 'passed').length}/${report.categories.code.length}\n` +
          `• Dependencies: ${report.categories.dependency.filter(c => c.status === 'passed').length}/${report.categories.dependency.length}\n` +
          `• Configuration: ${report.categories.configuration.filter(c => c.status === 'passed').length}/${report.categories.configuration.length}\n` +
          `• Security Gate: ${report.categories.security.filter(c => c.status === 'passed').length}/${report.categories.security.length}\n` +
          `• Discord Integration: ${report.categories.discord.filter(c => c.status === 'passed').length}/${report.categories.discord.length}`,
        inline: false
      }
    )
    .setFooter({ text: `Execution ID: ${executionId} • Read-only diagnostics` });

  if (report.findings.length > 0) {
    const findingsText = report.findings.slice(0, 5).map(f =>
      `\`[${f.severity.toUpperCase()}]\` **${f.name}**: ${f.message}\nAction: ${f.remediation}`
    ).join('\n\n');
    embed.addFields({ name: 'Findings & Remediation', value: findingsText.slice(0, 1024), inline: false });
  }

  await interaction.editReply({ embeds: [embed] });
}
