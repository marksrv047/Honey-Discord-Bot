/**
 * Premium Minimal Response Formatter for Honey Bot.
 *
 * Enforces calm, composed, professional, and understated messaging.
 * Ordinary responses contain no emojis by default.
 * Outputs concise outcomes rather than narrated activities.
 */

/**
 * Strips any stray leading/trailing emojis or decorative symbols.
 */
export function cleanText(str) {
  if (!str) return '';
  return str
    .replace(/^[\s\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E0}-\u{1F1FF}🍯🐝🛑⚠️❌✅🔍🏷️💡🎉🚀✨0-9#*•\-–—]+\s*/u, '')
    .trim();
}

/**
 * Formats a clean, minimal outcome message for single actions.
 */
export function formatSingleOutcome(intentOrAction, opResult, details = {}) {
  if (!opResult || !opResult.success) {
    const errorMsg = opResult?.error || 'Execution encountered an unexpected issue.';
    // Format calm failure explanations
    if (errorMsg.includes('Missing Permissions') || errorMsg.includes('50013') || errorMsg.includes('lacks required permission')) {
      return `Couldn't complete the action. The bot is missing the required permission.`;
    }
    if (errorMsg.includes('Hierarchy') || errorMsg.includes('higher than')) {
      return `Couldn't complete the action because of role hierarchy restrictions.`;
    }
    if (errorMsg.includes('not found')) {
      return `Target resource could not be found.`;
    }
    return `Couldn't complete the action: ${errorMsg}`;
  }

  // If verification failed or was inconclusive
  if (opResult.verificationStatus === 'inconclusive' || opResult.verified === false && opResult.status === 'inconclusive') {
    return 'The change was submitted, but I couldn\'t verify the final state.';
  }

  const action = intentOrAction.toLowerCase();
  const target = details.targetRef || details.targetChannel || details.targetRole || details.targetMember || '';

  switch (action) {
    case 'rename_channel': {
      const name = details.name || details.args?.name || '';
      return `Renamed #${target.replace(/^#/, '')} to #${name}.`;
    }

    case 'send_announcement': {
      const ch = (details.targetRef || details.channel || 'announcements').replace(/^#/, '');
      return `Announcement posted in #${ch}.`;
    }

    case 'send_message': {
      const ch = (details.targetRef || details.channel || 'channel').replace(/^#/, '');
      return `Message posted in #${ch}.`;
    }

    case 'assign_role': {
      const role = (details.targetRole || details.role || details.args?.role || 'role').replace(/^@/, '');
      const member = (details.targetMember || details.member || details.args?.targetMember || 'member').replace(/^@/, '');
      return `Assigned the ${role} role to @${member}.`;
    }

    case 'remove_role': {
      const role = (details.targetRole || details.role || details.args?.role || 'role').replace(/^@/, '');
      const member = (details.targetMember || details.member || details.args?.targetMember || 'member').replace(/^@/, '');
      return `Removed the ${role} role from @${member}.`;
    }

    case 'kick_member': {
      const member = (details.targetMember || details.member || 'member').replace(/^@/, '');
      return `Kicked @${member} from the server.`;
    }

    case 'ban_member': {
      const member = (details.targetMember || details.member || 'user').replace(/^@/, '');
      return `Banned @${member} from the server.`;
    }

    case 'lock_channel': {
      const ch = (details.targetRef || 'channel').replace(/^#/, '');
      return `Locked #${ch}.`;
    }

    case 'unlock_channel': {
      const ch = (details.targetRef || 'channel').replace(/^#/, '');
      return `Unlocked #${ch}.`;
    }

    case 'set_channel_slowmode': {
      const ch = (details.targetRef || 'channel').replace(/^#/, '');
      const sec = details.seconds || details.args?.seconds || 0;
      return `Slowmode in #${ch} set to ${sec}s.`;
    }

    case 'create_channel': {
      const name = details.name || details.args?.name || 'channel';
      return `Created #${name}.`;
    }

    case 'delete_channel': {
      const name = (details.targetRef || details.targetChannel || 'channel').replace(/^#/, '');
      return `Deleted #${name}.`;
    }

    case 'create_role': {
      const name = details.name || details.args?.name || 'role';
      return `Created role @${name}.`;
    }

    case 'delete_role': {
      const name = (details.targetRef || details.targetRole || 'role').replace(/^@/, '');
      return `Deleted role @${name}.`;
    }

    case 'change_nickname': {
      const member = (details.targetMember || 'member').replace(/^@/, '');
      const nick = details.nickname || details.args?.nickname || '';
      return `Changed nickname for @${member} to "${nick}".`;
    }

    case 'purge_messages': {
      const count = details.count || details.args?.count || 5;
      const ch = (details.targetRef || 'channel').replace(/^#/, '');
      return `Purged ${count} messages in #${ch}.`;
    }

    case 'setup_ticket_system': {
      const ch = details.channelName || details.args?.channelName || 'tickets';
      return `Ticket system configured in #${ch}.`;
    }

    default: {
      if (opResult.details) {
        // Strip emojis and prefixes
        return cleanText(opResult.details);
      }
      return 'Action completed.';
    }
  }
}

/**
 * Formats a concise confirmation message.
 */
export function formatConfirmationQuestion(action, targetRef) {
  const cleanTarget = String(targetRef).replace(/^[@#]/, '');
  switch (action) {
    case 'ban_member':
      return `Confirm ban of @${cleanTarget}?`;
    case 'kick_member':
      return `Confirm kick of @${cleanTarget}?`;
    case 'delete_channel':
      return `Confirm deletion of #${cleanTarget}?`;
    case 'delete_role':
      return `Confirm deletion of role @${cleanTarget}?`;
    default:
      return `Confirm execution of ${action}?`;
  }
}

/**
 * Formats a calm summary for multi-step tasks.
 */
export function formatMultiActionSummary(results) {
  const total = results.length;
  const passed = results.filter(r => r.status === 'COMPLETED' || r.status === 'passed').length;
  const failed = results.filter(r => r.status === 'FAILED' || r.status === 'failed' || r.status === 'MISMATCH').length;
  const inconclusive = results.filter(r => r.status === 'inconclusive' || r.status === 'UNVERIFIED').length;

  if (failed === 0 && inconclusive === 0) {
    return `Completed ${total} of ${total} actions.`;
  }

  const firstFailure = results.find(r => r.status === 'FAILED' || r.status === 'failed' || r.status === 'MISMATCH');
  const failureReason = firstFailure?.details || 'a permission or validation failure';

  return `Completed ${passed} of ${total} actions. The ${firstFailure?.action || 'subsequent'} update failed: ${cleanText(failureReason)}.`;
}

/**
 * Formats audit and health check outcomes.
 */
export function formatAuditSummary(healthReport) {
  const { summary } = healthReport;
  return `Audit complete. ${summary.passed} checks passed, ${summary.failed} issues found, and ${summary.inconclusive + summary.skipped} could not run.`;
}
