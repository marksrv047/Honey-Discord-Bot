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
 * Refines conversational, advisory, and suggestion messages.
 * - Strips cheesy persona fluff, bee puns, and filler introductions.
 * - Formats horizontal or squashed bullet points into clean vertical sequence with distinct newlines.
 * - Replaces '@Role' in suggestions with '**Role**' to avoid accidental mentions.
 * - Strips trailing filler slogans.
 */
export function formatRefinedResponse(text) {
  if (!text || typeof text !== 'string') return '';

  // 0. Unescape literal \n or \r\n escape sequences
  let cleaned = text
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .trim();

  // 1. Strip leading emojis and cheesy introductory fluff (iteratively handles chained phrases)
  let prev = '';
  while (prev !== cleaned) {
    prev = cleaned;
    cleaned = cleaned
      .replace(/^[\s\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E0}-\u{1F1FF}🍯🐝✨🎉🚀]+\s*/u, '')
      .replace(/^(?:buzz\s*buzz[!.]*|bzz[!.]*|happy\s+to\s+help[—\-:]*|hey\s+there[!.]*)\s*/i, '')
      .trim();
  }

  // 2. Strip cheesy trailing slogans
  cleaned = cleaned
    .replace(/\s*(?:Mix\s+and\s+match[^\n.]*[!.]*|Hope\s+this\s+helps[^\n.]*[!.]*|Feel\s+free\s+to\s+ask[^\n.]*[!.]*|Let\s+me\s+know\s+if\s+you\s+need[^\n.]*[!.]*)\s*$/i, '')
    .trim();

  // 3. Clean decorative embellishments before colons (e.g. "Elsewhere ˎˊ-:" -> "Elsewhere:")
  cleaned = cleaned.replace(/\s*[\u02CA\u02CB\u02CE\u02CF\u02D7\u208B\uFE63\uFF0D\u2212\u2014\-]+\s*:/g, ':');

  // 4. Ensure each bullet point begins on a fresh newline
  // Matches any bullet (•, ●, -, *) preceded by non-newline characters
  cleaned = cleaned.replace(/([^\n])\s*[•●]\s*/g, '$1\n• ');
  cleaned = cleaned.replace(/([^\n])\s*[-*]\s+([A-Z0-9*#@])/g, '$1\n• $2');
  cleaned = cleaned.replace(/([^\n])\s*(\d+\.)\s+([A-Z0-9*#@])/g, '$1\n$2 $3');

  // 5. Replace '@Role' at start of bullets with '**Role**' to prevent phantom Discord mentions
  cleaned = cleaned.replace(/(?:^|\n)\s*[•●\-*]\s*@([a-zA-Z0-9_\-]+)\b/g, '\n• **$1**');

  // 6. Ensure blank lines before headings if directly following text
  cleaned = cleaned.replace(/([^\n])\n(\*\*[^*]+\*\*)/g, '$1\n\n$2');

  // 7. Clean up spacing and multiple newlines
  cleaned = cleaned
    .split('\n')
    .map(line => line.trim())
    .filter((line, idx, arr) => line.length > 0 || (idx > 0 && arr[idx - 1].length > 0))
    .join('\n')
    .trim();

  // Capitalize first character
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  return cleaned;
}

function extractSnowflake(val) {
  if (!val) return null;
  const str = String(val).trim();
  if (/^\d{17,20}$/.test(str)) return str;
  const match = str.match(/<[@#&]!?(\d{17,20})>/);
  if (match) return match[1];
  return null;
}

/**
 * Formats a clean, minimal outcome message for single actions.
 */
export function formatSingleOutcome(intentOrAction, opResult, details = {}) {
  if (!opResult || !opResult.success) {
    const errorMsg = opResult?.error || 'Execution encountered an unexpected issue.';
    const action = intentOrAction.toLowerCase();
    const target = details.targetRef || details.targetChannel || details.targetRole || details.targetMember || '';
    const cleanTarget = String(target).replace(/^[@#]/, '');
    const reason = details.reason || details.args?.reason;

    // Specific failure explanations per action if target is available
    if (errorMsg.includes('Missing Permissions') || errorMsg.includes('50013') || errorMsg.includes('lacks required permission')) {
      if (action === 'ban_member') return `Couldn't ban @${cleanTarget || 'user'}. The bot lacks the required permission.`;
      if (action === 'kick_member') return `Couldn't kick @${cleanTarget || 'member'}. The bot lacks the required permission.`;
      if (action === 'timeout_member') return `Couldn't time out @${cleanTarget || 'member'}. The bot lacks the required permission.`;
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
  const reason = details.reason || details.args?.reason;

  switch (action) {
    case 'rename_channel': {
      const chSnowflake = extractSnowflake(details.targetChannelId || details.resourceId) || extractSnowflake(details.targetRef);
      const name = details.name || details.args?.name || '';
      if (chSnowflake && name) {
        return `Renamed <#${chSnowflake}> to #${name.replace(/^#/, '')}.`;
      }
      return `Renamed #${target.replace(/^#/, '')} to #${name.replace(/^#/, '')}.`;
    }

    case 'send_announcement': {
      const chSnowflake = extractSnowflake(details.targetChannelId || details.resourceId) || extractSnowflake(details.targetRef);
      if (chSnowflake) {
        return `Announcement posted in <#${chSnowflake}>.`;
      }
      const ch = (details.targetRef || details.channel || 'announcements').replace(/^#/, '');
      return `Announcement posted in #${ch}.`;
    }

    case 'send_message': {
      const chSnowflake = extractSnowflake(details.targetChannelId || details.resourceId) || extractSnowflake(details.targetRef);
      if (chSnowflake) {
        return `Message posted in <#${chSnowflake}>.`;
      }
      const ch = (details.targetRef || details.channel || 'channel').replace(/^#/, '');
      return `Message posted in #${ch}.`;
    }

    case 'assign_role': {
      const roleSnowflake = extractSnowflake(details.targetRoleId || details.resourceId) || extractSnowflake(details.targetRole);
      const memberSnowflake = extractSnowflake(details.targetMemberId) || extractSnowflake(details.targetMember);
      if (roleSnowflake && memberSnowflake) {
        return `Done — <@${memberSnowflake}> was given the <@&${roleSnowflake}> role.`;
      }
      const role = (details.targetRole || details.role || details.args?.role || 'role').replace(/^@/, '');
      const member = (details.targetMember || details.member || details.args?.targetMember || 'member').replace(/^@/, '');
      return `Assigned the ${role} role to @${member}.`;
    }

    case 'remove_role': {
      const roleSnowflake = extractSnowflake(details.targetRoleId || details.resourceId) || extractSnowflake(details.targetRole);
      const memberSnowflake = extractSnowflake(details.targetMemberId) || extractSnowflake(details.targetMember);
      if (roleSnowflake && memberSnowflake) {
        return `Done — <@&${roleSnowflake}> role removed from <@${memberSnowflake}>.${reason ? ` Reason: ${reason}.` : ''}`;
      }
      const role = (details.targetRole || details.role || details.args?.role || 'role').replace(/^@/, '');
      const member = (details.targetMember || details.member || details.args?.targetMember || 'member').replace(/^@/, '');
      if (reason) {
        return `Removed ${role} role from @${member}. Reason: ${reason}.`;
      }
      return `Removed the ${role} role from @${member}.`;
    }

    case 'kick_member': {
      const snowflake = extractSnowflake(details.targetMemberId || details.resourceId) || extractSnowflake(details.targetMember);
      if (snowflake) {
        if (reason) {
          return `Done — <@${snowflake}> was kicked from the server. Reason: ${reason}.`;
        }
        return `Done — <@${snowflake}> was kicked from the server.`;
      }
      const member = (details.targetMember || details.member || 'member').replace(/^@/, '');
      if (reason) {
        return `Kicked @${member}. Reason: ${reason}.`;
      }
      return `Kicked @${member} from the server.`;
    }

    case 'ban_member': {
      const snowflake = extractSnowflake(details.targetMemberId || details.resourceId) || extractSnowflake(details.targetMember);
      if (snowflake) {
        if (reason) {
          return `Done — <@${snowflake}> was banned from the server. Reason: ${reason}.`;
        }
        return `Done — <@${snowflake}> was banned from the server.`;
      }
      const member = (details.targetMember || details.member || 'user').replace(/^@/, '');
      if (reason) {
        return `Banned @${member}. Reason: ${reason}.`;
      }
      return `Banned @${member} from the server.`;
    }

    case 'timeout_member': {
      const snowflake = extractSnowflake(details.targetMemberId || details.resourceId) || extractSnowflake(details.targetMember);
      const mins = details.durationMinutes || details.args?.durationMinutes || 10;
      if (snowflake) {
        if (reason) {
          return `Timed out <@${snowflake}> for ${mins} minutes. Reason: ${reason}.`;
        }
        return `Timed out <@${snowflake}> for ${mins} minutes.`;
      }
      const member = (details.targetMember || details.member || 'member').replace(/^@/, '');
      if (reason) {
        return `Timed out @${member} for ${mins} minutes. Reason: ${reason}.`;
      }
      return `Timed out @${member} for ${mins} minutes.`;
    }

    case 'remove_timeout': {
      const snowflake = extractSnowflake(details.targetMemberId || details.resourceId) || extractSnowflake(details.targetMember);
      if (snowflake) {
        return `Removed timeout from <@${snowflake}>.`;
      }
      const member = (details.targetMember || details.member || 'member').replace(/^@/, '');
      return `Removed timeout from @${member}.`;
    }

    case 'unban_member': {
      const snowflake = extractSnowflake(details.targetMemberId || details.resourceId) || extractSnowflake(details.targetMember);
      if (snowflake) {
        return `Unbanned <@${snowflake}>.`;
      }
      const target = (details.targetMemberId || details.targetMember || 'user').replace(/^@/, '');
      return `Unbanned ${target}.`;
    }

    case 'edit_channel_topic': {
      const chSnowflake = extractSnowflake(details.targetChannelId || details.resourceId) || extractSnowflake(details.targetRef);
      const topic = details.topic || details.args?.topic || '';
      if (chSnowflake) return `Set topic of <#${chSnowflake}> to "${topic}".`;
      const ch = (details.targetRef || 'channel').replace(/^#/, '');
      return `Set topic of #${ch} to "${topic}".`;
    }

    case 'lock_channel': {
      const chSnowflake = extractSnowflake(details.targetChannelId || details.resourceId) || extractSnowflake(details.targetRef);
      if (chSnowflake) return `Locked <#${chSnowflake}>.`;
      const ch = (details.targetRef || 'channel').replace(/^#/, '');
      return `Locked #${ch}.`;
    }

    case 'unlock_channel': {
      const chSnowflake = extractSnowflake(details.targetChannelId || details.resourceId) || extractSnowflake(details.targetRef);
      if (chSnowflake) return `Unlocked <#${chSnowflake}>.`;
      const ch = (details.targetRef || 'channel').replace(/^#/, '');
      return `Unlocked #${ch}.`;
    }

    case 'set_channel_slowmode': {
      const chSnowflake = extractSnowflake(details.targetChannelId || details.resourceId) || extractSnowflake(details.targetRef);
      const sec = details.seconds || details.args?.seconds || 0;
      if (chSnowflake) return `Slowmode in <#${chSnowflake}> set to ${sec}s.`;
      const ch = (details.targetRef || 'channel').replace(/^#/, '');
      return `Slowmode in #${ch} set to ${sec}s.`;
    }

    case 'create_channel': {
      const chSnowflake = extractSnowflake(details.targetChannelId || details.resourceId);
      if (chSnowflake) {
        return `Created <#${chSnowflake}> for project updates.`;
      }
      const name = details.name || details.args?.name || 'channel';
      return `Created #${name.replace(/^#/, '')}.`;
    }

    case 'delete_channel': {
      const chSnowflake = extractSnowflake(details.targetChannelId || details.resourceId) || extractSnowflake(details.targetRef);
      const name = (details.targetRef || details.targetChannel || 'channel').replace(/^#/, '');
      if (chSnowflake) {
        return `Deleted \`${name}\` (channel ID: ${chSnowflake}).`;
      }
      return `Deleted #${name}.`;
    }

    case 'create_role': {
      const roleSnowflake = extractSnowflake(details.targetRoleId || details.resourceId);
      if (roleSnowflake) {
        return `Created role <@&${roleSnowflake}>.`;
      }
      const name = details.name || details.args?.name || 'role';
      return `Created role @${name.replace(/^@/, '')}.`;
    }

    case 'delete_role': {
      const roleSnowflake = extractSnowflake(details.targetRoleId || details.resourceId) || extractSnowflake(details.targetRef);
      const name = (details.targetRef || details.targetRole || 'role').replace(/^@/, '');
      if (roleSnowflake) {
        return `Deleted role \`${name}\` (role ID: ${roleSnowflake}).`;
      }
      return `Deleted role @${name}.`;
    }

    case 'edit_role': {
      const roleSnowflake = extractSnowflake(details.targetRoleId || details.resourceId) || extractSnowflake(details.targetRole);
      const name = (details.name || details.targetRole || details.targetRef || 'role').replace(/^@/, '');
      if (opResult.details) return cleanText(opResult.details);
      if (roleSnowflake) return `Updated role <@&${roleSnowflake}>.`;
      return `Updated role @${name}.`;
    }

    case 'change_nickname': {
      const snowflake = extractSnowflake(details.targetMemberId || details.resourceId) || extractSnowflake(details.targetMember);
      const member = snowflake ? `<@${snowflake}>` : `@${String(details.targetMember || 'member').replace(/^@/, '')}`;
      const nick = details.nickname !== undefined ? details.nickname : details.args?.nickname;
      if (!nick) {
        return `Removed server nickname for ${member}.`;
      }
      return `Changed nickname for ${member} to "${nick}".`;
    }

    case 'remove_nickname': {
      const snowflake = extractSnowflake(details.targetMemberId || details.resourceId) || extractSnowflake(details.targetMember);
      const member = snowflake ? `<@${snowflake}>` : `@${String(details.targetMember || 'member').replace(/^@/, '')}`;
      return `Removed server nickname for ${member}.`;
    }

    case 'inspect_nickname':
    case 'lookup_member': {
      if (opResult.details) return opResult.details;
      return 'Member details retrieved.';
    }

    case 'purge_messages': {
      const count = opResult.deletedCount !== undefined ? opResult.deletedCount : (details.count || details.args?.count || 5);
      const chSnowflake = extractSnowflake(details.targetChannelId || details.resourceId) || extractSnowflake(details.targetRef);
      const targetStr = chSnowflake ? `<#${chSnowflake}>` : `#${(details.targetRef || 'channel').replace(/^#/, '')}`;
      const skippedNote = opResult.skippedCount > 0 ? ` (${opResult.skippedCount} older than 14 days skipped)` : '';
      const authorNote = details.author ? ` from @${String(details.author).replace(/^@/, '')}` : '';
      return `Purged ${count} message${count === 1 ? '' : 's'}${authorNote} from ${targetStr}${skippedNote}.`;
    }

    case 'search_messages': {
      const count = opResult.matchCount !== undefined ? opResult.matchCount : (details.matchCount || 0);
      const chSnowflake = extractSnowflake(details.targetChannelId || details.resourceId) || extractSnowflake(details.targetRef);
      const targetStr = chSnowflake ? `<#${chSnowflake}>` : `#${(details.targetRef || 'channel').replace(/^#/, '')}`;
      return `Found ${count} message${count === 1 ? '' : 's'} matching search criteria in ${targetStr}.`;
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
  const failureReason = firstFailure?.reason || firstFailure?.error || firstFailure?.details || 'a permission or validation failure';

  return `Completed ${passed} of ${total} actions. The ${firstFailure?.action || 'subsequent'} update failed: ${cleanText(failureReason)}.`;
}

/**
 * Formats audit and health check outcomes.
 */
export function formatAuditSummary(healthReport) {
  const { summary } = healthReport;
  return `Audit complete. ${summary.passed} checks passed, ${summary.failed} issues found, and ${summary.inconclusive + summary.skipped} could not run.`;
}
