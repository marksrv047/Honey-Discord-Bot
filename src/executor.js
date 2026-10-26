import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { checkRoleHierarchy, auditServerPermissions } from './permissions.js';
import { classifyDiscordError, ActionLedger } from './recovery.js';
import { Verifier } from './verification.js';
import { TicketManager } from './tickets.js';
import { Operations } from './operations.js';
import { ExecutionContext } from './execution-context.js';
import { SecurityGate } from './security-gate.js';
import { config } from './config.js';
import { resolveColor } from './color-utils.js';
import { ModLogService } from './mod-log.js';
import { MusicService } from './music-service.js';
import { DashboardManager } from './dashboard.js';
import { ChannelGuard } from './channel-guard.js';
import { Logger } from './logger.js';

const logger = new Logger('Executor');

/**
 * Deterministic Discord API execution engine.
 */
export class Executor {
  /**
   * Sorts actions topologically so dependencies (categories, roles) are created before channels and permissions.
   */
  static orderActions(actions) {
    const priority = {
      update_server_name: 1,
      update_server_description: 1,
      update_server_icon: 1,
      update_server_banner: 1,
      update_server_settings: 1,
      create_role: 2,
      create_channel_category: 3, // Categories before regular channels
      create_channel: 4,
      edit_role: 5,
      edit_channel: 5,
      rename_channel: 5,
      set_channel_slowmode: 5,
      lock_channel: 6,
      unlock_channel: 6,
      set_channel_permission: 6,
      assign_role: 7,
      remove_role: 7,
      change_nickname: 8,
      timeout_member: 8,
      remove_timeout: 8,
      kick_member: 9,
      ban_member: 9,
      unban_member: 9,
      delete_channel: 10,
      delete_role: 10,
      setup_ticket_system: 11,
      audit_server: 12,
      list_channels: 13,
      list_roles: 13
    };

    return [...actions].sort((a, b) => {
      let pA = priority[a.action] || 5;
      let pB = priority[b.action] || 5;

      // Prioritize category channels over other channels
      if (a.action === 'create_channel' && a.type === 'GUILD_CATEGORY') pA = 3;
      if (b.action === 'create_channel' && b.type === 'GUILD_CATEGORY') pB = 3;

      return pA - pB;
    });
  }

  /**
   * Executes an entire plan sequentially with pre-checks, rate-limit backoff, and post-verification.
   */
  static async executePlan(guild, plan, executionId, invokingMember) {
    const sortedActions = Executor.orderActions(plan.actions);
    const results = [];
    const failedTargets = new Set();

    logger.info(`Starting execution ${executionId} with ${sortedActions.length} actions`, { guild: guild.name });

    for (const action of sortedActions) {
      // Check if this action depends on a target that failed previously in this execution
      const targetsToCheck = [
        action.targetChannel,
        action.targetRole,
        action.targetMember,
        action.targetRoleOrMember,
        action.role,
        action.name
      ].filter(Boolean);
      const failedPrereq = targetsToCheck.find(t => failedTargets.has(String(t).toLowerCase()));
      if (failedPrereq) {
        logger.warn(`Skipping action ${action.action} because prerequisite target ${failedPrereq} failed`);
        results.push({
          action: action.action,
          status: 'SKIPPED',
          verificationStatus: 'failed',
          intendedChange: `Execute ${action.action}`,
          observedOutcome: `Prerequisite action failed: target resource "${failedPrereq}" was not created`,
          verified: false,
          details: `Skipped: Prerequisite target "${failedPrereq}" failed to create.`
        });
        continue;
      }

      // 1. Spacing delay between calls to prevent rate limits
      await new Promise(r => setTimeout(r, config.safety.actionDelayMs));

      let executionResult = { success: false, details: '' };

      try {
        executionResult = await Executor.executeSingleActionWithRetry(guild, action, executionId, invokingMember);
      } catch (err) {
        const classified = classifyDiscordError(err);
        logger.error(`Action ${action.action} encountered error`, { error: err.message, type: classified.type });
        executionResult = {
          success: false,
          error: classified.userMessage
        };
      }

      // If a creation action failed, record it so dependent actions don't run
      if (!executionResult.success) {
        if (action.action === 'create_channel' || action.action === 'create_role') {
          if (action.name) failedTargets.add(action.name.toLowerCase());
        }
      }

      // 2. Post-Verification Phase
      const verification = await Verifier.verifyAction(guild, action, executionResult);
      results.push(verification);

      // Stop on fatal permission failures that block all subsequent operations
      if (!executionResult.success && executionResult.isFatal) {
        logger.warn('Execution aborted due to fatal prerequisite failure', { action: action.action });
        break;
      }
    }

    return results;
  }

  /**
   * Executes a single action with bounded retries for transient errors.
   */
  static async executeSingleActionWithRetry(guild, action, executionId, invokingMember) {
    let attempts = 0;
    const maxRetries = config.safety.maxRetries;

    while (attempts <= maxRetries) {
      try {
        return await Executor.executeSingleAction(guild, action, executionId, invokingMember);
      } catch (err) {
        attempts++;
        const classified = classifyDiscordError(err);

        if (classified.retryable && attempts <= maxRetries) {
          const backoff = attempts * 1000;
          logger.warn(`Action failed transiently, retrying in ${backoff}ms (Attempt ${attempts})`, { action: action.action });
          await new Promise(r => setTimeout(r, backoff));
        } else {
          throw err;
        }
      }
    }
  }

