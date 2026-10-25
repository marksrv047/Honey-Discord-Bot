import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { Planner } from './planner.js';
import { Executor } from './executor.js';
import { Verifier } from './verification.js';
import { ConfirmationManager } from './confirmations.js';
import { checkUserAuthorization, checkBotPermissions } from './permissions.js';
import { getGuildStateSnapshot } from './server-state.js';
import { ActionLedger } from './recovery.js';
import { validateConfig, config } from './config.js';
import { Logger } from './logger.js';

const logger = new Logger('Commands');
const planner = new Planner();

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
 * Handles the primary /go command.
 */
async function handleGoCommand(interaction) {
  // Always defer reply immediately to prevent 3000ms Discord interaction timeout
  await interaction.deferReply();

  const userPrompt = interaction.options.getString('prompt');
  const guild = interaction.guild;
  const member = interaction.member;
  const executionId = Logger.generateExecutionId();

  logger.info(`Received /go command [${executionId}]`, { user: interaction.user.tag, prompt: userPrompt });

  try {
    // Phase 1: Pre-check & Server Snapshot
    await interaction.editReply('🔍 **Auditing server state and understanding intent...**');
    const serverState = await getGuildStateSnapshot(guild);

    // Phase 2: AI Intent Understanding & Planning
    await interaction.editReply('🧠 **Synthesizing administrative plan with Zero-Cost AI...**');
    const plan = await planner.createPlan(userPrompt, serverState);

    // Check if clarification is needed
    if (plan.clarificationNeeded) {
      return await interaction.editReply({
        content: `❓ **Clarification Needed:**\n${plan.clarificationNeeded}\n\n*Please run \`/go\` again with more details.*`
      });
    }

    // Check if plan has 0 actions (e.g. impossible request or purely explanatory)
    if (!plan.actions || plan.actions.length === 0) {
      return await interaction.editReply({
        content: `ℹ️ **Assessment Result:**\n${plan.thoughtProcess}`
      });
    }

    // Phase 3: Authorization Check
    const userAuth = checkUserAuthorization(member, plan.actions);
    if (!userAuth.authorized) {
      return await interaction.editReply({
        content: `🛑 **Unauthorized:** ${userAuth.reason}`
      });
    }

    const botAuth = checkBotPermissions(guild, plan.actions);
    if (!botAuth.capable) {
      return await interaction.editReply({
        content: `⚠️ **Bot Permission Error:** ${botAuth.reason}`
      });
    }

    // Phase 4: High-Impact Confirmation Check
    if (plan.isHighImpact) {
      const confirmed = await ConfirmationManager.requestConfirmation(interaction, plan);
      if (!confirmed) return; // User cancelled or timed out
    } else {
      await interaction.editReply(`⚡ **Executing ${plan.actions.length} verified administrative actions...**`);
    }

    // Phase 5: Validated Execution & Post-Verification
    const results = await Executor.executePlan(guild, plan, executionId, member);

    // Phase 6: Rich Report
    const reportEmbed = Verifier.generateReportEmbed(plan, results, executionId);
    await interaction.editReply({
      content: '',
      embeds: [reportEmbed],
      components: []
    });

  } catch (err) {
    logger.error(`Error in /go command [${executionId}]`, { error: err.message, stack: err.stack });
    await interaction.editReply({
      content: `❌ **Execution Failed:** ${err.message}`
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
  await interaction.editReply(`⏳ **Rolling back execution \`${executionId}\` (${resources.length} created resources)...**`);

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
  const configStatus = validateConfig();
  const ping = interaction.client.ws.ping;

  const embed = new EmbedBuilder()
    .setTitle('🛠️ Admin Agent Diagnostics & Health Report')
    .setColor(configStatus.valid ? 0x2ECC71 : 0xE74C3C)
    .addFields(
      { name: 'Discord Gateway Ping', value: `${ping}ms`, inline: true },
      { name: 'Active AI Provider', value: `\`${config.ai.provider.toUpperCase()}\``, inline: true },
      { name: 'Zero-Cost Guarantee', value: '🔒 **ACTIVE (No paid fallbacks)**', inline: true },
      { name: 'Model In Use', value: `\`${config.ai[config.ai.provider]?.model || 'default'}\``, inline: true },
      { name: 'Configuration Status', value: configStatus.valid ? '✅ Valid' : `⚠️ ${configStatus.issues.join('\n')}`, inline: false }
    )
    .setFooter({ text: 'Discord Admin Agent v1.0.0 • Node.js v24' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
