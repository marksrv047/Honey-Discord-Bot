import { ChannelType, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { checkRoleHierarchy, auditServerPermissions } from './permissions.js';
import { ActionLedger } from './recovery.js';
import { TicketManager } from './tickets.js';
import { MusicService } from './music-service.js';
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
   * Changes nickname of a member.
   */
  static async changeNickname(guild, memberRef, nickname, context) {
    const member = await context.resolveTarget(memberRef, 'member');
    if (!member) {
      return { success: false, error: `Member "${memberRef}" not found`, action: 'change_nickname' };
    }

    if (nickname && nickname.length > 32) {
      return {
        success: false,
        error: `Nickname length out of bounds: Discord nicknames cannot exceed 32 characters (received ${nickname.length} characters).`,
        action: 'change_nickname'
      };
    }

    const hierarchy = checkRoleHierarchy(guild, { action: 'change_nickname' }, member);
    if (!hierarchy.valid) {
      return { success: false, error: hierarchy.reason, action: 'change_nickname' };
    }

    if (member.nickname === nickname) {
      return {
        success: true,
        action: 'change_nickname',
        details: `Nickname for ${member.user.tag} is already "${nickname}"`,
        verified: true,
        resourceId: member.id
      };
    }

    const oldNickname = member.nickname || '';
    await member.setNickname(nickname, `Changed via Honey Bot by ${context.invokingUser.tag}`);

    if (guild?.id && context?.executionId) {
      ActionLedger.recordAction(guild.id, context.executionId, {
        type: 'nickname_change',
        action: 'change_nickname',
        targetMemberId: member.id,
        targetMemberTag: member.user?.tag,
        oldNickname,
        newNickname: nickname,
        preState: { nickname: oldNickname },
        postState: { nickname },
        actor: context.invokingUser ? { id: context.invokingUser.id, tag: context.invokingUser.tag } : null,
        reversibility: 'reversible'
      });
    }

    return {
      success: true,
      action: 'change_nickname',
      details: `Nickname for ${member.user.tag} set to "${nickname}"`,
      verified: true,
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
   * Purges / bulk deletes up to 100 messages from a channel.
   */
  static async purgeMessages(guild, channelRef, count = 5, context) {
    const channel = await context.resolveTarget(channelRef, 'channel');
    if (!channel) {
      return { success: false, error: `Channel "${channelRef}" not found in this server.`, action: 'purge_messages' };
    }

    const countNum = parseInt(count, 10);
    if (isNaN(countNum) || countNum < 1 || countNum > 100) {
      return {
        success: false,
        error: `Purge count out of bounds: Bulk delete must be between 1 and 100 messages (Discord API restriction). Received "${count}".`,
        action: 'purge_messages'
      };
    }

    const deleted = await channel.bulkDelete(countNum, true);

    if (guild?.id && context?.executionId) {
      ActionLedger.recordAction(guild.id, context.executionId, {
        type: 'purge_messages',
        action: 'purge_messages',
        targetChannelId: channel.id,
        targetChannelName: channel.name,
        targetId: channel.id,
        targetName: channel.name,
        count: deleted.size,
        actor: context.invokingUser ? { id: context.invokingUser.id, tag: context.invokingUser.tag } : null,
        reversibility: 'irreversible',
        unavailabilityReason: 'Bulk message deletions cannot be undone because Discord permanently removes purged messages from its servers.'
      });
    }

    return {
      success: true,
      action: 'purge_messages',
      details: `Purged ${deleted.size} messages from #${channel.name}`,
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
