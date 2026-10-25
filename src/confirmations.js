import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ComponentType } from 'discord.js';

/**
 * Handles confirmation workflow for high-impact or destructive operations.
 */
export class ConfirmationManager {
  /**
   * Prompts the user with an interactive confirmation panel.
   * Returns true if confirmed, false if cancelled or timed out.
   */
  static async requestConfirmation(interaction, plan, timeoutMs = 60000) {
    // 1. Truncate thought process if too long
    const thought = (plan.thoughtProcess || 'Executing requested administrative changes.').slice(0, 500);

    // 2. Format and truncate action list safely within Discord's 4096 character limit
    const actionLines = plan.actions.map((a, i) => `\`${i + 1}.\` **${a.action}** ${ConfirmationManager.formatActionSummary(a)}`.trim());
    let actionText = actionLines.join('\n');

    if (actionText.length > 2500) {
      const truncatedLines = actionLines.slice(0, 15);
      const remaining = plan.actions.length - 15;
      actionText = truncatedLines.join('\n') + `\n*...and ${remaining} additional action(s)*`;
    }

    const description = 
      `The requested operation involves **high-impact, destructive, or mass changes**.\n\n` +
      `**Intended Plan:**\n${thought}\n\n` +
      `**Actions to Execute (${plan.actions.length}):**\n${actionText}`;

    const embed = new EmbedBuilder()
      .setTitle('⚠️ High-Impact Operation Confirmation Required')
      .setDescription(description.slice(0, 4000)) // Hard guarantee under Discord's 4096 limit
      .setColor(0xE67E22)
      .setFooter({ text: `Requester: ${interaction.user.tag || interaction.user.username} • Expires in ${timeoutMs / 1000}s` });

    const confirmBtn = new ButtonBuilder()
      .setCustomId(`confirm_${interaction.id}`)
      .setLabel('Confirm & Execute')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('⚠️');

    const cancelBtn = new ButtonBuilder()
      .setCustomId(`cancel_${interaction.id}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(confirmBtn, cancelBtn);

    // Explicitly clear prior deferred content string so it doesn't overlap
    const reply = await interaction.editReply({
      content: '',
      embeds: [embed],
      components: [row]
    });

    try {
      const response = await reply.awaitMessageComponent({
        filter: i => i.user.id === interaction.user.id && (i.customId === `confirm_${interaction.id}` || i.customId === `cancel_${interaction.id}`),
        time: timeoutMs,
        componentType: ComponentType.Button
      });

      if (response.customId === `confirm_${interaction.id}`) {
        await response.update({
          content: '⏳ **Confirmation received. Proceeding with execution...**',
          embeds: [],
          components: []
        });
        return true;
      } else {
        await response.update({
          content: '❌ **Operation cancelled by user. No server changes were made.**',
          embeds: [],
          components: []
        });
        return false;
      }
    } catch {
      // Timeout or expired interaction
      await interaction.editReply({
        content: '⏰ **Confirmation timed out. Operation aborted safely.**',
        embeds: [],
        components: []
      });
      return false;
    }
  }

  /**
   * Formats action parameters for clean preview display.
   */
  static formatActionSummary(action) {
    switch (action.action) {
      case 'update_server_name':
        return `to "${action.name}"`;
      case 'update_server_description':
        return `"${action.description.slice(0, 30)}..."`;
      case 'update_server_icon':
        return `(Updated from URL)`;
      case 'update_server_banner':
        return `(Updated from URL)`;
      case 'create_role':
        return `\`${action.name}\` (${action.color || 'default'})`;
      case 'edit_role':
        return `Role \`${action.targetRole}\``;
      case 'delete_role':
        return `Role \`${action.targetRole}\``;
      case 'create_channel':
        return `\`#${action.name}\` (${action.type})`;
      case 'edit_channel':
        return `Channel \`${action.targetChannel}\``;
      case 'delete_channel':
        return `Channel \`${action.targetChannel}\``;
      case 'set_channel_permission':
        return `for \`${action.targetRoleOrMember}\` on \`${action.targetChannel}\``;
      case 'timeout_member':
        return `User \`${action.targetMember}\` for ${action.durationMinutes}m`;
      case 'kick_member':
        return `User \`${action.targetMember}\``;
      case 'ban_member':
        return `User \`${action.targetMember}\` (${action.reason || 'No reason'})`;
      case 'setup_ticket_system':
        return `panel in \`#${action.channelName || 'tickets'}\``;
      case 'audit_server':
        return `scope: ${action.scope || 'all'}`;
      default:
        return '';
    }
  }
}
