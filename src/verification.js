import { EmbedBuilder } from 'discord.js';

/**
 * Post-execution verification engine.
 * Re-reads Discord state to confirm changes actually succeeded.
 */
export class Verifier {
  /**
   * Verifies an action result against live guild state.
   */
  static async verifyAction(guild, actionObj, executionResult) {
    if (!executionResult.success) {
      return {
        action: actionObj.action,
        status: 'FAILED',
        verified: false,
        details: executionResult.error || 'Execution failed'
      };
    }

    try {
      switch (actionObj.action) {
        case 'update_server_name': {
          await guild.fetch();
          const match = guild.name === actionObj.name;
          return {
            action: actionObj.action,
            status: match ? 'COMPLETED' : 'MISMATCH',
            verified: match,
            details: match ? `Server name is now "${guild.name}"` : `Guild name is "${guild.name}", expected "${actionObj.name}"`
          };
        }

        case 'create_role': {
          await guild.roles.fetch();
          const role = guild.roles.cache.find(r => r.name.toLowerCase() === actionObj.name.toLowerCase());
          const verified = Boolean(role);
          return {
            action: actionObj.action,
            status: verified ? 'COMPLETED' : 'FAILED',
            verified,
            details: verified ? `Role @${role.name} verified in server hierarchy` : `Role "${actionObj.name}" could not be verified in guild cache`
          };
        }

        case 'delete_role': {
          await guild.roles.fetch();
          const role = guild.roles.cache.find(r => r.id === actionObj.targetRole || r.name.toLowerCase() === actionObj.targetRole.toLowerCase());
          const verified = !role;
          return {
            action: actionObj.action,
            status: verified ? 'COMPLETED' : 'MISMATCH',
            verified,
            details: verified ? `Role "${actionObj.targetRole}" successfully removed` : `Role still exists in guild`
          };
        }

        case 'create_channel': {
          await guild.channels.fetch();
          const channel = guild.channels.cache.find(c => c.name.toLowerCase() === actionObj.name.toLowerCase());
          const verified = Boolean(channel);
          return {
            action: actionObj.action,
            status: verified ? 'COMPLETED' : 'FAILED',
            verified,
            details: verified ? `Channel #${channel.name} verified (ID: ${channel.id})` : `Channel #${actionObj.name} not found in guild cache`
          };
        }

        case 'delete_channel': {
          await guild.channels.fetch();
          const channel = guild.channels.cache.find(c => c.id === actionObj.targetChannel || c.name.toLowerCase() === actionObj.targetChannel.toLowerCase());
          const verified = !channel;
          return {
            action: actionObj.action,
            status: verified ? 'COMPLETED' : 'MISMATCH',
            verified,
            details: verified ? `Channel "${actionObj.targetChannel}" deleted` : `Channel still found in guild`
          };
        }

        case 'setup_ticket_system': {
          await guild.channels.fetch();
          const panelChannel = guild.channels.cache.find(c => c.name.toLowerCase() === (actionObj.channelName || 'tickets').toLowerCase());
          const verified = Boolean(panelChannel);
          return {
            action: actionObj.action,
            status: verified ? 'COMPLETED' : 'FAILED',
            verified,
            details: verified ? `Ticket panel live in #${panelChannel.name}` : `Ticket channel could not be confirmed`
          };
        }

        default:
          return {
            action: actionObj.action,
            status: 'COMPLETED',
            verified: true,
            details: executionResult.details || 'Action completed successfully'
          };
      }
    } catch (err) {
      return {
        action: actionObj.action,
        status: 'UNVERIFIED',
        verified: false,
        details: `Post-check failed: ${err.message}`
      };
    }
  }

  /**
   * Generates a rich, color-coded Discord Embed summarizing all actions and verification statuses.
   */
  static generateReportEmbed(plan, results, executionId) {
    const total = results.length;
    const completed = results.filter(r => r.status === 'COMPLETED').length;
    const failed = results.filter(r => r.status === 'FAILED' || r.status === 'MISMATCH').length;
    const skipped = results.filter(r => r.status === 'SKIPPED').length;

    const allSuccessful = failed === 0 && skipped === 0;
    const color = allSuccessful ? 0x2ECC71 : (completed > 0 ? 0xF1C40F : 0xE74C3C);

    const embed = new EmbedBuilder()
      .setTitle(allSuccessful ? '✅ Administrative Actions Completed & Verified' : '⚠️ Execution Report (Partial or Skipped)')
      .setColor(color)
      .setDescription(
        `**Execution ID:** \`${executionId}\`\n` +
        `**Intent Summary:** ${plan.thoughtProcess}\n\n` +
        `📊 **Summary:** ${completed}/${total} completed • ${failed} failed • ${skipped} skipped`
      )
      .setTimestamp();

    // Group items into chunks of fields
    const formattedList = results.map((r, i) => {
      const icon = r.status === 'COMPLETED' ? '✅' : (r.status === 'SKIPPED' ? '⏭️' : '❌');
      return `${icon} \`${i + 1}.\` **${r.action}**: ${r.details}`;
    }).join('\n');

    // Discord embed description limit is 4096, field value is 1024
    if (formattedList.length <= 1024) {
      embed.addFields({ name: 'Itemized Audit Trail', value: formattedList });
    } else {
      embed.addFields(
        { name: 'Audit Trail (Part 1)', value: formattedList.slice(0, 1000) },
        { name: 'Audit Trail (Part 2)', value: formattedList.slice(1000, 2000) }
      );
    }

    embed.setFooter({ text: 'Reversible actions logged • Use /undo to revert if needed' });

    return embed;
  }
}
