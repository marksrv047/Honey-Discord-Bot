import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ComponentType } from 'discord.js';
import { SecurityGate } from './security-gate.js';

/**
 * Handles confirmation workflow for high-impact or destructive operations.
 */
export class ConfirmationManager {
  /**
   * High-impact actions that unconditionally require administrator confirmation.
   */
  static HIGH_IMPACT_ACTIONS = new Set([
    'delete_channel',
    'delete_category',
    'delete_role',
    'ban_member',
    'kick_member',
    'purge_messages',
    'softban_member',
    'update_server_name',
    'reset_guild_policy'
  ]);

  /**
   * Determines whether an individual action is classified as high-impact.
   */
  static isHighImpactAction(action) {
    if (!action) return false;
    const actionName = typeof action === 'string' ? action : action.action;
    if (!actionName) return false;
    if (this.HIGH_IMPACT_ACTIONS.has(actionName)) return true;
    if (actionName === 'purge_messages' && (action.count || 0) > 20) return true;
    if (actionName.startsWith('undo_')) return true;
    return false;
  }

  /**
   * Determines whether a full action plan requires interactive confirmation.
   */
  static requiresConfirmation(plan) {
    if (!plan) return false;
    if (plan.isHighImpact) return true;
    const actions = Array.isArray(plan.actions) ? plan.actions : [];
    if (actions.length > 3) return true;
    return actions.some(a => this.isHighImpactAction(a));
  }

  /**
   * Prompts the user with an interactive confirmation panel.
   * Returns true if confirmed, false if cancelled or timed out.
   */
  static async requestConfirmation(interaction, plan, timeoutMs = 60000) {
    if (!interaction) return false;

    const actions = Array.isArray(plan?.actions) ? plan.actions.filter(Boolean) : [];

    // 1. Truncate thought process if too long
    const thought = (plan?.thoughtProcess || 'Executing requested administrative changes.').slice(0, 500);

    // 2. Format and truncate action list safely within Discord's 4096 character limit
    const actionLines = actions.map((a, i) => {
      const title = ConfirmationManager.formatActionTitle(a?.action);
      const summary = ConfirmationManager.formatActionSummary(a);
      return `\`${i + 1}.\` **${title}** ${summary}`.trim();
    });

    let actionText = actionLines.length > 0
      ? actionLines.join('\n')
      : '*No specific actions specified.*';

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
      .setFooter({
        text: `Requester: ${interaction.user?.tag || interaction.user?.username || 'User'} • Expires in ${Math.round(timeoutMs / 1000)}s`.slice(0, 2048)
      });

    const userId = interaction.user?.id || 'user';
    const guildId = interaction.guild?.id || 'guild';
    const interactionId = interaction.id || `int_${Date.now()}`;

    const token = SecurityGate.generateConfirmationToken(userId, guildId, actions);
    const confirmCustomId = `confirm_${interactionId}_${token}`;
    const cancelCustomId = `cancel_${interactionId}_${token}`;

    const confirmBtn = new ButtonBuilder()
      .setCustomId(confirmCustomId)
      .setLabel('Confirm & Execute')
      .setStyle(ButtonStyle.Danger);

    const cancelBtn = new ButtonBuilder()
      .setCustomId(cancelCustomId)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(confirmBtn, cancelBtn);

    // Edit deferred/replied interaction or reply directly
    const shouldEdit = interaction.deferred || interaction.replied || typeof interaction.reply !== 'function';
    let message = null;

    try {
      if (shouldEdit && typeof interaction.editReply === 'function') {
        message = await interaction.editReply({ content: '', embeds: [embed], components: [row] });
      } else if (typeof interaction.reply === 'function') {
        message = await interaction.reply({ content: '', embeds: [embed], components: [row], fetchReply: true });
      } else if (typeof interaction.followUp === 'function') {
        message = await interaction.followUp({ content: '', embeds: [embed], components: [row], fetchReply: true });
      }
    } catch {
      return false;
    }

    // Ensure we have a valid message instance to await component interactions on
    if (!message || typeof message.awaitMessageComponent !== 'function') {
      if (typeof interaction.fetchReply === 'function') {
        message = await interaction.fetchReply().catch(() => null);
      }
    }

    if (!message || typeof message.awaitMessageComponent !== 'function') {
      return false;
    }

    // Await user button interaction
    let response = null;
    try {
      response = await message.awaitMessageComponent({
        filter: i => {
          if (interaction.user?.id && i.user?.id !== interaction.user.id) {
            if (typeof i.reply === 'function') {
              i.reply({
                content: '⛔ Only the operator who initiated this command can confirm or cancel it.',
                ephemeral: true
              }).catch(() => {});
            }
            return false;
          }
          return i.customId === confirmCustomId || i.customId === cancelCustomId;
        },
        time: timeoutMs,
        componentType: ComponentType.Button
      });
    } catch {
      // Timeout or collector error
      try {
        if (interaction.deferred || interaction.replied || typeof interaction.editReply === 'function') {
          await interaction.editReply({
            content: '⏳ **Confirmation timed out.** Operation aborted safely with no changes.',
            embeds: [],
            components: []
          }).catch(() => {});
        }
      } catch {}
      return false;
    }

    // Process confirm vs cancel
    if (response.customId === confirmCustomId) {
      // Cryptographically re-verify token before proceeding
      const isValid = SecurityGate.verifyConfirmationToken(token, userId, guildId, actions);
      if (!isValid) {
        if (typeof response.update === 'function') {
          await response.update({
            content: '🛑 **Security Refusal:** Confirmation token verification failed. Action parameters were altered or token was reused.',
            embeds: [],
            components: []
          }).catch(() => {});
        }
        return false;
      }

      if (typeof response.update === 'function') {
        await response.update({
          content: '✅ **Confirmation received.** Proceeding with execution...',
          embeds: [],
          components: []
        }).catch(async () => {
          if (typeof interaction.editReply === 'function') {
            await interaction.editReply({
              content: '✅ **Confirmation received.** Proceeding with execution...',
              embeds: [],
              components: []
            }).catch(() => {});
          }
        });
      }
      return true;
    } else {
      if (typeof response.update === 'function') {
        await response.update({
          content: '🛑 **Operation cancelled.** No server changes were made.',
          embeds: [],
          components: []
        }).catch(async () => {
          if (typeof interaction.editReply === 'function') {
            await interaction.editReply({
              content: '🛑 **Operation cancelled.** No server changes were made.',
              embeds: [],
              components: []
            }).catch(() => {});
          }
        });
      }
      return false;
    }
  }

