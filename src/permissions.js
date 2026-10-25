import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { CAPABILITY_REGISTRY } from './capabilities.js';

/**
 * Checks if the invoking member has authority to perform the planned actions.
 */
/**
 * Checks if the invoking member has authority to perform the planned actions.
 * Enforces:
 * 1. Administrator only (or Guild Owner)
 * 2. User's highest role MUST be positioned above the bot's role
 */
export function checkUserAuthorization(member, actions = []) {
  // 1. Server owner always has unconditional full authorization
  if (member.guild.ownerId === member.id) {
    return { authorized: true };
  }

  // 2. Strict Administrator-only requirement
  if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
    return {
      authorized: false,
      reason: 'Access Denied: Honey Bot administration is restricted strictly to Server Administrators (missing the following Discord permissions: Administrator).'
    };
  }

  // 3. Strict Role Hierarchy: Invoking user's highest role MUST be above the bot's highest role
  const botMember = member.guild.members.me;
  if (botMember) {
    const userRolePos = member.roles?.highest?.position ?? 0;
    const botRolePos = botMember.roles?.highest?.position ?? 0;

    if (userRolePos <= botRolePos) {
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
  const botMember = guild.members.me;
  if (!botMember) {
    return { valid: false, reason: 'Cannot determine bot member in guild.' };
  }

  const botHighestRole = botMember.roles.highest;

  // Check if target is a Role
  if (actionObj.action.includes('role') && targetRoleOrMember) {
    // If targetRole is a role instance
    const role = typeof targetRoleOrMember === 'object' && targetRoleOrMember.position !== undefined
      ? targetRoleOrMember
      : guild.roles.cache.find(r => r.id === targetRoleOrMember || r.name.toLowerCase() === String(targetRoleOrMember).toLowerCase());

    if (role) {
      if (role.position >= botHighestRole.position) {
        return {
          valid: false,
          reason: `Hierarchy Error: Role "${role.name}" (position ${role.position}) is higher than or equal to the bot's highest role "${botHighestRole.name}" (position ${botHighestRole.position}). Drag the bot's role higher in Server Settings > Roles.`
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
      : guild.members.cache.find(m => m.id === targetRoleOrMember || m.user?.username.toLowerCase() === String(targetRoleOrMember).toLowerCase());

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
      if (member.roles.highest.position >= botHighestRole.position) {
        return {
          valid: false,
          reason: `Hierarchy Error: Member "${member.user.tag}" has a role "${member.roles.highest.name}" that is higher than or equal to the bot's highest role "${botHighestRole.name}".`
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Audits server permissions for high-risk configurations.
 */
export function auditServerPermissions(guild) {
  const issues = [];
  const everyone = guild.roles.everyone;

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
  for (const [, channel] of guild.channels.cache) {
    if (channel.isTextBased() && channel.permissionsFor(everyone)?.has(PermissionFlagsBits.SendMessages)) {
      // Check if it's an announcement or rules channel that should be read-only
      if (/rules|announcement|welcome|info/i.test(channel.name)) {
        issues.push(`WARNING: Channel #${channel.name} appears to be an announcement/rules channel, but @everyone is allowed to send messages in it.`);
      }
    }
  }

  return issues;
}
