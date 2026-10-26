import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { CAPABILITY_REGISTRY } from './capabilities.js';
import { GuildConfigService, expandCapabilities } from './guild-config.js';

/**
 * Checks if the invoking member has authority to perform the planned actions
 * within the authoritative Discord guild context.
 *
 * Evaluates:
 * 1. Server Owner unconditional authority
 * 2. Guild-specific Authorization Policy (operatorRoles & operatorMembers)
 * 3. Discord native Administrator & explicit permission requirements
 * 4. Hard-deny precedence rules
 * 5. Role hierarchy restrictions
 */
export function checkUserAuthorization(member, actions = []) {
  if (!member || !member.guild) {
    return { authorized: false, reason: 'Access Denied: Invalid member or server context.' };
  }

  const guild = member.guild;

  // 1. Server owner always has unconditional full authorization
  if (guild.ownerId === member.id) {
    return { authorized: true };
  }

  // 2. Load guild-specific isolated configuration
  const guildId = guild.id || 'default_mock_guild';
  const config = GuildConfigService.getConfig(guildId);
  const policy = config.authorizationPolicy || {};
  const operatorRoles = policy.operatorRoles || {};
  const operatorMembers = policy.operatorMembers || {};
  const policyAdmins = policy.policyAdmins || { roles: [], members: [] };

  const hasAdminPerm = Boolean(member.permissions?.has?.(PermissionFlagsBits.Administrator));

  // 3. Policy Management Actions (/go prompt: allow role, configure policy, reset policy)
  const isPolicyAction = actions.some(a =>
    ['configure_guild_policy', 'reset_guild_policy'].includes(a.action)
  );

  if (isPolicyAction) {
    return checkPolicyAdminAuthorization(member);
  }

  // 4. Action-by-Action Capability Evaluation
  const memberRoles = member.roles?.cache ? Array.from(member.roles.cache.values()) : [];
  const memberException = operatorMembers[member.id];

  for (const actionObj of actions) {
    const actName = actionObj.action;
    const capability = CAPABILITY_REGISTRY[actName];

    // Read-only inspection / diagnostics inquiry
    const isInspection = actName === 'inspect_guild_policy' || actName === 'test_guild_policy';

    // A. Check Member-Specific Hard Denials
    if (memberException?.denyCapabilities) {
      const memberDenySet = expandCapabilities(memberException.denyCapabilities);
      if (memberDenySet.has(actName) || memberDenySet.has('*')) {
        return {
          authorized: false,
          reason: `Access Denied: Your member account is explicitly denied capability "${actName}" under this server's policy.`
        };
      }
    }

    // B. Check Role-Specific Hard Denials (Denials take precedence)
    for (const role of memberRoles) {
      const roleConfig = operatorRoles[role.id];
      if (roleConfig?.denyCapabilities) {
        const roleDenySet = expandCapabilities(roleConfig.denyCapabilities);
        if (roleDenySet.has(actName) || roleDenySet.has('*')) {
          return {
            authorized: false,
            reason: `Access Denied: Your role @${role.name} explicitly denies capability "${actName}" in this server.`
          };
        }
      }
    }

    // C. Check Member-Specific Grants
    let isGranted = false;
    if (memberException?.capabilities) {
      const memberAllowSet = expandCapabilities(memberException.capabilities);
      if (memberAllowSet.has(actName) || memberAllowSet.has('*')) {
        isGranted = true;
      }
    }

    // D. Check Role-Specific Grants
    if (!isGranted) {
      for (const role of memberRoles) {
        const roleConfig = operatorRoles[role.id];
        if (roleConfig?.capabilities) {
          const roleAllowSet = expandCapabilities(roleConfig.capabilities);
          if (roleAllowSet.has(actName) || roleAllowSet.has('*')) {
            isGranted = true;
            break;
          }
        }
      }
    }

    // E. Discord Administrator fallback
    if (!isGranted && hasAdminPerm) {
      isGranted = true;
    }

    // F. Inspection fallback: If policy grants inspection or user has ManageServer
    if (!isGranted && isInspection) {
      if (hasAdminPerm || member.permissions?.has?.(PermissionFlagsBits.ManageGuild)) {
        isGranted = true;
      }
    }

    if (!isGranted) {
      return {
        authorized: false,
        reason: `Access Denied: You do not have an authorized role or permission in this server to perform '${actName}'. Only Server Administrators or authorized roles can perform this action (missing the following Discord permissions: Administrator).`
      };
    }

    // 5. Discord Native Permission Validation
    // Even if bot policy grants an action, Discord API requires native permissions
    const nativeDiscordPermMap = {
      ban_member: PermissionFlagsBits.BanMembers,
      unban_member: PermissionFlagsBits.BanMembers,
      kick_member: PermissionFlagsBits.KickMembers,
      timeout_member: PermissionFlagsBits.ModerateMembers,
      remove_timeout: PermissionFlagsBits.ModerateMembers,
      create_channel: PermissionFlagsBits.ManageChannels,
      delete_channel: PermissionFlagsBits.ManageChannels,
      rename_channel: PermissionFlagsBits.ManageChannels,
      edit_channel: PermissionFlagsBits.ManageChannels,
      lock_channel: PermissionFlagsBits.ManageChannels,
      unlock_channel: PermissionFlagsBits.ManageChannels,
      create_role: PermissionFlagsBits.ManageRoles,
      edit_role: PermissionFlagsBits.ManageRoles,
      delete_role: PermissionFlagsBits.ManageRoles,
      assign_role: PermissionFlagsBits.ManageRoles,
      remove_role: PermissionFlagsBits.ManageRoles
    };

    const nativePerm = nativeDiscordPermMap[actName];
    if (!hasAdminPerm && nativePerm) {
      if (typeof member.permissions?.has === 'function' && !member.permissions.has(nativePerm)) {
        const permName = new PermissionsBitField(nativePerm).toArray().join(', ');
        return {
          authorized: false,
          reason: `Discord Permission Restriction: Even though bot policy permits this, your account lacks the required Discord '${permName}' permission in this server.`
        };
      }
    }
  }

  // 6. Strict Role Hierarchy check against Bot (for destructive/administrative actions)
  const botMember = guild.members.me;
  if (botMember && hasAdminPerm) {
    const userRolePos = member.roles?.highest?.position ?? member.roles?.highest?.rawPosition ?? 0;
    const botRolePos = botMember.roles?.highest?.position ?? botMember.roles?.highest?.rawPosition ?? 0;

    if (botRolePos > 0 && userRolePos <= botRolePos) {
      const userRoleName = member.roles?.highest?.name || 'your role';
      const botRoleName = botMember.roles?.highest?.name || 'Honey Bot';
      return {
        authorized: false,
        reason: `Role Hierarchy Restriction: Your highest role (@${userRoleName}) is at or below Honey Bot's role (@${botRoleName}). Only administrators with a role positioned higher than the bot can execute administrative commands.`
      };
    }
  }

  return { authorized: true };
}

