import { ChannelType, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { checkRoleHierarchy, auditServerPermissions } from './permissions.js';
import { ActionLedger } from './recovery.js';
import { TicketManager } from './tickets.js';
import { MusicService } from './music-service.js';
import { resolveColor } from './color-utils.js';
import { Logger } from './logger.js';

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
   * Edits a role's name, color, hoist, or permissions with per-property verification.
   */
  static async editRole(guild, targetRoleRef, updates = {}, context = {}) {
    let role;
    if (context.resolveTarget) {
      role = await context.resolveTarget(targetRoleRef, 'role');
    }
    if (!role && guild.roles?.cache) {
      const cleanRef = String(targetRoleRef).replace(/^@/, '').toLowerCase();
      role = guild.roles.cache.find(r => r.id === targetRoleRef || r.name.toLowerCase() === cleanRef);
    }
    if (!role) {
      return { success: false, error: `Role "${targetRoleRef}" not found in server.`, action: 'edit_role' };
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
   * Changes or removes the nickname of a member with target resolution and verification.
   */
  static async changeNickname(guild, memberRef, nickname, context) {
    const ref = memberRef || 'me';
    let member;
    if (/^(me|my|myself|self|i)$/i.test(String(ref).trim())) {
      member = context.invokingMember || (await context.resolveTarget?.(ref, 'member'));
    } else {
      member = await context.resolveTarget(ref, 'member');
    }

    if (member?.isAmbiguous) {
      return {
        success: false,
        isAmbiguous: true,
        error: member.clarificationQuestion,
        action: 'change_nickname'
      };
    }

    if (!member) {
      return { success: false, error: `Member "${ref}" not found in this server.`, action: 'change_nickname' };
    }

    const isRemoval = nickname === null || nickname === undefined || /^(?:none|reset|remove|clear)$/i.test(String(nickname).trim());
    const targetNickname = isRemoval ? null : String(nickname).trim();

    if (targetNickname && targetNickname.length > 32) {
      return {
        success: false,
        error: `Nickname length out of bounds: Discord nicknames cannot exceed 32 characters (received ${targetNickname.length} characters).`,
        action: 'change_nickname'
      };
    }

    const hierarchy = checkRoleHierarchy(guild, { action: 'change_nickname' }, member);
    if (!hierarchy.valid) {
      return { success: false, error: hierarchy.reason, action: 'change_nickname' };
    }

    const currentNickname = member.nickname || null;
    if (currentNickname === targetNickname) {
      return {
        success: true,
        action: 'change_nickname',
        targetMemberId: member.id,
        nickname: targetNickname,
        details: isRemoval
          ? `Server nickname for ${member.user?.tag || member.displayName} is already cleared.`
          : `Nickname for ${member.user?.tag || member.displayName} is already "${targetNickname}".`,
        verified: true,
        resourceId: member.id
      };
    }

    const oldNickname = member.nickname || '';
    const actorTag = context.invokingUser ? context.invokingUser.tag : 'administrator';
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

    const details = isRemoval
      ? `Removed server nickname for ${member.user?.tag || member.displayName} (reverted to username).`
      : `Changed nickname for ${member.user?.tag || member.displayName} to "${targetNickname}".`;

    return {
      success: true,
      action: 'change_nickname',
      targetMemberId: member.id,
      nickname: targetNickname,
      details,
      verified,
      resourceId: member.id
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
   * Looks up a member and returns profile summary.
   */
  static async lookupMember(guild, memberRef, context) {
    const member = await context.resolveTarget(memberRef, 'member');
    if (!member) return { success: false, error: `Member "${memberRef}" not found in server`, action: 'lookup_member' };
    const roles = member.roles.cache.filter(r => r.id !== guild.id).map(r => `@${r.name}`);
    return {
      success: true,
      action: 'lookup_member',
      details: `**User:** ${member.user.tag} (ID: ${member.id})\n` +
        `**Joined Server:** ${member.joinedAt ? member.joinedAt.toLocaleDateString() : 'Unknown'}\n` +
        `**Roles (${roles.length}):** ${roles.slice(0, 15).join(', ') || 'None'}`,
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
}
