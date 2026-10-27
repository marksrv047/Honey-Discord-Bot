import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { Logger } from './logger.js';
import { ModLogService } from './mod-log.js';

const logger = new Logger('ServerTemplates');

/**
 * Curated, production-grade server templates inspired by established server architectures.
 */
export const SERVER_TEMPLATES = {
  COMMUNITY_HUB: {
    id: 'COMMUNITY_HUB',
    name: 'Community Hub',
    description: 'A complete community setup with information, general chat, media, community voice, and a private staff ops area.',
    roles: [
      { name: 'Admin', color: '#E74C3C', hoist: true, mentionable: true, permissions: [PermissionFlagsBits.Administrator] },
      { name: 'Moderator', color: '#3498DB', hoist: true, mentionable: true, permissions: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers, PermissionFlagsBits.ModerateMembers] },
      { name: 'Member', color: '#2ECC71', hoist: false, mentionable: false, permissions: [] }
    ],
    categories: [
      {
        name: 'WELCOME & RULES',
        channels: [
          { name: 'rules', type: ChannelType.GuildText, topic: 'Server guidelines and code of conduct', readOnly: true },
          { name: 'announcements', type: ChannelType.GuildText, topic: 'Official community announcements', readOnly: true },
          { name: 'welcome', type: ChannelType.GuildText, topic: 'Member greetings and welcome logs', readOnly: true }
        ]
      },
      {
        name: 'COMMUNITY CHAT',
        channels: [
          { name: 'general', type: ChannelType.GuildText, topic: 'Main public hangout and discussion' },
          { name: 'media-share', type: ChannelType.GuildText, topic: 'Share artwork, screenshots, and videos' },
          { name: 'bot-commands', type: ChannelType.GuildText, topic: 'Dedicated channel for bot commands and /go' }
        ]
      },
      {
        name: 'VOICE LOUNGES',
        channels: [
          { name: 'General Voice', type: ChannelType.GuildVoice },
          { name: 'Music Lounge', type: ChannelType.GuildVoice },
          { name: 'AFK / Quiet', type: ChannelType.GuildVoice }
        ]
      },
      {
        name: 'STAFF OPERATIONS',
        isPrivateStaff: true,
        channels: [
          { name: 'mod-chat', type: ChannelType.GuildText, topic: 'Private staff discussion' },
          { name: 'mod-logs', type: ChannelType.GuildText, topic: 'Automated audit logs from Honey Bot' },
          { name: 'Staff Voice', type: ChannelType.GuildVoice }
        ]
      }
    ]
  },
  GAMING_COMMUNITY: {
    id: 'GAMING_COMMUNITY',
    name: 'Gaming Community',
    description: 'Designed for gaming guilds and esports teams, featuring LFG, clip-sharing, and team squads.',
    roles: [
      { name: 'Guild Master', color: '#F1C40F', hoist: true, mentionable: true, permissions: [PermissionFlagsBits.Administrator] },
      { name: 'Team Captain', color: '#E67E22', hoist: true, mentionable: true, permissions: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.MoveMembers] },
      { name: 'Gamer', color: '#9B59B6', hoist: false, mentionable: true, permissions: [] }
    ],
    categories: [
      {
        name: 'HEADQUARTERS',
        channels: [
          { name: 'information', type: ChannelType.GuildText, topic: 'Team info and schedule', readOnly: true },
          { name: 'announcements', type: ChannelType.GuildText, topic: 'Match updates and tournament news', readOnly: true }
        ]
      },
      {
        name: 'SQUADS & LFG',
        channels: [
          { name: 'looking-for-group', type: ChannelType.GuildText, topic: 'Find squadmates and rank matches' },
          { name: 'game-clips', type: ChannelType.GuildText, topic: 'Highlight reels and clutch plays' },
          { name: 'general-gaming', type: ChannelType.GuildText, topic: 'Patch notes, game discussion and meta' }
        ]
      },
      {
        name: 'SQUAD COMMS',
        channels: [
          { name: 'Squad Alpha', type: ChannelType.GuildVoice },
          { name: 'Squad Bravo', type: ChannelType.GuildVoice },
          { name: 'Duo Room 1', type: ChannelType.GuildVoice },
          { name: 'Duo Room 2', type: ChannelType.GuildVoice }
        ]
      },
      {
        name: 'OFFICER LOUNGE',
        isPrivateStaff: true,
        channels: [
          { name: 'officer-discussion', type: ChannelType.GuildText, topic: 'Staff planning' },
          { name: 'bot-audit-logs', type: ChannelType.GuildText, topic: 'Server audit trail' }
        ]
      }
    ]
  },
  TECH_DEVELOPER: {
    id: 'TECH_DEVELOPER',
    name: 'Tech & Developer Workspace',
    description: 'Tailored for software teams, open source projects, code collaboration, and issue tracking.',
    roles: [
      { name: 'Core Maintainer', color: '#34495E', hoist: true, mentionable: true, permissions: [PermissionFlagsBits.Administrator] },
      { name: 'Contributor', color: '#1ABC9C', hoist: true, mentionable: false, permissions: [] },
      { name: 'Developer', color: '#3498DB', hoist: false, mentionable: false, permissions: [] }
    ],
    categories: [
      {
        name: 'DOCUMENTATION & RELEASES',
        channels: [
          { name: 'getting-started', type: ChannelType.GuildText, topic: 'Repo links, installation and docs', readOnly: true },
          { name: 'release-notes', type: ChannelType.GuildText, topic: 'Version releases and changelogs', readOnly: true }
        ]
      },
      {
        name: 'DEV COLLABORATION',
        channels: [
          { name: 'code-help', type: ChannelType.GuildText, topic: 'Ask code questions and share snippets' },
          { name: 'project-showcase', type: ChannelType.GuildText, topic: 'Showcase demos and projects' },
          { name: 'dev-chat', type: ChannelType.GuildText, topic: 'General engineering discussions' }
        ]
      },
      {
        name: 'DEVELOPER VOICE',
        channels: [
          { name: 'Pair Programming', type: ChannelType.GuildVoice },
          { name: 'Sprint Standup', type: ChannelType.GuildVoice }
        ]
      },
      {
        name: 'ADMINISTRATION',
        isPrivateStaff: true,
        channels: [
          { name: 'dev-ops', type: ChannelType.GuildText, topic: 'CI/CD and infrastructure discussion' },
          { name: 'security-modlog', type: ChannelType.GuildText, topic: 'Admin and security audit logs' }
        ]
      }
    ]
  }
};