/**
 * Checks if the bot itself has the required permissions to execute the actions.
 */
export function checkBotPermissions(guild, actions) {
  const botMember = guild.members.me;
  if (!botMember) {
    return { capable: false, reason: 'Bot member could not be resolved in the guild.' };
  }

  // If bot is administrator, it has all permission flags
  if (botMember.permissions.has(PermissionFlagsBits.Administrator)) {
    return { capable: true };
  }

  const missing = new Set();

  for (const actionObj of actions) {
    const capability = CAPABILITY_REGISTRY[actionObj.action];
    if (!capability) continue;

    for (const reqPerm of capability.requiredBotPermissions) {
      if (!botMember.permissions.has(reqPerm)) {
        missing.add(new PermissionsBitField(reqPerm).toArray().join(', '));
      }
    }
  }

  if (missing.size > 0) {
    return {
      capable: false,
      reason: `Bot is missing required Discord permissions: ${Array.from(missing).join(', ')}. Please grant these permissions in Server Settings > Roles.`
    };
  }

  return { capable: true };
}

/**
 * Checks role hierarchy rules.
 * Discord enforces that a bot cannot manage roles higher or equal to its own highest role,
 * and cannot moderate members whose highest role is higher or equal to the bot's highest role.
 */
export function checkRoleHierarchy(guild, actionObj, targetRoleOrMember) {
  if (!guild || !guild.members || !guild.members.me) {
    return { valid: true };
  }
  const botMember = guild.members.me;
  const botHighestRole = botMember.roles?.highest;

  // Check if target is a Role
  if (actionObj.action.includes('role') && targetRoleOrMember) {
    const role = typeof targetRoleOrMember === 'object' && targetRoleOrMember.position !== undefined
      ? targetRoleOrMember
      : guild.roles?.cache?.find(r => r.id === targetRoleOrMember || r.name?.toLowerCase() === String(targetRoleOrMember).toLowerCase());

    if (role && botHighestRole) {
      const rolePos = role.position ?? role.rawPosition ?? 0;
      const botPos = botHighestRole.position ?? botHighestRole.rawPosition ?? 0;
      if (botPos > 0 && rolePos >= botPos) {
        return {
          valid: false,
          reason: `Hierarchy Error: Role "${role.name}" (position ${rolePos}) is higher than or equal to the bot's highest role "${botHighestRole.name}" (position ${botPos}). Drag the bot's role higher in Server Settings > Roles.`
        };
      }
      if (role.managed) {
        return {
          valid: false,
          reason: `Managed Role: Role "${role.name}" is managed by an integration or bot and cannot be modified or deleted directly.`
        };
      }
    }
  }

  // Check if target is a Member (for moderation)
  if (['kick_member', 'ban_member', 'timeout_member', 'change_nickname'].includes(actionObj.action) && targetRoleOrMember) {
    const member = typeof targetRoleOrMember === 'object' && targetRoleOrMember.roles
      ? targetRoleOrMember
      : guild.members?.cache?.find(m => m.id === targetRoleOrMember || m.user?.username?.toLowerCase() === String(targetRoleOrMember).toLowerCase());

    if (member) {
      if (member.id === guild.ownerId) {
        return {
          valid: false,
          reason: `Target is the Server Owner. The server owner cannot be kicked, banned, timed out, or edited by any bot.`
        };
      }
      if (member.id === botMember.id) {
        return {
          valid: false,
          reason: `Target is the bot itself. The bot will not moderate itself.`
        };
      }
      const memberPos = member.roles?.highest?.position ?? member.roles?.highest?.rawPosition ?? 0;
      const botPos = botHighestRole?.position ?? botHighestRole?.rawPosition ?? 0;
      if (botPos > 0 && memberPos >= botPos) {
        return {
          valid: false,
          reason: `Hierarchy Error: Member "${member.user?.tag || member.id}" has a role "${member.roles.highest?.name || 'Unknown'}" that is higher than or equal to the bot's highest role "${botHighestRole.name || 'Bot'}".`
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Checks whether the member is authorized to modify guild access policy.
 */
export function checkPolicyAdminAuthorization(member) {
  if (!member || !member.guild) {
    return { authorized: false, reason: 'Access Denied: Invalid member or server context.' };
  }

  // 1. Server Owner always authorized
  if (member.guild.ownerId === member.id) {
    return { authorized: true };
  }

  const config = GuildConfigService.getConfig(member.guild.id);
  const policy = config.authorizationPolicy || {};
  const hasAdminPerm = Boolean(member.permissions?.has?.(PermissionFlagsBits.Administrator));

  if (policy.adminOnlyPolicyChanges !== false) {
    if (!hasAdminPerm) {
      return {
        authorized: false,
        reason: 'Access Denied: In this server, Honey Bot policy management is restricted strictly to Server Administrators.'
      };
    }
    return { authorized: true };
  }

  const policyAdmins = policy.policyAdmins || { roles: [], members: [] };
  const isNamedAdminMember = policyAdmins.members?.includes(member.id);
  const hasNamedAdminRole = member.roles?.cache && policyAdmins.roles?.some(rId => member.roles.cache.has(rId));

  if (!hasAdminPerm && !isNamedAdminMember && !hasNamedAdminRole) {
    return {
      authorized: false,
      reason: 'Access Denied: Only server administrators or configured Honey Bot policy administrators can modify access rules.'
    };
  }

  return { authorized: true };
}

/**
 * Audits server permissions for high-risk configurations.
 */
export function auditServerPermissions(guild) {
  const issues = [];
  const everyone = guild.roles?.everyone;
  if (!everyone) return issues;

  // 1. Check @everyone risky permissions
  const dangerousFlags = [
    { flag: PermissionFlagsBits.Administrator, name: 'Administrator' },
    { flag: PermissionFlagsBits.ManageGuild, name: 'Manage Server' },
    { flag: PermissionFlagsBits.ManageRoles, name: 'Manage Roles' },
    { flag: PermissionFlagsBits.ManageChannels, name: 'Manage Channels' },
    { flag: PermissionFlagsBits.MentionEveryone, name: 'Mention @everyone' },
    { flag: PermissionFlagsBits.BanMembers, name: 'Ban Members' },
    { flag: PermissionFlagsBits.KickMembers, name: 'Kick Members' }
  ];

  for (const { flag, name } of dangerousFlags) {
    if (everyone.permissions.has(flag)) {
      issues.push(`CRITICAL: The @everyone role has "${name}" enabled! Anyone joining can abuse this.`);
    }
  }

  // 2. Audit public channels
  if (guild.channels?.cache) {
    for (const [, channel] of guild.channels.cache) {
      if (channel.isTextBased && channel.isTextBased() && channel.permissionsFor?.(everyone)?.has(PermissionFlagsBits.SendMessages)) {
        if (/rules|announcement|welcome|info/i.test(channel.name)) {
          issues.push(`WARNING: Channel #${channel.name} appears to be an announcement/rules channel, but @everyone is allowed to send messages in it.`);
        }
      }
    }
  }

  return issues;
}
