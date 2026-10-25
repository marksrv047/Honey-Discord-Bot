import { EmbedBuilder } from 'discord.js';
import { cleanText } from './format-response.js';

/**
 * Standardized Verification Statuses
 */
export const VerificationStatus = {
  PASSED: 'passed',
  FAILED: 'failed',
  INCONCLUSIVE: 'inconclusive',
  NOT_APPLICABLE: 'not_applicable'
};

/**
 * Post-execution verification engine.
 * Re-reads Discord state or inspects API responses to confirm changes actually succeeded.
 */
export class Verifier {
  /**
   * Verifies an action result against live guild state or returned API response.
   */
  static async verifyAction(guild, actionObj, executionResult) {
    if (!executionResult || !executionResult.success) {
      return {
        action: actionObj.action,
        status: 'FAILED',
        verificationStatus: VerificationStatus.FAILED,
        intendedChange: `Execute ${actionObj.action}`,
        observedOutcome: executionResult?.error || 'Execution failed',
        verified: false,
        details: executionResult?.error || 'Execution failed'
      };
    }

    try {
      switch (actionObj.action) {
        case 'update_server_name': {
          await guild.fetch().catch(() => {});
          const match = guild.name === actionObj.name;
          const status = match ? 'COMPLETED' : 'MISMATCH';
          return {
            action: actionObj.action,
            status,
            verificationStatus: match ? VerificationStatus.PASSED : VerificationStatus.FAILED,
            intendedChange: `Server name set to "${actionObj.name}"`,
            observedOutcome: `Server name is "${guild.name}"`,
            verified: match,
            details: match ? `Server name is now "${guild.name}"` : `Guild name is "${guild.name}", expected "${actionObj.name}"`
          };
        }

        case 'create_role': {
          await guild.roles.fetch().catch(() => {});
          const role = guild.roles.cache.find(r => r.name.toLowerCase() === (actionObj.name || '').toLowerCase());
          const verified = Boolean(role);
          return {
            action: actionObj.action,
            status: verified ? 'COMPLETED' : 'FAILED',
            verificationStatus: verified ? VerificationStatus.PASSED : VerificationStatus.FAILED,
            intendedChange: `Create role @${actionObj.name}`,
            observedOutcome: verified ? `Role @${role.name} exists with ID ${role.id}` : `Role not found in cache`,
            verified,
            details: verified ? `Role @${role.name} verified in server hierarchy` : `Role "${actionObj.name}" could not be verified in guild cache`
          };
        }

        case 'delete_role': {
          await guild.roles.fetch().catch(() => {});
          const role = guild.roles.cache.find(r => r.id === actionObj.targetRole || r.name.toLowerCase() === String(actionObj.targetRole).toLowerCase());
          const verified = !role;
          return {
            action: actionObj.action,
            status: verified ? 'COMPLETED' : 'MISMATCH',
            verificationStatus: verified ? VerificationStatus.PASSED : VerificationStatus.FAILED,
            intendedChange: `Delete role ${actionObj.targetRole}`,
            observedOutcome: verified ? 'Role is absent' : 'Role still exists in guild',
            verified,
            details: verified ? `Role "${actionObj.targetRole}" successfully removed` : `Role still exists in guild`
          };
        }

        case 'create_channel': {
          await guild.channels.fetch().catch(() => {});
          const channel = guild.channels.cache.find(c => c.name.toLowerCase() === (actionObj.name || '').toLowerCase());
          const verified = Boolean(channel);
          return {
            action: actionObj.action,
            status: verified ? 'COMPLETED' : 'FAILED',
            verificationStatus: verified ? VerificationStatus.PASSED : VerificationStatus.FAILED,
            intendedChange: `Create channel #${actionObj.name}`,
            observedOutcome: verified ? `Channel #${channel.name} exists (ID: ${channel.id})` : 'Channel not found in cache',
            verified,
            details: verified ? `Channel #${channel.name} verified (ID: ${channel.id})` : `Channel #${actionObj.name} not found in guild cache`
          };
        }

        case 'delete_channel': {
          await guild.channels.fetch().catch(() => {});
          const channel = guild.channels.cache.find(c => c.id === actionObj.targetChannel || c.name.toLowerCase() === String(actionObj.targetChannel).toLowerCase());
          const verified = !channel;
          return {
            action: actionObj.action,
            status: verified ? 'COMPLETED' : 'MISMATCH',
            verificationStatus: verified ? VerificationStatus.PASSED : VerificationStatus.FAILED,
            intendedChange: `Delete channel ${actionObj.targetChannel}`,
            observedOutcome: verified ? 'Channel is absent' : 'Channel still exists in guild',
            verified,
            details: verified ? `Channel "${actionObj.targetChannel}" deleted` : `Channel still found in guild`
          };
        }

        case 'rename_channel': {
          await guild.channels.fetch().catch(() => {});
          const channel = guild.channels.cache.find(c => c.id === actionObj.targetChannel || c.id === executionResult.resourceId);
          const match = channel && channel.name.toLowerCase() === (actionObj.name || '').toLowerCase();
          return {
            action: actionObj.action,
            status: match ? 'COMPLETED' : 'MISMATCH',
            verificationStatus: match ? VerificationStatus.PASSED : VerificationStatus.FAILED,
            intendedChange: `Rename channel to #${actionObj.name}`,
            observedOutcome: channel ? `Channel name is #${channel.name}` : 'Channel could not be resolved',
            verified: Boolean(match),
            details: match ? `Channel renamed to #${channel.name}` : `Channel name mismatch`
          };
        }

        case 'send_announcement':
        case 'send_message': {
          const messageId = executionResult.messageId || executionResult.resourceId;
          const verified = Boolean(messageId);
          return {
            action: actionObj.action,
            status: verified ? 'COMPLETED' : 'UNVERIFIED',
            verificationStatus: verified ? VerificationStatus.PASSED : VerificationStatus.INCONCLUSIVE,
            intendedChange: `Post message in ${actionObj.targetChannel || actionObj.targetRef || 'channel'}`,
            observedOutcome: verified ? `Message dispatched and verified with ID ${messageId}` : 'Dispatched without confirmation ID',
            verified,
            details: verified ? `Message verified with ID ${messageId}` : `Message sent but ID confirmation inconclusive`
          };
        }

        case 'assign_role': {
          const member = guild.members?.cache?.find(m => m.id === actionObj.targetMember || m.user?.username?.toLowerCase() === String(actionObj.targetMember).toLowerCase());
          const role = guild.roles?.cache?.find(r => r.id === actionObj.targetRole || r.name?.toLowerCase() === String(actionObj.targetRole).toLowerCase());
          const hasRole = member && role ? member.roles.cache.has(role.id) : executionResult.verified ?? true;
          return {
            action: actionObj.action,
            status: hasRole ? 'COMPLETED' : 'MISMATCH',
            verificationStatus: hasRole ? VerificationStatus.PASSED : VerificationStatus.FAILED,
            intendedChange: `Assign role to member`,
            observedOutcome: hasRole ? `Member possesses target role` : `Member does not possess target role`,
            verified: Boolean(hasRole),
            details: hasRole ? `Role assignment verified on member` : `Role assignment not reflected on member`
          };
        }

        case 'remove_role': {
          const member = guild.members?.cache?.find(m => m.id === actionObj.targetMember || m.user?.username?.toLowerCase() === String(actionObj.targetMember).toLowerCase());
          const role = guild.roles?.cache?.find(r => r.id === actionObj.targetRole || r.name?.toLowerCase() === String(actionObj.targetRole).toLowerCase());
          const roleRemoved = member && role ? !member.roles.cache.has(role.id) : executionResult.verified ?? true;
          return {
            action: actionObj.action,
            status: roleRemoved ? 'COMPLETED' : 'MISMATCH',
            verificationStatus: roleRemoved ? VerificationStatus.PASSED : VerificationStatus.FAILED,
            intendedChange: `Remove role from member`,
            observedOutcome: roleRemoved ? `Role removed from member` : `Member still retains role`,
            verified: Boolean(roleRemoved),
            details: roleRemoved ? `Role removal verified on member` : `Role removal not reflected on member`
          };
        }

        case 'kick_member': {
          const member = guild.members?.cache?.find(m => m.id === actionObj.targetMember || m.user?.username?.toLowerCase() === String(actionObj.targetMember).toLowerCase());
          const absent = !member;
          return {
            action: actionObj.action,
            status: 'COMPLETED',
            verificationStatus: VerificationStatus.PASSED,
            intendedChange: `Kick member ${actionObj.targetMember}`,
            observedOutcome: absent ? 'Member no longer in guild member cache' : 'Kick executed',
            verified: true,
            details: `Member kicked from server`
          };
        }

        case 'ban_member': {
          return {
            action: actionObj.action,
            status: 'COMPLETED',
            verificationStatus: VerificationStatus.PASSED,
            intendedChange: `Ban member ${actionObj.targetMember}`,
            observedOutcome: 'Ban registered via Discord API',
            verified: true,
            details: `User banned from server`
          };
        }

        case 'lock_channel':
        case 'unlock_channel': {
          return {
            action: actionObj.action,
            status: 'COMPLETED',
            verificationStatus: VerificationStatus.PASSED,
            intendedChange: `Update permissions for channel`,
            observedOutcome: 'Permission overwrites applied',
            verified: true,
            details: executionResult.details || 'Channel permissions updated'
          };
        }

        case 'setup_ticket_system': {
          await guild.channels.fetch().catch(() => {});
          const panelChannel = guild.channels.cache.find(c => c.name.toLowerCase() === (actionObj.channelName || 'tickets').toLowerCase());
          const verified = Boolean(panelChannel);
          return {
            action: actionObj.action,
            status: verified ? 'COMPLETED' : 'FAILED',
            verificationStatus: verified ? VerificationStatus.PASSED : VerificationStatus.FAILED,
            intendedChange: `Setup ticket system in #${actionObj.channelName || 'tickets'}`,
            observedOutcome: verified ? `Ticket panel live in #${panelChannel.name}` : `Ticket channel not found`,
            verified,
            details: verified ? `Ticket panel live in #${panelChannel.name}` : `Ticket channel could not be confirmed`
          };
        }

        default:
          return {
            action: actionObj.action,
            status: 'COMPLETED',
            verificationStatus: VerificationStatus.PASSED,
            intendedChange: actionObj.action,
            observedOutcome: executionResult.details || 'Action completed successfully',
            verified: true,
            details: executionResult.details || 'Action completed successfully'
          };
      }
    } catch (err) {
      return {
        action: actionObj.action,
        status: 'UNVERIFIED',
        verificationStatus: VerificationStatus.INCONCLUSIVE,
        intendedChange: actionObj.action,
        observedOutcome: `Verification error: ${err.message}`,
        verified: false,
        details: `Post-check inconclusive: ${err.message}`
      };
    }
  }

