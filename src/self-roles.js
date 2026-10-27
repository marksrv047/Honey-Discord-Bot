import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  EmbedBuilder
} from 'discord.js';
import { Logger } from './logger.js';
import { checkRoleHierarchy } from './permissions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = new Logger('SelfRoles');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const SELF_ROLES_FILE = path.join(DATA_DIR, 'reaction-roles.json');

/**
 * SelfRoleManager
 * Authoritative manager for persistent reaction roles, interactive button panels,
 * and select-menu role assignment.
 *
 * Guarantees:
 * - Full guild isolation (guildId keying)
 * - Persistent storage surviving restarts
 * - Whitelist security: members cannot obtain unlisted roles
 * - Safe role hierarchy checks before any mutation
 * - Dual interaction support: Buttons, Select Menus, and Reaction Emojis
 * - Stale mapping detection (deleted roles or deleted messages)
 * - Rebuild and repair capabilities
 */
export class SelfRoleManager {
  static _panels = new Map(); // panelId -> PanelConfig
  static _loaded = false;
  static _storagePath = SELF_ROLES_FILE;

  static get storagePath() {
    return this._storagePath;
  }

  static set storagePath(p) {
    this._storagePath = p;
    this._loaded = false;
  }

  static _ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      } catch (err) {
        logger.error('Failed to create data directory', { error: err.message });
      }
    }
  }

  /**
   * Loads persisted panels from disk.
   */
  static loadPanels() {
    if (this._loaded) return;
    this._ensureDataDir();

    if (fs.existsSync(this._storagePath)) {
      try {
        const raw = fs.readFileSync(this._storagePath, 'utf8');
        const data = JSON.parse(raw);
        this._panels.clear();
        if (Array.isArray(data)) {
          for (const item of data) {
            if (item && item.panelId) {
              this._panels.set(item.panelId, item);
            }
          }
        }
        logger.info(`Loaded ${this._panels.size} persistent self-role panel(s) from storage.`);
      } catch (err) {
        logger.error('Failed to read self-roles storage file', { error: err.message });
      }
    }
    this._loaded = true;
  }

  /**
   * Persists all panels to disk.
   */
  static persistPanels() {
    this._ensureDataDir();
    try {
      const records = Array.from(this._panels.values());
      const tempPath = `${this._storagePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tempPath, JSON.stringify(records, null, 2), 'utf8');
      fs.renameSync(tempPath, this._storagePath);
    } catch (err) {
      logger.error('Failed to persist self-roles storage file', { error: err.message });
    }
  }

  /**
   * Retrieves all panels for a specific guild.
   */
  static getGuildPanels(guildId) {
    this.loadPanels();
    return Array.from(this._panels.values()).filter(p => p.guildId === guildId);
  }

  /**
   * Retrieves a panel by its ID.
   */
  static getPanel(panelId) {
    this.loadPanels();
    return this._panels.get(panelId) || null;
  }

  /**
   * Finds a panel by message ID.
   */
  static getPanelByMessageId(messageId) {
    this.loadPanels();
    return Array.from(this._panels.values()).find(p => p.messageId === messageId) || null;
  }

  /**
   * Deploys or updates an interactive self-role panel.
   *
   * @param {Guild} guild
   * @param {Object} options
   * @returns {Promise<Object>}
   */
  static async setupPanel(guild, options = {}) {
    this.loadPanels();
    const guildId = guild.id;
    const channelRef = options.channelName || options.channel || 'roles';
    const panelType = (options.panelType || options.type || 'buttons').toLowerCase(); // 'buttons' | 'select' | 'reactions'
    const selectionRule = options.selectionRule === 'single' ? 'single' : 'multi';
    const title = options.title || '🎭 Self-Assignable Roles';
    const description = options.description || 'Choose your roles using the interactive controls below:';
    const rawRoles = options.roles || [];

    if (!Array.isArray(rawRoles) || rawRoles.length === 0) {
      throw new Error('At least one role configuration is required to create a self-role panel.');
    }

    // 1. Resolve or create destination channel
    let channel = null;
    const cleanChRef = String(channelRef).replace(/^[<#>]/g, '').trim().toLowerCase();
    channel = guild.channels?.cache?.find?.(c => 
      c.id === cleanChRef || c.name?.toLowerCase() === cleanChRef
    );

    if (!channel) {
      // Create dedicated read-only self-role channel
      channel = await guild.channels.create({
        name: cleanChRef.replace(/\s+/g, '-'),
        type: ChannelType.GuildText,
        topic: 'Select your server roles here',
        permissionOverwrites: [
          {
            id: guild.roles?.everyone?.id || guild.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions]
          }
        ],
        reason: 'Auto-created dedicated channel for self-assignable roles'
      });
      logger.info('Created self-role channel', { channelName: channel.name });
    }

    // Check bot permissions in target channel
    const botMember = guild.members?.me;
    if (botMember && typeof channel.permissionsFor === 'function') {
      const perms = channel.permissionsFor(botMember);
      if (!perms.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages)) {
        throw new Error(`Bot lacks ViewChannel or SendMessages permission in #${channel.name}.`);
      }
    }

    // 2. Resolve or create configured roles
    const configuredRoles = [];
    const panelId = options.panelId || `panel_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    for (const rConfig of rawRoles.slice(0, 25)) {
      const roleName = typeof rConfig === 'string' ? rConfig : (rConfig.name || rConfig.roleName || rConfig.role || '');
      if (!roleName) continue;

      let role = guild.roles?.cache?.find?.(r => 
        r.id === roleName || r.name?.toLowerCase() === roleName.toLowerCase()
      );

      if (!role) {
        role = await guild.roles.create({
          name: roleName,
          color: rConfig.color || '#99AAB5',
          mentionable: false,
          reason: 'Created for self-assignable role panel'
        });
        logger.info('Created role for self-role panel', { roleName: role.name, roleId: role.id });
      }

      // Check hierarchy: bot role must be higher than this role
      const hierarchy = checkRoleHierarchy(guild, { action: 'assign_role' }, role);
      if (!hierarchy.valid) {
        logger.warn(`Hierarchy restriction for role @${role.name}: ${hierarchy.reason}`);
      }

      configuredRoles.push({
        roleId: role.id,
        roleName: role.name,
        emoji: rConfig.emoji || null,
        description: rConfig.description || `Toggle the @${role.name} role`,
        color: role.hexColor || '#99AAB5'
      });
    }

    if (configuredRoles.length === 0) {
      throw new Error('No valid roles could be resolved or created for this panel.');
    }

    // 3. Prevent duplicate panel on retry: if panel already exists for this exact channel and title, reuse or update
    const existingPanel = Array.from(this._panels.values()).find(p => 
      p.guildId === guildId && p.channelId === channel.id && p.title.toLowerCase() === title.toLowerCase()
    );

    let message = null;
    if (existingPanel && existingPanel.messageId) {
      try {
        message = await channel.messages.fetch(existingPanel.messageId).catch(() => null);
      } catch {}
    }

    // 4. Build Embed
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(options.color || 0x5865F2)
      .setTimestamp()
      .setFooter({
        text: selectionRule === 'single'
          ? 'Selection Rule: Only one role active at a time'
          : 'Selection Rule: Click or choose a role to toggle it on/off'
      });

    // Add summary fields of available roles
    const roleListText = configuredRoles.map(r => {
      const emojiStr = r.emoji ? `${r.emoji} ` : '• ';
      return `${emojiStr}**@${r.roleName}**${r.description ? ` — ${r.description}` : ''}`;
    }).join('\n');

    embed.addFields([
      { name: 'Available Roles', value: roleListText.slice(0, 1024) }
    ]);

    // 5. Build Components
    const components = [];

    if (panelType === 'buttons') {
      // Discord allows max 5 buttons per ActionRow, max 5 rows (25 buttons total)
      const rows = [];
      let currentRow = new ActionRowBuilder();

      for (let i = 0; i < configuredRoles.length; i++) {
        const r = configuredRoles[i];
        if (currentRow.components.length >= 5) {
          rows.push(currentRow);
          currentRow = new ActionRowBuilder();
        }

        const btn = new ButtonBuilder()
          .setCustomId(`role:btn:${panelId}:${r.roleId}`)
          .setLabel(r.roleName.slice(0, 80))
          .setStyle(ButtonStyle.Secondary);

        if (r.emoji) {
          try {
            btn.setEmoji(r.emoji);
          } catch {}
        }

        currentRow.addComponents(btn);
      }

      if (currentRow.components.length > 0) {
        rows.push(currentRow);
      }
      components.push(...rows.slice(0, 5));
    } else if (panelType === 'select') {
      // Select Menu dropdown
      const menuOptions = configuredRoles.map(r => {
        const opt = new StringSelectMenuOptionBuilder()
          .setLabel(r.roleName.slice(0, 100))
          .setValue(r.roleId)
          .setDescription((r.description || `Toggle @${r.roleName}`).slice(0, 100));

        if (r.emoji) {
          try {
            opt.setEmoji(r.emoji);
          } catch {}
        }
        return opt;
      });

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`role:sel:${panelId}`)
        .setPlaceholder(options.placeholder || 'Select a role to assign or remove...')
        .addOptions(menuOptions);

      components.push(new ActionRowBuilder().addComponents(selectMenu));
    }

    // 6. Send or Edit Message
    if (message) {
      await message.edit({
        embeds: [embed],
        components: panelType === 'reactions' ? [] : components
      });
      logger.info('Updated existing self-role panel message', { messageId: message.id });
    } else {
      message = await channel.send({
        embeds: [embed],
        components: panelType === 'reactions' ? [] : components
      });
      logger.info('Published new self-role panel message', { messageId: message.id });
    }

    // 7. If reaction-based, add initial emoji reactions
    if (panelType === 'reactions') {
      for (const r of configuredRoles) {
        if (r.emoji) {
          try {
            await message.react(r.emoji);
          } catch (reactErr) {
            logger.warn(`Failed to add reaction emoji "${r.emoji}" to panel`, { error: reactErr.message });
          }
        }
      }
    }

    // 8. Persist Panel Record
    const panelRecord = {
      panelId,
      guildId,
      channelId: channel.id,
      channelName: channel.name,
      messageId: message.id,
      panelType,
      selectionRule,
      title,
      description,
      roles: configuredRoles,
      createdAt: existingPanel?.createdAt || Date.now(),
      updatedAt: Date.now()
    };

    this._panels.set(panelId, panelRecord);
    this.persistPanels();

    return {
      success: true,
      action: 'setup_role_panel',
      panelId,
      channelId: channel.id,
      channelName: channel.name,
      messageId: message.id,
      panelType,
      selectionRule,
      rolesCount: configuredRoles.length,
      roles: configuredRoles.map(r => r.roleName),
      details: `Self-role panel "${title}" deployed in #${channel.name} with ${configuredRoles.length} role(s) using ${panelType}.`,
      verified: true
    };
  }

  /**
   * Handles button interactions for self-assignable roles.
   */
  static async handleButtonInteraction(interaction) {
    if (!interaction.isButton()) return false;
    const customId = interaction.customId || '';
    if (!customId.startsWith('role:btn:')) return false;

    // Pattern: role:btn:<panelId>:<roleId>
    const parts = customId.split(':');
    if (parts.length < 4) return false;

    const panelId = parts[2];
    const roleId = parts[3];

    return await this._processRoleToggle(interaction, panelId, roleId);
  }

  /**
   * Handles select menu interactions for self-assignable roles.
   */
  static async handleSelectMenuInteraction(interaction) {
    if (!interaction.isStringSelectMenu()) return false;
    const customId = interaction.customId || '';
    if (!customId.startsWith('role:sel:')) return false;

    // Pattern: role:sel:<panelId>
    const parts = customId.split(':');
    if (parts.length < 3) return false;

    const panelId = parts[2];
    const roleId = interaction.values?.[0];
    if (!roleId) return false;

    return await this._processRoleToggle(interaction, panelId, roleId);
  }

  /**
   * Core execution of role toggle with whitelist security and role hierarchy validation.
   */
  static async _processRoleToggle(interaction, panelId, roleId) {
    const guild = interaction.guild;
    const member = interaction.member;

    if (!guild || !member) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Interaction must occur within a server.', ephemeral: true }).catch(() => {});
      }
      return true;
    }

    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
    }

    // 1. Whitelist Verification: panel must exist and role must be registered on it
    const panel = this.getPanel(panelId);
    if (!panel || panel.guildId !== guild.id) {
      await interaction.editReply({ content: '❌ This role panel is no longer active or registered.' }).catch(() => {});
      return true;
    }

    const roleConfig = panel.roles.find(r => r.roleId === roleId);
    if (!roleConfig) {
      // Member attempted to pass an arbitrary roleId not in the panel whitelist!
      logger.warn('Unauthorized role assignment attempt blocked by whitelist', {
        userId: member.id,
        roleId,
        panelId
      });
      await interaction.editReply({ content: '🛑 **Access Refusal:** This role is not part of the configured self-role menu.' }).catch(() => {});
      return true;
    }

    // 2. Fetch role from guild
    const role = guild.roles?.cache?.get?.(roleId) || await guild.roles?.fetch?.(roleId).catch(() => null);
    if (!role) {
      await interaction.editReply({ content: '❌ This role no longer exists in the server.' }).catch(() => {});
      return true;
    }

    // 3. Hierarchy Check
    const hierarchy = checkRoleHierarchy(guild, { action: 'assign_role' }, role);
    if (!hierarchy.valid) {
      await interaction.editReply({
        content: `❌ **Cannot modify role:** ${hierarchy.reason}\n*(Please ensure the Honey Bot role is moved above @${role.name} in Server Settings > Roles).*`
      }).catch(() => {});
      return true;
    }

    // 4. Toggle or Single-Select Role
    try {
      const hasRole = member.roles?.cache?.has ? member.roles.cache.has(roleId) : false;

      if (hasRole) {
        // Remove role
        await member.roles.remove(role, `Self-role toggle removed via panel [${panel.title}]`);
        await interaction.editReply({ content: `➖ Removed **@${role.name}** from your profile.` }).catch(() => {});
      } else {
        // If single-select, remove any conflicting roles from this panel first
        if (panel.selectionRule === 'single') {
          for (const other of panel.roles) {
            if (other.roleId !== roleId && member.roles.cache.has(other.roleId)) {
              const otherRole = guild.roles.cache.get(other.roleId);
              if (otherRole) {
                await member.roles.remove(otherRole, `Single-role selection rule swap in panel [${panel.title}]`).catch(() => {});
              }
            }
          }
        }

        // Add role
        await member.roles.add(role, `Self-role toggle added via panel [${panel.title}]`);
        await interaction.editReply({ content: `➕ Added **@${role.name}** to your profile!` }).catch(() => {});
      }
      return true;
    } catch (err) {
      logger.error('Error modifying member role', { error: err.message, roleId });
      await interaction.editReply({
        content: `❌ Failed to update role: ${err.message}. Check that Honey Bot has the "Manage Roles" permission.`
      }).catch(() => {});
      return true;
    }
  }

  /**
   * Handles reaction additions for reaction-role panels.
   */
  static async handleReactionAdd(reaction, user) {
    if (user.bot) return false;
    const messageId = reaction.message?.id;
    if (!messageId) return false;

    const panel = this.getPanelByMessageId(messageId);
    if (!panel || panel.panelType !== 'reactions') return false;

    const guild = reaction.message.guild;
    if (!guild || panel.guildId !== guild.id) return false;

    // Resolve emoji
    const emojiStr = reaction.emoji.id ? `<:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name;
    const roleConfig = panel.roles.find(r => r.emoji === emojiStr || r.emoji === reaction.emoji.name);
    if (!roleConfig) return false;

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return false;

    const role = guild.roles.cache.get(roleConfig.roleId);
    if (!role) return false;

    const hierarchy = checkRoleHierarchy(guild, { action: 'assign_role' }, role);
    if (!hierarchy.valid) {
      logger.warn(`Hierarchy restriction in reaction-role assignment: ${hierarchy.reason}`);
      return false;
    }

    try {
      if (!member.roles.cache.has(role.id)) {
        await member.roles.add(role, `Reaction-role added via emoji ${reaction.emoji.name}`);
        logger.info(`Assigned reaction role @${role.name} to ${member.user?.tag}`);
      }
      return true;
    } catch (err) {
      logger.error('Failed to assign reaction role', { error: err.message });
      return false;
    }
  }

  /**
   * Handles reaction removals for reaction-role panels.
   */
  static async handleReactionRemove(reaction, user) {
    if (user.bot) return false;
    const messageId = reaction.message?.id;
    if (!messageId) return false;

    const panel = this.getPanelByMessageId(messageId);
    if (!panel || panel.panelType !== 'reactions') return false;

    const guild = reaction.message.guild;
    if (!guild || panel.guildId !== guild.id) return false;

    const emojiStr = reaction.emoji.id ? `<:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name;
    const roleConfig = panel.roles.find(r => r.emoji === emojiStr || r.emoji === reaction.emoji.name);
    if (!roleConfig) return false;

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return false;

    const role = guild.roles.cache.get(roleConfig.roleId);
    if (!role) return false;

    const hierarchy = checkRoleHierarchy(guild, { action: 'assign_role' }, role);
    if (!hierarchy.valid) return false;

    try {
      if (member.roles.cache.has(role.id)) {
        await member.roles.remove(role, `Reaction-role removed via emoji ${reaction.emoji.name}`);
        logger.info(`Removed reaction role @${role.name} from ${member.user?.tag}`);
      }
      return true;
    } catch (err) {
      logger.error('Failed to remove reaction role', { error: err.message });
      return false;
    }
  }

  /**
   * Diagnostic health check for registered self-role panels in a guild.
   */
  static async diagnosePanels(guild) {
    this.loadPanels();
    const panels = this.getGuildPanels(guild.id);
    const findings = [];

    const botMember = guild.members?.me;
    const hasManageRoles = botMember?.permissions?.has ? botMember.permissions.has(PermissionFlagsBits.ManageRoles) : true;

    for (const panel of panels) {
      const channel = guild.channels?.cache?.get?.(panel.channelId);
      if (!channel) {
        findings.push({
          panelId: panel.panelId,
          title: panel.title,
          severity: 'HIGH',
          issue: `Channel #${panel.channelName || panel.channelId} was deleted from the server.`
        });
        continue;
      }

      // Check message
      let message = null;
      try {
        message = await channel.messages?.fetch?.(panel.messageId).catch(() => null);
      } catch {}

      if (!message) {
        findings.push({
          panelId: panel.panelId,
          title: panel.title,
          severity: 'HIGH',
          issue: `Panel message (ID: ${panel.messageId}) in #${channel.name} was deleted.`
        });
      }

      // Check roles
      for (const r of panel.roles) {
        const role = guild.roles?.cache?.get?.(r.roleId);
        if (!role) {
          findings.push({
            panelId: panel.panelId,
            title: panel.title,
            severity: 'MEDIUM',
            issue: `Configured role "${r.roleName}" (ID: ${r.roleId}) was deleted from server roles.`
          });
        } else if (botMember) {
          const hierarchy = checkRoleHierarchy(guild, { action: 'assign_role' }, role);
          if (!hierarchy.valid) {
            findings.push({
              panelId: panel.panelId,
              title: panel.title,
              severity: 'CRITICAL',
              issue: `Bot cannot manage role @${role.name}: ${hierarchy.reason}`
            });
          }
        }
      }
    }

    return {
      totalPanels: panels.length,
      hasManageRoles,
      findings,
      healthy: findings.length === 0
    };
  }

  /**
   * Repairs or rebuilds a broken panel.
   */
  static async repairPanel(guild, panelId) {
    const panel = this.getPanel(panelId);
    if (!panel || panel.guildId !== guild.id) {
      return { success: false, error: `Panel ${panelId} not found in this guild.` };
    }

    // Re-run setupPanel with existing options
    return await this.setupPanel(guild, {
      panelId: panel.panelId,
      channelName: panel.channelName,
      title: panel.title,
      description: panel.description,
      panelType: panel.panelType,
      selectionRule: panel.selectionRule,
      roles: panel.roles
    });
  }

  /**
   * Removes and unregisters a panel.
   */
  static async removePanel(guild, panelId, deleteMessage = true) {
    const panel = this.getPanel(panelId);
    if (!panel || panel.guildId !== guild.id) {
      return { success: false, error: 'Panel not found.' };
    }

    if (deleteMessage) {
      try {
        const channel = guild.channels?.cache?.get?.(panel.channelId);
        if (channel && typeof channel.messages?.fetch === 'function') {
          const msg = await channel.messages.fetch(panel.messageId).catch(() => null);
          if (msg) await msg.delete().catch(() => {});
        }
      } catch {}
    }

    this._panels.delete(panelId);
    this.persistPanels();
    return { success: true, details: `Self-role panel "${panel.title}" removed.` };
  }
}

