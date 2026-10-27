import { Events, PermissionFlagsBits, AuditLogEvent } from 'discord.js';
import { ModLogService } from './mod-log.js';
import { Logger } from './logger.js';

const logger = new Logger('GatewayEvents');

/**
 * Attaches gateway event listeners to observe external moderation and administrative actions,
 * correlate them with Discord audit logs, and record them to the centralized ModLogService.
 */
export function registerGatewayEventListeners(client) {
  if (!client) return;

  // 1. Member Ban Added
  client.on(Events.GuildBanAdd, async (ban) => {
    try {
      await handleExternalModerationEvent(ban.guild, 'ban_member', ban.user, AuditLogEvent.MemberBanAdd);
    } catch (err) {
      logger.warn('Error handling GuildBanAdd event', { error: err.message });
    }
  });

  // 2. Member Ban Removed
  client.on(Events.GuildBanRemove, async (ban) => {
    try {
      await handleExternalModerationEvent(ban.guild, 'unban_member', ban.user, AuditLogEvent.MemberBanRemove);
    } catch (err) {
      logger.warn('Error handling GuildBanRemove event', { error: err.message });
    }
  });

  // 3. Member Removed (Could be Kick or voluntarily Left)
  client.on(Events.GuildMemberRemove, async (member) => {
    try {
      await handleExternalModerationEvent(member.guild, 'kick_member', member.user, AuditLogEvent.MemberKick, true);
    } catch (err) {
      logger.warn('Error handling GuildMemberRemove event', { error: err.message });
    }
  });

  // 4. Role Created
  client.on(Events.GuildRoleCreate, async (role) => {
    try {
      await handleExternalModerationEvent(role.guild, 'create_role', { id: role.id, name: role.name }, AuditLogEvent.RoleCreate);
    } catch (err) {
      logger.warn('Error handling GuildRoleCreate event', { error: err.message });
    }
  });

  // 5. Role Deleted
  client.on(Events.GuildRoleDelete, async (role) => {
    try {
      await handleExternalModerationEvent(role.guild, 'delete_role', { id: role.id, name: role.name }, AuditLogEvent.RoleDelete);
    } catch (err) {
      logger.warn('Error handling GuildRoleDelete event', { error: err.message });
    }
  });

  // 6. Channel Created
  client.on(Events.ChannelCreate, async (channel) => {
    if (!channel.guild) return;
    try {
      await handleExternalModerationEvent(channel.guild, 'create_channel', { id: channel.id, name: channel.name }, AuditLogEvent.ChannelCreate);
    } catch (err) {
      logger.warn('Error handling ChannelCreate event', { error: err.message });
    }
  });

  // 7. Channel Deleted
  client.on(Events.ChannelDelete, async (channel) => {
    if (!channel.guild) return;
    try {
      await handleExternalModerationEvent(channel.guild, 'delete_channel', { id: channel.id, name: channel.name }, AuditLogEvent.ChannelDelete);
    } catch (err) {
      logger.warn('Error handling ChannelDelete event', { error: err.message });
    }
  });

  logger.info('External gateway moderation event listeners registered');
}

/**
 * Correlates a gateway event with Discord audit log entries to attribute the external actor.
 */
async function handleExternalModerationEvent(guild, action, targetObj, auditLogType, requireAuditMatch = false) {
  if (!guild) return;

  const targetId = targetObj?.id || String(targetObj);

  // Check if this action was recently executed by Honey Bot itself (deduplication)
  if (ModLogService.isDeduplicated(guild.id, action, targetId)) {
    return;
  }

  let actor = { id: null, tag: 'Unknown' };
  let reason = 'External administrative action';

  // Check bot permissions for audit logs
  const me = guild.members?.me || await guild.members.fetchMe().catch(() => null);
  const canViewAuditLog = me && me.permissions && me.permissions.has(PermissionFlagsBits.ViewAuditLog);

  if (canViewAuditLog) {
    try {
      // Small delay to allow Discord audit log entry to propagate
      await new Promise(r => setTimeout(r, 1200));

      const logs = await guild.fetchAuditLogs({
        limit: 5,
        type: auditLogType
      });

      const entry = logs.entries.find(e => {
        const matchesTarget = e.target?.id === targetId || e.targetId === targetId;
        const isRecent = Date.now() - e.createdTimestamp < 15000;
        return matchesTarget && isRecent;
      });

      if (entry) {
        // If the executor was Honey Bot, deduplicate and exit
        if (entry.executor?.id === me.id) {
          return;
        }

        if (entry.executor) {
          actor = {
            id: entry.executor.id,
            tag: entry.executor.tag || entry.executor.username
          };
        }
        if (entry.reason) {
          reason = entry.reason;
        }
      } else if (requireAuditMatch) {
        // For GuildMemberRemove: if no audit log entry for kick exists, user left voluntarily
        return;
      }
    } catch (auditErr) {
      logger.warn('Failed to fetch audit log for gateway event', { error: auditErr.message });
      if (requireAuditMatch) return;
    }
  } else if (requireAuditMatch) {
    // If we cannot view audit logs, don't misattribute a voluntary leave as a kick
    return;
  }

  // Categorize: external bans/kicks go to MODERATION, while channel/role changes go to BOT_OPERATIONS
  const isModerationAction = ['ban_member', 'unban_member', 'kick_member'].includes(action);
  const category = isModerationAction ? 'MODERATION' : 'BOT_OPERATIONS';

  // Record to centralized logging service
  await ModLogService.logAction(guild, {
    category,
    action,
    actor,
    target: targetObj,
    reason,
    outcome: 'succeeded',
    source: 'gateway_event'
  });
}
