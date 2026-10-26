import { EmbedBuilder } from 'discord.js';
import { Logger } from './logger.js';
import { cleanText, formatRefinedResponse } from './format-response.js';

const logger = new Logger('ResponseService');

export const OutcomeClass = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  PARTIAL_SUCCESS: 'partial_success',
  DENIED: 'denied',
  UNVERIFIED: 'unverified',
  ALREADY_COMPLETED: 'already_completed',
  INFORMATIONAL: 'informational'
};

/**
 * Unified Response Engine for Honey Bot.
 *
 * Provides:
 * - Native Discord user (<@ID>), channel (<#ID>), and role (<@&ID>) mentions with verified IDs.
 * - Safe allowedMentions controls to distinguish visible mentions from loud notification pings.
 * - Prevention of accidental mass mentions (@everyone / @here sanitization).
 * - Context-aware response variation across action outcomes.
 * - Intelligent plain text vs embed selection.
 * - Safe interaction lifecycle integration across all five commands.
 */
export class ResponseService {
  /**
   * Resolves a snowflake ID (17-20 digits) from a string, mention, or object.
   */
  static extractSnowflake(input) {
    if (!input) return null;
    if (typeof input === 'object') {
      if (input.id && /^\d{17,20}$/.test(String(input.id))) return String(input.id);
      if (input.user?.id && /^\d{17,20}$/.test(String(input.user.id))) return String(input.user.id);
      return null;
    }
    const str = String(input).trim();
    if (/^\d{17,20}$/.test(str)) return str;
    const match = str.match(/<[@#&]!?(\d{17,20})>/);
    if (match) return match[1];
    return null;
  }

  /**
   * Formats a verified native Discord user mention (<@USER_ID>).
   * Falls back to a clean username with ID, or unverified name if no ID is available.
   * Never fabricates user IDs.
   */
  static formatUserMention(userIdOrTarget, fallbackName = null) {
    const snowflake = ResponseService.extractSnowflake(userIdOrTarget) || ResponseService.extractSnowflake(fallbackName);
    if (snowflake) {
      return `<@${snowflake}>`;
    }

    const name = fallbackName || (typeof userIdOrTarget === 'string' ? userIdOrTarget : null);
    if (name) {
      const clean = String(name).replace(/^[@!]/, '').trim();
      if (clean && clean !== 'member' && clean !== 'user') {
        return `@${clean}`;
      }
    }
    return '@member';
  }

  /**
   * Formats a verified native Discord channel mention (<#CHANNEL_ID>).
   * If the channel has been deleted, identifies by last verified name and ID.
   */
  static formatChannelMention(channelIdOrTarget, fallbackName = null, isDeleted = false) {
    const snowflake = ResponseService.extractSnowflake(channelIdOrTarget) || ResponseService.extractSnowflake(fallbackName);
    const cleanName = String(fallbackName || (typeof channelIdOrTarget === 'string' ? channelIdOrTarget : 'channel')).replace(/^#/, '').trim();

    if (isDeleted) {
      return `\`${cleanName || 'channel'}\` (channel ID: ${snowflake || 'unknown'})`;
    }

    if (snowflake) {
      return `<#${snowflake}>`;
    }

    return `#${cleanName || 'channel'}`;
  }

  /**
   * Formats a verified native Discord role mention (<@&ROLE_ID>).
   * If deleted or without ID, identifies by name.
   */
  static formatRoleMention(roleIdOrTarget, fallbackName = null, isDeleted = false) {
    const snowflake = ResponseService.extractSnowflake(roleIdOrTarget) || ResponseService.extractSnowflake(fallbackName);
    const cleanName = String(fallbackName || (typeof roleIdOrTarget === 'string' ? roleIdOrTarget : 'role')).replace(/^@/, '').trim();

    if (isDeleted) {
      return `\`@${cleanName || 'role'}\` (role ID: ${snowflake || 'unknown'})`;
    }

    if (snowflake) {
      return `<@&${snowflake}>`;
    }

    return `@${cleanName || 'role'}`;
  }

  /**
   * Standard allowedMentions configuration.
   * Prevents mass mentions (@everyone / @here) and separates visible mentions
   * from notification pings by defaulting parse to empty.
   */
  static getAllowedMentions(options = {}) {
    return {
      parse: [], // Never parse @everyone, @here, @users, or @roles by default
      users: options.notifyUsers || [],
      roles: options.notifyRoles || [],
      repliedUser: Boolean(options.repliedUser)
    };
  }

  /**
   * Sanitizes text to prevent mention injection and secret leakage.
   */
  static sanitizeText(str) {
    if (!str || typeof str !== 'string') return '';
    return Logger.redactSecrets(str)
      .replace(/@everyone/g, '@\u200beveryone')
      .replace(/@here/g, '@\u200bhere');
  }

  /**
   * Generates a context-aware deterministic variation index (0, 1, 2)
   * based on execution context or details.
   */
  static getVariationIndex(details = {}, count = 3) {
    const seed = details.executionId || details.correlationId || details.targetMemberId || details.targetChannelId || '';
    if (!seed) return 0;
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = (hash << 5) - hash + seed.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash) % count;
  }

  /**
   * Formats a single successful action outcome with context-aware wording.
   */
  static formatSuccess(action, details = {}, options = {}) {
    const v = ResponseService.getVariationIndex(details, 3);
    const act = String(action || '').toLowerCase();
    const reason = details.reason ? ResponseService.sanitizeText(details.reason) : null;
    const reasonText = reason ? ` Reason: ${reason}.` : '';

    switch (act) {
      case 'kick_member': {
        const snowflake = ResponseService.extractSnowflake(details.targetMemberId || details.resourceId || details.targetMember);
        // If a verified ID is available, use native mention
        if (snowflake) {
          const userMention = `<@${snowflake}>`;
          const templates = [
            `Done — ${userMention} was kicked from the server.${reasonText}`,
            `The kick succeeded. Target: ${userMention}.${reasonText}`,
            `Completed: removed ${userMention} from the server by kicking them.${reasonText}`
          ];
          return templates[v];
        }
        // Legacy fallback when only username string is passed
        const cleanTarget = String(details.targetMember || details.member || 'member').replace(/^@/, '');
        if (reason) {
          return `Kicked @${cleanTarget}. Reason: ${reason}.`;
        }
        return `Kicked @${cleanTarget} from the server.`;
      }

      case 'ban_member': {
        const snowflake = ResponseService.extractSnowflake(details.targetMemberId || details.resourceId || details.targetMember);
        if (snowflake) {
          const userMention = `<@${snowflake}>`;
          const templates = [
            `Done — ${userMention} was banned from the server.${reasonText}`,
            `Banned ${userMention} from the server.${reasonText}`,
            `The ban succeeded. Target: ${userMention}.${reasonText}`
          ];
          return templates[v];
        }
        const cleanTarget = String(details.targetMember || details.member || 'user').replace(/^@/, '');
        if (reason) {
          return `Banned @${cleanTarget}. Reason: ${reason}.`;
        }
        return `Banned @${cleanTarget} from the server.`;
      }

      case 'timeout_member': {
        const snowflake = ResponseService.extractSnowflake(details.targetMemberId || details.resourceId || details.targetMember);
        const mins = details.durationMinutes || details.args?.durationMinutes || 10;
        if (snowflake) {
          const userMention = `<@${snowflake}>`;
          const templates = [
            `Timed out ${userMention} for ${mins} minutes.${reasonText}`,
            `Done — ${userMention} was placed in timeout for ${mins} minutes.${reasonText}`,
            `Applied ${mins}-minute timeout to ${userMention}.${reasonText}`
          ];
          return templates[v];
        }
        const cleanTarget = String(details.targetMember || details.member || 'member').replace(/^@/, '');
        if (reason) {
          return `Timed out @${cleanTarget} for ${mins} minutes. Reason: ${reason}.`;
        }
        return `Timed out @${cleanTarget} for ${mins} minutes.`;
      }

      case 'remove_timeout': {
        const snowflake = ResponseService.extractSnowflake(details.targetMemberId || details.resourceId || details.targetMember);
        const user = snowflake ? `<@${snowflake}>` : `@${String(details.targetMember || details.member || 'member').replace(/^@/, '')}`;
        const templates = [
          `Removed timeout from ${user}.`,
          `Done — timeout cleared for ${user}.`,
          `The timeout on ${user} was successfully lifted.`
        ];
        return templates[v];
      }

      case 'unban_member': {
        const snowflake = ResponseService.extractSnowflake(details.targetMemberId || details.resourceId || details.targetMember);
        const user = snowflake ? `<@${snowflake}>` : String(details.targetMemberId || details.targetMember || 'user').replace(/^@/, '');
        const templates = [
          `Unbanned ${user}.`,
          `Done — ${user} was unbanned from the server.`,
          `The ban on ${user} has been revoked.`
        ];
        return templates[v];
      }

      case 'assign_role': {
        const roleSnowflake = ResponseService.extractSnowflake(details.targetRoleId || details.resourceId || details.targetRole || details.role);
        const role = roleSnowflake ? `<@&${roleSnowflake}>` : (details.targetRole || details.role || 'role').replace(/^@/, '');
        const memberSnowflake = ResponseService.extractSnowflake(details.targetMemberId || details.targetMember || details.member);
        const member = memberSnowflake ? `<@${memberSnowflake}>` : `@${String(details.targetMember || details.member || 'member').replace(/^@/, '')}`;

        if (!roleSnowflake && !memberSnowflake) {
          return `Assigned the ${role} role to ${member}.`;
        }
        const templates = [
          `Assigned the ${role} role to ${member}.`,
          `Done — ${member} was given the ${role} role.`,
          `Role ${role} successfully granted to ${member}.`
        ];
        return templates[v];
      }

      case 'remove_role': {
        const roleSnowflake = ResponseService.extractSnowflake(details.targetRoleId || details.resourceId || details.targetRole || details.role);
        const role = roleSnowflake ? `<@&${roleSnowflake}>` : (details.targetRole || details.role || 'role').replace(/^@/, '');
        const memberSnowflake = ResponseService.extractSnowflake(details.targetMemberId || details.targetMember || details.member);
        const member = memberSnowflake ? `<@${memberSnowflake}>` : `@${String(details.targetMember || details.member || 'member').replace(/^@/, '')}`;

        if (!roleSnowflake && !memberSnowflake) {
          if (reason) return `Removed ${role} role from ${member}. Reason: ${reason}.`;
          return `Removed the ${role} role from ${member}.`;
        }
        const templates = [
          `Removed the ${role} role from ${member}.${reasonText}`,
          `Done — ${role} role removed from ${member}.${reasonText}`,
          `Revoked role ${role} from ${member}.${reasonText}`
        ];
        return templates[v];
      }

      case 'create_channel': {
        const chSnowflake = ResponseService.extractSnowflake(details.targetChannelId || details.resourceId);
        const name = details.name || details.args?.name || 'channel';
        if (chSnowflake) {
          const chMention = `<#${chSnowflake}>`;
          const templates = [
            `Created ${chMention} for project updates.`,
            `Successfully created channel ${chMention}.`,
            `Done — created channel ${chMention}.`
          ];
          return templates[v];
        }
        return `Created #${name.replace(/^#/, '')}.`;
      }

      case 'rename_channel': {
        const chSnowflake = ResponseService.extractSnowflake(details.targetChannelId || details.resourceId || details.targetRef);
        const newName = details.name || details.args?.name || '';
        const targetRef = String(details.targetRef || '').replace(/^#/, '');

        if (chSnowflake && newName) {
          const templates = [
            `Renamed <#${chSnowflake}> to #${newName.replace(/^#/, '')}.`,
            `The channel rename succeeded. Updated channel: <#${chSnowflake}>.`,
            `Done — channel renamed: <#${chSnowflake}>.`
          ];
          return templates[v];
        }
        return `Renamed #${targetRef} to #${newName.replace(/^#/, '')}.`;
      }

      case 'delete_channel': {
        const chSnowflake = ResponseService.extractSnowflake(details.targetChannelId || details.resourceId || details.targetRef);
        const name = (details.targetRef || details.targetChannel || details.name || 'channel').replace(/^#/, '');
        if (chSnowflake) {
          return `Deleted \`${name}\` (channel ID: ${chSnowflake}).`;
        }
        return `Deleted #${name}.`;
      }

      case 'create_role': {
        const roleSnowflake = ResponseService.extractSnowflake(details.targetRoleId || details.resourceId);
        const name = details.name || details.args?.name || 'role';
        if (roleSnowflake) {
          return `Created role <@&${roleSnowflake}>.`;
        }
        return `Created role @${name.replace(/^@/, '')}.`;
      }

      case 'delete_role': {
        const roleSnowflake = ResponseService.extractSnowflake(details.targetRoleId || details.resourceId || details.targetRef);
        const name = (details.targetRef || details.targetRole || details.name || 'role').replace(/^@/, '');
        if (roleSnowflake) {
          return `Deleted role \`${name}\` (role ID: ${roleSnowflake}).`;
        }
        return `Deleted role @${name}.`;
      }

      case 'send_announcement': {
        const chSnowflake = ResponseService.extractSnowflake(details.targetChannelId || details.resourceId || details.targetRef || details.channel);
        if (chSnowflake) {
          return `Announcement posted in <#${chSnowflake}>.`;
        }
        const ch = (details.targetRef || details.channel || 'announcements').replace(/^#/, '');
        return `Announcement posted in #${ch}.`;
      }

      case 'send_message': {
        const chSnowflake = ResponseService.extractSnowflake(details.targetChannelId || details.resourceId || details.targetRef || details.channel);
        if (chSnowflake) {
          return `Message posted in <#${chSnowflake}>.`;
        }
        const ch = (details.targetRef || details.channel || 'channel').replace(/^#/, '');
        return `Message posted in #${ch}.`;
      }

      case 'purge_messages': {
        const chSnowflake = ResponseService.extractSnowflake(details.targetChannelId || details.resourceId || details.targetRef);
        const count = details.count || details.args?.count || 5;
        if (chSnowflake) {
          return `Purged ${count} messages from <#${chSnowflake}>.`;
        }
        const ch = (details.targetRef || 'general').replace(/^#/, '');
        return `Purged ${count} messages from #${ch}.`;
      }

      case 'lock_channel': {
        const chSnowflake = ResponseService.extractSnowflake(details.targetChannelId || details.resourceId || details.targetRef);
        if (chSnowflake) return `Locked <#${chSnowflake}>.`;
        const ch = (details.targetRef || 'channel').replace(/^#/, '');
        return `Locked #${ch}.`;
      }

      case 'unlock_channel': {
        const chSnowflake = ResponseService.extractSnowflake(details.targetChannelId || details.resourceId || details.targetRef);
        if (chSnowflake) return `Unlocked <#${chSnowflake}>.`;
        const ch = (details.targetRef || 'channel').replace(/^#/, '');
        return `Unlocked #${ch}.`;
      }

      case 'edit_channel_topic': {
        const chSnowflake = ResponseService.extractSnowflake(details.targetChannelId || details.resourceId || details.targetRef);
        const topic = details.topic || details.args?.topic || '';
        if (chSnowflake) return `Set topic of <#${chSnowflake}> to "${topic}".`;
        const ch = (details.targetRef || 'channel').replace(/^#/, '');
        return `Set topic of #${ch} to "${topic}".`;
      }

      case 'set_channel_slowmode': {
        const chSnowflake = ResponseService.extractSnowflake(details.targetChannelId || details.resourceId || details.targetRef);
        const sec = details.seconds || details.args?.seconds || 0;
        if (chSnowflake) return `Slowmode in <#${chSnowflake}> set to ${sec}s.`;
        const ch = (details.targetRef || 'channel').replace(/^#/, '');
        return `Slowmode in #${ch} set to ${sec}s.`;
      }

      case 'change_nickname': {
        const snowflake = ResponseService.extractSnowflake(details.targetMemberId || details.resourceId || details.targetMember);
        const member = snowflake ? `<@${snowflake}>` : `@${String(details.targetMember || 'member').replace(/^@/, '')}`;
        const nick = details.nickname || details.args?.nickname || '';
        return `Changed nickname for ${member} to "${nick}".`;
      }

      case 'remove_nickname': {
        const snowflake = ResponseService.extractSnowflake(details.targetMemberId || details.resourceId || details.targetMember);
        const member = snowflake ? `<@${snowflake}>` : `@${String(details.targetMember || 'member').replace(/^@/, '')}`;
        return `Removed server nickname for ${member}.`;
      }

      case 'inspect_nickname': {
        return details.details ? cleanText(details.details) : 'Inspected nickname.';
      }

      case 'lookup_member': {
        return details.details ? cleanText(details.details) : 'Retrieved member profile.';
      }

      case 'setup_ticket_system': {
        const chSnowflake = ResponseService.extractSnowflake(details.targetChannelId || details.resourceId);
        if (chSnowflake) return `Ticket system configured in <#${chSnowflake}>.`;
        const ch = details.channelName || details.args?.channelName || 'tickets';
        return `Ticket system configured in #${ch.replace(/^#/, '')}.`;
      }

      default: {
        if (details.details) {
          return cleanText(details.details);
        }
        return 'Action completed.';
      }
    }
  }

  /**
   * Formats a failure outcome truthfully identifying target and reason when known.
   */
  static formatFailure(action, errorMsg = '', details = {}) {
    const act = String(action || '').toLowerCase();
    const cleanError = ResponseService.sanitizeText(errorMsg || 'Execution encountered an unexpected issue.');

    const targetSnowflake = ResponseService.extractSnowflake(details.targetMemberId || details.targetChannelId || details.targetRoleId || details.resourceId);
    let target = '';
    if (targetSnowflake) {
      if (['kick_member', 'ban_member', 'timeout_member', 'remove_timeout'].includes(act)) {
        target = `<@${targetSnowflake}>`;
      } else if (['rename_channel', 'edit_channel_topic', 'lock_channel', 'unlock_channel'].includes(act)) {
        target = `<#${targetSnowflake}>`;
      } else if (['assign_role', 'remove_role'].includes(act)) {
        target = `<@&${targetSnowflake}>`;
      }
    }
    if (!target) {
      const rawTarget = details.targetRef || details.targetChannel || details.targetRole || details.targetMember || '';
      target = rawTarget ? `@${String(rawTarget).replace(/^[@#]/, '')}` : '';
    }

    if (cleanError.includes('Missing Permissions') || cleanError.includes('50013') || cleanError.includes('lacks required permission')) {
      if (act === 'ban_member') return `Couldn't ban ${target || '@user'}. The bot lacks the required permission.`;
      if (act === 'kick_member') return `Couldn't kick ${target || '@member'}. The bot lacks the required permission.`;
      if (act === 'timeout_member') return `Couldn't time out ${target || '@member'}. The bot lacks the required permission.`;
      return `Couldn't complete the action. The bot is missing the required permission.`;
    }

    if (cleanError.includes('Hierarchy') || cleanError.includes('higher than')) {
      return `Couldn't complete the action because of role hierarchy restrictions.`;
    }

    if (cleanError.includes('not found')) {
      return `Target resource could not be found.`;
    }

    return `Couldn't complete the action: ${cleanError}`;
  }

  /**
   * Formats a denied outcome (blocked by authorization or security gate).
   */
  static formatDenied(reason = '') {
    const cleanReason = ResponseService.sanitizeText(reason);
    return cleanReason ? `Request blocked by security policy: ${cleanReason}` : 'Request was blocked by security permissions or policy.';
  }

  /**
   * Formats an unverified or inconclusive outcome.
   */
  static formatUnverified() {
    return "The change was submitted, but I couldn't verify the final state.";
  }

  /**
   * Formats an already completed (idempotent no-op) outcome.
   */
  static formatAlreadyCompleted(action, targetRef) {
    const target = targetRef ? ` for ${targetRef}` : '';
    return `The requested state is already present${target}. No duplicate mutation was performed.`;
  }

  /**
   * Builds an action outcome response payload based on result structure.
   */
  static formatActionOutcome(action, opResult = {}, details = {}) {
    if (!opResult.success) {
      const text = ResponseService.formatFailure(action, opResult.error, details);
      return {
        outcomeClass: OutcomeClass.FAILURE,
        content: text,
        embeds: [],
        allowedMentions: ResponseService.getAllowedMentions()
      };
    }

    if (opResult.verificationStatus === 'inconclusive' || (opResult.verified === false && opResult.status === 'inconclusive')) {
      return {
        outcomeClass: OutcomeClass.UNVERIFIED,
        content: ResponseService.formatUnverified(),
        embeds: [],
        allowedMentions: ResponseService.getAllowedMentions()
      };
    }

    const mergedDetails = { ...details, ...opResult };
    const text = ResponseService.formatSuccess(action, mergedDetails);
    const embeds = opResult.embeds || (opResult.embed ? [opResult.embed] : []);
    return {
      outcomeClass: OutcomeClass.SUCCESS,
      content: text,
      embeds,
      allowedMentions: ResponseService.getAllowedMentions()
    };
  }

  /**
   * Builds a structured Embed for multi-step execution plans.
   */
  static buildMultiActionEmbed(plan, results = [], executionId) {
    const total = results.length;
    const passed = results.filter(r => r.status === 'COMPLETED' || r.status === 'passed').length;
    const failed = results.filter(r => r.status === 'FAILED' || r.status === 'failed' || r.status === 'MISMATCH').length;
    const skipped = results.filter(r => r.status === 'SKIPPED' || r.status === 'skipped').length;

    let color = 0x57F287; // Green
    if (failed > 0 && passed === 0) color = 0xED4245; // Red
    else if (failed > 0 || skipped > 0) color = 0xFEE75C; // Yellow

    const embed = new EmbedBuilder()
      .setTitle('Multi-Step Plan Execution')
      .setColor(color)
      .setTimestamp();

    if (executionId) {
      embed.setFooter({ text: `Honey Bot Execution • ${executionId}` });
    }

    if (plan.thoughtProcess) {
      embed.setDescription(ResponseService.sanitizeText(plan.thoughtProcess).slice(0, 4000));
    }

    // Add up to 25 fields for step items
    const fieldCount = Math.min(results.length, 25);
    for (let i = 0; i < fieldCount; i++) {
      const r = results[i];
      const statusIcon = r.status === 'COMPLETED' || r.status === 'passed' ? '✔' : (r.status === 'SKIPPED' ? '↷' : '✖');
      const act = r.action || `Step ${i + 1}`;
      const outcomeText = r.details || r.observedOutcome || r.status;

      embed.addFields({
        name: `${statusIcon} ${act}`,
        value: ResponseService.sanitizeText(String(outcomeText)).slice(0, 1024),
        inline: false
      });
    }

    return embed;
  }

  /**
   * Builds a structured Embed for moderation log troubleshooting & reports.
   */
  static buildModlogReportEmbed(report = {}, guild) {
    const isHealthy = report.status === 'healthy';
    const embed = new EmbedBuilder()
      .setTitle('Moderation Log Inspection & Audit')
      .setColor(isHealthy ? 0x57F287 : 0xFEE75C)
      .setTimestamp();

    const chMention = report.channelId ? `<#${report.channelId}>` : 'None configured';
    embed.addFields(
      { name: 'Logging Status', value: report.enabled ? 'Enabled' : 'Disabled', inline: true },
      { name: 'Configured Channel', value: chMention, inline: true },
      { name: 'Permissions', value: report.hasPermission ? 'Valid (Send Messages & Embeds)' : (report.permissionError || 'Missing permissions'), inline: false }
    );

    if (typeof report.pendingCount === 'number') {
      embed.addFields({ name: 'Pending Queue', value: `${report.pendingCount} delivery queued`, inline: true });
    }

    if (report.repairOutcome) {
      embed.addFields({ name: 'Auto-Repair Result', value: ResponseService.sanitizeText(report.repairOutcome), inline: false });
    }

    if (report.userMessage) {
      embed.setDescription(ResponseService.sanitizeText(report.userMessage).slice(0, 2048));
    }

    return embed;
  }

  /**
   * Builds a structured Embed for detailed system diagnostics.
   */
  static buildDiagnosticEmbed(diagnosticResult = {}, correlationId) {
    const isHealthy = diagnosticResult.status === 'healthy';
    const embed = new EmbedBuilder()
      .setTitle('Honey Bot Diagnostics')
      .setColor(isHealthy ? 0x57F287 : (diagnosticResult.status === 'failed' ? 0xED4245 : 0xFEE75C))
      .setTimestamp();

    if (correlationId) {
      embed.setFooter({ text: `Diagnostics • ${correlationId}` });
    }

    if (diagnosticResult.response) {
      embed.setDescription(ResponseService.sanitizeText(diagnosticResult.response).slice(0, 4000));
    }

    if (diagnosticResult.checks && typeof diagnosticResult.checks === 'object') {
      for (const [key, check] of Object.entries(diagnosticResult.checks)) {
        if (embed.data.fields && embed.data.fields.length >= 25) break;
        const icon = check.status === 'healthy' ? '✔' : '✖';
        embed.addFields({
          name: `${icon} ${key}`,
          value: ResponseService.sanitizeText(check.details || check.status || 'OK').slice(0, 1024),
          inline: true
        });
      }
    }

    return embed;
  }

  /**
   * Responds to a Discord interaction safely, handling deferral state
   * and enforcing default allowedMentions to prevent mass notifications.
   */
  static async respondToInteraction(interaction, payload = {}) {
    const allowedMentions = payload.allowedMentions || ResponseService.getAllowedMentions();
    const finalPayload = {
      content: payload.content || '',
      embeds: payload.embeds || [],
      components: payload.components || [],
      allowedMentions
    };

    if (payload.ephemeral) {
      finalPayload.ephemeral = true;
    }

    try {
      if (interaction.deferred || interaction.replied) {
        return await interaction.editReply(finalPayload);
      }
      return await interaction.reply(finalPayload);
    } catch (err) {
      logger.error('Failed to deliver interaction response', { error: err.message });
      try {
        if (!interaction.replied) {
          return await interaction.followUp({
            content: finalPayload.content || 'Action executed.',
            ephemeral: true,
            allowedMentions
          });
        }
      } catch {
        // Fallback suppressed to avoid uncaught rejection
      }
      return null;
    }
  }
}
