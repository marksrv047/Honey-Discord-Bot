import { ChannelType, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { checkRoleHierarchy, auditServerPermissions } from './permissions.js';
import { ActionLedger } from './recovery.js';
import { TicketManager } from './tickets.js';
import { MusicService } from './music-service.js';
import { resolveColor } from './color-utils.js';
import { Logger } from './logger.js';
import { MemberResolver } from './member-resolver.js';
import { ModLogService } from './mod-log.js';
import { WarningManager } from './warnings.js';
import { GuildConfigService } from './guild-config.js';

const logger = new Logger('Operations');

function getCacheValues(cache) {
  if (!cache) return [];
  if (Array.isArray(cache)) return cache;
  if (typeof cache.values === 'function') return Array.from(cache.values());
  return [];
}

function findInCache(cache, predicate) {
  if (!cache) return null;
  if (typeof cache.find === 'function') return cache.find(predicate);
  return getCacheValues(cache).find(predicate) || null;
}

/**
 * Deterministic Discord Administration Operations.
 * Each operation:
 * - Operates only on the targeted resource
 * - Enforces permissions and role hierarchy
 * - Is idempotent (no-ops if desired state already exists)
 * - Performs proportional verification
 * - Logs to ActionLedger for undoability
 */
export class Operations {
  /**
   * Renames a channel.
   */
  static async renameChannel(guild, channelRef, newName, context) {
    const channel = await context.resolveTarget(channelRef, 'channel');
    if (!channel) {
      return { success: false, error: `Channel "${channelRef}" not found`, action: 'rename_channel' };
    }

    // Idempotency: if already has this name, return success immediately without API call
    if (channel.name === newName) {
      return {
        success: true,
        action: 'rename_channel',
        details: `Channel #${channel.name} is already named "${newName}" (idempotent no-op)`,
        verified: true,
        resourceId: channel.id
      };
    }

    const oldName = channel.name;
    await channel.setName(newName, `Renamed via Honey Bot by ${context.invokingUser.tag}`);

    if (guild?.id && context?.executionId) {
      ActionLedger.recordAction(guild.id, context.executionId, {
        type: 'channel_rename',
        action: 'rename_channel',
        id: channel.id,
        targetId: channel.id,
        targetName: channel.name,
        oldName,
        newName,
        preState: { name: oldName },
        postState: { name: newName },
        actor: context.invokingUser ? { id: context.invokingUser.id, tag: context.invokingUser.tag } : null,
        reversibility: 'reversible'
      });
    }

    return {
      success: true,
      action: 'rename_channel',
      details: `Channel renamed to #${newName}`,
      verified: true,
      resourceId: channel.id
    };
  }

  /**
   * Edits channel topic.
   */
  static async editChannelTopic(guild, channelRef, topic, context) {
    const channel = await context.resolveTarget(channelRef, 'channel');
    if (!channel) {
      return { success: false, error: `Channel "${channelRef}" not found`, action: 'edit_channel_topic' };
    }

    if (channel.topic === topic) {
      return {
        success: true,
        action: 'edit_channel_topic',
        details: `Topic for #${channel.name} is already set to "${topic}"`,
        verified: true,
        resourceId: channel.id
      };
    }

    const oldTopic = channel.topic || '';
    await channel.setTopic(topic, `Topic updated via Honey Bot by ${context.invokingUser.tag}`);

    if (guild?.id && context?.executionId) {
      ActionLedger.recordAction(guild.id, context.executionId, {
        type: 'channel_topic',
        action: 'edit_channel_topic',
        id: channel.id,
        targetId: channel.id,
        targetName: channel.name,
        oldTopic,
        newTopic: topic,
        preState: { topic: oldTopic },
        postState: { topic },
        actor: context.invokingUser ? { id: context.invokingUser.id, tag: context.invokingUser.tag } : null,
        reversibility: 'reversible'
      });
    }

    return {
      success: true,
      action: 'edit_channel_topic',
      details: `Topic for #${channel.name} updated to "${topic}"`,
      verified: true,
      resourceId: channel.id
    };
  }

  /**
   * Sets channel slowmode (rate limit per user).
   */
  static async setChannelSlowmode(guild, channelRef, seconds, context) {
    const channel = await context.resolveTarget(channelRef, 'channel');
    if (!channel) {
      return { success: false, error: `Channel "${channelRef}" not found`, action: 'set_channel_slowmode' };
    }

    const sec = parseInt(seconds, 10);
    if (isNaN(sec) || sec < 0 || sec > 21600) {
      return {
        success: false,
        error: `Slowmode duration out of bounds: Slowmode must be between 0 and 21,600 seconds (6 hours). Received "${seconds}".`,
        action: 'set_channel_slowmode'
      };
    }

    if (channel.rateLimitPerUser === sec) {
      return {
        success: true,
        action: 'set_channel_slowmode',
        details: `Slowmode for #${channel.name} is already ${sec}s`,
        verified: true,
        resourceId: channel.id
      };
    }

    const oldSlowmode = channel.rateLimitPerUser || 0;
    await channel.setRateLimitPerUser(sec, `Slowmode set via Honey Bot by ${context.invokingUser.tag}`);

    if (guild?.id && context?.executionId) {
      ActionLedger.recordAction(guild.id, context.executionId, {
        type: 'channel_slowmode',
        action: 'set_channel_slowmode',
        id: channel.id,
        targetId: channel.id,
        targetName: channel.name,
        oldSlowmode,
        newSlowmode: sec,
        preState: { slowmode: oldSlowmode },
        postState: { slowmode: sec },
        actor: context.invokingUser ? { id: context.invokingUser.id, tag: context.invokingUser.tag } : null,
        reversibility: 'reversible'
      });
    }
    return {
      success: true,
      action: 'set_channel_slowmode',
      details: `Slowmode for #${channel.name} set to ${sec}s`,
      verified: true,
      resourceId: channel.id
    };
  }

  /**
   * Locks a channel (denies SendMessages to @everyone).
   */
  static async lockChannel(guild, channelRef, context) {
    const channel = await context.resolveTarget(channelRef, 'channel');
    if (!channel) {
      return { success: false, error: `Channel "${channelRef}" not found`, action: 'lock_channel' };
    }

    await channel.permissionOverwrites.edit(guild.roles.everyone, {
      SendMessages: false,
      AddReactions: false
    }, { reason: `Channel locked via Honey Bot by ${context.invokingUser.tag}` });

    return {
      success: true,
      action: 'lock_channel',
      details: `Channel #${channel.name} has been locked (@everyone SendMessages denied)`,
      verified: true,
      resourceId: channel.id
    };
  }

  /**
   * Unlocks a channel (restores SendMessages to @everyone).
   */
  static async unlockChannel(guild, channelRef, context) {
    const channel = await context.resolveTarget(channelRef, 'channel');
    if (!channel) {
      return { success: false, error: `Channel "${channelRef}" not found`, action: 'unlock_channel' };
    }

    await channel.permissionOverwrites.edit(guild.roles.everyone, {
      SendMessages: null
    }, { reason: `Channel unlocked via Honey Bot by ${context.invokingUser.tag}` });

    return {
      success: true,
      action: 'unlock_channel',
      details: `Channel #${channel.name} has been unlocked`,
      verified: true,
      resourceId: channel.id
    };
  }

  /**
   * Assigns a role to a member.
   */
  static async assignRole(guild, memberRef, roleRef, context) {
    const member = await context.resolveTarget(memberRef, 'member');
    if (!member) {
      return { success: false, error: `Member "${memberRef}" not found`, action: 'assign_role' };
    }
    if (member.isAmbiguous) {
      return { success: false, error: member.clarificationQuestion, isAmbiguous: true, action: 'assign_role' };
    }

    const role = await context.resolveTarget(roleRef, 'role');
    if (!role) {
      return { success: false, error: `Role "${roleRef}" not found`, action: 'assign_role' };
    }

    // Role hierarchy check
    const hierarchy = checkRoleHierarchy(guild, { action: 'assign_role' }, role);
    if (!hierarchy.valid) {
      return { success: false, error: hierarchy.reason, action: 'assign_role' };
    }

    // Idempotency check
    if (member.roles.cache.has(role.id)) {
      return {
        success: true,
        action: 'assign_role',
        details: `Member ${member.user.tag} already has role @${role.name} (idempotent no-op)`,
        verified: true,
        resourceId: role.id
      };
    }

    await member.roles.add(role, `Assigned via Honey Bot by ${context.invokingUser.tag}`);

    if (guild?.id && context?.executionId) {
      ActionLedger.recordAction(guild.id, context.executionId, {
        type: 'role_assignment',
        action: 'assign_role',
        targetMemberId: member.id,
        targetMemberTag: member.user?.tag,
        targetRoleId: role.id,
        targetRoleName: role.name,
        targetId: role.id,
        targetName: role.name,
        preState: { hasRole: false },
        postState: { hasRole: true },
        actor: context.invokingUser ? { id: context.invokingUser.id, tag: context.invokingUser.tag } : null,
        reversibility: 'reversible'
      });
    }

    return {
      success: true,
      action: 'assign_role',
      details: `Assigned role @${role.name} to ${member.user.tag}`,
      verified: true,
      resourceId: role.id
    };
  }

  /**
   * Removes a role from a member.
   */
  static async removeRole(guild, memberRef, roleRef, context) {
    const member = await context.resolveTarget(memberRef, 'member');
    if (!member) {
      return { success: false, error: `Member "${memberRef}" not found`, action: 'remove_role' };
    }
    if (member.isAmbiguous) {
      return { success: false, error: member.clarificationQuestion, isAmbiguous: true, action: 'remove_role' };
    }

    const role = await context.resolveTarget(roleRef, 'role');
    if (!role) {
      return { success: false, error: `Role "${roleRef}" not found`, action: 'remove_role' };
    }

    const hierarchy = checkRoleHierarchy(guild, { action: 'remove_role' }, role);
    if (!hierarchy.valid) {
      return { success: false, error: hierarchy.reason, action: 'remove_role' };
    }

    if (!member.roles.cache.has(role.id)) {
      return {
        success: true,
        action: 'remove_role',
        details: `Member ${member.user.tag} does not have role @${role.name} (idempotent no-op)`,
        verified: true,
        resourceId: role.id
      };
    }

    await member.roles.remove(role, `Removed via Honey Bot by ${context.invokingUser.tag}`);

    if (guild?.id && context?.executionId) {
      ActionLedger.recordAction(guild.id, context.executionId, {
        type: 'role_removal',
        action: 'remove_role',
        targetMemberId: member.id,
        targetMemberTag: member.user?.tag,
        targetRoleId: role.id,
        targetRoleName: role.name,
        targetId: role.id,
        targetName: role.name,
        preState: { hasRole: true },
        postState: { hasRole: false },
        actor: context.invokingUser ? { id: context.invokingUser.id, tag: context.invokingUser.tag } : null,
        reversibility: 'reversible'
      });
    }

    return {
      success: true,
      action: 'remove_role',
      details: `Removed role @${role.name} from ${member.user.tag}`,
      verified: true,
      resourceId: role.id
    };
  }

  /**
   * Creates a role with validated color and attributes.
   */
  static async createRole(guild, options = {}, context = {}) {
    const roleName = options.name || options.targetRole || 'new role';
    const existing = guild.roles?.cache?.find(r => r.name.toLowerCase() === roleName.toLowerCase());
    if (existing) {
      return {
        success: true,
        action: 'create_role',
        details: `Role @${existing.name} already exists (re-using existing)`,
        verified: true,
        resourceId: existing.id
      };
    }

    const resolvedColor = resolveColor(options.color) || '#99AAB5';
    const actorTag = context?.invokingUser ? context.invokingUser.tag : 'administrator';
    const role = await guild.roles.create({
      name: roleName,
      color: resolvedColor,
      hoist: Boolean(options.hoist),
      mentionable: Boolean(options.mentionable),
      permissions: options.permissions || [],
      reason: `Created via /go agent by ${actorTag}`
    });

    if (guild?.id && context?.executionId) {
      ActionLedger.recordCreatedResource(context.executionId, 'role', role.id, role.name);
    }

    return {
      success: true,
      action: 'create_role',
      details: `Role @${role.name} created with color ${resolvedColor}`,
      verified: true,
      resourceId: role.id
    };
  }

  /**
   * Deletes a role with hierarchy check.
   */
  static async deleteRole(guild, roleRef, context = {}) {
    const targetRef = roleRef || context?.targetRef;
    let role = null;
    if (context.resolveTarget) {
      role = await context.resolveTarget(targetRef, 'role');
    }
    if (!role && guild.roles?.cache) {
      const clean = String(targetRef).replace(/^@/, '').toLowerCase();
      role = guild.roles.cache.find(r => r.id === targetRef || r.name.toLowerCase() === clean);
    }
    if (!role) {
      return { success: true, action: 'delete_role', details: `Role "${targetRef}" does not exist (nothing to delete)`, verified: true };
    }

    const hierarchy = checkRoleHierarchy(guild, { action: 'delete_role' }, role);
    if (!hierarchy.valid) {
      return { success: false, error: hierarchy.reason, action: 'delete_role' };
    }

    const actorTag = context?.invokingUser ? context.invokingUser.tag : 'administrator';
    const oldName = role.name;
    const oldId = role.id;
    await role.delete(`Deleted via /go agent by ${actorTag}`);

    return {
      success: true,
      action: 'delete_role',
      details: `Role @${oldName} deleted`,
      verified: true,
      resourceId: oldId
    };
  }

  /**
   * Edits a role's name, color, hoist, or permissions with per-property verification.
   */
  static async editRole(guild, targetRoleRef, updates = {}, context = {}) {
    const roleIdentifier = targetRoleRef || updates.targetRole || updates.targetRef || updates.role || updates.name;
    let role;
    if (context.resolveTarget) {
      role = await context.resolveTarget(roleIdentifier, 'role');
    }
    if (!role && guild.roles?.cache) {
      const cleanRef = String(roleIdentifier).replace(/^@/, '').toLowerCase();
      role = guild.roles.cache.find(r => r.id === roleIdentifier || r.name.toLowerCase() === cleanRef);
    }
    if (!role) {
      return { success: false, error: `Role "${roleIdentifier}" not found in server.`, action: 'edit_role' };
    }

    const hierarchy = checkRoleHierarchy(guild, { action: 'edit_role' }, role);
    if (!hierarchy.valid) {
      return { success: false, error: hierarchy.reason, action: 'edit_role' };
    }

    const patchData = {};
    const requestedChanges = [];

    if (updates.name !== undefined && updates.name !== role.name) {
      patchData.name = updates.name;
      requestedChanges.push(`name to "${updates.name}"`);
    }

    if (updates.color !== undefined) {
      const resolvedColor = resolveColor(updates.color);
      if (!resolvedColor) {
        return {
          success: false,
          error: `Could not resolve role color "${updates.color}". Please specify a valid hex color code (e.g. #8B0000) or standard color name.`,
          action: 'edit_role'
        };
      }
      patchData.color = resolvedColor;
      requestedChanges.push(`color to ${resolvedColor}`);
    }

    if (updates.hoist !== undefined && updates.hoist !== role.hoist) {
      patchData.hoist = Boolean(updates.hoist);
      requestedChanges.push(`display separately (hoist)`);
    }

    if (updates.mentionable !== undefined && updates.mentionable !== role.mentionable) {
      patchData.mentionable = Boolean(updates.mentionable);
      requestedChanges.push(`mentionable`);
    }

    if (updates.permissions !== undefined) {
      patchData.permissions = updates.permissions;
      requestedChanges.push(`permissions`);
    }

    if (Object.keys(patchData).length === 0) {
      return {
        success: true,
        action: 'edit_role',
        targetRoleId: role.id,
        roleName: role.name,
        details: `Role @${role.name} already has the requested configuration.`,
        verified: true,
        resourceId: role.id
      };
    }

    const preState = {
      name: role.name,
      color: role.hexColor,
      hoist: role.hoist,
      mentionable: role.mentionable
    };

    const actorTag = context.invokingUser ? context.invokingUser.tag : 'administrator';
    await role.edit(patchData, `Edited via /go agent by ${actorTag}`);

    // Verify each property independently
    const verifiedProps = [];
    const failedProps = [];

    if (patchData.name) {
      if (role.name === patchData.name) verifiedProps.push(`name "${role.name}"`);
      else failedProps.push('name');
    }

    if (patchData.color) {
      if (role.hexColor?.toLowerCase() === patchData.color.toLowerCase()) {
        verifiedProps.push(`color ${patchData.color}`);
      } else {
        failedProps.push('color');
      }
    }

    if (patchData.hoist !== undefined) {
      if (role.hoist === patchData.hoist) verifiedProps.push('display separately');
      else failedProps.push('hoist');
    }

    const verified = failedProps.length === 0;

    if (guild?.id && context?.executionId) {
      ActionLedger.recordAction(guild.id, context.executionId, {
        type: 'role_edit',
        action: 'edit_role',
        targetRoleId: role.id,
        targetRoleName: role.name,
        preState,
        postState: {
          name: role.name,
          color: role.hexColor,
          hoist: role.hoist
        },
        actor: context.invokingUser ? { id: context.invokingUser.id, tag: context.invokingUser.tag } : null,
        reversibility: 'reversible'
      });
    }

    return {
      success: true,
      action: 'edit_role',
      targetRoleId: role.id,
      roleName: role.name,
      verified,
      verifiedProps,
      failedProps,
      details: verified
        ? `Role @${role.name} updated (${verifiedProps.join(', ')})`
        : `Role @${role.name} partially updated: verified ${verifiedProps.join(', ')}, but failed ${failedProps.join(', ')}`,
      resourceId: role.id
    };
  }

  /**
   * Creates a channel.
   */
  static async createChannel(guild, options, context) {
    let chType = ChannelType.GuildText;
    if (options.type === 'GUILD_VOICE' || options.type === 'VOICE') chType = ChannelType.GuildVoice;
    if (options.type === 'GUILD_CATEGORY' || options.type === 'CATEGORY') chType = ChannelType.GuildCategory;
    if (options.type === 'GUILD_ANNOUNCEMENT') chType = ChannelType.GuildAnnouncement;

    let parentId = null;
    if (options.category && chType !== ChannelType.GuildCategory) {
      const cat = await context.resolveTarget(options.category, 'channel');
      if (cat && cat.type === ChannelType.GuildCategory) parentId = cat.id;
    }

    // Idempotency: check if channel with same name and category already exists in cache
    const existing = findInCache(guild.channels?.cache, c => 
      c.name.toLowerCase() === options.name.toLowerCase() && 
      (parentId ? c.parentId === parentId : true)
    );
    if (existing) {
      return {
        success: true,
        action: 'create_channel',
        details: `Channel #${existing.name} already exists (re-using existing)`,
        verified: true,
        resourceId: existing.id
      };
    }

    const channel = await guild.channels.create({
      name: options.name,
      type: chType,
      parent: parentId,
      topic: options.topic,
      rateLimitPerUser: options.slowmodeSeconds || 0,
      reason: `Created via Honey Bot by ${context.invokingUser.tag}`
    });

    ActionLedger.recordCreatedResource(context.executionId, 'channel', channel.id, channel.name, guild.id);

    return {
      success: true,
      action: 'create_channel',
      details: `Channel #${channel.name} created successfully`,
      verified: true,
      resourceId: channel.id
    };
  }

  /**
   * Creates a role.
   */
  static async createRole(guild, options, context) {
    const existing = findInCache(guild.roles?.cache, r => r.name.toLowerCase() === options.name.toLowerCase());
    if (existing) {
      return {
        success: true,
        action: 'create_role',
        details: `Role @${existing.name} already exists (re-using existing)`,
        verified: true,
        resourceId: existing.id
      };
    }

    const role = await guild.roles.create({
      name: options.name,
      color: options.color || '#99AAB5',
      hoist: Boolean(options.hoist),
      mentionable: Boolean(options.mentionable),
      permissions: options.permissions || [],
      reason: `Created via Honey Bot by ${context.invokingUser.tag}`
    });

    ActionLedger.recordCreatedResource(context.executionId, 'role', role.id, role.name, guild.id);

    return {
      success: true,
      action: 'create_role',
      details: `Role @${role.name} created`,
      verified: true,
      resourceId: role.id
    };
  }

  /**
   * Deletes a channel (high-impact / destructive).
   */
  static async deleteChannel(guild, channelRef, context) {
    const channel = await context.resolveTarget(channelRef, 'channel');
    if (!channel) {
      return {
        success: true,
        action: 'delete_channel',
        details: `Channel "${channelRef}" already deleted or not found`,
        verified: true
      };
    }

    const name = channel.name;
    await channel.delete(`Deleted via Honey Bot by ${context.invokingUser.tag}`);
    return {
      success: true,
      action: 'delete_channel',
      details: `Channel #${name} deleted`,
      verified: true,
      resourceId: channel.id
    };
  }

  /**
   * Deletes a role (high-impact / destructive).
   */
  static async deleteRole(guild, roleRef, context) {
    const role = await context.resolveTarget(roleRef, 'role');
    if (!role) {
      return {
        success: true,
        action: 'delete_role',
        details: `Role "${roleRef}" already deleted or not found`,
        verified: true
      };
    }

    const hierarchy = checkRoleHierarchy(guild, { action: 'delete_role' }, role);
    if (!hierarchy.valid) {
      return { success: false, error: hierarchy.reason, action: 'delete_role' };
    }

    const name = role.name;
    await role.delete(`Deleted via Honey Bot by ${context.invokingUser.tag}`);
    return {
      success: true,
      action: 'delete_role',
      details: `Role @${name} deleted`,
      verified: true,
      resourceId: role.id
    };
  }

  /**
   * Replaces a member's server nickname with an explicit replacement value.
   * Preserves spaces, punctuation, checks constraints, and verifies postcondition.
   */
  static async changeNickname(guild, memberRef, nickname, context) {
    if (nickname === null) {
      return await Operations.removeNickname(guild, memberRef, context);
    }

    if (nickname === undefined || String(nickname).trim() === '') {
      return {
        success: false,
        error: 'No replacement nickname provided. To remove or reset a nickname instead, ask to remove or reset the nickname.',
        action: 'change_nickname'
      };
    }

    const targetNickname = String(nickname).trim();

    if (targetNickname.length < 1 || targetNickname.length > 32) {
      return {
        success: false,
        error: `Nickname length out of bounds: Discord nicknames must be between 1 and 32 characters (received ${targetNickname.length} characters).`,
        action: 'change_nickname'
      };
    }

    const ref = memberRef || 'me';
    let member;
    if (context && typeof context.resolveTarget === 'function') {
      member = await context.resolveTarget(ref, 'member');
    } else {
      member = await MemberResolver.resolveMember(guild, ref, context);
    }

    if (member?.isAmbiguous) {
      return {
        success: false,
        isAmbiguous: true,
        error: member.clarificationQuestion,
        candidates: member.candidates,
        action: 'change_nickname'
      };
    }

    if (!member) {
      return { success: false, error: `Member "${ref}" not found in this server.`, action: 'change_nickname' };
    }

    if (member.guild && member.guild.id && member.guild.id !== guild.id) {
      return { success: false, error: 'Cross-guild operations are not permitted.', action: 'change_nickname' };
    }

    const hierarchy = checkRoleHierarchy(guild, { action: 'change_nickname' }, member);
    if (!hierarchy.valid) {
      return { success: false, error: hierarchy.reason, action: 'change_nickname' };
    }

    const botMember = guild.members?.me || (guild.members?.cache ? guild.members.cache.get(guild.client?.user?.id) : null);
    if (botMember && typeof botMember.permissions?.has === 'function') {
      if (!botMember.permissions.has(PermissionFlagsBits.ManageNicknames) && !botMember.permissions.has(PermissionFlagsBits.Administrator)) {
        return {
          success: false,
          error: 'Honey Bot lacks the required "Manage Nicknames" permission in this server.',
          action: 'change_nickname'
        };
      }
    }

    const currentNickname = member.nickname || null;
    if (currentNickname === targetNickname) {
      return {
        success: true,
        action: 'change_nickname',
        targetMemberId: member.id,
        nickname: targetNickname,
        details: `Nickname for ${member.user?.tag || member.displayName} is already "${targetNickname}".`,
        verified: true,
        resourceId: member.id
      };
    }

    const oldNickname = member.nickname || '';
    const actorTag = context?.invokingUser ? context.invokingUser.tag : 'administrator';
    await member.setNickname(targetNickname, `Changed via Honey Bot by ${actorTag}`);

    // Verify resulting member state
    const updatedNickname = member.nickname ?? null;
    const verified = updatedNickname === targetNickname;

    if (guild?.id && context?.executionId) {
      ActionLedger.recordAction(guild.id, context.executionId, {
        type: 'nickname_change',
        action: 'change_nickname',
        targetMemberId: member.id,
        targetMemberTag: member.user?.tag,
        oldNickname,
        newNickname: targetNickname,
        preState: { nickname: oldNickname },
        postState: { nickname: targetNickname },
        actor: context.invokingUser ? { id: context.invokingUser.id, tag: context.invokingUser.tag } : null,
        reversibility: 'reversible'
      });
    }

    if (typeof ModLogService?.logAction === 'function') {
      await ModLogService.logAction(guild, {
        action: 'change_nickname',
        targetId: member.id,
        targetName: member.user?.tag || member.displayName,
        moderatorId: context?.invokingUser?.id,
        moderatorTag: context?.invokingUser?.tag,
        reason: `Changed nickname to "${targetNickname}"`,
        details: `Nickname changed from "${oldNickname || '(none)'}" to "${targetNickname}"`
      }).catch(err => logger.debug('ModLogService notification failed: ' + err.message));
    }

    return {
      success: true,
      action: 'change_nickname',
      targetMemberId: member.id,
      nickname: targetNickname,
      details: `Changed nickname for ${member.user?.tag || member.displayName} to "${targetNickname}".`,
      verified,
      verificationStatus: verified ? 'verified' : 'inconclusive',
      resourceId: member.id
    };
  }

  /**
   * Explicitly removes a member's server nickname, reverting to their default username.
   */
  static async removeNickname(guild, memberRef, context) {
    const ref = memberRef || 'me';
    let member;
    if (context && typeof context.resolveTarget === 'function') {
      member = await context.resolveTarget(ref, 'member');
    } else {
      member = await MemberResolver.resolveMember(guild, ref, context);
    }

    if (member?.isAmbiguous) {
      return {
        success: false,
        isAmbiguous: true,
        error: member.clarificationQuestion,
        candidates: member.candidates,
        action: 'remove_nickname'
      };
    }

    if (!member) {
      return { success: false, error: `Member "${ref}" not found in this server.`, action: 'remove_nickname' };
    }

    if (member.guild && member.guild.id && member.guild.id !== guild.id) {
      return { success: false, error: 'Cross-guild operations are not permitted.', action: 'remove_nickname' };
    }

    const hierarchy = checkRoleHierarchy(guild, { action: 'remove_nickname' }, member);
    if (!hierarchy.valid) {
      return { success: false, error: hierarchy.reason, action: 'remove_nickname' };
    }

    const botMember = guild.members?.me || (guild.members?.cache ? guild.members.cache.get(guild.client?.user?.id) : null);
    if (botMember && typeof botMember.permissions?.has === 'function') {
      if (!botMember.permissions.has(PermissionFlagsBits.ManageNicknames) && !botMember.permissions.has(PermissionFlagsBits.Administrator)) {
        return {
          success: false,
          error: 'Honey Bot lacks the required "Manage Nicknames" permission in this server.',
          action: 'remove_nickname'
        };
      }
    }

    const currentNickname = member.nickname || null;
    if (!currentNickname) {
      return {
        success: true,
        action: 'remove_nickname',
        targetMemberId: member.id,
        nickname: null,
        details: `Server nickname for ${member.user?.tag || member.displayName} is already cleared.`,
        verified: true,
        resourceId: member.id
      };
    }

    const oldNickname = member.nickname || '';
    const actorTag = context?.invokingUser ? context.invokingUser.tag : 'administrator';
    await member.setNickname(null, `Removed nickname via Honey Bot by ${actorTag}`);

    const updatedNickname = member.nickname ?? null;
    const verified = updatedNickname === null;

    if (guild?.id && context?.executionId) {
      ActionLedger.recordAction(guild.id, context.executionId, {
        type: 'nickname_change',
        action: 'remove_nickname',
        targetMemberId: member.id,
        targetMemberTag: member.user?.tag,
        oldNickname,
        newNickname: null,
        preState: { nickname: oldNickname },
        postState: { nickname: null },
        actor: context.invokingUser ? { id: context.invokingUser.id, tag: context.invokingUser.tag } : null,
        reversibility: 'reversible'
      });
    }

    if (typeof ModLogService?.logAction === 'function') {
      await ModLogService.logAction(guild, {
        action: 'remove_nickname',
        targetId: member.id,
        targetName: member.user?.tag || member.displayName,
        moderatorId: context?.invokingUser?.id,
        moderatorTag: context?.invokingUser?.tag,
        reason: 'Removed server nickname',
        details: `Cleared server nickname "${oldNickname}"`
      }).catch(err => logger.debug('ModLogService notification failed: ' + err.message));
    }

    return {
      success: true,
      action: 'remove_nickname',
      targetMemberId: member.id,
      nickname: null,
      details: `Removed server nickname for ${member.user?.tag || member.displayName} (reverted to username).`,
      verified,
      verificationStatus: verified ? 'verified' : 'inconclusive',
      resourceId: member.id
    };
  }

  /**
   * Inspects a member's current nickname and username (read-only, no mutation).
   */
  static async inspectNickname(guild, memberRef, context) {
    const ref = memberRef || 'me';
    let member;
    if (context && typeof context.resolveTarget === 'function') {
      member = await context.resolveTarget(ref, 'member');
    } else {
      member = await MemberResolver.resolveMember(guild, ref, context);
    }

    if (member?.isAmbiguous) {
      return {
        success: false,
        isAmbiguous: true,
        error: member.clarificationQuestion,
        candidates: member.candidates,
        action: 'inspect_nickname'
      };
    }

    if (!member) {
      return { success: false, error: `Member "${ref}" not found in this server.`, action: 'inspect_nickname' };
    }

    const currentNick = member.nickname;
    const globalUsername = member.user?.username || 'Unknown';
    const displayName = member.displayName || globalUsername;

    const details = `**Nickname Information for ${displayName}:**\n` +
      `• Server Nickname: ${currentNick ? `"${currentNick}"` : '*None set (using username)*'}\n` +
      `• Global Username: \`${globalUsername}\`\n` +
      `• Server Display Name: **${displayName}**\n` +
      `• User ID: \`${member.id}\``;

    return {
      success: true,
      action: 'inspect_nickname',
      targetMemberId: member.id,
      details,
      verified: true
    };
  }

  /**
   * Lists server channels (only called when user explicitly asks for discovery/listing).
   */
  static async listChannels(guild, context) {
    // Only fetch channels if cache is empty or discovery requested
    const cacheSize = guild.channels?.cache?.size || 0;
    if (cacheSize === 0 && typeof guild.channels?.fetch === 'function') {
      await guild.channels.fetch();
    }

    const allChannels = getCacheValues(guild.channels?.cache);
    const categories = allChannels
      .filter(c => c.type === ChannelType.GuildCategory)
      .map(c => `📁 **${c.name}**`);

    const textChannels = allChannels
      .filter(c => c.type === ChannelType.GuildText || c.type === 0)
      .map(c => `#${c.name}`);

    const voiceChannels = allChannels
      .filter(c => c.type === ChannelType.GuildVoice || c.type === 2)
      .map(c => `🔊 ${c.name}`);

    return {
      success: true,
      action: 'list_channels',
      details: `Found ${allChannels.length} total channels:\n` +
        (categories.length ? categories.slice(0, 10).join(', ') + '\n' : '') +
        (textChannels.length ? `Text: ${textChannels.slice(0, 20).join(', ')}\n` : '') +
        (voiceChannels.length ? `Voice: ${voiceChannels.slice(0, 10).join(', ')}` : ''),
      verified: true
    };
  }

  /**
   * Lists server roles (only called when user explicitly asks).
   */
  static async listRoles(guild, context) {
    const cacheSize = guild.roles?.cache?.size || 0;
    if (cacheSize <= 1 && typeof guild.roles?.fetch === 'function') {
      await guild.roles.fetch();
    }

    const allRoles = getCacheValues(guild.roles?.cache);
    const roles = allRoles
      .filter(r => r.id !== guild.id)
      .sort((a, b) => (b.position || 0) - (a.position || 0))
      .map(r => `@${r.name}`);

    return {
      success: true,
      action: 'list_roles',
      details: `Found ${roles.length} roles (by hierarchy):\n${roles.slice(0, 25).join(', ')}`,
      verified: true
    };
  }

  /**
   * Read-only server permission audit.
   */
  static async auditServer(guild, context) {
    const issues = auditServerPermissions(guild);
    return {
      success: true,
      action: 'audit_server',
      details: issues.length > 0 
        ? issues.join(' | ') 
        : 'Security audit passed: No excessive @everyone permissions found.',
      verified: true
    };
  }

  /**
   * Broadcasts a rich announcement to a channel with optional @everyone ping.
   */
  static async sendAnnouncement(guild, channelRef, options, context) {
    const channel = await context.resolveTarget(channelRef, 'channel');
    if (!channel) {
      return { success: false, error: `Announcement channel "${channelRef}" not found in this server.`, action: 'send_announcement' };
    }

    // Channel-specific permission inspection
    const botMember = guild.members?.me;
    if (botMember && typeof channel.permissionsFor === 'function') {
      const perms = channel.permissionsFor(botMember);
      if (!perms.has(PermissionFlagsBits.ViewChannel)) {
        return {
          success: false,
          error: `Bot cannot view channel #${channel.name}. Please grant Honey Bot the "View Channel" permission in #${channel.name}.`,
          action: 'send_announcement'
        };
      }
      if (!perms.has(PermissionFlagsBits.SendMessages)) {
        return {
          success: false,
          error: `Bot does not have permission to send messages in #${channel.name}. In Channel Settings > Permissions for #${channel.name}, allow Honey Bot to "Send Messages".`,
          action: 'send_announcement'
        };
      }
      if (options.mentionEveryone && !perms.has(PermissionFlagsBits.MentionEveryone)) {
        return {
          success: false,
          error: `Bot lacks permission to mention @everyone in #${channel.name}. Please grant Honey Bot "Mention @everyone" permission in #${channel.name}.`,
          action: 'send_announcement'
        };
      }
    }

    const msgText = options.message || '';
    if (msgText.length > 4000) {
      return {
        success: false,
        error: `Announcement length out of bounds: Message is ${msgText.length} characters, exceeding Discord's 4,000 character embed description limit.`,
        action: 'send_announcement'
      };
    }

    const embed = new EmbedBuilder()
      .setTitle(options.title || '📢 Server Announcement')
      .setDescription(options.message || 'Announcement')
      .setColor(0xE67E22)
      .setTimestamp()
      .setFooter({ text: `Announced by ${context.invokingUser.tag}` });

    const payload = { embeds: [embed] };
    if (options.mentionEveryone) {
      payload.content = '@everyone';
    }

    let sent;
    try {
      sent = await channel.send(payload);
    } catch (err) {
      if (err.code === 50013 || err.message?.includes('Missing Permissions')) {
        return {
          success: false,
          error: `Discord Permission Error: Honey Bot cannot post in #${channel.name}. Please ensure the bot's role or channel permission overwrite has "Send Messages" enabled.`,
          action: 'send_announcement'
        };
      }
      throw err;
    }

    return {
      success: true,
      action: 'send_announcement',
      details: `Announcement posted to #${channel.name}${options.mentionEveryone ? ' with @everyone' : ''}`,
      verified: Boolean(sent?.id),
      resourceId: sent?.id
    };
  }

  /**
   * Sends a standard message to a channel.
   */
  static async sendMessage(guild, channelRef, content, context) {
    const channel = await context.resolveTarget(channelRef, 'channel');
    if (!channel) {
      return { success: false, error: `Target channel "${channelRef}" not found in this server.`, action: 'send_message' };
    }

    const text = typeof content === 'object' ? (content.content || content.message) : content;
    if (!text || String(text).trim().length === 0) {
      return { success: false, error: 'Message content cannot be empty.', action: 'send_message' };
    }
    if (String(text).length > 2000) {
      return {
        success: false,
        error: `Message length out of bounds: Content is ${String(text).length} characters, exceeding Discord's 2,000 character limit. Split your message into multiple parts.`,
        action: 'send_message'
      };
    }

    // Channel-specific permission inspection
    const botMember = guild.members?.me;
    if (botMember && typeof channel.permissionsFor === 'function') {
      const perms = channel.permissionsFor(botMember);
      if (!perms.has(PermissionFlagsBits.ViewChannel)) {
        return {
          success: false,
          error: `Bot cannot view channel #${channel.name}. Please grant Honey Bot "View Channel" in #${channel.name}.`,
          action: 'send_message'
        };
      }
      if (!perms.has(PermissionFlagsBits.SendMessages)) {
        return {
          success: false,
          error: `Bot does not have permission to send messages in #${channel.name}. In Channel Settings > Permissions for #${channel.name}, allow Honey Bot to "Send Messages".`,
          action: 'send_message'
        };
      }
    }

    let sent;
    try {
      sent = await channel.send(text);
    } catch (err) {
      if (err.code === 50013 || err.message?.includes('Missing Permissions')) {
        return {
          success: false,
          error: `Discord Permission Error: Honey Bot cannot send messages in #${channel.name}. Please check channel permissions for the bot in #${channel.name}.`,
          action: 'send_message'
        };
      }
      throw err;
    }

    return {
      success: true,
      action: 'send_message',
      details: `Message sent to #${channel.name}`,
      verified: Boolean(sent?.id),
      resourceId: sent?.id
    };
  }

  /**
   * Searches messages within a channel (Read-only search, zero mutations).
   */
  static async searchMessages(guild, channelRef, options = {}, context = {}) {
    const channel = await context.resolveTarget(channelRef || options.targetChannel || 'current', 'channel');
    if (!channel) {
      return { success: false, error: `Channel "${channelRef || 'current'}" not found.`, action: 'search_messages' };
    }

    let targetAuthorId = options.authorId || null;
    if (options.author) {
      const authRef = String(options.author).trim();
      if (/^(me|my|myself|self|i)$/i.test(authRef)) {
        targetAuthorId = context.invokingUser?.id;
      } else {
        const resolved = await context.resolveTarget(authRef, 'member');
        if (resolved && !resolved.isAmbiguous) {
          targetAuthorId = resolved.id || resolved.user?.id;
        }
      }
    }

    const limit = Math.min(100, Math.max(1, parseInt(options.limit || 25, 10)));
    const fetched = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!fetched) {
      return { success: false, error: `Could not fetch messages from #${channel.name}.`, action: 'search_messages' };
    }

    const messages = Array.from(fetched.values());
    const matches = [];

    for (const msg of messages) {
      if (targetAuthorId && msg.author?.id !== targetAuthorId) continue;
      if (options.contains && !msg.content?.toLowerCase().includes(options.contains.toLowerCase())) continue;
      matches.push({
        id: msg.id,
        author: msg.author?.tag || msg.author?.id,
        authorId: msg.author?.id,
        content: msg.content,
        createdAt: msg.createdAt
      });
      if (matches.length >= limit) break;
    }

    return {
      success: true,
      action: 'search_messages',
      matchCount: matches.length,
      matches,
      details: `Found ${matches.length} matching message(s) in #${channel.name}. (Read-only search, no messages were deleted).`,
      verified: true
    };
  }

  /**
   * Purges / bulk deletes messages from a channel with strict target, author, and age constraints.
   */
  static async purgeMessages(guild, channelRef, countOrOptions = 5, context = {}) {
    const config = typeof countOrOptions === 'number' ? { count: countOrOptions } : (countOrOptions || {});
    const countNum = parseInt(config.count !== undefined ? config.count : 5, 10);
    if (isNaN(countNum) || countNum < 1 || countNum > 100) {
      return { success: false, error: 'Bulk delete must be between 1 and 100 messages.', action: 'purge_messages' };
    }

    const channel = await context.resolveTarget(channelRef || config.targetChannel || 'current', 'channel');
    if (!channel) {
      return { success: false, error: `Channel "${channelRef || 'current'}" not found in this server.`, action: 'purge_messages' };
    }

    // 1. Resolve author filter if requested
    let targetAuthorId = config.authorId || null;

    if (config.author) {
      const authRef = String(config.author).trim();
      if (/^(me|my|myself|self|i)$/i.test(authRef)) {
        targetAuthorId = context.invokingUser?.id;
      } else {
        const resolved = await context.resolveTarget(authRef, 'member');
        if (resolved?.isAmbiguous) {
          return {
            success: false,
            isAmbiguous: true,
            error: resolved.clarificationQuestion,
            action: 'purge_messages'
          };
        }
        if (!resolved) {
          return {
            success: false,
            error: `Target author "${authRef}" could not be resolved. Message deletion stopped to prevent deleting unintended messages.`,
            action: 'purge_messages'
          };
        }
        targetAuthorId = resolved.id || resolved.user?.id;
      }
    }

    let candidates = [];
    let eligible = [];
    let skippedOldCount = 0;
    let deletedCount = 0;

    if (!targetAuthorId && !config.contains && (!channel.messages?.fetch || typeof channel.messages?.fetch !== 'function')) {
      const deleted = await channel.bulkDelete(countNum);
      deletedCount = (deleted instanceof Map || deleted instanceof Set) ? deleted.size : (deleted?.length ?? countNum);
    } else {
      const fetchLimit = (targetAuthorId || config.contains) ? 100 : countNum;
      if (!channel.messages?.fetch) {
        return {
          success: false,
          error: `Message history cannot be fetched for #${channel.name} to apply required filters.`,
          action: 'purge_messages'
        };
      }
      const fetched = await channel.messages.fetch({ limit: fetchLimit });
      candidates = Array.from(fetched.values());

      const now = Date.now();
      const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;

      for (const msg of candidates) {
        // Author check
        if (targetAuthorId && msg.author?.id !== targetAuthorId) {
          continue;
        }

        // Content match check
        if (config.contains && !msg.content?.toLowerCase().includes(config.contains.toLowerCase())) {
          continue;
        }

        // 14-day Discord restriction check
        if (now - msg.createdTimestamp >= fourteenDaysMs) {
          skippedOldCount++;
          continue;
        }

        eligible.push(msg);
        if (eligible.length >= countNum) break;
      }

      if (eligible.length === 0) {
        let desc = `No matching messages eligible for deletion found in #${channel.name}`;
        if (targetAuthorId) desc += ` from user <@${targetAuthorId}>`;
        if (config.contains) desc += ` matching "${config.contains}"`;
        if (skippedOldCount > 0) desc += ` (${skippedOldCount} message(s) skipped because they are older than Discord's 14-day bulk-delete limit)`;
        return {
          success: true,
          action: 'purge_messages',
          targetChannelId: channel.id,
          channelName: channel.name,
          deletedCount: 0,
          eligibleCount: 0,
          candidateCount: candidates.length,
          skippedCount: skippedOldCount,
          details: desc + '.',
          verified: true
        };
      }

      // Bulk delete only the eligible filtered messages
      const deleted = await channel.bulkDelete(eligible, true);
      deletedCount = deleted?.size ?? eligible.length;
    }

    if (guild?.id && context?.executionId) {
      ActionLedger.recordAction(guild.id, context.executionId, {
        type: 'purge_messages',
        action: 'purge_messages',
        targetChannelId: channel.id,
        targetChannelName: channel.name,
        targetId: channel.id,
        targetName: channel.name,
        count: deletedCount,
        authorFilter: targetAuthorId,
        actor: context.invokingUser ? { id: context.invokingUser.id, tag: context.invokingUser.tag } : null,
        reversibility: 'irreversible',
        unavailabilityReason: 'Bulk message deletions cannot be undone because Discord permanently removes purged messages from its servers.'
      });
    }

    let detailStr = targetAuthorId
      ? `Purged ${deletedCount} message(s) from <@${targetAuthorId}> in #${channel.name}`
      : `Purged ${deletedCount} messages from #${channel.name}`;

    if (skippedOldCount > 0) {
      detailStr += ` (${skippedOldCount} older than 14 days skipped)`;
    }

    return {
      success: true,
      action: 'purge_messages',
      targetChannelId: channel.id,
      channelName: channel.name,
      deletedCount,
      eligibleCount: eligible.length,
      candidateCount: candidates.length,
      skippedCount: skippedOldCount,
      details: detailStr,
      verified: true
    };
  }

  /**
   * Pins a message in a channel.
   */
  static async pinMessage(guild, channelRef, messageId, context) {
    const channel = await context.resolveTarget(channelRef, 'channel');
    if (!channel) return { success: false, error: `Channel "${channelRef}" not found`, action: 'pin_message' };
    const msg = await channel.messages.fetch(messageId);
    if (!msg) return { success: false, error: `Message "${messageId}" not found in #${channel.name}`, action: 'pin_message' };
    await msg.pin();
    return {
      success: true,
      action: 'pin_message',
      details: `Pinned message (${messageId}) in #${channel.name}`,
      verified: true
    };
  }

  /**
   * Unpins a message in a channel.
   */
  static async unpinMessage(guild, channelRef, messageId, context) {
    const channel = await context.resolveTarget(channelRef, 'channel');
    if (!channel) return { success: false, error: `Channel "${channelRef}" not found`, action: 'unpin_message' };
    const msg = await channel.messages.fetch(messageId);
    if (!msg) return { success: false, error: `Message "${messageId}" not found in #${channel.name}`, action: 'unpin_message' };
    await msg.unpin();
    return {
      success: true,
      action: 'unpin_message',
      details: `Unpinned message (${messageId}) in #${channel.name}`,
      verified: true
    };
  }

  /**
   * Adds an emoji reaction to a message.
   */
  static async addReaction(guild, channelRef, messageId, emoji, context) {
    const channel = await context.resolveTarget(channelRef, 'channel');
    if (!channel) return { success: false, error: `Channel "${channelRef}" not found`, action: 'add_reaction' };
    const msg = await channel.messages.fetch(messageId);
    if (!msg) return { success: false, error: `Message "${messageId}" not found in #${channel.name}`, action: 'add_reaction' };
    await msg.react(emoji);
    return {
      success: true,
      action: 'add_reaction',
      details: `Added reaction ${emoji} to message ${messageId}`,
      verified: true
    };
  }

  /**
   * Moves a channel to a specific category.
   */
  static async moveChannel(guild, channelRef, categoryRef, context) {
    const channel = await context.resolveTarget(channelRef, 'channel');
    if (!channel) return { success: false, error: `Channel "${channelRef}" not found`, action: 'move_channel' };
    const category = await context.resolveTarget(categoryRef, 'channel');
    if (!category || category.type !== ChannelType.GuildCategory) {
      return { success: false, error: `Category "${categoryRef}" not found or is not a category`, action: 'move_channel' };
    }
    await channel.setParent(category.id, { lockPermissions: false });
    return {
      success: true,
      action: 'move_channel',
      details: `Moved #${channel.name} under category "${category.name}"`,
      verified: true
    };
  }

  /**
   * Looks up a member and generates a detailed evidence-based profile display.
   * Produces both a Discord Embed and structured markdown text.
   */
  static async lookupMember(guild, memberRef, context) {
    const ref = memberRef || 'me';
    let member;
    if (context && typeof context.resolveTarget === 'function') {
      member = await context.resolveTarget(ref, 'member');
    } else {
      member = await MemberResolver.resolveMember(guild, ref, context);
    }

    if (member?.isAmbiguous) {
      return {
        success: false,
        isAmbiguous: true,
        error: member.clarificationQuestion,
        candidates: member.candidates,
        action: 'lookup_member'
      };
    }

    if (!member) {
      return { success: false, error: `Member "${ref}" not found in this server.`, action: 'lookup_member' };
    }

    // 1. Identity
    const user = member.user || {};
    const isBot = Boolean(user.bot);
    const globalUsername = user.username || 'Unknown';
    const serverNickname = member.nickname || null;
    const displayName = member.displayName || globalUsername;
    const accountCreatedTs = user.createdTimestamp ? Math.floor(user.createdTimestamp / 1000) : null;
    const avatarUrl = typeof member.displayAvatarURL === 'function' ? member.displayAvatarURL({ dynamic: true, size: 256 }) : null;

    // 2. Server Membership
    const joinedTs = member.joinedTimestamp ? Math.floor(member.joinedTimestamp / 1000) : null;
    const isOwner = guild.ownerId === member.id;
    const highestRole = member.roles?.highest || { name: '@everyone', position: 0 };

    // Role hierarchy comparison
    const botMember = guild.members?.me || (guild.members?.cache ? guild.members.cache.get(guild.client?.user?.id) : null);
    const botHighest = botMember?.roles?.highest;
    let hierarchyStatus = 'Standard hierarchy';
    if (isOwner) {
      hierarchyStatus = '👑 Server Owner (Protected from moderation/bot changes)';
    } else if (botHighest) {
      if (botHighest.position > highestRole.position) {
        hierarchyStatus = `Manageable by Bot (Bot role position: ${botHighest.position} > ${highestRole.position})`;
      } else {
        hierarchyStatus = `⚠️ Above or equal to Bot role (Bot position: ${botHighest.position} ≤ ${highestRole.position} — Bot cannot modify this member)`;
      }
    }

    // 3. Roles
    const rawRoles = member.roles?.cache ? getCacheValues(member.roles.cache) : [];
    const assignedRoles = rawRoles
      .filter(r => r.id !== guild.id)
      .sort((a, b) => (b.position || 0) - (a.position || 0));
    const roleMentions = assignedRoles.map(r => `<@&${r.id}>`);
    const roleNames = assignedRoles.map(r => `@${r.name}`);
    const displayedRoles = roleMentions.length > 20
      ? roleMentions.slice(0, 20).join(', ') + ` *...and ${roleMentions.length - 20} more*`
      : (roleMentions.join(', ') || '*No roles assigned*');
    const displayedRoleNames = roleNames.length > 20
      ? roleNames.slice(0, 20).join(', ') + ` *...and ${roleNames.length - 20} more*`
      : (roleNames.join(', ') || '*No roles assigned*');

    // 4. Permissions (Guild vs Channel distinction)
    const isAdmin = Boolean(member.permissions?.has?.(PermissionFlagsBits.Administrator));
    const keyPermsList = [
      { name: 'Administrator', flag: PermissionFlagsBits.Administrator },
      { name: 'Manage Server', flag: PermissionFlagsBits.ManageGuild },
      { name: 'Manage Roles', flag: PermissionFlagsBits.ManageRoles },
      { name: 'Manage Channels', flag: PermissionFlagsBits.ManageChannels },
      { name: 'Ban Members', flag: PermissionFlagsBits.BanMembers },
      { name: 'Kick Members', flag: PermissionFlagsBits.KickMembers },
      { name: 'Moderate Members (Timeout)', flag: PermissionFlagsBits.ModerateMembers },
      { name: 'Manage Messages', flag: PermissionFlagsBits.ManageMessages },
      { name: 'Manage Nicknames', flag: PermissionFlagsBits.ManageNicknames },
      { name: 'Mention @everyone', flag: PermissionFlagsBits.MentionEveryone },
      { name: 'View Audit Log', flag: PermissionFlagsBits.ViewAuditLog }
    ];

    const grantedGuildPerms = [];
    for (const p of keyPermsList) {
      if (typeof member.permissions?.has === 'function' && member.permissions.has(p.flag)) {
        grantedGuildPerms.push(p.name);
      }
    }

    let channelPermNote = '';
    if (context?.channel && typeof member.permissionsIn === 'function') {
      try {
        const inChan = member.permissionsIn(context.channel);
        const canSend = inChan.has(PermissionFlagsBits.SendMessages);
        const canView = inChan.has(PermissionFlagsBits.ViewChannel);
        channelPermNote = `\n• Channel-specific (<#${context.channel.id}>): View: ${canView ? '✅' : '❌'}, Send: ${canSend ? '✅' : '❌'}`;
        if (isAdmin) {
          channelPermNote += ' *(Administrator bypasses channel overwrites)*';
        }
      } catch {}
    }

    // 5. Moderation History from ActionLedger
    let activeTimeoutNote = 'None (Active)';
    if (member.communicationDisabledUntilTimestamp && member.communicationDisabledUntilTimestamp > Date.now()) {
      const timeoutTs = Math.floor(member.communicationDisabledUntilTimestamp / 1000);
      activeTimeoutNote = `⚠️ Active timeout until <t:${timeoutTs}:F> (<t:${timeoutTs}:R>)`;
    }

    ActionLedger.loadAllHistory();
    const gLedger = ActionLedger.getGuildLedger(guild.id);
    const memberActions = [];
    if (gLedger) {
      for (const [execId, acts] of gLedger.entries()) {
        for (const act of acts) {
          if (act.targetMemberId === member.id || act.targetMemberTag === member.user?.tag) {
            memberActions.push(act);
          }
        }
      }
    }
    memberActions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    let modHistorySummary = '';
    if (memberActions.length > 0) {
      const recent = memberActions.slice(0, 3).map(a => {
        const ts = a.timestamp ? `<t:${Math.floor(a.timestamp / 1000)}:R>` : 'Recently';
        const actName = (a.action || a.type || 'Action').replace(/_/g, ' ');
        const reason = a.reason || a.args?.reason ? ` (Reason: "${a.reason || a.args?.reason}")` : '';
        return `• **${actName}** ${ts}${reason}`;
      }).join('\n');
      modHistorySummary = `Recorded actions (${memberActions.length} total):\n${recent}`;
    } else {
      modHistorySummary = 'No moderation records found in Honey Bot log.\n*(Note: Actions taken outside bot commands or prior to bot installation are not tracked).*';
    }

    // 6. Status and Activity
    const inVoice = member.voice?.channel ? `🔊 Connected to <#${member.voice.channel.id}> (${member.voice.channel.name})` : 'Not in voice';
    const presenceStatus = member.presence?.status ? `Status: ${member.presence.status}` : 'Presence data unavailable (requires privileged Presence Gateway intent)';

    // Build Discord Embed
    const embed = new EmbedBuilder()
      .setColor(0xFEE75C)
      .setTitle(`Member Profile: ${displayName}`)
      .setThumbnail(avatarUrl)
      .addFields(
        {
          name: '👤 Identity',
          value: `• **Global Username:** \`${globalUsername}\`\n` +
                 `• **Server Nickname:** ${serverNickname ? `\`${serverNickname}\`` : '*None (using display name)*'}\n` +
                 `• **Display Name:** **${displayName}**\n` +
                 `• **User ID:** \`${member.id}\` (<@${member.id}>)\n` +
                 `• **Account Type:** ${isBot ? '🤖 Bot Account' : '👤 Human User'}\n` +
                 `• **Created:** ${accountCreatedTs ? `<t:${accountCreatedTs}:F> (<t:${accountCreatedTs}:R>)` : 'Unknown'}`,
          inline: false
        },
        {
          name: '🏰 Server Membership',
          value: `• **Joined Server:** ${joinedTs ? `<t:${joinedTs}:F> (<t:${joinedTs}:R>)` : 'Unknown'}\n` +
                 `• **Highest Role:** **${highestRole.name}** (Position: ${highestRole.position})\n` +
                 `• **Hierarchy:** ${hierarchyStatus}`,
          inline: false
        },
        {
          name: `🛡️ Roles (${assignedRoles.length})`,
          value: displayedRoles,
          inline: false
        },
        {
          name: '🔑 Key Permissions',
          value: (grantedGuildPerms.length > 0 ? grantedGuildPerms.join(', ') : 'Standard member permissions') + channelPermNote,
          inline: false
        },
        {
          name: '📋 Moderation Status & History',
          value: `• **Current Restriction:** ${activeTimeoutNote}\n• ${modHistorySummary}`,
          inline: false
        },
        {
          name: '📡 Status & Voice',
          value: `• **Voice:** ${inVoice}\n• **Presence:** ${presenceStatus}`,
          inline: false
        }
      )
      .setFooter({ text: `Honey Bot Member Inspection • ID: ${member.id}` })
      .setTimestamp();

    // Clean Markdown string fallback for text-only contexts
    const markdownDetails = `### 👤 Member Profile: **${displayName}**\n` +
      `**Identity**\n` +
      `• Global Username: \`${globalUsername}\`\n` +
      `• Server Nickname: ${serverNickname ? `"${serverNickname}"` : '*None set*'}\n` +
      `• Display Name: **${displayName}**\n` +
      `• User ID: \`${member.id}\` (<@${member.id}>)\n` +
      `• Account Type: ${isBot ? 'Bot Account 🤖' : 'Human User 👤'}\n` +
      `• Created: ${accountCreatedTs ? `<t:${accountCreatedTs}:F>` : 'Unknown'}\n\n` +
      `**Server Membership**\n` +
      `• Joined: ${joinedTs ? `<t:${joinedTs}:F>` : 'Unknown'}\n` +
      `• Highest Role: **${highestRole.name}** (Position: ${highestRole.position})\n` +
      `• Hierarchy: ${hierarchyStatus}\n\n` +
      `**Roles (${assignedRoles.length})**\n` +
      `${displayedRoleNames}\n\n` +
      `**Key Permissions**\n` +
      `• Guild Permissions: ${grantedGuildPerms.length > 0 ? grantedGuildPerms.join(', ') : 'Standard member'}${channelPermNote}\n\n` +
      `**Moderation Status & History**\n` +
      `• Active Restriction: ${activeTimeoutNote}\n` +
      `• ${modHistorySummary}\n\n` +
      `**Voice & Activity**\n` +
      `• Voice: ${inVoice}\n` +
      `• Presence: ${presenceStatus}`;

    return {
      success: true,
      action: 'lookup_member',
      targetMemberId: member.id,
      details: markdownDetails,
      embed,
      embeds: [embed],
      verified: true
    };
  }

  /**
   * Generates official OAuth2 installation link for Honey Bot.
   */
  static async getBotInvite(guild, context) {
    const clientId = guild?.client?.user?.id || '1563781678063689749';
    const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=8&scope=bot%20applications.commands`;
    return {
      success: true,
      action: 'get_bot_invite',
      details: `🔗 **Official Bot Installation Link:**\n[Click here to invite Honey Bot](${inviteUrl})\n\n*(Note: Per Discord security rules, adding bots requires an administrator to complete the OAuth2 browser flow).*`,
      verified: true
    };
  }

  /**
   * Explains Discord bot installation requirements.
   */
  static async explainBotInstallation(guild, context) {
    return {
      success: true,
      action: 'explain_bot_installation',
      details: `ℹ️ **How to Add Bots to Discord:**\n` +
        `1. Discord API strictly prohibits any bot from directly installing another bot into a server without human authorization.\n` +
        `2. An administrator with the "Manage Server" permission must visit the bot's official OAuth2 URL and authorize it.\n` +
        `3. To invite Honey Bot, run \`/go prompt: get bot invite link\`.`,
      verified: true
    };
  }

  // =========================================================================
  // MUSIC & VOICE PLAYBACK OPERATIONS
  // =========================================================================

  static async playMusic(guild, query, context) {
    return await MusicService.play(guild, context?.invokingMember, query);
  }

  static async pauseMusic(guild, context) {
    return await MusicService.pause(guild);
  }

  static async resumeMusic(guild, context) {
    return await MusicService.resume(guild);
  }

  static async skipMusic(guild, context) {
    return await MusicService.skip(guild);
  }

  static async stopMusic(guild, context) {
    return await MusicService.stop(guild);
  }

  static async getMusicQueue(guild, context) {
    return await MusicService.getQueue(guild);
  }

  static async getNowPlaying(guild, context) {
    return await MusicService.nowPlaying(guild);
  }

  static async setMusicVolume(guild, volume, context) {
    return await MusicService.setVolume(guild, volume);
  }

  static async leaveVoice(guild, context) {
    return await MusicService.leave(guild);
  }

  // =========================================================================
  // USER-SPECIFIC CHANNEL PERMISSION MANAGEMENT (TRI-STATE: ALLOW/DENY/INHERIT)
  // =========================================================================

  /**
   * Sets user-specific channel permission overwrites.
   * Accurately supports Allow, Deny, and Inherit (null) while preserving unrelated permissions.
   * Explains Discord Administrator bypass if member has Administrator privileges.
   */
  static async setUserChannelPermission(guild, targetMemberRef, targetChannelRef, permissions = {}, context = {}) {
    let member = null;
    if (context.resolveTarget) {
      member = await context.resolveTarget(targetMemberRef, 'member');
    }
    if (!member && guild.members?.cache) {
      const cleanRef = String(targetMemberRef).replace(/[<@!>]/g, '').trim();
      member = guild.members.cache.find(m => m.id === cleanRef || m.user?.username?.toLowerCase() === cleanRef.toLowerCase() || m.displayName?.toLowerCase() === cleanRef.toLowerCase());
    }
    if (!member) {
      return { success: false, error: `Member "${targetMemberRef}" not found.`, action: 'set_user_channel_permission' };
    }
    if (member.isAmbiguous) {
      return { success: false, error: member.clarificationQuestion, isAmbiguous: true, action: 'set_user_channel_permission' };
    }

    let channel = null;
    if (context.resolveTarget) {
      channel = await context.resolveTarget(targetChannelRef, 'channel');
    }
    if (!channel && guild.channels?.cache) {
      const cleanCh = String(targetChannelRef).replace(/^#/, '').toLowerCase();
      channel = guild.channels.cache.find(c => c.id === targetChannelRef || c.name.toLowerCase() === cleanCh);
    }
    if (!channel) {
      return { success: false, error: `Channel "${targetChannelRef}" not found.`, action: 'set_user_channel_permission' };
    }

    if (!channel.permissionOverwrites || typeof channel.permissionOverwrites.edit !== 'function') {
      return { success: false, error: `Channel #${channel.name} does not support permission overwrites.`, action: 'set_user_channel_permission' };
    }

    // Role hierarchy check
    const hierarchy = checkRoleHierarchy(guild, { action: 'set_user_channel_permission' }, member);
    if (!hierarchy.valid) {
      return { success: false, error: hierarchy.reason, action: 'set_user_channel_permission' };
    }

    const PERM_NAME_MAP = {
      viewchannel: 'ViewChannel', view: 'ViewChannel', see: 'ViewChannel', read: 'ViewChannel',
      sendmessages: 'SendMessages', sendmessage: 'SendMessages', messages: 'SendMessages', send: 'SendMessages', talk: 'SendMessages', chat: 'SendMessages',
      sendmessagesinthreads: 'SendMessagesInThreads', readmessagehistory: 'ReadMessageHistory', history: 'ReadMessageHistory',
      addreactions: 'AddReactions', react: 'AddReactions', reactions: 'AddReactions',
      attachfiles: 'AttachFiles', attachfile: 'AttachFiles', files: 'AttachFiles', images: 'AttachFiles',
      embedlinks: 'EmbedLinks', links: 'EmbedLinks', mentioneveryone: 'MentionEveryone', pingeveryone: 'MentionEveryone',
      managemessages: 'ManageMessages', deletemessages: 'ManageMessages', connect: 'Connect', speak: 'Speak', stream: 'Stream',
      useapplicationcommands: 'UseApplicationCommands', commands: 'UseApplicationCommands',
      createpublicthreads: 'CreatePublicThreads', createprivatethreads: 'CreatePrivateThreads', managethreads: 'ManageThreads',
      managechannels: 'ManageChannels', mutemembers: 'MuteMembers', deafenmembers: 'DeafenMembers', movemembers: 'MoveMembers'
    };

    const normalizePerm = (str) => {
      if (!str) return null;
      const clean = String(str).replace(/[\s_\-]/g, '').toLowerCase();
      return PERM_NAME_MAP[clean] || str;
    };

    const allowList = (permissions.allow || []).map(normalizePerm).filter(Boolean);
    const denyList = (permissions.deny || []).map(normalizePerm).filter(Boolean);
    const inheritList = (permissions.inherit || []).map(normalizePerm).filter(Boolean);

    const existingOverwrite = channel.permissionOverwrites.cache?.get(member.id);
    const prevAllow = existingOverwrite?.allow?.toArray ? existingOverwrite.allow.toArray() : [];
    const prevDeny = existingOverwrite?.deny?.toArray ? existingOverwrite.deny.toArray() : [];

    const newAllowSet = new Set(prevAllow);
    const newDenySet = new Set(prevDeny);

    for (const p of allowList) {
      newAllowSet.add(p);
      newDenySet.delete(p);
    }
    for (const p of denyList) {
      newDenySet.add(p);
      newAllowSet.delete(p);
    }
    for (const p of inheritList) {
      newAllowSet.delete(p);
      newDenySet.delete(p);
    }

    // Check idempotency: if no changes needed
    const sameAllow = prevAllow.length === newAllowSet.size && prevAllow.every(p => newAllowSet.has(p));
    const sameDeny = prevDeny.length === newDenySet.size && prevDeny.every(p => newDenySet.has(p));
    if (sameAllow && sameDeny) {
      return {
        success: true,
        action: 'set_user_channel_permission',
        targetMemberId: member.id,
        targetMemberTag: member.user?.tag || member.displayName,
        channelId: channel.id,
        channelName: channel.name,
        details: `${member.displayName || member.user?.tag} already has the requested channel permissions in #${channel.name}. No changes were made.`,
        verified: true,
        resourceId: channel.id
      };
    }

    const patch = {};
    for (const p of newAllowSet) patch[p] = true;
    for (const p of newDenySet) patch[p] = false;
    for (const p of inheritList) patch[p] = null;

    const actorTag = context?.invokingUser ? context.invokingUser.tag : 'administrator';
    await channel.permissionOverwrites.edit(member.id, patch, {
      reason: `Channel permissions updated for ${member.user?.tag || member.id} via Honey Bot by ${actorTag}`
    });

    const hasAdmin = member.permissions?.has?.(PermissionFlagsBits.Administrator);
    let note = '';
    if (hasAdmin && (denyList.length > 0 || newDenySet.size > 0)) {
      note = ' (Note: This member has Administrator privileges, which bypass channel overwrites.)';
    }

    const changedParts = [];
    if (allowList.length > 0) changedParts.push(`allowed: ${allowList.join(', ')}`);
    if (denyList.length > 0) changedParts.push(`denied: ${denyList.join(', ')}`);
    if (inheritList.length > 0) changedParts.push(`reset to inherit: ${inheritList.join(', ')}`);

    if (guild?.id && context?.executionId) {
      ActionLedger.recordAction(guild.id, context.executionId, {
        type: 'user_channel_permission',
        action: 'set_user_channel_permission',
        targetMemberId: member.id,
        targetMemberTag: member.user?.tag,
        channelId: channel.id,
        channelName: channel.name,
        targetId: channel.id,
        targetName: channel.name,
        preState: { allow: prevAllow, deny: prevDeny },
        postState: { allow: Array.from(newAllowSet), deny: Array.from(newDenySet) },
        actor: context.invokingUser ? { id: context.invokingUser.id, tag: context.invokingUser.tag } : null,
        reversibility: 'reversible'
      });
    }

    return {
      success: true,
      action: 'set_user_channel_permission',
      targetMemberId: member.id,
      targetMemberTag: member.user?.tag || member.displayName,
      channelId: channel.id,
      channelName: channel.name,
      details: `Updated ${member.displayName || member.user?.tag}'s permissions in #${channel.name}: ${changedParts.join('; ')}.${note}`,
      verified: true,
      resourceId: channel.id
    };
  }

  /**
   * Inspects and explains user permissions, distinguishing channel overwrites, role permissions, and Administrator bypass.
   */
  static async inspectUserPermissions(guild, targetMemberRef, targetChannelRef, context = {}) {
    let member = null;
    if (context.resolveTarget) {
      member = await context.resolveTarget(targetMemberRef, 'member');
    }
    if (!member && guild.members?.cache) {
      const cleanRef = String(targetMemberRef).replace(/[<@!>]/g, '').trim();
      member = guild.members.cache.find(m => m.id === cleanRef || m.user?.username?.toLowerCase() === cleanRef.toLowerCase() || m.displayName?.toLowerCase() === cleanRef.toLowerCase());
    }
    if (!member) {
      return { success: false, error: `Member "${targetMemberRef}" not found.`, action: 'inspect_user_permissions' };
    }

    let channel = null;
    if (targetChannelRef) {
      if (context.resolveTarget) {
        channel = await context.resolveTarget(targetChannelRef, 'channel');
      }
      if (!channel && guild.channels?.cache) {
        const cleanCh = String(targetChannelRef).replace(/^#/, '').toLowerCase();
        channel = guild.channels.cache.find(c => c.id === targetChannelRef || c.name.toLowerCase() === cleanCh);
      }
    }

    const hasAdmin = member.permissions?.has?.(PermissionFlagsBits.Administrator);
    const memberRoles = member.roles?.cache ? Array.from(member.roles.cache.values()).filter(r => r.id !== guild.id) : [];

    if (channel) {
      const explicitOverwrite = channel.permissionOverwrites?.cache?.get(member.id);
      const explicitAllow = explicitOverwrite?.allow?.toArray ? explicitOverwrite.allow.toArray() : [];
      const explicitDeny = explicitOverwrite?.deny?.toArray ? explicitOverwrite.deny.toArray() : [];

      const roleOverwrites = [];
      for (const role of memberRoles) {
        const rOw = channel.permissionOverwrites?.cache?.get(role.id);
        if (rOw) {
          const rAllow = rOw.allow?.toArray ? rOw.allow.toArray() : [];
          const rDeny = rOw.deny?.toArray ? rOw.deny.toArray() : [];
          if (rAllow.length > 0 || rDeny.length > 0) {
            roleOverwrites.push(`@${role.name} (+${rAllow.join(', ')} / -${rDeny.join(', ')})`);
          }
        }
      }

      const effective = channel.permissionsFor ? channel.permissionsFor(member).toArray() : [];
      let explanation = `**Permissions for ${member.displayName || member.user?.tag} in #${channel.name}:**\n`;
      if (hasAdmin) {
        explanation += `👑 **Administrator:** Yes (bypasses all channel restrictions)\n`;
      }
      explanation += `• **Explicit Member Allow:** ${explicitAllow.length ? explicitAllow.join(', ') : 'None'}\n`;
      explanation += `• **Explicit Member Deny:** ${explicitDeny.length ? explicitDeny.join(', ') : 'None'}\n`;
      explanation += `• **Role Overwrites:** ${roleOverwrites.length ? roleOverwrites.join('; ') : 'None'}\n`;
      explanation += `• **Key Effective Permissions:** ${effective.slice(0, 10).join(', ')}${effective.length > 10 ? ` (+${effective.length - 10} more)` : ''}`;

      return {
        success: true,
        action: 'inspect_user_permissions',
        details: explanation,
        verified: true,
        hasAdmin,
        explicitAllow,
        explicitDeny,
        effective
      };
    } else {
      let explanation = `**Server-wide Permissions for ${member.displayName || member.user?.tag}:**\n`;
      explanation += `• **Administrator:** ${hasAdmin ? 'Yes (bypasses all restrictions)' : 'No'}\n`;
      explanation += `• **Roles (${memberRoles.length}):** ${memberRoles.map(r => `@${r.name}`).join(', ') || 'None'}\n`;
      const perms = member.permissions ? member.permissions.toArray() : [];
      explanation += `• **Key Permissions:** ${perms.slice(0, 10).join(', ')}${perms.length > 10 ? ` (+${perms.length - 10} more)` : ''}`;

      return {
        success: true,
        action: 'inspect_user_permissions',
        details: explanation,
        verified: true,
        hasAdmin,
        roles: memberRoles.map(r => r.name)
      };
    }
  }

  // =========================================================================
  // VOICE MODERATION OPERATIONS
  // =========================================================================

  static async voiceMute(guild, memberRef, context = {}) {
    const member = await context.resolveTarget?.(memberRef, 'member') || guild.members?.cache?.get(memberRef);
    if (!member) return { success: false, error: `Member "${memberRef}" not found.`, action: 'voice_mute' };
    if (!member.voice || !member.voice.channel) {
      return { success: false, error: `Member ${member.displayName || member.user?.tag} is not connected to any voice channel.`, action: 'voice_mute' };
    }
    const hierarchy = checkRoleHierarchy(guild, { action: 'voice_mute' }, member);
    if (!hierarchy.valid) return { success: false, error: hierarchy.reason, action: 'voice_mute' };

    await member.voice.setMute(true, `Server-muted via Honey Bot`);
    return {
      success: true,
      action: 'voice_mute',
      details: `Server-muted ${member.displayName || member.user?.tag} in voice channel #${member.voice.channel.name}`,
      verified: true,
      resourceId: member.id
    };
  }

  static async voiceUnmute(guild, memberRef, context = {}) {
    const member = await context.resolveTarget?.(memberRef, 'member') || guild.members?.cache?.get(memberRef);
    if (!member) return { success: false, error: `Member "${memberRef}" not found.`, action: 'voice_unmute' };
    if (!member.voice || !member.voice.channel) {
      return { success: false, error: `Member ${member.displayName || member.user?.tag} is not connected to any voice channel.`, action: 'voice_unmute' };
    }
    await member.voice.setMute(false, `Server-unmuted via Honey Bot`);
    return {
      success: true,
      action: 'voice_unmute',
      details: `Server-unmuted ${member.displayName || member.user?.tag} in voice channel #${member.voice.channel.name}`,
      verified: true,
      resourceId: member.id
    };
  }

  static async voiceDeafen(guild, memberRef, context = {}) {
    const member = await context.resolveTarget?.(memberRef, 'member') || guild.members?.cache?.get(memberRef);
    if (!member) return { success: false, error: `Member "${memberRef}" not found.`, action: 'voice_deafen' };
    if (!member.voice || !member.voice.channel) {
      return { success: false, error: `Member ${member.displayName || member.user?.tag} is not connected to any voice channel.`, action: 'voice_deafen' };
    }
    const hierarchy = checkRoleHierarchy(guild, { action: 'voice_deafen' }, member);
    if (!hierarchy.valid) return { success: false, error: hierarchy.reason, action: 'voice_deafen' };

    await member.voice.setDeaf(true, `Server-deafened via Honey Bot`);
    return {
      success: true,
      action: 'voice_deafen',
      details: `Server-deafened ${member.displayName || member.user?.tag} in voice channel #${member.voice.channel.name}`,
      verified: true,
      resourceId: member.id
    };
  }

  static async voiceUndeafen(guild, memberRef, context = {}) {
    const member = await context.resolveTarget?.(memberRef, 'member') || guild.members?.cache?.get(memberRef);
    if (!member) return { success: false, error: `Member "${memberRef}" not found.`, action: 'voice_undeafen' };
    if (!member.voice || !member.voice.channel) {
      return { success: false, error: `Member ${member.displayName || member.user?.tag} is not connected to any voice channel.`, action: 'voice_undeafen' };
    }
    await member.voice.setDeaf(false, `Server-undeafened via Honey Bot`);
    return {
      success: true,
      action: 'voice_undeafen',
      details: `Server-undeafened ${member.displayName || member.user?.tag} in voice channel #${member.voice.channel.name}`,
      verified: true,
      resourceId: member.id
    };
  }

  static async voiceMove(guild, memberRef, targetChannelRef, context = {}) {
    const member = await context.resolveTarget?.(memberRef, 'member') || guild.members?.cache?.get(memberRef);
    if (!member) return { success: false, error: `Member "${memberRef}" not found.`, action: 'voice_move' };
    if (!member.voice || !member.voice.channel) {
      return { success: false, error: `Member ${member.displayName || member.user?.tag} is not connected to any voice channel.`, action: 'voice_move' };
    }
    const targetChannel = await context.resolveTarget?.(targetChannelRef, 'channel') || guild.channels?.cache?.get(targetChannelRef);
    if (!targetChannel) return { success: false, error: `Voice channel "${targetChannelRef}" not found.`, action: 'voice_move' };
    if (targetChannel.type !== ChannelType.GuildVoice && targetChannel.type !== ChannelType.GuildStageVoice) {
      return { success: false, error: `Channel #${targetChannel.name} is not a voice channel.`, action: 'voice_move' };
    }

    await member.voice.setChannel(targetChannel, `Moved via Honey Bot`);
    return {
      success: true,
      action: 'voice_move',
      details: `Moved ${member.displayName || member.user?.tag} to voice channel #${targetChannel.name}`,
      verified: true,
      resourceId: targetChannel.id
    };
  }

  static async voiceDisconnect(guild, memberRef, context = {}) {
    const member = await context.resolveTarget?.(memberRef, 'member') || guild.members?.cache?.get(memberRef);
    if (!member) return { success: false, error: `Member "${memberRef}" not found.`, action: 'voice_disconnect' };
    if (!member.voice || !member.voice.channel) {
      return { success: false, error: `Member ${member.displayName || member.user?.tag} is not connected to any voice channel.`, action: 'voice_disconnect' };
    }
    const hierarchy = checkRoleHierarchy(guild, { action: 'voice_disconnect' }, member);
    if (!hierarchy.valid) return { success: false, error: hierarchy.reason, action: 'voice_disconnect' };

    const oldChannel = member.voice.channel.name;
    await member.voice.disconnect(`Disconnected via Honey Bot`);
    return {
      success: true,
      action: 'voice_disconnect',
      details: `Disconnected ${member.displayName || member.user?.tag} from voice channel #${oldChannel}`,
      verified: true,
      resourceId: member.id
    };
  }

  // =========================================================================
  // WARNING & MODERATION HISTORY OPERATIONS
  // =========================================================================

  static async issueWarning(guild, memberRef, reason, context = {}) {
    const member = await context.resolveTarget?.(memberRef, 'member') || guild.members?.cache?.get(memberRef);
    if (!member) return { success: false, error: `Member "${memberRef}" not found.`, action: 'issue_warning' };

    const hierarchy = checkRoleHierarchy(guild, { action: 'issue_warning' }, member);
    if (!hierarchy.valid) return { success: false, error: hierarchy.reason, action: 'issue_warning' };

    const actor = context?.invokingUser || { id: 'admin', tag: 'Administrator' };
    const warning = WarningManager.addWarning(guild.id, member.id, {
      reason: reason || 'No reason provided',
      moderatorId: actor.id,
      moderatorTag: actor.tag
    });

    const allWarnings = WarningManager.getWarnings(guild.id, member.id);
    return {
      success: true,
      action: 'issue_warning',
      details: `Warned ${member.displayName || member.user?.tag} for: "${warning.reason}". (Total warnings: ${allWarnings.length})`,
      verified: true,
      warningId: warning.id,
      resourceId: member.id
    };
  }

  static async inspectWarnings(guild, memberRef, context = {}) {
    const member = await context.resolveTarget?.(memberRef, 'member') || guild.members?.cache?.get(memberRef);
    if (!member) return { success: false, error: `Member "${memberRef}" not found.`, action: 'inspect_warnings' };

    const warnings = WarningManager.getWarnings(guild.id, member.id);
    if (warnings.length === 0) {
      return {
        success: true,
        action: 'inspect_warnings',
        details: `${member.displayName || member.user?.tag} has 0 warnings.`,
        verified: true,
        count: 0,
        warnings: []
      };
    }

    const lines = warnings.map((w, idx) => `\`${idx + 1}.\` **${w.reason}** (by ${w.moderatorTag} on ${new Date(w.timestamp).toLocaleDateString()})`);
    return {
      success: true,
      action: 'inspect_warnings',
      details: `**Warnings for ${member.displayName || member.user?.tag} (${warnings.length}):**\n${lines.join('\n')}`,
      verified: true,
      count: warnings.length,
      warnings
    };
  }

  static async clearWarnings(guild, memberRef, context = {}) {
    const member = await context.resolveTarget?.(memberRef, 'member') || guild.members?.cache?.get(memberRef);
    if (!member) return { success: false, error: `Member "${memberRef}" not found.`, action: 'clear_warnings' };

    const res = WarningManager.clearWarnings(guild.id, member.id);
    return {
      success: true,
      action: 'clear_warnings',
      details: `Cleared ${res.count} warning(s) for ${member.displayName || member.user?.tag}.`,
      verified: true,
      count: res.count,
      resourceId: member.id
    };
  }

  static async softbanMember(guild, memberRef, reason, context = {}) {
    const member = await context.resolveTarget?.(memberRef, 'member') || guild.members?.cache?.get(memberRef);
    if (!member) return { success: false, error: `Member "${memberRef}" not found.`, action: 'softban_member' };

    const hierarchy = checkRoleHierarchy(guild, { action: 'softban_member' }, member);
    if (!hierarchy.valid) return { success: false, error: hierarchy.reason, action: 'softban_member' };

    const safeReason = String(reason || 'Softban via Honey Bot (kick + message purge)').slice(0, 512);
    const memberId = member.id;
    const memberTag = member.user?.tag || member.displayName;

    await guild.members.ban(memberId, {
      deleteMessageSeconds: 86400,
      reason: safeReason
    });

    await guild.members.unban(memberId, `Softban complete: unbanned after message purge`);

    return {
      success: true,
      action: 'softban_member',
      details: `Soft-banned ${memberTag}: messages purged (1 day) and member kicked.`,
      verified: true,
      resourceId: memberId
    };
  }

  static async inspectMemberModeration(guild, memberRef, context = {}) {
    const member = await context.resolveTarget?.(memberRef, 'member') || guild.members?.cache?.get(memberRef);
    if (!member) return { success: false, error: `Member "${memberRef}" not found.`, action: 'inspect_member_moderation' };

    const isTimedOut = member.communicationDisabledUntilTimestamp && member.communicationDisabledUntilTimestamp > Date.now();
    const timeoutRemaining = isTimedOut ? Math.round((member.communicationDisabledUntilTimestamp - Date.now()) / 60000) : 0;
    const warnings = WarningManager.getWarnings(guild.id, member.id);
    const inVoice = Boolean(member.voice?.channel);
    const hasAdmin = member.permissions?.has?.(PermissionFlagsBits.Administrator);
    const roles = member.roles?.cache ? Array.from(member.roles.cache.values()).filter(r => r.id !== guild.id).map(r => `@${r.name}`) : [];

    let details = `**Moderation State for ${member.displayName || member.user?.tag}:**\n`;
    details += `• **Timeout:** ${isTimedOut ? `Active (${timeoutRemaining}m remaining)` : 'None'}\n`;
    details += `• **Warnings:** ${warnings.length}\n`;
    details += `• **Voice:** ${inVoice ? `Connected to #${member.voice.channel.name}${member.voice.serverMute ? ' (Muted)' : ''}${member.voice.serverDeaf ? ' (Deafened)' : ''}` : 'Not connected'}\n`;
    details += `• **Administrator:** ${hasAdmin ? 'Yes' : 'No'}\n`;
    details += `• **Roles (${roles.length}):** ${roles.join(', ') || 'None'}`;

    return {
      success: true,
      action: 'inspect_member_moderation',
      details,
      verified: true,
      isTimedOut,
      timeoutRemaining,
      warningsCount: warnings.length,
      inVoice,
      hasAdmin,
      resourceId: member.id
    };
  }

  static async unbanMember(guild, targetUserRef, reason, context = {}) {
    const cleanId = String(targetUserRef).replace(/[<@!>]/g, '').trim();
    let targetId = cleanId;

    if (!/^\d{17,20}$/.test(cleanId) && guild.bans?.fetch) {
      try {
        const bans = await guild.bans.fetch();
        const matchedBan = bans.find(b => b.user.username.toLowerCase() === cleanId.toLowerCase() || b.user.tag?.toLowerCase() === cleanId.toLowerCase());
        if (matchedBan) {
          targetId = matchedBan.user.id;
        }
      } catch (err) {
        logger.debug(`Bans fetch failed: ${err.message}`);
      }
    }

    if (!targetId || typeof targetId !== 'string' || targetId.trim().length === 0) {
      return { success: false, error: `Could not resolve banned user "${targetUserRef}". Please provide their exact User ID.`, action: 'unban_member' };
    }

    const safeReason = String(reason || 'Unbanned via Honey Bot').slice(0, 512);
    await guild.members.unban(targetId, safeReason);

    return {
      success: true,
      action: 'unban_member',
      details: `User <@${targetId}> unbanned.`,
      verified: true,
      resourceId: targetId
    };
  }

  static async configureGuildPolicy(guild, updates, context = {}) {
    const actor = context.invokingUser || { id: 'unknown', tag: 'Administrator' };
    const actorMember = context.invokingMember || (context.invokingUser ? guild.members?.cache?.get(context.invokingUser.id) : null);

    if (actorMember) {
      const { checkPolicyAdminAuthorization } = await import('./permissions.js');
      const auth = checkPolicyAdminAuthorization(actorMember);
      if (!auth.authorized) {
        return {
          success: false,
          error: `Unauthorized: ${auth.reason}`,
          action: 'configure_guild_policy'
        };
      }
    }

    const preConfig = GuildConfigService.getConfig(guild.id);
    let resolvedRole = null;
    let resolvedMember = null;

    // Resolve Role if provided
    const rawRole = updates.role || updates.targetRole;
    if (rawRole) {
      const cleanRoleId = String(rawRole).replace(/[<@&>]/g, '').trim();
      const roleNameQuery = String(rawRole).replace(/^@/, '').toLowerCase();

      const roleCollection = guild.roles?.cache ? Array.from(guild.roles.cache.values()) : [];
      const matchingRoles = roleCollection.filter(r =>
        r.id === cleanRoleId ||
        r.id === rawRole ||
        r.name?.toLowerCase() === roleNameQuery
      );

      if (matchingRoles.length > 1 && !/^\d{17,20}$/.test(cleanRoleId)) {
        return {
          success: false,
          error: `Multiple roles matched "${rawRole}" (${matchingRoles.map(r => `@${r.name} [ID: ${r.id}]`).join(', ')}). Please specify the exact role ID to avoid ambiguity.`,
          action: 'configure_guild_policy'
        };
      }

      resolvedRole = matchingRoles[0] || null;

      if (!resolvedRole) {
        return {
          success: false,
          error: `Role "${rawRole}" not found in this server. Please specify an existing role name or role ID.`,
          action: 'configure_guild_policy'
        };
      }
    }

    // Resolve Member if provided
    const rawMember = updates.member || updates.targetMember;
    if (rawMember) {
      const cleanMemberId = String(rawMember).replace(/[<@!>]/g, '').trim();
      resolvedMember = guild.members?.cache?.find(m =>
        m.id === cleanMemberId ||
        m.id === rawMember ||
        m.user?.username?.toLowerCase() === String(rawMember).toLowerCase() ||
        m.displayName?.toLowerCase() === String(rawMember).toLowerCase()
      );

      if (!resolvedMember && !/^\d{17,20}$/.test(cleanMemberId)) {
        return {
          success: false,
          error: `Member "${rawMember}" not found in this server.`,
          action: 'configure_guild_policy'
        };
      }
    }

    let savedConfig = null;
    let summary = '';

    if (updates.adminOnly !== undefined) {
      savedConfig = GuildConfigService.setAdminOnlyPolicyChanges(guild.id, updates.adminOnly, actor);
      summary = `Configured Honey Bot policy: Only administrators may change access rules: ${updates.adminOnly}`;
    } else if (updates.policyAdmins) {
      savedConfig = GuildConfigService.setPolicyAdmins(guild.id, updates.policyAdmins, actor);
      summary = `Updated Honey Bot policy administrators for this server.`;
    } else if (resolvedRole) {
      if (updates.revokeRole) {
        savedConfig = GuildConfigService.revokeRole(guild.id, resolvedRole.id, actor);
        summary = `Revoked Honey Bot authorization for role @${resolvedRole.name}.`;
      } else if (updates.removeCapabilities && updates.removeCapabilities.length > 0) {
        savedConfig = GuildConfigService.removeRoleCapability(guild.id, resolvedRole.id, updates.removeCapabilities, actor);
        summary = `Removed capabilities (${updates.removeCapabilities.join(', ')}) from role @${resolvedRole.name}.`;
      } else {
        const caps = updates.capabilities || updates.allow || [];
        const denyCaps = updates.denyCapabilities || updates.deny || [];
        savedConfig = GuildConfigService.authorizeRole(guild.id, {
          roleId: resolvedRole.id,
          roleName: resolvedRole.name,
          capabilities: caps,
          denyCapabilities: denyCaps
        }, actor);

        const allowText = caps.length > 0 ? `Allowed: ${caps.join(', ')}` : 'No explicit grants';
        const denyText = denyCaps.length > 0 ? ` | Denied: ${denyCaps.join(', ')}` : '';
        summary = `Updated Honey Bot authorization for role @${resolvedRole.name}: ${allowText}${denyText}.`;
      }
    } else if (resolvedMember || rawMember) {
      const mId = resolvedMember ? resolvedMember.id : String(rawMember).replace(/[<@!>]/g, '');
      const mTag = resolvedMember?.user?.tag || resolvedMember?.displayName || mId;

      if (updates.revokeMember) {
        savedConfig = GuildConfigService.revokeMember(guild.id, mId, actor);
        summary = `Revoked member exception for ${mTag}.`;
      } else {
        const caps = updates.capabilities || updates.allow || [];
        const denyCaps = updates.denyCapabilities || updates.deny || [];
        savedConfig = GuildConfigService.authorizeMember(guild.id, {
          memberId: mId,
          memberTag: mTag,
          capabilities: caps,
          denyCapabilities: denyCaps
        }, actor);
        summary = `Updated member exception for ${mTag}.`;
      }
    } else {
      return {
        success: false,
        error: 'Please specify a target role or member to configure Honey Bot access policy.',
        action: 'configure_guild_policy'
      };
    }

    // Record to ActionLedger for recovery
    ActionLedger.recordAction(guild.id, context.executionId || 'exec_policy', {
      actionId: `policy_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      action: 'configure_guild_policy',
      type: 'configure_guild_policy',
      guildId: guild.id,
      actor: actor.tag || actor.id,
      preState: preConfig,
      postState: savedConfig,
      details: summary,
      timestamp: new Date().toISOString()
    });

    return {
      success: true,
      action: 'configure_guild_policy',
      details: summary,
      revision: savedConfig.revision,
      verified: true
    };
  }

  static async inspectGuildPolicy(guild, context = {}) {
    const config = GuildConfigService.getConfig(guild.id);
    const policy = config.authorizationPolicy || {};
    const rolesMap = policy.operatorRoles || {};
    const membersMap = policy.operatorMembers || {};
    const policyAdmins = policy.policyAdmins || { roles: [], members: [] };

    const roleEntries = Object.values(rolesMap);
    const memberEntries = Object.values(membersMap);

    const orphanRoles = [];
    const formattedRoles = [];

    for (const r of roleEntries) {
      const liveRole = guild.roles?.cache?.get(r.roleId);
      if (!liveRole) {
        orphanRoles.push(`• **@${r.roleName}** (ID: \`${r.roleId}\` - *Deleted from server*)`);
      } else {
        const allows = r.capabilities?.length > 0 ? r.capabilities.join(', ') : 'none';
        const denys = r.denyCapabilities?.length > 0 ? ` (Denied: ${r.denyCapabilities.join(', ')})` : '';
        formattedRoles.push(`• <@&${r.roleId}> (\`${r.roleName}\`): ${allows}${denys}`);
      }
    }

    const formattedMembers = memberEntries.map(m => {
      const allows = m.capabilities?.length > 0 ? m.capabilities.join(', ') : 'none';
      const denys = m.denyCapabilities?.length > 0 ? ` (Denied: ${m.denyCapabilities.join(', ')})` : '';
      return `• <@${m.memberId}> (${m.memberTag}): ${allows}${denys}`;
    });

    let details = `**Honey Bot Access Policy for ${guild.name}** (Revision ${config.revision})\n\n`;

    if (formattedRoles.length > 0) {
      details += `**Authorized Roles (${formattedRoles.length}):**\n${formattedRoles.join('\n')}\n\n`;
    } else {
      details += `**Authorized Roles:** None explicitly configured (server administrators have default access).\n\n`;
    }

    if (formattedMembers.length > 0) {
      details += `**Member Exceptions (${formattedMembers.length}):**\n${formattedMembers.join('\n')}\n\n`;
    }

    if (orphanRoles.length > 0) {
      details += `⚠️ **Orphan Configured Roles (${orphanRoles.length}):**\n${orphanRoles.join('\n')}\n\n`;
    }

    const adminPolicyText = policy.adminOnlyPolicyChanges !== false
      ? 'Strictly Server Administrators (and Guild Owner)'
      : `Policy Admins (${policyAdmins.roles.length} roles, ${policyAdmins.members.length} members)`;
    details += `**Who can change access rules:** ${adminPolicyText}`;

    const embed = new EmbedBuilder()
      .setTitle(`🛡️ Honey Bot Access Rules — ${guild.name}`)
      .setDescription(details.slice(0, 4000))
      .setColor(0x3498DB)
      .setFooter({ text: `Guild ID: ${guild.id} • Revision: ${config.revision}` });

    return {
      success: true,
      action: 'inspect_guild_policy',
      details,
      embed,
      config
    };
  }

  static async testGuildPolicy(guild, query = {}, context = {}) {
    const rawRole = query.role || query.targetRole;
    const rawMember = query.member || query.targetMember;
    const targetAction = query.targetAction || query.action || query.capability || 'moderation';

    let resolvedRole = null;
    let resolvedMember = null;

    if (rawRole) {
      const cleanId = String(rawRole).replace(/[<@&>]/g, '').trim();
      resolvedRole = guild.roles?.cache?.find(r => r.id === cleanId || r.name?.toLowerCase() === String(rawRole).replace(/^@/, '').toLowerCase());
    }

    if (rawMember) {
      const cleanId = String(rawMember).replace(/[<@!>]/g, '').trim();
      resolvedMember = guild.members?.cache?.find(m => m.id === cleanId || m.user?.username?.toLowerCase() === String(rawMember).toLowerCase());
    }

    if (!resolvedRole && !resolvedMember) {
      return {
        success: false,
        error: 'Please specify which role or member to test (e.g. "Would Moderator role be allowed to ban?").',
        action: 'test_guild_policy'
      };
    }

    // Build synthetic mock member if testing a role alone
    let testMember = resolvedMember;
    if (!testMember && resolvedRole) {
      testMember = {
        id: 'simulated_member',
        displayName: `Simulated [${resolvedRole.name}]`,
        guild,
        roles: {
          cache: new Map([[resolvedRole.id, resolvedRole]]),
          highest: resolvedRole
        },
        permissions: {
          has: (flag) => resolvedRole.permissions?.has ? resolvedRole.permissions.has(flag) : false
        }
      };
    }

    const { checkUserAuthorization } = await import('./permissions.js');
    const auth = checkUserAuthorization(testMember, [{ action: targetAction }]);

    const subject = resolvedRole ? `Role @${resolvedRole.name}` : `Member ${testMember.displayName}`;
    let resultMessage = '';

    if (auth.authorized) {
      resultMessage = `✅ **Allowed:** ${subject} **IS AUTHORIZED** to perform "${targetAction}" in this server under current access policy.`;
    } else {
      resultMessage = `🛑 **Denied:** ${subject} **IS NOT AUTHORIZED** to perform "${targetAction}" in this server.\n*Reason:* ${auth.reason}`;
    }

    return {
      success: true,
      action: 'test_guild_policy',
      details: resultMessage,
      authorized: auth.authorized,
      reason: auth.reason
    };
  }

  static async resetGuildPolicy(guild, context = {}) {
    const actor = context.invokingUser || { id: 'unknown', tag: 'Administrator' };
    const preConfig = GuildConfigService.getConfig(guild.id);
    const reset = GuildConfigService.resetConfig(guild.id, actor);

    ActionLedger.recordAction(guild.id, context.executionId || 'exec_reset', {
      actionId: `reset_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      action: 'reset_guild_policy',
      type: 'reset_guild_policy',
      guildId: guild.id,
      actor: actor.tag || actor.id,
      preState: preConfig,
      postState: reset,
      details: 'Reset server access rules to default bootstrap policy',
      timestamp: new Date().toISOString()
    });

    return {
      success: true,
      action: 'reset_guild_policy',
      details: `Reset Honey Bot access configuration for this server to defaults (Revision ${reset.revision}). Only Server Administrators can now operate the bot.`,
      revision: reset.revision,
      verified: true
    };
  }
}