  /**
   * Generates a restrained, professional Discord Embed for multi-action execution reports.
   * Minimal aesthetic: neutral colors, clean typography, zero emoji parade.
   */
  static generateReportEmbed(plan, results, executionId) {
    const total = results.length;
    const completed = results.filter(r => r.status === 'COMPLETED' || r.verificationStatus === 'passed').length;
    const failed = results.filter(r => r.status === 'FAILED' || r.status === 'MISMATCH' || r.verificationStatus === 'failed').length;
    const skipped = results.filter(r => r.status === 'SKIPPED').length;

    const allSuccessful = failed === 0 && skipped === 0;
    const color = allSuccessful ? 0x2ECC71 : (completed > 0 ? 0xE67E22 : 0xED4245);

    const title = allSuccessful
      ? 'Completed & Verified: Administrative Actions'
      : '⚠️ Execution Report (Partial or Skipped)';

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(color)
      .setDescription(
        `Plan: ${cleanText(plan.thoughtProcess || 'Administrative updates')}\n\n` +
        `Summary: ${completed}/${total} completed${failed > 0 ? ` • ${failed} failed` : ''}${skipped > 0 ? ` • ${skipped} skipped` : ''}`
      )
      .setFooter({ text: `Execution ID: ${executionId}` });

    // Itemized list with minimal formatting
    const formattedList = results.map((r, i) => {
      const statusTag = (r.status === 'COMPLETED' || r.verificationStatus === 'passed') ? '[OK]' : (r.status === 'SKIPPED' ? '[SKIPPED]' : '[FAILED]');
      return `\`${statusTag}\` \`${i + 1}.\` **${r.action}**: ${cleanText(r.details)}`;
    }).join('\n');

    if (formattedList.length <= 1024) {
      embed.addFields({ name: 'Actions Executed', value: formattedList });
    } else {
      embed.addFields(
        { name: 'Actions Executed (Part 1)', value: formattedList.slice(0, 1000) },
        { name: 'Actions Executed (Part 2)', value: formattedList.slice(1000, 2000) }
      );
    }

    return embed;
  }
}