  /**
   * Maps internal action identifiers to clean, user-facing title strings.
   */
  static formatActionTitle(actionName) {
    if (!actionName || typeof actionName !== 'string') return 'Action';
    return actionName
      .replace(/_/g, ' ')
      .replace(/^./, s => s.toUpperCase());
  }

  /**
   * Formats action parameters for clean preview display.
   */
  static formatActionSummary(action) {
    if (!action || typeof action !== 'object') return '';
    const act = action.action || '';

    if (act.startsWith('undo_')) {
      const base = act.replace(/^undo_/, '').replace(/_/g, ' ');
      const target = action.target || action.targetName || action.targetChannel || action.targetRole || action.targetMember || '';
      return target ? `Reverse ${base} on \`${target}\`` : `Reverse ${base}`;
    }

    switch (act) {
      case 'update_server_name':
        return `to "${action.name || ''}"`;
      case 'update_server_description':
        return action.description ? `"${action.description.slice(0, 30)}..."` : '""';
      case 'update_server_icon':
        return `(Updated from URL)`;
      case 'update_server_banner':
        return `(Updated from URL)`;
      case 'create_role':
        return `\`${action.name || action.roleName || 'new role'}\` (${action.color || 'default'})`;
      case 'edit_role':
        return `Role \`${action.targetRole || action.role || action.name || ''}\``;
      case 'delete_role':
        return `Role \`${action.targetRole || action.role || action.roleName || action.name || ''}\``;
      case 'assign_role':
        return `Role \`${action.targetRole || action.role || ''}\` to \`${action.targetMember || action.target || ''}\``;
      case 'remove_role':
        return `Role \`${action.targetRole || action.role || ''}\` from \`${action.targetMember || action.target || ''}\``;
      case 'create_channel':
        return `\`#${action.name || action.channelName || 'unnamed'}\` (${action.type || 'GUILD_TEXT'})`;
      case 'edit_channel':
        return `Channel \`${action.targetChannel || action.channel || action.name || ''}\``;
      case 'rename_channel':
        return `Channel \`${action.targetChannel || action.channel || 'current'}\` to \`#${action.newName || action.name || ''}\``;
      case 'delete_channel':
        return `Channel \`${action.targetChannel || action.channel || action.channelName || action.name || ''}\``;
      case 'create_category':
        return `Category \`${action.name || 'new category'}\``;
      case 'rename_category':
        return `Category \`${action.targetCategory || action.category || 'current'}\` to \`${action.newName || action.name || ''}\``;
      case 'delete_category':
        return `Category \`${action.targetCategory || action.category || ''}\``;
      case 'lock_channel':
        return `Channel \`${action.targetChannel || action.channel || 'current'}\``;
      case 'unlock_channel':
        return `Channel \`${action.targetChannel || action.channel || 'current'}\``;
      case 'set_channel_slowmode':
        return `${action.seconds || 0}s in \`${action.targetChannel || action.channel || 'current'}\``;
      case 'purge_messages':
        return `${action.count || 5} messages in \`${action.targetChannel || action.channel || 'current'}\``;
      case 'set_channel_permission':
        return `for \`${action.targetRoleOrMember || action.member || action.role || ''}\` on \`${action.targetChannel || action.channel || ''}\``;
      case 'timeout_member':
        return `User \`${action.targetMember || action.target || action.user || ''}\` for ${action.durationMinutes || action.duration || 0}m`;
      case 'remove_timeout':
        return `User \`${action.targetMember || action.target || action.user || ''}\``;
      case 'change_nickname':
        return `User \`${action.targetMember || action.target || ''}\` to "${action.nickname || action.newNickname || ''}"`;
      case 'remove_nickname':
        return `User \`${action.targetMember || action.target || ''}\``;
      case 'kick_member':
        return `User \`${action.targetMember || action.target || action.user || ''}\``;
      case 'ban_member':
        return `User \`${action.targetMember || action.target || action.user || ''}\` (${action.reason || 'No reason'})`;
      case 'unban_member':
        return `User \`${action.targetMember || action.target || action.user || ''}\``;
      case 'setup_ticket_system':
        return `panel in \`#${action.channelName || action.name || 'tickets'}\``;
      case 'audit_server':
        return `scope: ${action.scope || 'all'}`;
      case 'configure_guild_policy':
        return `(${action.operation || 'update'}${action.targetRole ? ` role: @${action.targetRole}` : ''}${action.targetMember ? ` member: ${action.targetMember}` : ''})`;
      case 'reset_guild_policy':
        return `(reset to server default access rules)`;
      default:
        if (action.targetRole || action.targetChannel || action.targetMember || action.target) {
          return `Target: \`${action.targetRole || action.targetChannel || action.targetMember || action.target}\``;
        }
        return '';
    }
  }
}
