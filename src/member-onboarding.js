import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits
} from 'discord.js';
import { Logger } from './logger.js';
import { ModLogService } from './mod-log.js';
import { checkRoleHierarchy } from './permissions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = new Logger('MemberOnboarding');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const ONBOARDING_CONFIG_FILE = path.join(DATA_DIR, 'member-onboarding.json');

/**
 * MemberOnboardingManager
 * Comprehensive suite for member welcome/farewell messaging, automatic role assignment,
 * rules verification buttons, and onboarding progress tracking.
 */
export class MemberOnboardingManager {
  static _configs = new Map(); // guildId -> OnboardingConfig
  static _isLoaded = false;
  static _storagePath = ONBOARDING_CONFIG_FILE;

  static get storagePath() {
    return this._storagePath;
  }

  static set storagePath(p) {
    this._storagePath = p;
    this._isLoaded = false;
  }

  static _ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      } catch (err) {
        logger.error('Failed to create data directory for onboarding', { error: err.message });
      }
    }
  }

  static getDefaultConfig() {
    return {
      welcome: {
        enabled: false,
        channelId: null,
        message: 'Welcome to **{server}**, {user}! You are member #{memberCount}.',
        sendEmbed: true,
        embedTitle: 'Welcome to {server}!',
        embedColor: 0xFEE75C, // Honey amber
        footerText: 'Enjoy your stay • Member #{memberCount}',
        includeAvatar: true
      },
      farewell: {
        enabled: false,
        channelId: null,
        message: '**{tag}** has left the server. We now have {memberCount} members.'
      },
      autoRoles: {
        enabled: false,
        memberRoleIds: [],
        botRoleIds: []
      },
      verification: {
        enabled: false,
        channelId: null,
        verifiedRoleId: null,
        unverifiedRoleId: null,
        buttonText: 'Verify & Agree to Rules',
        buttonEmoji: '✅',
        panelTitle: 'Server Verification & Rules Acceptance',
        panelDescription: 'Please review server rules. Click the button below to verify your account and gain access to the channels.'
      }
    };
  }

  static loadAll() {
    if (this._isLoaded) return;
    this._ensureDataDir();

    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const parsed = JSON.parse(raw);
        this._configs.clear();
        for (const [guildId, conf] of Object.entries(parsed)) {
          this._configs.set(guildId, {
            ...this.getDefaultConfig(),
            ...conf,
            welcome: { ...this.getDefaultConfig().welcome, ...(conf.welcome || {}) },
            farewell: { ...this.getDefaultConfig().farewell, ...(conf.farewell || {}) },
            autoRoles: { ...this.getDefaultConfig().autoRoles, ...(conf.autoRoles || {}) },
            verification: { ...this.getDefaultConfig().verification, ...(conf.verification || {}) }
          });
        }
      }
      this._isLoaded = true;
    } catch (err) {
      logger.error('Failed to load member onboarding configurations', { error: err.message });
      this._isLoaded = true;
    }
  }

  static saveAll() {
    this._ensureDataDir();
    try {
      const serializable = {};
      for (const [guildId, conf] of this._configs.entries()) {
        serializable[guildId] = conf;
      }
      const tmpFile = `${this.storagePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpFile, JSON.stringify(serializable, null, 2), 'utf8');
      fs.renameSync(tmpFile, this.storagePath);
    } catch (err) {
      logger.error('Failed to save member onboarding configurations', { error: err.message });
    }
  }

  static getConfig(guildId) {
    this.loadAll();
    return this._configs.get(guildId) || this.getDefaultConfig();
  }

  static updateConfig(guildId, update) {
    this.loadAll();
    const current = this.getConfig(guildId);
    const updated = {
      ...current,
      ...update,
      welcome: { ...current.welcome, ...(update.welcome || {}) },
      farewell: { ...current.farewell, ...(update.farewell || {}) },
      autoRoles: { ...current.autoRoles, ...(update.autoRoles || {}) },
      verification: { ...current.verification, ...(update.verification || {}) }
    };
    this._configs.set(guildId, updated);
    this.saveAll();
    return updated;
  }

  static formatText(template, member) {
    if (!template || !member) return '';
    const guild = member.guild;
    return template
      .replace(/\{user\}/g, `<@${member.id}>`)
      .replace(/\{username\}/g, member.user?.username || member.displayName || '')
      .replace(/\{tag\}/g, member.user?.tag || member.displayName || '')
      .replace(/\{server\}/g, guild?.name || 'the server')
      .replace(/\{memberCount\}/g, String(guild?.memberCount || ''));
  }

  /**
   * Handles GuildMemberAdd event: dispatches welcome message and auto-roles.
   */
  static async handleMemberJoin(member, client) {
    if (!member || !member.guild) return;
    const guild = member.guild;
    const guildId = guild.id;
    const config = this.getConfig(guildId);

    // 1. Auto-Role Assignment
    if (config.autoRoles?.enabled) {
      const isBot = member.user?.bot;
      const targetRoleIds = isBot ? config.autoRoles.botRoleIds : config.autoRoles.memberRoleIds;

      if (targetRoleIds?.length > 0 && guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
        for (const roleId of targetRoleIds) {
          const role = guild.roles.cache.get(roleId);
          if (role) {
            const hierarchy = checkRoleHierarchy(guild, { action: 'assign_role' }, role);
            if (hierarchy.valid !== false) {
              await member.roles.add(role, 'Automated onboarding auto-role').catch(err => {
                logger.warn(`Failed to assign auto-role ${role.name}: ${err.message}`);
              });
            }
          }
        }
      }
    }

    // 2. Unverified Role Assignment if verification workflow is enabled
    if (config.verification?.enabled && config.verification.unverifiedRoleId) {
      const unverifiedRole = guild.roles.cache.get(config.verification.unverifiedRoleId);
      if (unverifiedRole && guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
        const hierarchy = checkRoleHierarchy(guild, { action: 'assign_role' }, unverifiedRole);
        if (hierarchy.valid !== false) {
          await member.roles.add(unverifiedRole, 'Assigned unverified role awaiting verification button').catch(() => {});
        }
      }
    }

    // 3. Welcome Message Dispatch
    if (config.welcome?.enabled && config.welcome.channelId) {
      const channel = guild.channels.cache.get(config.welcome.channelId);
      if (channel && channel.isTextBased()) {
        try {
          if (config.welcome.sendEmbed) {
            const embed = new EmbedBuilder()
              .setTitle(this.formatText(config.welcome.embedTitle, member))
              .setDescription(this.formatText(config.welcome.message, member))
              .setColor(config.welcome.embedColor || 0xFEE75C)
              .setTimestamp();

            if (config.welcome.includeAvatar && member.user?.displayAvatarURL) {
              embed.setThumbnail(member.user.displayAvatarURL({ dynamic: true }));
            }
            if (config.welcome.footerText) {
              embed.setFooter({ text: this.formatText(config.welcome.footerText, member) });
            }

            await channel.send({ embeds: [embed] });
          } else {
            await channel.send({ content: this.formatText(config.welcome.message, member) });
          }
        } catch (sendErr) {
          logger.warn(`Failed to deliver welcome message in guild ${guild.name}: ${sendErr.message}`);
        }
      }
    }
  }

  /**
   * Handles GuildMemberRemove event: dispatches farewell message if enabled.
   */
  static async handleMemberLeave(member) {
    if (!member || !member.guild) return;
    const guild = member.guild;
    const guildId = guild.id;
    const config = this.getConfig(guildId);

    if (config.farewell?.enabled && config.farewell.channelId) {
      const channel = guild.channels.cache.get(config.farewell.channelId);
      if (channel && channel.isTextBased()) {
        try {
          const text = this.formatText(config.farewell.message, member);
          await channel.send({ content: text });
        } catch (err) {
          logger.warn(`Failed to send farewell message: ${err.message}`);
        }
      }
    }
  }

  /**
   * Publishes the interactive verification panel with a "Verify" button.
   */
  static async publishVerificationPanel(guild, channelId) {
    const config = this.getConfig(guild.id);
    const channel = guild.channels.cache.get(channelId);
    if (!channel) return { success: false, error: 'Channel not found' };

    const embed = new EmbedBuilder()
      .setTitle(config.verification.panelTitle || 'Server Verification')
      .setDescription(config.verification.panelDescription || 'Click below to verify and unlock channels.')
      .setColor(0x57F287)
      .setFooter({ text: 'Automated Member Verification • Honey Bot' });

    const btn = new ButtonBuilder()
      .setCustomId('onboard:verify_member')
      .setLabel(config.verification.buttonText || 'Verify & Access')
      .setEmoji(config.verification.buttonEmoji || '✅')
      .setStyle(ButtonStyle.Success);

    const row = new ActionRowBuilder().addComponents(btn);

    const msg = await channel.send({ embeds: [embed], components: [row] });
    this.updateConfig(guild.id, {
      verification: {
        ...config.verification,
        enabled: true,
        channelId: channel.id,
        panelMessageId: msg.id
      }
    });

    return { success: true, messageId: msg.id };
  }

  /**
   * Handles verification button click.
   */
  static async handleVerificationInteraction(interaction) {
    if (!interaction.isButton() || interaction.customId !== 'onboard:verify_member') {
      return false;
    }

    const guild = interaction.guild;
    const member = interaction.member;
    const config = this.getConfig(guild.id);

    if (!config.verification?.enabled || !config.verification.verifiedRoleId) {
      await interaction.reply({
        content: '⚠️ Verification is currently not configured with a target role.',
        ephemeral: true
      });
      return true;
    }

    const verifiedRole = guild.roles.cache.get(config.verification.verifiedRoleId);
    if (!verifiedRole) {
      await interaction.reply({
        content: '⚠️ The verified role configured for this server no longer exists. Please contact an administrator.',
        ephemeral: true
      });
      return true;
    }

    if (!guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      await interaction.reply({
        content: '⚠️ Honey Bot is missing the `Manage Roles` permission to complete verification.',
        ephemeral: true
      });
      return true;
    }

    try {
      await member.roles.add(verifiedRole, 'Completed member verification workflow');

      if (config.verification.unverifiedRoleId) {
        const unverifiedRole = guild.roles.cache.get(config.verification.unverifiedRoleId);
        if (unverifiedRole && member.roles.cache.has(unverifiedRole.id)) {
          await member.roles.remove(unverifiedRole, 'Removed unverified role after verification').catch(() => {});
        }
      }

      await interaction.reply({
        content: `🎉 **Verified!** You have been assigned the **${verifiedRole.name}** role. Welcome to the server!`,
        ephemeral: true
      });

      return true;
    } catch (err) {
      logger.error('Failed to assign verified role', { error: err.message });
      await interaction.reply({
        content: `❌ Verification error: ${err.message}`,
        ephemeral: true
      });
      return true;
    }
  }
}