  /**
   * Core dispatcher for individual Discord actions.
   */
  static async executeSingleAction(guild, action, executionId, invokingMember) {
    // Immutable Security Gate check on every single mutation pathway
    SecurityGate.evaluateActionSequence([action], invokingMember, guild);

    switch (action.action) {
      case 'update_server_name': {
        await guild.setName(action.name, `Updated via /go agent by ${invokingMember.user.tag}`);
        return { success: true, details: `Server name set to "${action.name}"` };
      }

      case 'update_server_description': {
        if (!guild.features.includes('COMMUNITY')) {
          return { success: true, details: 'Skipped description: Server requires Community feature enabled in Discord settings.' };
        }
        await guild.setDescription(action.description, `Updated via /go agent`);
        return { success: true, details: `Server description updated` };
      }

      case 'update_server_icon': {
        await guild.setIcon(action.iconUrl, `Icon updated via /go agent`);
        return { success: true, details: `Server icon updated successfully` };
      }

      case 'update_server_banner': {
        if (guild.premiumTier < 2) {
          return {
            success: true,
            details: `Skipped banner: Server is Boost Tier ${guild.premiumTier}. Discord requires Boost Tier 2 (7+ boosts) for custom banners.`
          };
        }
        await guild.setBanner(action.bannerUrl, `Banner updated via /go agent`);
        return { success: true, details: `Server banner updated` };
      }

      case 'create_role': {
        const roleName = String(action.name || action.roleName || action.role || action.targetRole || action.target || '').trim();
        if (!roleName) {
          return { success: false, error: 'Role name is required' };
        }
        // Idempotency: check if role already exists
        const existing = guild.roles.cache.find(r => r.name?.toLowerCase() === roleName.toLowerCase());
        if (existing) {
          return { success: true, details: `Role @${existing.name} already exists (re-using existing)` };
        }

        const resolvedColor = resolveColor(action.color || action.hexColor || action.hex) || '#99AAB5';
        const role = await guild.roles.create({
          name: roleName,
          color: resolvedColor,
          hoist: Boolean(action.hoist),
          mentionable: Boolean(action.mentionable),
          permissions: action.permissions || [],
          reason: `Created via /go agent by ${invokingMember?.user?.tag || invokingMember?.displayName || 'Admin'}`
        });

        ActionLedger.recordCreatedResource(executionId, 'role', role.id, role.name);
        return { success: true, details: `Role @${role.name} created with color ${resolvedColor}` };
      }

      case 'edit_role': {
        const targetRef = action.targetRole || action.targetRef || action.role || action.name;
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          resolveTarget: async (ref) => guild.roles.cache.find(r => r.id === ref || r.name?.toLowerCase() === String(ref).replace(/^@/, '').toLowerCase())
        };
        return await Operations.editRole(guild, targetRef, action, ctx);
      }

      case 'delete_role': {
        const rawTarget = action.roles || action.targetRole || action.targetRef || action.role;
        let roleTargets = [];
        if (Array.isArray(rawTarget)) {
          roleTargets = rawTarget;
        } else if (typeof rawTarget === 'string') {
          roleTargets = rawTarget.split(/,\s*|\s+and\s+/i).map(s => s.trim()).filter(Boolean);
        }
        if (roleTargets.length === 0) {
          return { success: false, error: 'No role specified to delete' };
        }

        const deleted = [];
        const errors = [];
        for (const targetRef of roleTargets) {
          const cleanRef = String(targetRef).replace(/^@/, '').trim();
          const role = guild.roles.cache.find(r => r.id === cleanRef || r.name?.toLowerCase() === cleanRef.toLowerCase());
          if (!role) {
            deleted.push(`Role "${cleanRef}" (already not present)`);
            continue;
          }
          const hierarchy = checkRoleHierarchy(guild, action, role);
          if (!hierarchy.valid) {
            errors.push(`Cannot delete @${role.name}: ${hierarchy.reason}`);
            continue;
          }
          await role.delete(`Deleted via /go agent by ${invokingMember?.user?.tag || invokingMember?.displayName || 'Admin'}`);
          deleted.push(`@${role.name}`);
        }

        if (errors.length > 0 && deleted.length === 0) {
          return { success: false, error: errors.join('; ') };
        }
        return {
          success: true,
          details: `Deleted roles: ${deleted.join(', ')}${errors.length > 0 ? ` (Warnings: ${errors.join('; ')})` : ''}`
        };
      }

      case 'assign_role': {
        const memberRef = action.targetMember || action.targetMemberId || (action.targetType === 'member' ? action.targetRef : null) || (action.targetRole ? null : action.targetRef) || action.targetRef;
        const roleRef = action.targetRole || action.targetRoleId || action.role || action.name || (action.targetType === 'role' ? action.targetRef : null);
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          resolveTarget: async (ref, type) => {
            if (type === 'role') return guild.roles.cache.find(r => r.id === ref || r.name.toLowerCase() === String(ref).replace(/^@/, '').toLowerCase());
            return guild.members.cache.find(m => m.id === ref || m.user?.username?.toLowerCase() === String(ref).toLowerCase() || m.displayName?.toLowerCase() === String(ref).toLowerCase());
          }
        };
        return await Operations.assignRole(guild, memberRef, roleRef, ctx);
      }

