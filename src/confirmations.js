import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ComponentType } from 'discord.js';
import { SecurityGate } from './security-gate.js';
import { Logger } from './logger.js';

const logger = new Logger('ConfirmationManager');

/**
 * Handles confirmation workflow for high-impact or destructive operations.
 */
export class ConfirmationManager {
  /**
   * Maps internal action identifiers to clean, user-facing titles.
   */
  static formatActionTitle(actionName) {
    if (!actionName) return 'Action';
    const titles = {
      update_server_name: 'Update server name',
      update_server_description: 'Update server description',
      update_server_icon: 'Update server icon',
      update_server_banner: 'Update server banner',
      create_role: 'Create role',
      edit_role: 'Edit role',
      delete_role: 'Delete role',
      assign_role: 'Assign role',
      remove_role: 'Remove role',
      create_channel: 'Create channel',
      edit_channel: 'Edit channel',
      delete_channel: 'Delete channel',
      rename_channel: 'Rename channel',
      create_category: 'Create category',
      rename_category: 'Rename category',
      delete_category: 'Delete category',
      move_channel_to_category: 'Move channel to category',
      set_channel_permission: 'Set channel permission',
      set_category_permission: 'Set category permission',
      sync_category_permissions: 'Sync category permissions',
      timeout_member: 'Timeout member',
      remove_timeout: 'Remove timeout',
      kick_member: 'Kick member',
      ban_member: 'Ban member',
      unban_member: 'Unban member',
      purge_messages: 'Purge messages',
      setup_ticket_system: 'Setup ticket system',
      audit_server: 'Audit server',
      configure_guild_policy: 'Configure server policy',
      reset_guild_policy: 'Reset server policy'
    };
    if (titles[actionName]) return titles[actionName];
    return String(actionName)
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  /**
   * Prompts the user with an interactive confirmation panel.
   * Returns true if confirmed, false if cancelled or timed out.
   */
  static async requestConfirmation(interaction, plan, timeoutMs = 60000) {
    const actions = Array.isArray(plan?.actions) ? plan.actions : [];

    // 1. Truncate thought process if too long
    const thought = (plan?.thoughtProcess || 'Executing requested administrative changes.').slice(0, 500);

    // 2. Format and truncate action list safely within Discord's 4096 character limit
    const actionLines = actions.map((a, i) => {
      const title = ConfirmationManager.formatActionTitle(a.action);
      const summary = ConfirmationManager.formatActionSummary(a);
      return `\`${i + 1}.\` **${title}** ${summary}`.trim();
    });
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
    let reply;
    if (shouldEdit) {
      await interaction.editReply({ content: '', embeds: [embed], components: [row] });
      reply = typeof interaction.fetchReply === 'function'
        ? await interaction.fetchReply().catch(() => null)
        : null;
    } else {
      reply = await interaction.reply({ content: '', embeds: [embed], components: [row], fetchReply: true });
    }

    // Fallback: if fetchReply wasn't available or failed, use mock/editReply return value
    if (!reply && typeof interaction.editReply === 'function') {
      reply = await interaction.editReply({ content: '', embeds: [embed], components: [row] });
    }

    if (!reply || typeof reply.awaitMessageComponent !== 'function') {
      logger.warn('Could not establish message component collector for confirmation');
      return false;
    }

    try {
      const response = await reply.awaitMessageComponent({
        filter: async (i) => {
          const isTargetCustomId = i.customId === `confirm_${interaction.id}_${token}` ||
                                   i.customId === `cancel_${interaction.id}_${token}`;
          if (!isTargetCustomId) return false;

          if (i.user.id !== interaction.user.id) {
            await i.reply({
              content: 'Only the user who initiated this command can confirm or cancel it.',
              ephemeral: true
            }).catch(() => {});
            return false;
          }
          return true;
        },
        time: timeoutMs,
        componentType: ComponentType.Button
      });

      if (response.customId === `confirm_${interaction.id}_${token}`) {
        // Cryptographically re-verify token before proceeding
        const isValid = SecurityGate.verifyConfirmationToken(token, interaction.user.id, interaction.guild?.id || 'guild', actions);
        if (!isValid) {
          try {
            await response.update({
              content: 'Security Refusal: Confirmation token verification failed. Action parameters were altered or token was reused.',
              embeds: [],
              components: []
            });
          } catch {}
          return false;
        }

        try {
          if (!response.replied && !response.deferred) {
            await response.update({
              content: 'Confirmation received. Proceeding with execution...',
              embeds: [],
              components: []
            });
          }
        } catch (updateErr) {
          logger.warn('Failed to update confirmation response message, proceeding with execution', { error: updateErr.message });
        }
        return true;
      } else {
        try {
          if (!response.replied && !response.deferred) {
            await response.update({
              content: 'Operation cancelled. No server changes were made.',
              embeds: [],
              components: []
            });
          }
        } catch (updateErr) {
          logger.warn('Failed to update cancellation message', { error: updateErr.message });
        }
        return false;
      }
    } catch (err) {
      const isTimeout = err?.code === 'InteractionCollectorError' || err?.message?.includes('time') || err?.name === 'TimeoutError';
      if (!isTimeout) {
        logger.warn('Confirmation encountered error during collection', { error: err?.message, code: err?.code });
      }

      if (interaction.deferred || interaction.replied || typeof interaction.editReply === 'function') {
        const timeoutContent = isTimeout
          ? 'Confirmation timed out. Operation aborted safely.'
          : 'Confirmation aborted safely.';
        await interaction.editReply({
          content: timeoutContent,
          embeds: [],
          components: []
        }).catch(() => {});
      }
      return false;
    }
  }

  /**
   * Formats action parameters for clean preview display.
   */
  static formatActionSummary(action) {
    if (!action) return '';
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
      case 'assign_role':
        return `Role \`${action.targetRole || action.role || ''}\` to \`${action.targetMember || action.targetMemberId || 'member'}\``;
      case 'remove_role':
        return `Role \`${action.targetRole || action.role || ''}\` from \`${action.targetMember || action.targetMemberId || 'member'}\``;
      case 'create_channel':
        return `\`#${action.name || 'unnamed'}\` (${action.type || 'GUILD_TEXT'})`;
      case 'edit_channel':
        return `Channel \`${action.targetChannel || ''}\``;
      case 'delete_channel':
        return `Channel \`${action.targetChannel || ''}\``;
      case 'rename_channel':
        return `\`#${action.targetChannel || action.targetRef || ''}\` to "${action.name || ''}"`;
      case 'create_category':
        return `\`${action.name || 'unnamed'}\``;
      case 'rename_category':
        return `\`${action.targetCategory || action.targetRef || ''}\` to "${action.name || ''}"`;
      case 'delete_category':
        return `Category \`${action.targetCategory || action.targetRef || ''}\``;
      case 'move_channel_to_category':
        return `\`${action.targetChannel || ''}\` to \`${action.category || action.targetCategory || ''}\``;
      case 'set_channel_permission':
        return `for \`${action.targetRoleOrMember || ''}\` on \`${action.targetChannel || ''}\``;
      case 'set_category_permission':
        return `for \`${action.targetRoleOrMember || ''}\` on \`${action.targetCategory || ''}\``;
      case 'sync_category_permissions':
        return `Category \`${action.targetCategory || ''}\``;
      case 'timeout_member':
        return `User \`${action.targetMember || ''}\` for ${action.durationMinutes || 0}m`;
      case 'remove_timeout':
        return `User \`${action.targetMember || ''}\``;
      case 'kick_member':
        return `User \`${action.targetMember || ''}\``;
      case 'ban_member':
        return `User \`${action.targetMember || ''}\` (${action.reason || 'No reason'})`;
      case 'unban_member':
        return `User \`${action.targetMember || action.targetMemberId || ''}\``;
      case 'purge_messages':
        return `${action.count || 5} messages in \`${action.targetChannel || action.targetRef || 'channel'}\``;
      case 'setup_ticket_system':
        return `panel in \`#${action.channelName || 'tickets'}\``;
      case 'audit_server':
        return `scope: ${action.scope || 'all'}`;
      case 'configure_guild_policy':
        return `(${action.operation || 'update'}${action.targetRole ? ` role: @${action.targetRole}` : ''}${action.targetMember ? ` member: ${action.targetMember}` : ''})`;
      case 'reset_guild_policy':
        return `(reset to server default access rules)`;
      default:
        return '';
    }
  }
}

