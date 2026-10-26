import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ComponentType } from 'discord.js';
import { SecurityGate } from './security-gate.js';

/**
 * Handles confirmation workflow for high-impact or destructive operations.
 */
export class ConfirmationManager {
  /**
   * Prompts the user with an interactive confirmation panel.
   * Returns true if confirmed, false if cancelled or timed out.
   */
  static async requestConfirmation(interaction, plan, timeoutMs = 60000) {
    const actions = Array.isArray(plan?.actions) ? plan.actions : [];

    // 1. Truncate thought process if too long
    const thought = (plan?.thoughtProcess || 'Executing requested administrative changes.').slice(0, 500);

    // 2. Format and truncate action list safely within Discord's 4096 character limit
    const actionLines = actions.map((a, i) => `\`${i + 1}.\` **${a.action}** ${ConfirmationManager.formatActionSummary(a)}`.trim());
    let actionText = actionLines.join('\n');

    if (actionText.length > 2500) {
      const truncatedLines = actionLines.slice(0, 15);
      const remaining = actions.length - 15;
      actionText = truncatedLines.join('\n') + `\n*...and ${remaining} additional action(s)*`;
    }

    const description =
      `The requested operation involves **high-impact, destructive, or mass changes**.\n\n` +
      `**Intended Plan:**\n${thought}\n\n` +
      `**Actions to Execute (${actions.length}):**\n${actionText}`;

    const embed = new EmbedBuilder()
      .setTitle('Confirmation Required')
      .setDescription(description.slice(0, 4000)) // Hard guarantee under Discord's 4096 limit
      .setColor(0xE67E22)
      .setFooter({ text: `Requester: ${interaction.user?.tag || interaction.user?.username || 'User'} • Expires in ${timeoutMs / 1000}s` });

    const token = SecurityGate.generateConfirmationToken(interaction.user.id, interaction.guild?.id || 'guild', actions);

    const confirmBtn = new ButtonBuilder()
      .setCustomId(`confirm_${interaction.id}_${token}`)
      .setLabel('Confirm & Execute')
      .setStyle(ButtonStyle.Danger);

    const cancelBtn = new ButtonBuilder()
      .setCustomId(`cancel_${interaction.id}_${token}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(confirmBtn, cancelBtn);

    // Edit deferred/replied interaction or reply directly
    const shouldEdit = interaction.deferred || interaction.replied || typeof interaction.reply !== 'function';
    const reply = shouldEdit
      ? await interaction.editReply({ content: '', embeds: [embed], components: [row] })
      : await interaction.reply({ content: '', embeds: [embed], components: [row], fetchReply: true });

    try {
      const response = await reply.awaitMessageComponent({
        filter: i => i.user.id === interaction.user.id && (i.customId === `confirm_${interaction.id}_${token}` || i.customId === `cancel_${interaction.id}_${token}`),
        time: timeoutMs,
        componentType: ComponentType.Button
      });

      if (response.customId === `confirm_${interaction.id}_${token}`) {
        // Cryptographically re-verify token before proceeding
        const isValid = SecurityGate.verifyConfirmationToken(token, interaction.user.id, interaction.guild?.id || 'guild', actions);
        if (!isValid) {
          await response.update({
            content: 'Security Refusal: Confirmation token verification failed. Action parameters were altered or token was reused.',
            embeds: [],
            components: []
          });
          return false;
        }

        await response.update({
          content: 'Confirmation received. Proceeding with execution...',
          embeds: [],
          components: []
        });
        return true;
      } else {
        await response.update({
          content: 'Operation cancelled. No server changes were made.',
          embeds: [],
          components: []
        });
        return false;
      }
    } catch {
      // Timeout or expired interaction
      if (interaction.deferred || interaction.replied || typeof interaction.editReply === 'function') {
        await interaction.editReply({
          content: 'Confirmation timed out. Operation aborted safely.',
          embeds: [],
          components: []
        }).catch(() => { });
      }
      return false;
    }
  }

  /**
   * Formats action parameters for clean preview display.
   */
  static formatActionSummary(action) {
    switch (action.action) {
      case 'update_server_name':
        return `to "${action.name || ''}"`;
      case 'update_server_description':
        return action.description ? `"${action.description.slice(0, 30)}..."` : '""';
      case 'update_server_icon':
        return `(Updated from URL)`;
      case 'update_server_banner':
        return `(Updated from URL)`;
      case 'create_role':
        return `\`${action.name || 'new role'}\` (${action.color || 'default'})`;
      case 'edit_role':
        return `Role \`${action.targetRole || ''}\``;
      case 'delete_role':
        return `Role \`${action.targetRole || ''}\``;
      case 'create_channel':
        return `\`#${action.name || 'unnamed'}\` (${action.type || 'GUILD_TEXT'})`;
      case 'edit_channel':
        return `Channel \`${action.targetChannel || ''}\``;
      case 'delete_channel':
        return `Channel \`${action.targetChannel || ''}\``;
      case 'set_channel_permission':
        return `for \`${action.targetRoleOrMember || ''}\` on \`${action.targetChannel || ''}\``;
      case 'timeout_member':
        return `User \`${action.targetMember || ''}\` for ${action.durationMinutes || 0}m`;
      case 'kick_member':
        return `User \`${action.targetMember || ''}\``;
      case 'ban_member':
        return `User \`${action.targetMember || ''}\` (${action.reason || 'No reason'})`;
      case 'setup_ticket_system':
        return `panel in \`#${action.channelName || 'tickets'}\``;
      case 'audit_server':
        return `scope: ${action.scope || 'all'}`;
      default:
        return '';
    }
  }
}