      case 'remove_role': {
        const memberRef = action.targetMember || action.targetMemberId || (action.targetType === 'member' ? action.targetRef : null) || (action.targetRole ? null : action.targetRef) || action.targetRef;
        const roleRef = action.targetRole || action.targetRoleId || action.role || action.name || (action.targetType === 'role' ? action.targetRef : null);
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          resolveTarget: async (ref, type) => {
            if (type === 'role') return guild.roles.cache.find(r => r.id === ref || r.name.toLowerCase() === String(ref).replace(/^@/, '').toLowerCase());
            return guild.members.cache.find(m => m.id === ref || m.user?.username?.toLowerCase() === String(ref).toLowerCase() || m.displayName?.toLowerCase() === String(ref).toLowerCase());
          }
        };
        return await Operations.removeRole(guild, memberRef, roleRef, ctx);
      }

      case 'create_channel': {
        const channelName = String(action.name || action.channelName || action.channel || action.targetChannel || action.target || '').trim();
        if (!channelName) {
          return { success: false, error: 'Channel name is required' };
        }

        // Resolve channel type
        let chType = ChannelType.GuildText;
        if (action.type === 'GUILD_VOICE' || action.type === 'VOICE' || action.type === 'voice') chType = ChannelType.GuildVoice;
        if (action.type === 'GUILD_ANNOUNCEMENT' || action.type === 'announcement') chType = ChannelType.GuildAnnouncement;
        if (action.type === 'GUILD_CATEGORY' || action.type === 'category') chType = ChannelType.GuildCategory;
        if (action.type === 'GUILD_STAGE_VOICE' || action.type === 'stage') chType = ChannelType.GuildStageVoice;

        // Find parent category if specified
        let parentId = null;
        const parentCategoryName = action.category || action.parentCategory || action.parent;
        if (parentCategoryName && chType !== ChannelType.GuildCategory) {
          const cleanParent = String(parentCategoryName).toLowerCase().trim();
          const category = guild.channels.cache.find(
            c => c.type === ChannelType.GuildCategory && (c.id === cleanParent || c.name?.toLowerCase() === cleanParent)
          );
          if (category) parentId = category.id;
        }

        // Check if channel already exists
        const existing = guild.channels.cache.find(c => c.name?.toLowerCase() === channelName.toLowerCase() && (!parentId || c.parentId === parentId));
        if (existing) {
          return { success: true, details: `Channel #${existing.name} already exists (re-using existing)` };
        }

        // Permission overwrites for private channels
        const overwrites = [];
        if (action.isPrivate && guild.roles?.everyone) {
          overwrites.push({
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel]
          });
        }

        if (action.allowedRoles && action.allowedRoles.length > 0) {
          for (const roleNameOrId of action.allowedRoles) {
            const r = guild.roles.cache.find(role => role.id === roleNameOrId || role.name?.toLowerCase() === String(roleNameOrId).toLowerCase());
            if (r) {
              overwrites.push({
                id: r.id,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
              });
            }
          }
        }

        const channel = await guild.channels.create({
          name: channelName,
          type: chType,
          parent: parentId,
          topic: action.topic || undefined,
          rateLimitPerUser: action.slowmodeSeconds || 0,
          nsfw: Boolean(action.nsfw),
          permissionOverwrites: overwrites.length > 0 ? overwrites : undefined,
          reason: `Created via /go agent by ${invokingMember?.user?.tag || invokingMember?.displayName || 'Admin'}`
        });

        ActionLedger.recordCreatedResource(executionId, 'channel', channel.id, channel.name);
        return { success: true, details: `Channel #${channel.name} created successfully` };
      }

      case 'edit_channel': {
        const channel = guild.channels.cache.find(c => c.id === action.targetChannel || c.name.toLowerCase() === action.targetChannel.toLowerCase());
        if (!channel) {
          return { success: false, error: `Channel "${action.targetChannel}" not found` };
        }

        await channel.edit({
          name: action.name || channel.name,
          topic: action.topic !== undefined ? action.topic : channel.topic,
          rateLimitPerUser: action.slowmodeSeconds !== undefined ? action.slowmodeSeconds : channel.rateLimitPerUser,
          nsfw: action.nsfw !== undefined ? action.nsfw : channel.nsfw
        }, `Edited via /go agent`);

        return { success: true, details: `Channel #${channel.name} edited` };
      }

      case 'delete_channel': {
        const channel = guild.channels.cache.find(c => c.id === action.targetChannel || c.name.toLowerCase() === action.targetChannel.toLowerCase());
        if (!channel) {
          return { success: true, details: `Channel "${action.targetChannel}" already deleted` };
        }

        await channel.delete(`Deleted via /go agent by ${invokingMember.user.tag}`);
        return { success: true, details: `Channel #${channel.name} deleted` };
      }

      case 'set_channel_permission': {
        const channel = guild.channels.cache.find(c => c.id === action.targetChannel || c.name.toLowerCase() === action.targetChannel.toLowerCase());
        if (!channel) {
          return { success: false, error: `Channel "${action.targetChannel}" not found` };
        }

        // Find target role or member
        const role = guild.roles.cache.find(r => r.id === action.targetRoleOrMember || r.name.toLowerCase() === action.targetRoleOrMember.toLowerCase());
        const targetId = role ? role.id : action.targetRoleOrMember;

        const allowBits = action.allow ? action.allow.map(p => PermissionFlagsBits[p]).filter(Boolean) : [];
        const denyBits = action.deny ? action.deny.map(p => PermissionFlagsBits[p]).filter(Boolean) : [];

        await channel.permissionOverwrites.edit(targetId, {
          ...Object.fromEntries(allowBits.map(b => [b, true])),
          ...Object.fromEntries(denyBits.map(b => [b, false]))
        }, { reason: `Overwrites updated via /go agent` });

        return { success: true, details: `Permissions for ${role ? `@${role.name}` : targetId} updated on #${channel.name}` };
      }

      case 'create_category': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember?.user,
          executionId
        };
        return await Operations.createCategory(guild, action, ctx);
      }

      case 'rename_category': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember?.user,
          executionId
        };
        const targetRef = action.targetCategory || action.targetRef || action.category || action.name;
        const newName = action.newName || action.name;
        return await Operations.renameCategory(guild, targetRef, newName, ctx);
      }

      case 'delete_category': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember?.user,
          executionId
        };
        const targetRef = action.targetCategory || action.targetRef || action.category;
        return await Operations.deleteCategory(guild, targetRef, action, ctx);
      }

      case 'inspect_category': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember?.user,
          executionId
        };
        const targetRef = action.targetCategory || action.targetRef || action.category;
        return await Operations.inspectCategory(guild, targetRef, ctx);
      }

      case 'list_categories': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember?.user,
          executionId
        };
        return await Operations.listCategories(guild, ctx);
      }

      case 'move_channel_to_category': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember?.user,
          executionId
        };
        const targetCh = action.targetChannel || action.channel || action.targetRef;
        const targetCat = action.category ?? action.targetCategory;
        return await Operations.moveChannelToCategory(guild, targetCh, targetCat, action, ctx);
      }

      case 'set_category_permission': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember?.user,
          executionId
        };
        const targetCat = action.targetCategory || action.category || action.targetRef;
        const targetEntity = action.targetRoleOrMember || action.targetRole || action.targetMember || action.role || action.user;
        return await Operations.setCategoryPermission(guild, targetCat, targetEntity, action.allow || [], action.deny || [], ctx);
      }

      case 'sync_category_permissions': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember?.user,
          executionId
        };
        const targetCat = action.targetCategory || action.category || action.targetRef;
        const targetCh = action.targetChannel || 'all';
        return await Operations.syncCategoryPermissions(guild, targetCat, targetCh, ctx);
      }

      case 'inspect_category_sync': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember?.user,
          executionId
        };
        const targetCat = action.targetCategory || action.category || action.targetRef;
        return await Operations.inspectCategorySync(guild, targetCat, ctx);
      }

      case 'timeout_member': {
        const rawTarget = String(action.targetMember || action.targetRef || '');
        const cleanId = rawTarget.replace(/[<@!>]/g, '').trim();
        const member = guild.members.cache.find(m => m.id === cleanId || m.id === rawTarget || m.user?.username?.toLowerCase() === rawTarget.toLowerCase() || m.displayName?.toLowerCase() === rawTarget.toLowerCase());
        if (!member) {
          return { success: false, error: `Member "${action.targetMember}" not found in server` };
        }

        const hierarchy = checkRoleHierarchy(guild, action, member);
        if (!hierarchy.valid) return { success: false, error: hierarchy.reason };

        const safeReason = String(action.reason || 'No reason provided').slice(0, 512);
        await member.timeout(action.durationMinutes * 60 * 1000, safeReason);
        return {
          success: true,
          action: 'timeout_member',
          details: `Member ${member.user.tag} timed out for ${action.durationMinutes}m`,
          verified: true,
          resourceId: member.id,
          targetMemberId: member.id,
          targetMemberTag: member.user?.tag,
          durationMinutes: action.durationMinutes,
          reason: safeReason
        };
      }

      case 'remove_timeout': {
        const rawTarget = String(action.targetMember || action.targetRef || '');
        const cleanId = rawTarget.replace(/[<@!>]/g, '').trim();
        const member = guild.members.cache.find(m => m.id === cleanId || m.id === rawTarget || m.user?.username?.toLowerCase() === rawTarget.toLowerCase() || m.displayName?.toLowerCase() === rawTarget.toLowerCase());
        if (!member) return { success: false, error: `Member "${action.targetMember}" not found` };

        const safeReason = String(action.reason || 'No reason provided').slice(0, 512);
        await member.timeout(null, safeReason);
        return {
          success: true,
          action: 'remove_timeout',
          details: `Timeout removed from ${member.user.tag}`,
          verified: true,
          resourceId: member.id,
          targetMemberId: member.id,
          targetMemberTag: member.user?.tag
        };
      }

      case 'kick_member': {
        const rawTarget = String(action.targetMember || action.targetRef || '');
        const cleanId = rawTarget.replace(/[<@!>]/g, '').trim();
        const member = guild.members.cache.find(m => m.id === cleanId || m.id === rawTarget || m.user?.username?.toLowerCase() === rawTarget.toLowerCase() || m.displayName?.toLowerCase() === rawTarget.toLowerCase());
        if (!member) return { success: false, error: `Member "${action.targetMember}" not found` };

        const hierarchy = checkRoleHierarchy(guild, action, member);
        if (!hierarchy.valid) return { success: false, error: hierarchy.reason };

        const safeReason = String(action.reason || 'No reason provided').slice(0, 512);
        await member.kick(safeReason);
        return {
          success: true,
          action: 'kick_member',
          details: `Member ${member.user.tag} kicked`,
          verified: true,
          resourceId: member.id,
          targetMemberId: member.id,
          targetMemberTag: member.user?.tag,
          targetMember: member.user?.tag,
          reason: safeReason
        };
      }

      case 'ban_member': {
        const rawTarget = String(action.targetMember || action.targetRef || '');
        const cleanId = rawTarget.replace(/[<@!>]/g, '').trim();
        const member = guild.members.cache.find(m => m.id === cleanId || m.id === rawTarget || m.user?.username?.toLowerCase() === rawTarget.toLowerCase() || m.displayName?.toLowerCase() === rawTarget.toLowerCase());
        const targetId = member ? member.id : cleanId;

        if (member) {
          const hierarchy = checkRoleHierarchy(guild, action, member);
          if (!hierarchy.valid) return { success: false, error: hierarchy.reason };
        }

        const safeReason = String(action.reason || 'No reason provided').slice(0, 512);
        await guild.members.ban(targetId, {
          deleteMessageSeconds: (action.deleteMessageDays || 0) * 86400,
          reason: safeReason
        });

        return {
          success: true,
          action: 'ban_member',
          details: `User ${targetId} banned`,
          verified: true,
          resourceId: targetId,
          targetMemberId: targetId,
          targetMemberTag: member?.user?.tag,
          reason: safeReason
        };
      }

      case 'unban_member': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : { invokingUser: invokingMember.user };
        return await Operations.unbanMember(guild, action.targetMember || action.targetMemberId || action.targetRef, action.reason, ctx);
      }

      case 'set_user_channel_permission': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          resolveTarget: async (ref, type) => {
            if (type === 'channel') return guild.channels.cache.find(c => c.id === ref || c.name.toLowerCase() === String(ref).replace(/^#/, '').toLowerCase());
            return guild.members.cache.find(m => m.id === ref || m.user?.username?.toLowerCase() === String(ref).toLowerCase() || m.displayName?.toLowerCase() === String(ref).toLowerCase());
          }
        };
        const perms = {
          allow: action.allow || (action.permissions?.allow) || [],
          deny: action.deny || (action.permissions?.deny) || [],
          inherit: action.inherit || (action.permissions?.inherit) || []
        };
        return await Operations.setUserChannelPermission(guild, action.targetMember || action.targetRef, action.targetChannel, perms, ctx);
      }

      case 'inspect_user_permissions': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          resolveTarget: async (ref, type) => {
            if (type === 'channel') return guild.channels.cache.find(c => c.id === ref || c.name.toLowerCase() === String(ref).replace(/^#/, '').toLowerCase());
            return guild.members.cache.find(m => m.id === ref || m.user?.username?.toLowerCase() === String(ref).toLowerCase() || m.displayName?.toLowerCase() === String(ref).toLowerCase());
          }
        };
        return await Operations.inspectUserPermissions(guild, action.targetMember || action.targetRef, action.targetChannel, ctx);
      }

      case 'voice_mute': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : { invokingUser: invokingMember.user, resolveTarget: async (ref) => guild.members.cache.find(m => m.id === ref || m.user?.username?.toLowerCase() === String(ref).toLowerCase()) };
        return await Operations.voiceMute(guild, action.targetMember || action.targetRef, ctx);
      }

      case 'voice_unmute': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : { invokingUser: invokingMember.user, resolveTarget: async (ref) => guild.members.cache.find(m => m.id === ref || m.user?.username?.toLowerCase() === String(ref).toLowerCase()) };
        return await Operations.voiceUnmute(guild, action.targetMember || action.targetRef, ctx);
      }

      case 'voice_deafen': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : { invokingUser: invokingMember.user, resolveTarget: async (ref) => guild.members.cache.find(m => m.id === ref || m.user?.username?.toLowerCase() === String(ref).toLowerCase()) };
        return await Operations.voiceDeafen(guild, action.targetMember || action.targetRef, ctx);
      }

      case 'voice_undeafen': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : { invokingUser: invokingMember.user, resolveTarget: async (ref) => guild.members.cache.find(m => m.id === ref || m.user?.username?.toLowerCase() === String(ref).toLowerCase()) };
        return await Operations.voiceUndeafen(guild, action.targetMember || action.targetRef, ctx);
      }

      case 'voice_move': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          resolveTarget: async (ref, type) => {
            if (type === 'channel') return guild.channels.cache.find(c => c.id === ref || c.name.toLowerCase() === String(ref).replace(/^#/, '').toLowerCase());
            return guild.members.cache.find(m => m.id === ref || m.user?.username?.toLowerCase() === String(ref).toLowerCase());
          }
        };
        return await Operations.voiceMove(guild, action.targetMember || action.targetRef, action.targetChannel, ctx);
      }

      case 'voice_disconnect': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : { invokingUser: invokingMember.user, resolveTarget: async (ref) => guild.members.cache.find(m => m.id === ref || m.user?.username?.toLowerCase() === String(ref).toLowerCase()) };
        return await Operations.voiceDisconnect(guild, action.targetMember || action.targetRef, ctx);
      }

      case 'issue_warning': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : { invokingUser: invokingMember.user, resolveTarget: async (ref) => guild.members.cache.find(m => m.id === ref || m.user?.username?.toLowerCase() === String(ref).toLowerCase()) };
        return await Operations.issueWarning(guild, action.targetMember || action.targetRef, action.reason, ctx);
      }

      case 'inspect_warnings': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : { invokingUser: invokingMember.user, resolveTarget: async (ref) => guild.members.cache.find(m => m.id === ref || m.user?.username?.toLowerCase() === String(ref).toLowerCase()) };
        return await Operations.inspectWarnings(guild, action.targetMember || action.targetRef, ctx);
      }

      case 'clear_warnings': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : { invokingUser: invokingMember.user, resolveTarget: async (ref) => guild.members.cache.find(m => m.id === ref || m.user?.username?.toLowerCase() === String(ref).toLowerCase()) };
        return await Operations.clearWarnings(guild, action.targetMember || action.targetRef, ctx);
      }

      case 'softban_member': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : { invokingUser: invokingMember.user, resolveTarget: async (ref) => guild.members.cache.find(m => m.id === ref || m.user?.username?.toLowerCase() === String(ref).toLowerCase()) };
        return await Operations.softbanMember(guild, action.targetMember || action.targetRef, action.reason, ctx);
      }

      case 'inspect_member_moderation': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : { invokingUser: invokingMember.user, resolveTarget: async (ref) => guild.members.cache.find(m => m.id === ref || m.user?.username?.toLowerCase() === String(ref).toLowerCase()) };
        return await Operations.inspectMemberModeration(guild, action.targetMember || action.targetRef, ctx);
      }

      case 'configure_guild_policy': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          executionId
        };
        return await Operations.configureGuildPolicy(guild, action, ctx);
      }

      case 'inspect_guild_policy': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          executionId
        };
        return await Operations.inspectGuildPolicy(guild, ctx);
      }

      case 'test_guild_policy': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          executionId
        };
        return await Operations.testGuildPolicy(guild, action, ctx);
      }

      case 'reset_guild_policy': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          executionId
        };
        return await Operations.resetGuildPolicy(guild, ctx);
      }

      case 'change_nickname': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          resolveTarget: async (ref) => /me|my|myself|self|i/i.test(ref) ? invokingMember : guild.members.cache.find(m => m.id === ref || m.user?.username?.toLowerCase() === String(ref).toLowerCase() || m.displayName?.toLowerCase() === String(ref).toLowerCase())
        };
        const requestedNick = action.nickname ?? action.newNickname ?? action.name;
        return await Operations.changeNickname(guild, action.targetMember || action.targetRef, requestedNick, ctx);
      }

      case 'remove_nickname': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          resolveTarget: async (ref) => /me|my|myself|self|i/i.test(ref) ? invokingMember : guild.members.cache.find(m => m.id === ref || m.user?.username?.toLowerCase() === String(ref).toLowerCase() || m.displayName?.toLowerCase() === String(ref).toLowerCase())
        };
        return await Operations.removeNickname(guild, action.targetMember || action.targetRef, ctx);
      }

      case 'inspect_nickname': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          resolveTarget: async (ref) => /me|my|myself|self|i/i.test(ref) ? invokingMember : guild.members.cache.find(m => m.id === ref || m.user?.username?.toLowerCase() === String(ref).toLowerCase() || m.displayName?.toLowerCase() === String(ref).toLowerCase())
        };
        return await Operations.inspectNickname(guild, action.targetMember || action.targetRef, ctx);
      }

      case 'setup_ticket_system': {
        const ticketResult = await TicketManager.setupTicketSystem(guild, action);
        return {
          success: true,
          details: `Ticket panel created in #${ticketResult.channel} under category "${ticketResult.category}" with role @${ticketResult.supportRole}`
        };
      }

      case 'audit_server': {
        const issues = auditServerPermissions(guild);
        return {
          success: true,
          details: issues.length > 0 ? issues.join(' | ') : 'Security audit passed: No excessive @everyone permissions found.'
        };
      }

      case 'rename_channel': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          resolveTarget: async (ref, type) => {
            if (/current|this/i.test(ref)) return invokingMember.guild?.channels?.cache?.first();
            return guild.channels.cache.find(c => c.id === ref || c.name.toLowerCase() === String(ref).replace(/^#/, '').toLowerCase());
          }
        };
        return await Operations.renameChannel(guild, action.targetChannel || action.targetRef || 'current', action.name, ctx);
      }

      case 'lock_channel': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          resolveTarget: async (ref) => /current|this/i.test(ref) ? invokingMember.guild?.channels?.cache?.first() : guild.channels.cache.find(c => c.id === ref || c.name.toLowerCase() === String(ref).toLowerCase())
        };
        return await Operations.lockChannel(guild, action.targetChannel || action.targetRef || 'current', ctx);
      }

      case 'unlock_channel': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          resolveTarget: async (ref) => /current|this/i.test(ref) ? invokingMember.guild?.channels?.cache?.first() : guild.channels.cache.find(c => c.id === ref || c.name.toLowerCase() === String(ref).toLowerCase())
        };
        return await Operations.unlockChannel(guild, action.targetChannel || action.targetRef || 'current', ctx);
      }

      case 'set_channel_slowmode': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          resolveTarget: async (ref) => /current|this/i.test(ref) ? invokingMember.guild?.channels?.cache?.first() : guild.channels.cache.find(c => c.id === ref || c.name.toLowerCase() === String(ref).toLowerCase())
        };
        return await Operations.setChannelSlowmode(guild, action.targetChannel || action.targetRef || 'current', action.seconds || 0, ctx);
      }

      case 'list_channels': {
        return await Operations.listChannels(guild, invokingMember);
      }

      case 'list_roles': {
        return await Operations.listRoles(guild, invokingMember);
      }

      case 'open_dashboard': {
        return {
          success: true,
          details: 'Opened interactive server dashboard.'
        };
      }

      case 'voice_join':
      case 'music_join':
      case 'connect_voice': {
        const targetCh = action.targetChannel || action.channel || action.targetRef;
        return await MusicService.connectVoice(guild, targetCh, invokingMember);
      }

      case 'send_announcement': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          resolveTarget: async (ref) => /current|this/i.test(ref) ? invokingMember.guild?.channels?.cache?.first() : guild.channels.cache.find(c => c.id === ref || c.name.toLowerCase() === String(ref).replace(/^#/, '').toLowerCase())
        };
        return await Operations.sendAnnouncement(guild, action.targetChannel || action.targetRef || 'current', action, ctx);
      }

      case 'send_message': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          resolveTarget: async (ref) => /current|this/i.test(ref) ? invokingMember.guild?.channels?.cache?.first() : guild.channels.cache.find(c => c.id === ref || c.name.toLowerCase() === String(ref).replace(/^#/, '').toLowerCase())
        };
        return await Operations.sendMessage(guild, action.targetChannel || action.targetRef || 'current', action.content || action.message, ctx);
      }

      case 'purge_messages': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          resolveTarget: async (ref) => /current|this/i.test(ref) ? invokingMember.guild?.channels?.cache?.first() : guild.channels.cache.find(c => c.id === ref || c.name.toLowerCase() === String(ref).replace(/^#/, '').toLowerCase())
        };
        const purgeOpts = {
          count: action.count || 5,
          author: action.author,
          authorId: action.authorId,
          contains: action.contains
        };
        return await Operations.purgeMessages(guild, action.targetChannel || action.targetRef || 'current', purgeOpts, ctx);
      }

      case 'search_messages': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          resolveTarget: async (ref) => /current|this/i.test(ref) ? invokingMember.guild?.channels?.cache?.first() : guild.channels.cache.find(c => c.id === ref || c.name.toLowerCase() === String(ref).replace(/^#/, '').toLowerCase())
        };
        const searchOpts = {
          count: action.count || 25,
          author: action.author,
          authorId: action.authorId,
          contains: action.contains
        };
        return await Operations.searchMessages(guild, action.targetChannel || action.targetRef || 'current', searchOpts, ctx);
      }

      case 'pin_message': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          resolveTarget: async (ref) => /current|this/i.test(ref) ? invokingMember.guild?.channels?.cache?.first() : guild.channels.cache.find(c => c.id === ref || c.name.toLowerCase() === String(ref).toLowerCase())
        };
        return await Operations.pinMessage(guild, action.targetChannel || action.targetRef || 'current', action.messageId, ctx);
      }

      case 'unpin_message': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          resolveTarget: async (ref) => /current|this/i.test(ref) ? invokingMember.guild?.channels?.cache?.first() : guild.channels.cache.find(c => c.id === ref || c.name.toLowerCase() === String(ref).toLowerCase())
        };
        return await Operations.unpinMessage(guild, action.targetChannel || action.targetRef || 'current', action.messageId, ctx);
      }

      case 'add_reaction': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          resolveTarget: async (ref) => /current|this/i.test(ref) ? invokingMember.guild?.channels?.cache?.first() : guild.channels.cache.find(c => c.id === ref || c.name.toLowerCase() === String(ref).toLowerCase())
        };
        return await Operations.addReaction(guild, action.targetChannel || action.targetRef || 'current', action.messageId, action.emoji, ctx);
      }

      case 'move_channel': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          resolveTarget: async (ref) => /current|this/i.test(ref) ? invokingMember.guild?.channels?.cache?.first() : guild.channels.cache.find(c => c.id === ref || c.name.toLowerCase() === String(ref).toLowerCase())
        };
        return await Operations.moveChannel(guild, action.targetChannel || action.targetRef || 'current', action.category, ctx);
      }

      case 'lookup_member': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : {
          invokingUser: invokingMember.user,
          resolveTarget: async (ref) => guild.members?.cache?.find(m => m.id === ref || m.user?.username?.toLowerCase() === String(ref).toLowerCase())
        };
        return await Operations.lookupMember(guild, action.targetMember || action.targetRef, ctx);
      }

      case 'get_bot_invite': {
        return await Operations.getBotInvite(guild, invokingMember);
      }

      case 'explain_bot_installation': {
        return await Operations.explainBotInstallation(guild, invokingMember);
      }

      case 'unsupported': {
        return {
          success: false,
          error: action.thought || 'This action is unsupported or not permitted by Discord API.'
        };
      }

      case 'connect_voice': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : { invokingMember };
        return await Operations.connectVoice(guild, action.targetChannel || action.channel, ctx);
      }

      case 'music_play': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : { invokingMember };
        const rawQuery = action.query || action.args?.query || (action.targetType !== 'channel' && action.targetRef !== 'current' ? action.targetRef : null) || action.target;
        return await Operations.playMusic(guild, rawQuery, ctx);
      }

      case 'music_pause': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : { invokingMember };
        return await Operations.pauseMusic(guild, ctx);
      }

      case 'music_resume': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : { invokingMember };
        return await Operations.resumeMusic(guild, ctx);
      }

      case 'music_skip': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : { invokingMember };
        return await Operations.skipMusic(guild, ctx);
      }

      case 'music_stop': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : { invokingMember };
        return await Operations.stopMusic(guild, ctx);
      }

      case 'music_queue': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : { invokingMember };
        return await Operations.getMusicQueue(guild, ctx);
      }

      case 'music_nowplaying': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : { invokingMember };
        return await Operations.getNowPlaying(guild, ctx);
      }

      case 'music_volume': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : { invokingMember };
        return await Operations.setMusicVolume(guild, action.volume, ctx);
      }

      case 'music_leave': {
        const ctx = invokingMember instanceof ExecutionContext ? invokingMember : { invokingMember };
        return await Operations.leaveVoice(guild, ctx);
      }

      default:
        return { success: false, error: `Unknown action: ${action.action}` };
    }
  }

  /**
   * Minimal execution path for a single interpreted intent.
   * Understands once, executes directly on the targeted resource without full-server discovery.
   */
  static async executeIntent(guild, intentObj, executionContext, executionId) {
    logger.info(`Executing single intent directly: ${intentObj.intent}`, {
      targetRef: intentObj.targetRef,
      executionId
    });

    switch (intentObj.intent) {
      case 'rename_channel':
        return await Operations.renameChannel(guild, intentObj.targetRef, intentObj.args.name, executionContext);

      case 'edit_channel_topic':
        return await Operations.editChannelTopic(guild, intentObj.targetRef, intentObj.args.topic, executionContext);

      case 'set_channel_slowmode':
        return await Operations.setChannelSlowmode(guild, intentObj.targetRef, intentObj.args.seconds, executionContext);

      case 'lock_channel':
        return await Operations.lockChannel(guild, intentObj.targetRef, executionContext);

      case 'unlock_channel':
        return await Operations.unlockChannel(guild, intentObj.targetRef, executionContext);

      case 'assign_role': {
        const memberRef = intentObj.args?.targetMember || intentObj.args?.targetMemberId || intentObj.args?.member || (intentObj.targetType === 'member' ? intentObj.targetRef : null) || (intentObj.args?.targetRole || intentObj.args?.role ? null : intentObj.targetRef) || intentObj.targetRef;
        const roleRef = intentObj.args?.targetRole || intentObj.args?.targetRoleId || intentObj.args?.role || (intentObj.targetType === 'role' ? intentObj.targetRef : null) || intentObj.targetRef;
        return await Operations.assignRole(guild, memberRef, roleRef, executionContext);
      }

      case 'remove_role': {
        const memberRef = intentObj.args?.targetMember || intentObj.args?.targetMemberId || intentObj.args?.member || (intentObj.targetType === 'member' ? intentObj.targetRef : null) || (intentObj.args?.targetRole || intentObj.args?.role ? null : intentObj.targetRef) || intentObj.targetRef;
        const roleRef = intentObj.args?.targetRole || intentObj.args?.targetRoleId || intentObj.args?.role || (intentObj.targetType === 'role' ? intentObj.targetRef : null) || intentObj.targetRef;
        return await Operations.removeRole(guild, memberRef, roleRef, executionContext);
      }

      case 'create_channel':
        return await Operations.createChannel(guild, { name: intentObj.args.name, ...intentObj.args }, executionContext);

      case 'create_role':
        return await Operations.createRole(guild, { name: intentObj.args.name, ...intentObj.args }, executionContext);

      case 'delete_channel':
        return await Operations.deleteChannel(guild, intentObj.targetRef, executionContext);

      case 'delete_role':
        return await Operations.deleteRole(guild, intentObj.targetRef, executionContext);

      case 'edit_role':
        return await Operations.editRole(guild, intentObj.targetRef || intentObj.args?.targetRole, intentObj.args, executionContext);

      case 'change_nickname':
        return await Operations.changeNickname(guild, intentObj.targetRef || intentObj.args?.targetMember, intentObj.args?.nickname ?? intentObj.args?.newNickname ?? intentObj.args?.name, executionContext);

      case 'remove_nickname':
        return await Operations.removeNickname(guild, intentObj.targetRef || intentObj.args?.targetMember, executionContext);

      case 'inspect_nickname':
        return await Operations.inspectNickname(guild, intentObj.targetRef || intentObj.args?.targetMember, executionContext);

      case 'send_announcement':
        return await Operations.sendAnnouncement(guild, intentObj.targetRef, {
          message: intentObj.args.message,
          title: intentObj.args.title,
          mentionEveryone: Boolean(intentObj.args.mentionEveryone)
        }, executionContext);

      case 'send_message':
        return await Operations.sendMessage(guild, intentObj.targetRef, intentObj.args.content || intentObj.args.message, executionContext);

      case 'purge_messages':
        return await Operations.purgeMessages(guild, intentObj.targetRef, intentObj.args || { count: 5 }, executionContext);

      case 'search_messages':
        return await Operations.searchMessages(guild, intentObj.targetRef, intentObj.args || { count: 25 }, executionContext);

      case 'pin_message':
        return await Operations.pinMessage(guild, intentObj.targetRef, intentObj.args.messageId, executionContext);

      case 'unpin_message':
        return await Operations.unpinMessage(guild, intentObj.targetRef, intentObj.args.messageId, executionContext);

      case 'add_reaction':
        return await Operations.addReaction(guild, intentObj.targetRef, intentObj.args.messageId, intentObj.args.emoji, executionContext);

      case 'move_channel':
        return await Operations.moveChannel(guild, intentObj.targetRef, intentObj.args.category, executionContext);

      case 'create_category':
        return await Operations.createCategory(guild, { name: intentObj.args?.name || intentObj.targetRef, ...intentObj.args }, executionContext);

      case 'rename_category':
        return await Operations.renameCategory(guild, intentObj.targetRef || intentObj.args?.targetCategory, intentObj.args?.newName || intentObj.args?.name, executionContext);

      case 'delete_category':
        return await Operations.deleteCategory(guild, intentObj.targetRef || intentObj.args?.targetCategory, intentObj.args || {}, executionContext);

      case 'inspect_category':
        return await Operations.inspectCategory(guild, intentObj.targetRef || intentObj.args?.targetCategory, executionContext);

      case 'list_categories':
        return await Operations.listCategories(guild, executionContext);

      case 'move_channel_to_category':
        return await Operations.moveChannelToCategory(guild, intentObj.targetRef || intentObj.args?.targetChannel, intentObj.args?.category ?? intentObj.args?.targetCategory, intentObj.args || {}, executionContext);

      case 'set_category_permission':
        return await Operations.setCategoryPermission(guild, intentObj.targetRef || intentObj.args?.targetCategory, intentObj.args?.targetRoleOrMember || intentObj.args?.targetRole || intentObj.args?.role, intentObj.args?.allow || [], intentObj.args?.deny || [], executionContext);

      case 'sync_category_permissions':
        return await Operations.syncCategoryPermissions(guild, intentObj.targetRef || intentObj.args?.targetCategory, intentObj.args?.targetChannel || 'all', executionContext);

      case 'inspect_category_sync':
        return await Operations.inspectCategorySync(guild, intentObj.targetRef || intentObj.args?.targetCategory, executionContext);

      case 'lookup_member':
        return await Operations.lookupMember(guild, intentObj.targetRef, executionContext);

      case 'get_bot_invite':
        return await Operations.getBotInvite(guild, executionContext);

      case 'explain_bot_installation':
        return await Operations.explainBotInstallation(guild, executionContext);

      case 'list_channels':
        return await Operations.listChannels(guild, executionContext);

      case 'list_roles':
        return await Operations.listRoles(guild, executionContext);

      case 'audit_server':
        return await Operations.auditServer(guild, executionContext);

      case 'music_play': {
        const rawQuery = intentObj.args?.query || intentObj.query || (intentObj.targetType !== 'channel' && intentObj.targetRef !== 'current' ? intentObj.targetRef : null) || intentObj.target;
        return await Operations.playMusic(guild, rawQuery, executionContext);
      }

      case 'music_pause':
        return await Operations.pauseMusic(guild, executionContext);

      case 'music_resume':
        return await Operations.resumeMusic(guild, executionContext);

      case 'music_skip':
        return await Operations.skipMusic(guild, executionContext);

      case 'music_stop':
        return await Operations.stopMusic(guild, executionContext);

      case 'music_queue':
        return await Operations.getMusicQueue(guild, executionContext);

      case 'music_nowplaying':
        return await Operations.getNowPlaying(guild, executionContext);

      case 'music_volume':
        return await Operations.setMusicVolume(guild, intentObj.args.volume, executionContext);

      case 'music_leave':
        return await Operations.leaveVoice(guild, executionContext);

      case 'open_dashboard': {
        const dashboardPayload = await DashboardManager.buildDashboardPayload(guild, executionContext.invokingMember, executionContext.invokingUser, 'overview');
        return {
          success: true,
          details: 'Opened interactive server dashboard.',
          embeds: dashboardPayload.embeds || [],
          components: dashboardPayload.components || []
        };
      }

      case 'inspect_modlog': {
        const conf = ModLogService.getConfig(guild.id);
        if (!conf || !conf.channelId) {
          const existingCh = guild.channels?.cache?.find?.(c => ['mod-logs', 'modlog', 'mod-log', 'moderation-logs'].includes(c.name?.toLowerCase()));
          if (existingCh) {
            return {
              success: true,
              details: `A moderation log channel exists at <#${existingCh.id}> (#${existingCh.name}), but mod-log delivery is not currently linked to it. Run \`/modlog prompt: use #${existingCh.name}\` to link it.`,
              channelId: existingCh.id,
              channelName: existingCh.name
            };
          }
          return {
            success: true,
            details: 'No moderation log channel is currently configured for this server. You can configure one with `/modlog prompt: set up modlog` or `/go prompt: set up modlog`.'
          };
        }
        const ch = guild.channels?.cache?.get?.(conf.channelId);
        const chMention = ch ? `<#${ch.id}>` : (conf.channelName ? `#${conf.channelName}` : `<#${conf.channelId}>`);
        return {
          success: true,
          details: `Mod logging is configured for ${chMention}. (Status: ${conf.enabled ? 'Enabled' : 'Disabled'})`,
          channelId: conf.channelId,
          channelName: conf.channelName
        };
      }

      case 'setup_modlog': {
        const targetRef = intentObj.targetRef || intentObj.args?.channel || 'mod-logs';
        const res = await ModLogService.setupModlogs(guild, {
          channelName: targetRef,
          createIfMissing: true,
          userTagOrId: executionContext.invokingUser?.tag || 'Admin',
          testDelivery: true
        });
        if (!res.success) {
          return { success: false, error: res.error || 'Failed to setup modlog channel' };
        }
        return {
          success: true,
          details: `Mod logging is configured for <#${res.channel?.id}>. The channel was verified and a test entry was delivered.`,
          channelId: res.channel?.id,
          channelName: res.channel?.name
        };
      }

      case 'voice_join':
      case 'music_join':
      case 'connect_voice': {
        const targetCh = intentObj.targetRef || intentObj.args?.channel;
        return await MusicService.connectVoice(guild, targetCh, executionContext.invokingMember);
      }

      case 'guard_channel': {
        const targetRef = intentObj.targetRef || intentObj.args?.channel || 'current';
        const channel = typeof executionContext?.resolveTarget === 'function'
          ? await executionContext.resolveTarget(targetRef, 'channel')
          : (/current|this/i.test(targetRef) ? executionContext?.channel : guild.channels.cache.find(c => c.id === targetRef || c.name?.toLowerCase() === String(targetRef).replace(/^#/, '').toLowerCase()));
        if (!channel) return { success: false, error: `Channel "${targetRef}" not found.` };
        ChannelGuard.guardChannel(guild.id, channel.id);
        return {
          success: true,
          details: `Channel <#${channel.id}> is now guarded. Normal user messages will receive a warning and be auto-deleted. After 3 warnings the user will be kicked. Spam messages trigger an instant kick.`
        };
      }

      case 'unguard_channel': {
        const targetRef = intentObj.targetRef || intentObj.args?.channel || 'current';
        const channel = typeof executionContext?.resolveTarget === 'function'
          ? await executionContext.resolveTarget(targetRef, 'channel')
          : (/current|this/i.test(targetRef) ? executionContext?.channel : guild.channels.cache.find(c => c.id === targetRef || c.name?.toLowerCase() === String(targetRef).replace(/^#/, '').toLowerCase()));
        if (!channel) return { success: false, error: `Channel "${targetRef}" not found.` };
        ChannelGuard.unguardChannel(guild.id, channel.id);
        return {
          success: true,
          details: `Channel <#${channel.id}> is no longer guarded.`
        };
      }

      case 'list_guarded_channels': {
        const ids = ChannelGuard.getGuardedChannels(guild.id);
        if (ids.length === 0) {
          return { success: true, details: 'No channels are currently explicitly guarded in this server.' };
        }
        const mentions = ids.map(id => `<#${id}>`).join(', ');
        return { success: true, details: `Guarded channels in this server: ${mentions}` };
      }

      case 'unsupported':
        return {
          success: false,
          error: intentObj.thought || 'This operation is not currently supported by Honey Bot or Discord API rules.'
        };

      default:
        // Convert intent to single action for standard execution
        const actionObj = {
          action: intentObj.intent,
          targetChannel: intentObj.targetRef,
          targetRole: intentObj.targetRef,
          targetMember: intentObj.targetRef,
          ...intentObj.args
        };
        return await Executor.executeSingleAction(guild, actionObj, executionId, executionContext.invokingMember);
    }
  }
}

