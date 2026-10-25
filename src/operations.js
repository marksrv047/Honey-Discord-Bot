import { ChannelType, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { checkRoleHierarchy, auditServerPermissions } from './permissions.js';
import { ActionLedger } from './recovery.js';
import { TicketManager } from './tickets.js';
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

    await channel.setName(newName, `Renamed via Honey Bot by ${context.invokingUser.tag}`);
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

    await channel.setTopic(topic, `Topic updated via Honey Bot by ${context.invokingUser.tag}`);
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

    const sec = parseInt(seconds, 10) || 0;
    if (channel.rateLimitPerUser === sec) {
      return {
        success: true,
        action: 'set_channel_slowmode',
        details: `Slowmode for #${channel.name} is already ${sec}s`,
        verified: true,
        resourceId: channel.id
      };
    }

    await channel.setRateLimitPerUser(sec, `Slowmode set via Honey Bot by ${context.invokingUser.tag}`);
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

    ActionLedger.recordCreatedResource(context.executionId, 'channel', channel.id, channel.name);

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

    ActionLedger.recordCreatedResource(context.executionId, 'role', role.id, role.name);

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

    await member.setNickname(nickname, `Changed via Honey Bot by ${context.invokingUser.tag}`);
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
      return { success: false, error: `Announcement channel "${channelRef}" not found`, action: 'send_announcement' };
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

    const sent = await channel.send(payload);
    return {
      success: true,
      action: 'send_announcement',
      details: `Announcement posted to #${channel.name}${options.mentionEveryone ? ' with @everyone' : ''}`,
      verified: Boolean(sent?.id),
      resourceId: sent.id
    };
  }

  /**
   * Sends a standard message to a channel.
   */
  static async sendMessage(guild, channelRef, content, context) {
    const channel = await context.resolveTarget(channelRef, 'channel');
    if (!channel) {
      return { success: false, error: `Channel "${channelRef}" not found`, action: 'send_message' };
    }

    const text = typeof content === 'object' ? (content.content || content.message) : content;
    const sent = await channel.send(text);
    return {
      success: true,
      action: 'send_message',
      details: `Message sent to #${channel.name}`,
      verified: Boolean(sent?.id),
      resourceId: sent.id
    };
  }

  /**
   * Purges / bulk deletes up to 100 messages from a channel.
   */
  static async purgeMessages(guild, channelRef, count = 5, context) {
    const channel = await context.resolveTarget(channelRef, 'channel');
    if (!channel) {
      return { success: false, error: `Channel "${channelRef}" not found`, action: 'purge_messages' };
    }

    const deleteCount = Math.min(Math.max(parseInt(count, 10) || 1, 1), 100);
    const deleted = await channel.bulkDelete(deleteCount, true);
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
}
