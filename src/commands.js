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
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
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
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // Diagnostics command
  new SlashCommandBuilder()
    .setName('diagnostics')
    .setDescription('Inspects AI provider status, zero-cost guarantee, and Discord permissions')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
];

/**
 * Slash command execution router.
 */
export async function handleCommandInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  if (!interaction.guild) {
    return await interaction.reply({
      content: '❌ Honey Bot administration commands must be run inside a Discord server, not in Direct Messages.',
      ephemeral: true
    }).catch(() => {});
  }

  const { commandName } = interaction;

  if (commandName === 'go') {
    await handleGoCommand(interaction);
  } else if (commandName === 'undo') {
    await handleUndoCommand(interaction);
  } else if (commandName === 'diagnostics') {
    await handleDiagnosticsCommand(interaction);
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
      const chatEmbed = new EmbedBuilder()
        .setTitle('🍯 Honey Administrative Assistant')
        .setColor(0xF39C12)
        .setDescription(interpreted.conversationalResponse)
        .addFields({
          name: '🐝 Try running instructions like:',
          value: '• `/go prompt: rename this channel to general`\n• `/go prompt: lock this channel`\n• `/go prompt: setup ticket system for support`\n• `/go prompt: audit server permissions`\n• `/undo` to revert any recent changes'
        })
        .setFooter({ text: 'Operated by Zero-Cost AI • /go <instruction>' });

      return await interaction.editReply({
        content: '',
        embeds: [chatEmbed]
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

    // Format concise result embed
    const singleReportEmbed = new EmbedBuilder()
      .setTitle('✅ Action Completed & Verified')
      .setColor(0x2ECC71)
      .setDescription(`**${opResult.details}**\n\n*Targeted execution • 0 unneeded discovery calls*`)
      .setFooter({ text: `Execution ID: ${executionId} • Honey Admin Bot` })
      .setTimestamp();

    await interaction.editReply({
      content: '',
      embeds: [singleReportEmbed],
      components: []
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
      content: 'ℹ️ **No recent created channels or roles found in this session to undo.**'
    });
  }

  const [executionId, resources] = lastEntry;
  const result = await ActionLedger.rollbackExecution(guild, executionId);

  if (result.success) {
    const embed = new EmbedBuilder()
      .setTitle('🔄 Rollback Successful')
      .setDescription(`Execution \`${executionId}\` has been reversed.\n\n` + result.report.map(r => `• ${r}`).join('\n'))
      .setColor(0x3498DB);

    await interaction.editReply({ embeds: [embed] });
  } else {
    await interaction.editReply(`❌ **Rollback failed:** ${result.message}`);
  }
}

/**
 * Handles the /diagnostics command.
 */
async function handleDiagnosticsCommand(interaction) {
  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  const configStatus = validateConfig();
  const ping = interaction.client.ws.ping;

  const embed = new EmbedBuilder()
    .setTitle('🛠️ Admin Agent Diagnostics & Health Report')
    .setColor(configStatus.valid ? 0x2ECC71 : 0xE74C3C)
    .addFields(
      { name: 'Discord Gateway Ping', value: `${ping}ms`, inline: true },
      { name: 'Active AI Provider', value: `\`${config.ai.provider.toUpperCase()}\``, inline: true },
      { name: 'Execution Engine', value: '⚡ **Intent-Driven / Targeted**', inline: true },
      { name: 'Model In Use', value: `\`${config.ai[config.ai.provider]?.model || 'default'}\``, inline: true },
      { name: 'Task Budgets', value: '📊 `Max 3 Calls • 6k Tokens • 30s Deadline`', inline: true },
      { name: 'Zero-Cost Guarantee', value: '🔒 **ACTIVE (No paid fallbacks)**', inline: true },
      { name: 'Configuration Status', value: configStatus.valid ? '✅ Valid' : `⚠️ ${configStatus.issues.join('\n')}`, inline: false }
    )
    .setFooter({ text: 'Honey Admin Bot v1.2.0 • Lightweight Intent Engine' });

  await interaction.editReply({ embeds: [embed] });
}