/**
 * ServerTemplateEngine
 * Manages previewing, validation, and safe application of server templates.
 */
export class ServerTemplateEngine {
  static getAvailableTemplates() {
    return Object.values(SERVER_TEMPLATES).map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      categoryCount: t.categories.length,
      channelCount: t.categories.reduce((acc, c) => acc + c.channels.length, 0),
      roleCount: t.roles.length
    }));
  }

  static getTemplate(templateId) {
    if (!templateId) return null;
    return SERVER_TEMPLATES[String(templateId).toUpperCase()] || null;
  }

  static generatePreview(templateId) {
    const tmpl = this.getTemplate(templateId);
    if (!tmpl) return null;

    let text = `📋 **Template: ${tmpl.name}**\n${tmpl.description}\n\n`;
    text += `### Roles (${tmpl.roles.length}):\n`;
    for (const r of tmpl.roles) {
      text += `• **@${r.name}** (${r.color})\n`;
    }

    text += `\n### Channels & Categories (${tmpl.categories.reduce((a, c) => a + c.channels.length, 0)}):\n`;
    for (const cat of tmpl.categories) {
      text += `📁 **${cat.name}** ${cat.isPrivateStaff ? '*(Private Staff)*' : ''}\n`;
      for (const ch of cat.channels) {
        const icon = ch.type === ChannelType.GuildVoice ? '🔊' : '💬';
        const note = ch.readOnly ? ' *(Read-Only)*' : '';
        text += `  ${icon} #${ch.name}${note}\n`;
      }
    }

    return text;
  }

  /**
   * Applies the template to a Discord guild.
   */
  static async applyTemplate(guild, templateId, actor) {
    const tmpl = this.getTemplate(templateId);
    if (!tmpl) {
      return { success: false, error: `Template "${templateId}" not found.` };
    }

    if (!guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels) ||
        !guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return { success: false, error: 'Honey Bot requires `Manage Channels` and `Manage Roles` permissions to apply templates.' };
    }

    const createdRoles = [];
    const createdCategories = [];
    const createdChannels = [];
    const everyoneRole = guild.roles.everyone;

    try {
      // 1. Create Roles if they don't already exist
      const roleMap = new Map();
      for (const rDef of tmpl.roles) {
        let role = guild.roles.cache.find(r => r.name.toLowerCase() === rDef.name.toLowerCase());
        if (!role) {
          role = await guild.roles.create({
            name: rDef.name,
            color: rDef.color,
            hoist: rDef.hoist,
            mentionable: rDef.mentionable,
            permissions: rDef.permissions || [],
            reason: `Applied via Server Template: ${tmpl.name}`
          });
          createdRoles.push(role.name);
        }
        roleMap.set(rDef.name.toLowerCase(), role);
      }

      const modRole = roleMap.get('moderator') || roleMap.get('team captain') || roleMap.get('core maintainer');
      const adminRole = roleMap.get('admin') || roleMap.get('guild master');

      // 2. Create Categories & Channels
      for (const catDef of tmpl.categories) {
        let category = guild.channels.cache.find(
          c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === catDef.name.toLowerCase()
        );

        if (!category) {
          const catOverwrites = [];
          if (catDef.isPrivateStaff) {
            catOverwrites.push({
              id: everyoneRole.id,
              deny: [PermissionFlagsBits.ViewChannel]
            });
            if (modRole) {
              catOverwrites.push({
                id: modRole.id,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
              });
            }
            if (adminRole) {
              catOverwrites.push({
                id: adminRole.id,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
              });
            }
          }

          category = await guild.channels.create({
            name: catDef.name,
            type: ChannelType.GuildCategory,
            permissionOverwrites: catOverwrites,
            reason: `Applied via Server Template: ${tmpl.name}`
          });
          createdCategories.push(category.name);
        }

        // Create Channels in Category
        for (const chDef of catDef.channels) {
          let ch = guild.channels.cache.find(
            c => c.name.toLowerCase() === chDef.name.toLowerCase() && c.parentId === category.id
          );

          if (!ch) {
            const chOverwrites = [];
            if (chDef.readOnly) {
              chOverwrites.push({
                id: everyoneRole.id,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
                deny: [PermissionFlagsBits.SendMessages]
              });
              if (modRole) {
                chOverwrites.push({
                  id: modRole.id,
                  allow: [PermissionFlagsBits.SendMessages]
                });
              }
            }

            ch = await guild.channels.create({
              name: chDef.name,
              type: chDef.type,
              parent: category.id,
              topic: chDef.topic || null,
              permissionOverwrites: chOverwrites.length > 0 ? chOverwrites : undefined,
              reason: `Applied via Server Template: ${tmpl.name}`
            });
            createdChannels.push(ch.name);
          }
        }
      }

      await ModLogService.logAction(guild, {
        action: 'apply_server_template',
        actor,
        target: tmpl.name,
        reason: `Applied server layout template "${tmpl.name}"`,
        outcome: 'succeeded',
        source: '/go'
      }).catch(() => {});

      logger.info(`Successfully applied template ${tmpl.name} in guild ${guild.name}`);
      return {
        success: true,
        templateName: tmpl.name,
        createdRoles,
        createdCategories,
        createdChannels
      };
    } catch (err) {
      logger.error('Failed to apply server template', { error: err.message });
      return { success: false, error: err.message };
    }
  }
}

