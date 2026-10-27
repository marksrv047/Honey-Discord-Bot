import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import { GuildConfigService } from './guild-config.js';
import { ModLogService } from './mod-log.js';
import { TaskQueue, TaskQueueState } from './task-queue.js';
import { MusicService } from './music-service.js';
import { ActionLedger } from './recovery.js';
import { DiagnosticService, DiagnosticStatus } from './diagnostic-service.js';
import { CapabilityRegistry } from './capabilities.js';
import { SETTINGS_CATALOG, getSettingById } from './dashboard-catalog.js';
import { ExperienceStore } from './experience-store.js';
import { SecurityEngine } from './security-engine.js';
import { CaseManager } from './case-manager.js';
import { MemberOnboardingManager } from './member-onboarding.js';
import { ApplicationManager } from './applications.js';
import { WorkflowEngine } from './workflow-engine.js';
import { CommunityUtils } from './community-utils.js';
import { TaskScheduler } from './scheduler.js';
import { AnalyticsService } from './analytics-service.js';
import { HoneypotService } from './honeypot-service.js';
import { Logger } from './logger.js';

const logger = new Logger('DashboardManager');

/**
 * Standard visual brand colors (minimalist, calm, restrained).
 */
export const DASH_COLORS = {
  PRIMARY: 0x5865F2,    // Indigo / Discord blurple
  SUCCESS: 0x57F287,    // Soft green
  WARNING: 0xFEE75C,    // Amber warning
  DANGER: 0xED4245,     // Crimson error/alert
  NEUTRAL: 0x2B2D31,    // Deep charcoal
  MUTED: 0x4E5058       // Slate gray
};

/**
 * Supported Dashboard Navigation Pages
 */
export const DASHBOARD_PAGES = [
  { id: 'overview', label: 'Overview', emoji: '📊', description: 'Server operational health & summary' },
  { id: 'security', label: 'Security & Anti-Raid', emoji: '🛡️', description: 'Anti-spam shields, join velocity & emergency lockdown' },
  { id: 'cases', label: 'Moderation Cases', emoji: '⚖️', description: 'Case history (CASE-XXXX), auto-escalation & temp bans' },
  { id: 'moderation', label: 'Moderation Policy', emoji: '🔨', description: 'Timeouts, warnings, kick/ban confirmation policy' },
  { id: 'onboarding', label: 'Member Onboarding', emoji: '👋', description: 'Welcome embeds, auto-roles & rules verification' },
  { id: 'tickets', label: 'Tickets & Apps', emoji: '🎫', description: 'Support tickets, review queue & transcripts' },
  { id: 'workflows', label: 'Workflows', emoji: '⚡', description: 'Event automation (Trigger -> Conditions -> Actions)' },
  { id: 'community', label: 'Community Utilities', emoji: '💡', description: 'Button polls, suggestions, starboard & FAQs' },
  { id: 'scheduler', label: 'Events & Reminders', emoji: '📅', description: 'Scheduled announcements, reminders & event RSVPs' },
  { id: 'analytics', label: 'Server Analytics', emoji: '📈', description: 'Privacy-conscious growth & activity trends' },
  { id: 'roles', label: 'Roles & Access', emoji: '👥', description: 'Operator roles and capability rules' },
  { id: 'channels', label: 'Channels', emoji: '📁', description: 'Channels, categories & sync status' },
  { id: 'modlog', label: 'Modlogs', emoji: '📜', description: 'Audit destination, filters & delivery health' },
  { id: 'honeypot', label: 'Honeypot Security', emoji: '🍯', description: 'Subsystem status & safety notice' },
  { id: 'music', label: 'Music & Voice', emoji: '🎵', description: 'Voice playback state & queue controls' },
  { id: 'queue', label: 'Task Queue', emoji: '⏳', description: 'Active tasks, history & cancellations' },
  { id: 'diagnostics', label: 'Diagnostics', emoji: '🩺', description: 'Health checks, API latency & recovery' },
  { id: 'learning', label: 'Continuous Learning', emoji: '🧠', description: 'Experience records, success rate & dataset export' },
  { id: 'settings', label: 'All Settings', emoji: '⚙️', description: 'Authoritative server settings catalog' },
  { id: 'catalog', label: 'Capability Catalog', emoji: '📖', description: 'Real commands vs /go capabilities' }
];

/**
 * Centralized Interactive Server Dashboard & Guild Configuration Manager.
 */
export class DashboardManager {
  /**
   * Evaluates the actor's permission level for the current guild.
   */
  static getAccessLevel(guild, member, user) {
    if (!guild) return { level: 'NONE', canView: false, canEdit: false, label: 'No Guild Context' };
    if (user && guild.ownerId === user.id) {
      return { level: 'OWNER', canView: true, canEdit: true, label: 'Server Owner (Full Access)' };
    }
    if (member?.permissions?.has?.(PermissionFlagsBits.Administrator)) {
      return { level: 'ADMIN', canView: true, canEdit: true, label: 'Administrator (Full Access)' };
    }
    if (member?.permissions?.has?.(PermissionFlagsBits.ManageGuild)) {
      return { level: 'MANAGE_GUILD', canView: true, canEdit: true, label: 'Manage Server (Config Access)' };
    }

    // Check operator roles from persistent config
    const conf = GuildConfigService.getConfig(guild.id);
    const opRoles = conf?.authorizationPolicy?.operatorRoles || {};
    const memberRoleIds = member?.roles?.cache ? Array.from(member.roles.cache.keys()) : [];
    const isOperator = memberRoleIds.some(rId => Boolean(opRoles[rId]));

    if (isOperator) {
      const adminOnly = conf?.authorizationPolicy?.adminOnlyPolicyChanges ?? true;
      return {
        level: 'OPERATOR',
        canView: true,
        canEdit: !adminOnly,
        label: adminOnly ? 'Operator (View Only - Admin Policy Enforced)' : 'Authorized Operator'
      };
    }

    return { level: 'MEMBER', canView: true, canEdit: false, label: 'Server Member (View Only)' };
  }

  /**
   * Main entry point to build dashboard payload for a specific page.
   */
  static async buildDashboardPayload(guild, member, user, page = 'overview', options = {}) {
    const access = this.getAccessLevel(guild, member, user);
    const pageId = DASHBOARD_PAGES.some(p => p.id === page) ? page : 'overview';

    let embed;
    let extraRows = [];

    switch (pageId) {
      case 'security':
        ({ embed, extraRows } = await this._renderSecurityPage(guild, access));
        break;
      case 'cases':
        ({ embed, extraRows } = await this._renderCasesPage(guild, access));
        break;
      case 'onboarding':
        ({ embed, extraRows } = await this._renderOnboardingPage(guild, access));
        break;
      case 'tickets':
        ({ embed, extraRows } = await this._renderTicketsPage(guild, access));
        break;
      case 'workflows':
        ({ embed, extraRows } = await this._renderWorkflowsPage(guild, access));
        break;
      case 'community':
        ({ embed, extraRows } = await this._renderCommunityPage(guild, access));
        break;
      case 'scheduler':
        ({ embed, extraRows } = await this._renderSchedulerPage(guild, access));
        break;
      case 'analytics':
        ({ embed, extraRows } = await this._renderAnalyticsPage(guild, access));
        break;
      case 'moderation':
        ({ embed, extraRows } = await this._renderModerationPage(guild, access));
        break;
      case 'roles':
        ({ embed, extraRows } = await this._renderRolesPage(guild, access));
        break;
      case 'channels':
        ({ embed, extraRows } = await this._renderChannelsPage(guild, access));
        break;
      case 'modlog':
        ({ embed, extraRows } = await this._renderModlogPage(guild, access));
        break;
      case 'honeypot':
        ({ embed, extraRows } = await this._renderHoneypotPage(guild, access));
        break;
      case 'music':
        ({ embed, extraRows } = await this._renderMusicPage(guild, access));
        break;
      case 'queue':
        ({ embed, extraRows } = await this._renderQueuePage(guild, access));
        break;
      case 'diagnostics':
        ({ embed, extraRows } = await this._renderDiagnosticsPage(guild, access));
        break;
      case 'learning':
        ({ embed, extraRows } = await this._renderLearningPage(guild, access));
        break;
      case 'settings':
        ({ embed, extraRows } = await this._renderSettingsPage(guild, access, options.catalogCategory));
        break;
      case 'catalog':
        ({ embed, extraRows } = await this._renderCatalogPage(guild, access, options.pageIndex || 0));
        break;
      case 'overview':
      default:
        ({ embed, extraRows } = await this._renderOverviewPage(guild, access));
        break;
    }

    // Build standard navigation row (Row 1: Navigation Select Menu)
    const navSelect = new StringSelectMenuBuilder()
      .setCustomId(`dash:nav:${pageId}`)
      .setPlaceholder(`Navigation: ${DASHBOARD_PAGES.find(p => p.id === pageId)?.label || 'Overview'}`)
      .addOptions(
        DASHBOARD_PAGES.map(p => ({
          label: p.label,
          value: p.id,
          description: p.description.slice(0, 100),
          default: p.id === pageId
        }))
      );

    const navRow = new ActionRowBuilder().addComponents(navSelect);

    // Build quick utility buttons row (Row 2)
    const quickButtons = [
      new ButtonBuilder()
        .setCustomId(`dash:page:overview`)
        .setLabel('Overview')
        .setStyle(pageId === 'overview' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`dash:page:modlog`)
        .setLabel('Modlogs')
        .setStyle(pageId === 'modlog' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`dash:page:diagnostics`)
        .setLabel('Diagnostics')
        .setStyle(pageId === 'diagnostics' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`dash:page:catalog`)
        .setLabel('Catalog')
        .setStyle(pageId === 'catalog' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`dash:action:refresh:${pageId}`)
        .setLabel('Refresh')
        .setStyle(ButtonStyle.Secondary)
    ];
    const buttonRow = new ActionRowBuilder().addComponents(quickButtons);

    // Combine rows (ensuring Discord's <= 5 ActionRows limit)
    const components = [navRow, buttonRow, ...extraRows].slice(0, 5);

    return {
      embeds: [embed],
      components
    };
  }

  // =========================================================================
  // PAGE RENDERERS
  // =========================================================================

  /**
   * 1. Overview Page
   */
  static async _renderOverviewPage(guild, access) {
    const config = GuildConfigService.getConfig(guild.id);
    const modlogConf = ModLogService.getConfig(guild.id);
    const honeypotConf = HoneypotService.getConfig(guild.id);
    const activeTasks = TaskQueue.getGuildActiveTasks(guild.id);
    const musicSub = MusicService.getSubscription(guild.id);
    const client = guild.client;

    const botMember = guild.members?.me || (guild.members?.fetchMe ? await guild.members.fetchMe().catch(() => null) : null);
    const ping = client?.ws?.ping !== undefined && client.ws.ping >= 0 ? `${client.ws.ping}ms` : 'Active';
    const uptime = Math.floor(process.uptime());
    const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`;

    // Configuration Completeness calculation
    let completePoints = 0;
    const totalPoints = 4;
    if (modlogConf.channelId && modlogConf.enabled) completePoints++;
    if (Object.keys(config.authorizationPolicy?.operatorRoles || {}).length > 0) completePoints++;
    if (config.featureSettings?.moderationEnabled) completePoints++;
    if (config.featureSettings?.musicEnabled) completePoints++;
    const completenessPercent = Math.round((completePoints / totalPoints) * 100);

    // Grounded warnings identification
    const warnings = [];
    if (!modlogConf.channelId) {
      warnings.push('⚠️ **Modlogs Unconfigured:** No destination channel set for audit records.');
    } else if (!modlogConf.enabled) {
      warnings.push('⚠️ **Modlogs Disabled:** Log channel exists, but live event logging is disabled.');
    }
    if (botMember && !botMember.permissions?.has(PermissionFlagsBits.ManageChannels)) {
      warnings.push('⚠️ **Missing Bot Permission:** Bot lacks `Manage Channels` for lock/slowmode.');
    }
    if (botMember && !botMember.permissions?.has(PermissionFlagsBits.ModerateMembers)) {
      warnings.push('⚠️ **Missing Bot Permission:** Bot lacks `Moderate Members` for timeouts.');
    }

    const embed = new EmbedBuilder()
      .setTitle(`Server Dashboard — ${guild.name}`)
      .setDescription(
        `Centralized operations center and guild-isolated configuration repository for **Honey Bot**.\n\n` +
        `**Guild ID:** \`${guild.id}\` • **Your Access:** ${access.label}\n` +
        `**Bot Gateway:** Connected (${ping}) • **Uptime:** ${uptimeStr}`
      )
      .setColor(warnings.length > 0 ? DASH_COLORS.WARNING : DASH_COLORS.PRIMARY)
      .addFields(
        {
          name: 'Configuration Completeness',
          value: `**${completenessPercent}%** Complete (${completePoints}/${totalPoints} Core Systems Configured)\n` +
                 `• Modlogs: ${modlogConf.channelId ? `<#${modlogConf.channelId}> (${modlogConf.enabled ? 'Active' : 'Muted'})` : '*Unconfigured*'}\n` +
                 `• Operator Roles: ${Object.keys(config.authorizationPolicy?.operatorRoles || {}).length} configured\n` +
                 `• Moderation: ${config.featureSettings?.moderationEnabled ? 'Enabled' : 'Disabled'}\n` +
                 `• Voice & Music: ${config.featureSettings?.musicEnabled ? 'Enabled' : 'Disabled'}`,
          inline: false
        },
        {
          name: 'Subsystem Status',
          value: `• **Task Engine:** ${activeTasks.length} active tasks\n` +
                 `• **Voice Player:** ${musicSub?.currentTrack ? `Playing in <#${musicSub.voiceConnection?.joinConfig?.channelId}>` : 'Idle / Disconnected'}\n` +
                 `• **Honeypot Trap:** ${honeypotConf?.enabled ? (honeypotConf.strictMode ? 'Active (Strict Instant-Kick)' : 'Active (Monitored Mode)') : (honeypotConf?.channelId ? 'Disabled' : '*Unconfigured*')}\n` +
                 `• **Anti-Nuke Guard:** Active (Hardcoded Application Safety)`,
          inline: false
        }
      )
      .setFooter({ text: 'Use the select menu or buttons below to configure server settings' })
      .setTimestamp();

    if (warnings.length > 0) {
      embed.addFields({
        name: 'Grounded Warnings & Attention Items',
        value: warnings.join('\n'),
        inline: false
      });
    }

    // Extra action buttons for overview (Row 3)
    const extraButtons = [
      new ButtonBuilder()
        .setCustomId('dash:page:moderation')
        .setLabel('Configure Moderation')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('dash:page:roles')
        .setLabel('Manage Roles')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('setup:recheck')
        .setLabel('Bot Permissions & Setup')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🛡️')
    ];
    const extraRows = [new ActionRowBuilder().addComponents(extraButtons)];

    return { embed, extraRows };
  }

  /**
   * 1b. Security & Anti-Raid Page
   */
  static async _renderSecurityPage(guild, access) {
    const policy = SecurityEngine.getPolicy(guild.id);
    const isLocked = SecurityEngine.isLockdownActive(guild.id);
    const isSafe = SecurityEngine.isSafeModeActive(guild.id);
    const native = await SecurityEngine.inspectNativeSafety(guild);

    const embed = new EmbedBuilder()
      .setTitle(`🛡️ Security & Anti-Raid Hub — ${guild.name}`)
      .setDescription(
        `Automated perimeter protection, burst suppression, and emergency defense.\n` +
        `• **Lockdown Status:** ${isLocked ? '🚨 **ACTIVE (Public Text Muted)**' : '🟢 Inactive (Normal)'}\n` +
        `• **Safe Mode:** ${isSafe ? '🟡 Active (Automation Suspended)' : '🟢 Normal Execution'}`
      )
      .setColor(isLocked ? DASH_COLORS.DANGER : DASH_COLORS.PRIMARY)
      .addFields(
        {
          name: 'Intelligent Anti-Spam',
          value: `• **Status:** ${policy.antiSpam.enabled ? 'Enabled' : 'Disabled'}\n` +
                 `• **Burst Limit:** \`${policy.antiSpam.maxMessagesPerWindow} msgs / ${policy.antiSpam.windowSeconds}s\`\n` +
                 `• **Duplicate Limit:** \`${policy.antiSpam.maxDuplicates} msgs / ${policy.antiSpam.duplicateWindowSeconds}s\`\n` +
                 `• **Action:** \`${policy.antiSpam.action} (${policy.antiSpam.timeoutMinutes}m)\`\n` +
                 `• **Block Invites:** ${policy.antiSpam.blockDiscordInvites ? 'Yes' : 'No'}`,
          inline: true
        },
        {
          name: 'Anti-Raid Defense',
          value: `• **Status:** ${policy.antiRaid.enabled ? 'Enabled' : 'Disabled'}\n` +
                 `• **Join Threshold:** \`${policy.antiRaid.maxJoinsPerWindow} joins / ${policy.antiRaid.joinWindowSeconds}s\`\n` +
                 `• **Auto-Lockdown:** ${policy.antiRaid.autoLockdown ? 'Enabled' : 'Disabled'}\n` +
                 `• **Immutable Anti-Nuke:** Active`,
          inline: true
        },
        {
          name: 'Discord Native Safety Insights',
          value: `• **Verification Level:** \`${native?.verificationLevel || 'Unknown'}\`\n` +
                 `• **Moderator 2FA:** \`${native?.mfaLevel || 'NONE'}\`\n` +
                 `• **Native AutoMod Rules:** \`${native?.nativeAutoModRulesCount || 0} active\``,
          inline: false
        }
      )
      .setFooter({ text: 'Changes require Administrator permissions' });

    const extraButtons = [
      new ButtonBuilder()
        .setCustomId(`dash:action:${isLocked ? 'lift_lockdown' : 'enable_lockdown'}`)
        .setLabel(isLocked ? 'Lift Lockdown' : 'Emergency Lockdown')
        .setStyle(isLocked ? ButtonStyle.Success : ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`dash:action:${isSafe ? 'disable_safemode' : 'enable_safemode'}`)
        .setLabel(isSafe ? 'Disable Safe Mode' : 'Enable Safe Mode')
        .setStyle(ButtonStyle.Secondary)
    ];

    return { embed, extraRows: [new ActionRowBuilder().addComponents(extraButtons)] };
  }

  /**
   * 1c. Moderation Cases Page
   */
  static async _renderCasesPage(guild, access) {
    const cases = CaseManager.listCases(guild.id);
    const rules = CaseManager.getEscalationRules(guild.id);
    const recent = cases.slice(0, 5);

    const caseLines = recent.length > 0
      ? recent.map(c => `• **[${c.caseId}]** \`${c.action.toUpperCase()}\` on <@${c.target.id}> by <@${c.moderator.id}>: *${c.reason.slice(0, 50)}*`).join('\n')
      : '*No moderation cases recorded in this guild.*';

    const embed = new EmbedBuilder()
      .setTitle(`⚖️ Moderation Cases & Escalation — ${guild.name}`)
      .setDescription(
        `Unified moderation infractions, temporary punishments, and auto-escalation.\n` +
        `**Total Cases Recorded:** \`${cases.length}\``
      )
      .setColor(DASH_COLORS.PRIMARY)
      .addFields(
        {
          name: 'Recent Moderation Cases',
          value: caseLines,
          inline: false
        },
        {
          name: 'Automated Infraction Escalation',
          value: `• **Status:** ${rules.enabled ? 'Active' : 'Disabled'}\n` +
                 `• **Rolling Window:** \`${rules.windowHours || 24} hours\`\n` +
                 rules.thresholds.map(t => `• **${t.count} infractions:** ${t.action} ${t.durationMinutes ? `(${t.durationMinutes}m)` : ''}`).join('\n'),
          inline: false
        }
      )
      .setFooter({ text: 'Cases are persisted across restarts in data/moderation-cases.json' });

    return { embed, extraRows: [] };
  }

  /**
   * 1d. Member Onboarding Page
   */
  static async _renderOnboardingPage(guild, access) {
    const conf = MemberOnboardingManager.getConfig(guild.id);

    const embed = new EmbedBuilder()
      .setTitle(`👋 Member Onboarding & Auto-Roles — ${guild.name}`)
      .setDescription('Configure welcome greetings, departure logs, auto-roles, and verification.')
      .setColor(DASH_COLORS.PRIMARY)
      .addFields(
        {
          name: 'Welcome Greeting',
          value: `• **Status:** ${conf.welcome.enabled ? 'Enabled' : 'Disabled'}\n` +
                 `• **Channel:** ${conf.welcome.channelId ? `<#${conf.welcome.channelId}>` : '*Not set*'}\n` +
                 `• **Format:** ${conf.welcome.sendEmbed ? 'Rich Honey Embed' : 'Plain Text'}`,
          inline: true
        },
        {
          name: 'Auto-Role Assignment',
          value: `• **Status:** ${conf.autoRoles.enabled ? 'Enabled' : 'Disabled'}\n` +
                 `• **Member Roles:** ${conf.autoRoles.memberRoleIds?.length ? conf.autoRoles.memberRoleIds.map(id => `<@&${id}>`).join(', ') : '*None*'}\n` +
                 `• **Bot Roles:** ${conf.autoRoles.botRoleIds?.length ? conf.autoRoles.botRoleIds.map(id => `<@&${id}>`).join(', ') : '*None*'}`,
          inline: true
        },
        {
          name: 'Rules Verification Workflow',
          value: `• **Status:** ${conf.verification.enabled ? 'Enabled' : 'Disabled'}\n` +
                 `• **Channel:** ${conf.verification.channelId ? `<#${conf.verification.channelId}>` : '*Not set*'}\n` +
                 `• **Role Granted:** ${conf.verification.verifiedRoleId ? `<@&${conf.verification.verifiedRoleId}>` : '*None*'}`,
          inline: false
        }
      )
      .setFooter({ text: 'Use /go "setup verification" or "configure welcome in #ch" to modify' });

    return { embed, extraRows: [] };
  }

  /**
   * 1e. Tickets & Applications Page
   */
  static async _renderTicketsPage(guild, access) {
    const apps = ApplicationManager.listApplications(guild.id);
    const pendingApps = apps.filter(a => a.status === 'pending');

    const embed = new EmbedBuilder()
      .setTitle(`🎫 Support Tickets & Applications — ${guild.name}`)
      .setDescription('Manage user support tickets, transcripts, staff applications, and member reports.')
      .setColor(DASH_COLORS.PRIMARY)
      .addFields(
        {
          name: 'Ticket Subsystem',
          value: '• **Category:** Support Tickets\n• **Modal Form Intake:** Active\n• **Transcripts:** Stored & Exported\n• **Setup:** Use `/go "setup ticket system"`',
          inline: true
        },
        {
          name: 'Application Queue',
          value: `• **Pending Applications:** \`${pendingApps.length}\`\n• **Total Handled:** \`${apps.length}\`\n• **Review Channel:** Configurable via /go`,
          inline: true
        }
      )
      .setFooter({ text: 'Enterprise support infrastructure • Zero-cost' });

    return { embed, extraRows: [] };
  }

  /**
   * 1f. Automation Workflows Page
   */
  static async _renderWorkflowsPage(guild, access) {
    const workflows = WorkflowEngine.listWorkflows(guild.id);
    const active = workflows.filter(w => w.enabled);

    const wfLines = workflows.length > 0
      ? workflows.map(w => `• **${w.name}** [${w.id}] — Trigger: \`${w.trigger}\` (${w.enabled ? '🟢 Active' : '⚪ Disabled'}) • Runs: ${w.runCount || 0}`).join('\n')
      : '*No automated workflows registered. Use `/go "create workflow ..."` to create.*';

    const embed = new EmbedBuilder()
      .setTitle(`⚡ Automation Workflow Engine — ${guild.name}`)
      .setDescription(
        `Event-driven orchestration: **Trigger → Conditions → Actions → Verification**\n` +
        `**Registered Workflows:** \`${workflows.length}\` (${active.length} active)`
      )
      .setColor(DASH_COLORS.PRIMARY)
      .addFields({ name: 'Workflows', value: wfLines })
      .setFooter({ text: 'Deterministic, validated, bounded execution' });

    return { embed, extraRows: [] };
  }

  /**
   * 1g. Community Utilities Page
   */
  static async _renderCommunityPage(guild, access) {
    const starboard = CommunityUtils.getStarboardConfig(guild.id);
    const faqs = CommunityUtils.getAutoResponses(guild.id);

    const embed = new EmbedBuilder()
      .setTitle(`💡 Community Utilities — ${guild.name}`)
      .setDescription('Server polls, suggestion boards, starboard, and auto-responders.')
      .setColor(DASH_COLORS.PRIMARY)
      .addFields(
        {
          name: 'Starboard',
          value: `• **Status:** ${starboard.enabled ? 'Enabled' : 'Disabled'}\n` +
                 `• **Channel:** ${starboard.channelId ? `<#${starboard.channelId}>` : '*Not set*'}\n` +
                 `• **Threshold:** ⭐ >= ${starboard.threshold}`,
          inline: true
        },
        {
          name: 'Auto-Responses & FAQs',
          value: `• **Triggers Configured:** \`${faqs.length}\`\n` +
                 faqs.slice(0, 3).map(f => `  - "${f.trigger}"`).join('\n') || '*None configured*',
          inline: true
        },
        {
          name: 'Suggestions & Polls',
          value: '• **Interactive Polls:** Multi-option button voting with live % bars\n• **Suggestions:** Community voting with Approve/Deny buttons',
          inline: false
        }
      );

    return { embed, extraRows: [] };
  }

  /**
   * 1h. Events & Scheduling Page
   */
  static async _renderSchedulerPage(guild, access) {
    const tasks = TaskScheduler.listTasks(guild.id, 'pending');

    const taskLines = tasks.length > 0
      ? tasks.slice(0, 5).map(t => `• **[${t.id}]** \`${t.type}\` in <#${t.channelId}> at <t:${Math.floor(new Date(t.targetTime).getTime() / 1000)}:R>`).join('\n')
      : '*No pending scheduled announcements or reminders.*';

    const embed = new EmbedBuilder()
      .setTitle(`📅 Events, Scheduling & Reminders — ${guild.name}`)
      .setDescription('Persistent scheduler, automated announcements, and community event RSVPs.')
      .setColor(DASH_COLORS.PRIMARY)
      .addFields(
        { name: 'Pending Scheduled Tasks', value: taskLines },
        {
          name: 'Capabilities',
          value: '• `/go "schedule reminder ..."`\n• `/go "schedule announcement ..."`\n• `/go "create event ..."` with RSVP buttons',
          inline: false
        }
      );

    return { embed, extraRows: [] };
  }

  /**
   * 1i. Server Analytics Page
   */
  static async _renderAnalyticsPage(guild, access) {
    const metrics = AnalyticsService.getOverviewMetrics(guild.id);

    const embed = new EmbedBuilder()
      .setTitle(`📈 Privacy-Safe Server Analytics — ${guild.name}`)
      .setDescription('Aggregated growth, message distribution, and operational metrics (30-day retention).')
      .setColor(DASH_COLORS.PRIMARY)
      .addFields(
        {
          name: 'Today at a Glance',
          value: `• **Joins:** \`${metrics.today.joins}\`\n• **Leaves:** \`${metrics.today.leaves}\`\n• **Messages:** \`${metrics.today.messages}\`\n• **Spam Blocks:** \`${metrics.today.spamBlocks}\``,
          inline: true
        },
        {
          name: 'Past 7 Days Growth',
          value: `• **Total Joins:** \`${metrics.past7Days.joins}\`\n• **Total Leaves:** \`${metrics.past7Days.leaves}\`\n• **Net Growth:** \`${metrics.past7Days.netGrowth >= 0 ? '+' : ''}${metrics.past7Days.netGrowth}\`\n• **Messages:** \`${metrics.past7Days.messages}\``,
          inline: true
        },
        {
          name: 'Subsystem Activity',
          value: `• **Moderation Cases Recorded:** \`${metrics.totalCasesRecorded}\`\n• **Active Workflows:** \`${metrics.activeWorkflows}\`\n• **Music Sessions:** \`${metrics.musicSessionsCount}\``,
          inline: false
        }
      );

    return { embed, extraRows: [] };
  }

  /**
   * 2. Moderation Page
   */
  static async _renderModerationPage(guild, access) {
    const config = GuildConfigService.getConfig(guild.id);
    const modSettings = config.moderationSettings || {};
    const approval = config.approvalSettings || {};
    const kickReq = approval.requireConfirmationFor?.includes('kick_member') ?? true;
    const banReq = approval.requireConfirmationFor?.includes('ban_member') ?? true;

    const embed = new EmbedBuilder()
      .setTitle(`Moderation Settings — ${guild.name}`)
      .setDescription(
        `Authoritative moderation policy applied to all timeout, warning, kick, and ban requests.\n` +
        `Settings are verified and persisted strictly within this guild.`
      )
      .setColor(DASH_COLORS.PRIMARY)
      .addFields(
        {
          name: 'Timeout Configuration',
          value: `• **Default Duration:** \`${modSettings.defaultTimeoutMinutes || 10} minutes\`\n` +
                 `• **Supported Range:** 1 to 40,320 minutes (Discord 28-day API ceiling)\n` +
                 `• **Status:** ${config.featureSettings?.moderationEnabled ? 'Active' : 'Disabled by feature toggle'}`,
          inline: true
        },
        {
          name: 'Warning & Escalation',
          value: `• **Warning Threshold:** \`${modSettings.warningThreshold || 3} warnings\`\n` +
                 `• **Notice Trigger:** Surfaces on member lookup and moderation audits\n` +
                 `• **Automated Ban:** Disabled (requires human review)`,
          inline: true
        },
        {
          name: 'Confirmation Safeguards',
          value: `• **Kick Member Confirmation:** ${kickReq ? 'Required' : 'Direct execution'}\n` +
                 `• **Ban Member Confirmation:** ${banReq ? 'Required' : 'Direct execution'}\n` +
                 `• **Anti-Nuke Protection:** Immutable (cannot be disabled)`,
          inline: false
        }
      )
      .setFooter({ text: 'Changes require Administrator or Manage Server permissions.' });

    const extraRows = [];
    if (access.canEdit) {
      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('dash:modal:moderation')
          .setLabel('Edit Timeout / Threshold')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`dash:toggle:kick_confirm:${kickReq ? 'off' : 'on'}`)
          .setLabel(`Kick Confirm: ${kickReq ? 'ON' : 'OFF'}`)
          .setStyle(kickReq ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`dash:toggle:ban_confirm:${banReq ? 'off' : 'on'}`)
          .setLabel(`Ban Confirm: ${banReq ? 'ON' : 'OFF'}`)
          .setStyle(banReq ? ButtonStyle.Success : ButtonStyle.Secondary)
      );
      extraRows.push(row1);
    }

    return { embed, extraRows };
  }

  /**
   * 3. Roles & Permissions Page
   */
  static async _renderRolesPage(guild, access) {
    const config = GuildConfigService.getConfig(guild.id);
    const policy = config.authorizationPolicy || {};
    const opRoles = Object.values(policy.operatorRoles || {});
    const adminOnly = policy.adminOnlyPolicyChanges ?? true;
    const defaultDeny = policy.defaultDeny ?? true;

    const roleBullets = opRoles.length > 0
      ? opRoles.map(r => `• <@&${r.roleId}> (\`${r.roleName || r.roleId}\`): ${r.capabilities?.length ? r.capabilities.join(', ') : 'All Granted'}`).join('\n')
      : '*No operator roles configured. Only Discord Administrators can invoke mutations.*';

    const embed = new EmbedBuilder()
      .setTitle(`Roles & Bot Authorization — ${guild.name}`)
      .setDescription(
        `Governs which server roles are authorized to invoke Honey Bot administrative actions.\n` +
        `Discord native permission hierarchy and immutable anti-nuke rules always apply.`
      )
      .setColor(DASH_COLORS.PRIMARY)
      .addFields(
        {
          name: 'Configured Operator Roles',
          value: roleBullets.slice(0, 1024),
          inline: false
        },
        {
          name: 'Access Control Rules',
          value: `• **Admin-Only Policy Changes:** ${adminOnly ? 'Enabled (Only Admins can change rules)' : 'Relaxed'}\n` +
                 `• **Default Deny Policy:** ${defaultDeny ? 'Active (Deny actions unless assigned)' : 'Open'}\n` +
                 `• **Role Hierarchy Guard:** Enforced (Bot cannot assign roles higher than its own top role)`,
          inline: false
        }
      )
      .setFooter({ text: 'Select a role or toggle policy controls below.' });

    const extraRows = [];
    if (access.canEdit) {
      const toggleRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`dash:toggle:admin_only:${adminOnly ? 'off' : 'on'}`)
          .setLabel(`Admin Only: ${adminOnly ? 'ON' : 'OFF'}`)
          .setStyle(adminOnly ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`dash:toggle:default_deny:${defaultDeny ? 'off' : 'on'}`)
          .setLabel(`Default Deny: ${defaultDeny ? 'ON' : 'OFF'}`)
          .setStyle(defaultDeny ? ButtonStyle.Success : ButtonStyle.Secondary)
      );
      extraRows.push(toggleRow);
    }

    return { embed, extraRows };
  }

  /**
   * 4. Channels & Categories Page
   */
  static async _renderChannelsPage(guild, access) {
    const modlogConf = ModLogService.getConfig(guild.id);
    const honeypotConf = HoneypotService.getConfig(guild.id);
    const channels = guild.channels?.cache ? Array.from(guild.channels.cache.values()) : [];
    const textChannels = channels.filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement);
    const voiceChannels = channels.filter(c => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice);
    const categories = channels.filter(c => c.type === ChannelType.GuildCategory);

    const embed = new EmbedBuilder()
      .setTitle(`Channels & Categories — ${guild.name}`)
      .setDescription(
        `Inspect and manage designated channels and category permissions.\n` +
        `Before applying category-level changes, permissions are verified across child channels.`
      )
      .setColor(DASH_COLORS.PRIMARY)
      .addFields(
        {
          name: 'Server Channel Inventory',
          value: `• **Text & Announcement Channels:** ${textChannels.length}\n` +
                 `• **Voice & Stage Channels:** ${voiceChannels.length}\n` +
                 `• **Categories:** ${categories.length}`,
          inline: true
        },
        {
          name: 'Designated Special Channels',
          value: `• **Moderation Logs:** ${modlogConf.channelId ? `<#${modlogConf.channelId}>` : '*None set*'}\n` +
                 `• **Honeypot Decoy Channel:** ${honeypotConf?.channelId ? `<#${honeypotConf.channelId}>` : '*None set (Use `/honeypot setup`)*'}\n` +
                 `• **Ticket Transcripts:** Automatic in-ticket delivery`,
          inline: true
        }
      )
      .setFooter({ text: 'Use /go to rename, lock, slowmode, or reorder channels.' });

    return { embed, extraRows: [] };
  }

  /**
   * 5. Modlogs Page
   */
  static async _renderModlogPage(guild, access) {
    const conf = ModLogService.getConfig(guild.id);
    const activeText = conf.enabled ? 'ACTIVE & DELIVERING' : 'MUTED / DISABLED';
    const channelText = conf.channelId ? `<#${conf.channelId}> (\`${conf.channelName || conf.channelId}\`)` : '*No channel configured*';
    const prefs = conf.preferences || {};
    const filters = Array.isArray(prefs.filterEvents) ? prefs.filterEvents.join(', ') : 'All events';

    const lastSuccess = conf.lastDeliverySuccess ? new Date(conf.lastDeliverySuccess).toLocaleTimeString() : 'None recorded';
    const lastFailure = conf.lastDeliveryFailure ? `${new Date(conf.lastDeliveryFailure.timestamp).toLocaleTimeString()}: ${conf.lastDeliveryFailure.error}` : 'None recorded';

    const embed = new EmbedBuilder()
      .setTitle(`Moderation & Audit Logging — ${guild.name}`)
      .setDescription(
        `Automated moderation log dispatches for all \`/go\` actions, \`/undo\` recoveries, and external gateway events.\n` +
        `Stored persistently in \`modlog-config.json\` strictly scoped to guild \`${guild.id}\`.`
      )
      .setColor(conf.enabled && conf.channelId ? DASH_COLORS.SUCCESS : DASH_COLORS.WARNING)
      .addFields(
        {
          name: 'Current Logging Status',
          value: `• **Status:** **${activeText}**\n` +
                 `• **Destination:** ${channelText}\n` +
                 `• **Active Event Filters:** \`${filters}\`\n` +
                 `• **Log Bot Actions:** ${prefs.logBotActions !== false ? 'Yes' : 'No'} • **Log External:** ${prefs.logExternalActions !== false ? 'Yes' : 'No'}`,
          inline: false
        },
        {
          name: 'Delivery Health & Auditing',
          value: `• **Successful Deliveries:** ${conf.deliveredCount || 0} (Last: ${lastSuccess})\n` +
                 `• **Failed Deliveries:** ${conf.failedCount || 0} (Last: ${lastFailure})\n` +
                 `• **Pending Retries:** ${Array.isArray(conf.pendingDeliveries) ? conf.pendingDeliveries.length : 0}`,
          inline: false
        }
      )
      .setFooter({ text: 'Test deliveries verify View, Send, and Embed permissions in the channel.' });

    const extraRows = [];
    if (access.canEdit) {
      // Channel Select Menu for Destination (Row 3)
      const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('dash:modlog:set_channel')
        .setPlaceholder('Select Modlog Destination Channel')
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

      extraRows.push(new ActionRowBuilder().addComponents(channelSelect));

      // Action Buttons (Row 4)
      const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`dash:modlog:toggle:${conf.enabled ? 'disable' : 'enable'}`)
          .setLabel(conf.enabled ? 'Mute Logging' : 'Enable Logging')
          .setStyle(conf.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('dash:modlog:test')
          .setLabel('Send Test Log')
          .setStyle(ButtonStyle.Primary)
      );
      extraRows.push(actionRow);
    }

    return { embed, extraRows };
  }

  /**
   * 6. Honeypot Page (Accurately Disclosed)
   */
  static async _renderHoneypotPage(guild, access) {
    const honeypotConf = HoneypotService.getConfig(guild.id);
    const isLive = honeypotConf?.enabled && honeypotConf?.channelId;

    const embed = new EmbedBuilder()
      .setTitle(`Honeypot Security & Intrusion Trap — ${guild.name}`)
      .setDescription(
        (isLive
          ? `🛡️ **Honeypot Engine Active in <#${honeypotConf.channelId}>**\n\n` +
            `Use the dedicated \`/honeypot\` slash command (\`/honeypot status\`, \`/honeypot setup\`) for interactive management.\n\n`
          : `🛡️ **System Notice: Subsystem Currently Unimplemented in Dashboard UI**\n\n` +
            `Interactive in-dashboard toggle controls are not yet integrated into this panel. Use the dedicated \`/honeypot\` slash command for configuration.\n\n`
        ) +
        `**Key Safety Principles:**\n` +
        `• An unexpected interaction in a honeypot channel is an **investigation trigger**, never conclusive proof of account compromise.\n` +
        `• Honey Bot never authorizes punitive actions (bans or kicks) solely upon an LLM detection classification.\n` +
        `• All automated anti-nuke and rate-limit guardrails operate independently in application code.\n\n` +
        `No inactive or non-functional controls are presented.`
      )
      .setColor(isLive ? DASH_COLORS.SUCCESS : DASH_COLORS.MUTED)
      .addFields(
        {
          name: 'Subsystem Status',
          value: isLive
            ? `• Status: \`${honeypotConf.strictMode ? 'STRICT_ACTIVE' : 'MONITORED_ACTIVE'}\`\n• Monitoring Channel: <#${honeypotConf.channelId}>\n• Mode: \`${honeypotConf.strictMode ? 'Strict Kick' : 'Monitored'}\``
            : '• Status: `UNAVAILABLE (Use /honeypot)`\n• Monitoring Channel: `None`\n• Active Decoys: `0`',
          inline: true
        },
        {
          name: 'Alternative Protections',
          value: '• Anti-Nuke: `Active (Hardcoded)`\n• Permission Hierarchy: `Enforced`\n• Modlog Auditing: `Available`',
          inline: true
        }
      )
      .setFooter({ text: 'Configure and test via /honeypot command.' });

    return { embed, extraRows: [] };
  }

  /**
   * 7. Music & Voice Page
   */
  static async _renderMusicPage(guild, access) {
    const sub = MusicService.getSubscription(guild.id);
    const botMember = guild.members?.me;
    const voiceChannelId = botMember?.voice?.channelId;

    const isConnected = Boolean(voiceChannelId);
    const currentTrack = sub?.currentTrack;
    const isPaused = sub?.isPaused ?? false;
    const queueLength = sub?.queue?.length ?? 0;

    const embed = new EmbedBuilder()
      .setTitle(`Music & Voice Subsystem — ${guild.name}`)
      .setDescription(
        `Direct operational control over Honey Bot's zero-cost voice and audio streaming engine.\n` +
        `Voice interactions are strictly deterministic and require no Groq LLM calls.`
      )
      .setColor(isConnected ? DASH_COLORS.SUCCESS : DASH_COLORS.PRIMARY)
      .addFields(
        {
          name: 'Connection State',
          value: isConnected
            ? `• **Connected Channel:** <#${voiceChannelId}>\n• **Player State:** ${isPaused ? 'Paused ⏸️' : 'Playing ▶️'}\n• **Volume:** ${Math.round((sub?.volume ?? 1.0) * 100)}%\n• **Loop Mode:** \`${sub?.loopMode || 'off'}\``
            : '• **Status:** Disconnected / Idle',
          inline: true
        },
        {
          name: 'Playback Queue',
          value: currentTrack
            ? `• **Now Playing:** [${currentTrack.title}](${currentTrack.url || 'https://youtube.com'})\n• **Duration:** \`${currentTrack.duration || 'Live'}\`\n• **Upcoming in Queue:** ${queueLength} track(s)`
            : '• **Queue:** Empty',
          inline: true
        }
      )
      .setFooter({ text: 'Use buttons below for immediate playback adjustments.' });

    const extraRows = [];
    if (access.canEdit && isConnected) {
      const controlsRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`dash:music:${isPaused ? 'resume' : 'pause'}`)
          .setLabel(isPaused ? 'Resume ▶️' : 'Pause ⏸️')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('dash:music:skip')
          .setLabel('Skip ⏭️')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('dash:music:stop')
          .setLabel('Stop ⏹️')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('dash:music:leave')
          .setLabel('Disconnect 🚪')
          .setStyle(ButtonStyle.Danger)
      );

      const loopLabel = sub?.loopMode === 'track' ? '🔁 Track' : (sub?.loopMode === 'queue' ? '🔁 Queue' : '➡️ Off');
      const queueRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('dash:music:loop')
          .setLabel(`Loop: ${loopLabel}`)
          .setStyle(sub?.loopMode !== 'off' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('dash:music:shuffle')
          .setLabel('Shuffle 🔀')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(queueLength <= 1),
        new ButtonBuilder()
          .setCustomId('dash:music:clear')
          .setLabel('Clear Queue 🗑️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(queueLength === 0)
      );

      extraRows.push(controlsRow, queueRow);
    }

    return { embed, extraRows };
  }

  /**
   * 8. Task Queue Page
   */
  static async _renderQueuePage(guild, access) {
    TaskQueue.loadAllTasks();
    const allTasks = Array.from(TaskQueue._tasks.values()).filter(t => t.guildId === guild.id);
    const activeTasks = TaskQueue.getGuildActiveTasks(guild.id);
    const recentTasks = allTasks.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 5);

    const taskBullets = recentTasks.length > 0
      ? recentTasks.map(t => {
          const statusBadge = t.status === TaskQueueState.COMPLETED ? '✅' : (t.status === TaskQueueState.FAILED ? '❌' : '⏳');
          const prompt = t.userPrompt ? t.userPrompt.slice(0, 45) : 'Instruction';
          return `${statusBadge} \`${t.taskId}\` — **${t.status}**: "${prompt}..." (${t.actions?.length || 1} actions)`;
        }).join('\n')
      : '*No tasks recorded for this server.*';

    const embed = new EmbedBuilder()
      .setTitle(`Task Queue & Automation Engine — ${guild.name}`)
      .setDescription(
        `Persistent, crash-resilient queue handling sequential Discord mutations.\n` +
        `Tasks survive process restarts and automatically reconcile uncertain actions.`
      )
      .setColor(activeTasks.length > 0 ? DASH_COLORS.WARNING : DASH_COLORS.PRIMARY)
      .addFields(
        {
          name: 'Queue Health Summary',
          value: `• **Active Running/Queued:** ${activeTasks.length}\n` +
                 `• **Total Recorded (Guild):** ${allTasks.length}\n` +
                 `• **Concurrency Guard:** Guild Lock Active`,
          inline: true
        },
        {
          name: 'Recent Task History',
          value: taskBullets.slice(0, 1024),
          inline: false
        }
      )
      .setFooter({ text: 'Active tasks can be cancelled if they have not yet mutated Discord.' });

    const extraRows = [];
    if (access.canEdit && activeTasks.length > 0) {
      const cancelRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`dash:queue:cancel:${activeTasks[0].taskId}`)
          .setLabel(`Cancel Task ${activeTasks[0].taskId.slice(0, 15)}...`)
          .setStyle(ButtonStyle.Danger)
      );
      extraRows.push(cancelRow);
    }

    return { embed, extraRows };
  }

  /**
   * 9. Diagnostics & Recovery Page
   */
  static async _renderDiagnosticsPage(guild, access) {
    const client = guild.client;
    const history = ActionLedger.getHistory(guild.id);
    const ping = client?.ws?.ping !== undefined && client.ws.ping >= 0 ? `${client.ws.ping}ms` : 'Active';

    // Fast non-destructive health audit
    const botMember = guild.members?.me || (guild.members?.fetchMe ? await guild.members.fetchMe().catch(() => null) : null);
    const keyPerms = [
      { name: 'ManageRoles', ok: botMember?.permissions?.has(PermissionFlagsBits.ManageRoles) },
      { name: 'ManageChannels', ok: botMember?.permissions?.has(PermissionFlagsBits.ManageChannels) },
      { name: 'ModerateMembers', ok: botMember?.permissions?.has(PermissionFlagsBits.ModerateMembers) },
      { name: 'KickMembers', ok: botMember?.permissions?.has(PermissionFlagsBits.KickMembers) },
      { name: 'BanMembers', ok: botMember?.permissions?.has(PermissionFlagsBits.BanMembers) }
    ];

    const missingPerms = keyPerms.filter(p => !p.ok).map(p => p.name);
    const permStatus = missingPerms.length === 0 ? 'All Key Permissions Granted' : `Missing: ${missingPerms.join(', ')}`;

    const embed = new EmbedBuilder()
      .setTitle(`System Diagnostics & Recovery — ${guild.name}`)
      .setDescription(
        `Real-time operational diagnostic telemetry and reversible action ledger.\n` +
        `Uses the existing diagnostic and recovery engines with zero Groq LLM overhead.`
      )
      .setColor(missingPerms.length === 0 ? DASH_COLORS.SUCCESS : DASH_COLORS.WARNING)
      .addFields(
        {
          name: 'Discord Gateway & Bot State',
          value: `• **Gateway WebSocket Ping:** \`${ping}\`\n` +
                 `• **Permission Health:** ${permStatus}\n` +
                 `• **Uptime:** ${Math.floor(process.uptime() / 60)} minutes`,
          inline: false
        },
        {
          name: 'Recovery & Undo Ledger',
          value: `• **Recorded Actions:** ${history.length} action(s) recorded\n` +
                 `• **Reversible Actions Available:** ${history.filter(h => h.reversible).length}\n` +
                 `• **Recovery Command:** \`/undo [prompt]\``,
          inline: false
        }
      )
      .setFooter({ text: 'To perform deep repair or test inference connectivity, use /diagnose.' });

    return { embed, extraRows: [] };
  }

  /**
   * 10. All Settings Page (Authoritative Catalog)
   */
  static async _renderSettingsPage(guild, access, filterCategory = null) {
    const list = filterCategory
      ? SETTINGS_CATALOG.filter(s => s.category === filterCategory)
      : SETTINGS_CATALOG;

    const embed = new EmbedBuilder()
      .setTitle(`Server Settings Catalog — ${guild.name}`)
      .setDescription(
        `Authoritative capability catalog reflecting actual bot runtime behavior.\n` +
        `Every setting listed directly alters real server operations; no fake controls exist.`
      )
      .setColor(DASH_COLORS.PRIMARY)
      .setFooter({ text: 'Settings can be modified through their dedicated dashboard tabs.' });

    // Group by category for clean, readable embed fields (<= 1024 chars per field)
    const categories = ['features', 'moderation', 'policy', 'modlog', 'security', 'honeypot'];
    const catLabels = {
      features: 'Feature Flags',
      moderation: 'Moderation Policies',
      policy: 'Roles & Access Control',
      modlog: 'Audit Logging',
      security: 'Security Guardrails',
      honeypot: 'Intrusion Detection'
    };

    for (const cat of categories) {
      const items = list.filter(s => s.category === cat);
      if (items.length === 0) continue;
      const lines = items.map(s => {
        let val = 'Unknown';
        try { val = s.getValue(guild.id); } catch { val = 'Error'; }
        return `• **${s.name}** (\`${s.id}\`): \`${String(val)}\`\n  *${s.description}* [Auth: \`${s.requiredAuth}\`]`;
      }).join('\n');

      embed.addFields({
        name: catLabels[cat] || cat,
        value: lines.slice(0, 1024),
        inline: false
      });
    }

    return { embed, extraRows: [] };
  }

  /**
   * 11. Capability Catalog Page (Paging through real capabilities)
   */
  static async _renderCatalogPage(guild, access, pageIndex = 0) {
    const categories = CapabilityRegistry.getAllCategories();
    const totalPages = categories.length;
    const safeIndex = Math.max(0, Math.min(pageIndex, totalPages - 1));
    const currentCat = categories[safeIndex];

    const embed = new EmbedBuilder()
      .setTitle(`Capability Catalog — ${currentCat.name} (Page ${safeIndex + 1}/${totalPages})`)
      .setDescription(
        `${currentCat.description}\n\n` +
        `**Command Interface Notice:**\n` +
        `• Real Discord Slash Commands: \`/go\`, \`/modlog\`, \`/diagnose\`, \`/undo\`, \`/help\`\n` +
        `• Natural-language operations below are invoked via \`/go prompt: <instruction>\`.\n` +
        `• Internal action names (e.g. \`rename_channel\`) are internal IDs, not slash commands.`
      )
      .setColor(DASH_COLORS.PRIMARY)
      .setFooter({ text: `Page ${safeIndex + 1} of ${totalPages} • Use pagination buttons below` });

    // Chunk capabilities into fields of <= 1000 characters
    let chunk = '';
    let part = 1;
    for (const c of currentCat.capabilities) {
      const auth = CapabilityRegistry.toAuthoritative(c);
      const ex = auth.goExample ? `\n  *Example:* \`${auth.goExample}\`` : '';
      const line = `• **${auth.title}** (\`${auth.action}\`) — ${auth.description}${ex}\n\n`;

      if (chunk.length + line.length > 1000) {
        embed.addFields({
          name: part === 1 ? `Operations in ${currentCat.name}` : `Operations (Continued)`,
          value: chunk.trim(),
          inline: false
        });
        chunk = line;
        part++;
      } else {
        chunk += line;
      }
    }

    if (chunk.trim()) {
      embed.addFields({
        name: part === 1 ? `Operations in ${currentCat.name}` : `Operations (Continued)`,
        value: chunk.trim(),
        inline: false
      });
    }

    const paginationRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`dash:catalog:page:${safeIndex - 1}`)
        .setLabel('◀️ Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safeIndex === 0),
      new ButtonBuilder()
        .setCustomId(`dash:catalog:page:${safeIndex + 1}`)
        .setLabel('Next ▶️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safeIndex >= totalPages - 1)
    );

    return { embed, extraRows: [paginationRow] };
  }

  /**
   * 12. Continuous Learning & Reliability Page
   */
  static async _renderLearningPage(guild, access) {
    const metrics = ExperienceStore.getGuildMetrics(guild.id);

    const embed = new EmbedBuilder()
      .setTitle(`Continuous Learning & Reliability — ${guild.name}`)
      .setDescription(
        `Honey Bot's persistent experience recording and evaluation system.\n` +
        `Learns from verified interaction outcomes and user feedback without modifying runtime prompts unverified.`
      )
      .setColor(DASH_COLORS.PRIMARY)
      .addFields(
        {
          name: 'Execution Statistics',
          value: `• **Total Recorded Operations:** ${metrics.totalExecutions}\n• **Verified Success Rate:** ${metrics.successRate}%\n• **Avg Engine Latency:** ${metrics.averageLatencyMs}ms`,
          inline: true
        },
        {
          name: 'User Satisfaction',
          value: `• **Helpful (👍):** ${metrics.positiveFeedback}\n• **Issues Reported (👎):** ${metrics.negativeFeedback}\n• **Quality Ratio:** ${metrics.positiveFeedback + metrics.negativeFeedback > 0 ? Math.round((metrics.positiveFeedback / (metrics.positiveFeedback + metrics.negativeFeedback)) * 100) : 100}%`,
          inline: true
        }
      );

    const failureKeys = Object.keys(metrics.failureBreakdown);
    if (failureKeys.length > 0) {
      const breakdownLines = failureKeys.map(k => `• \`${k}\`: ${metrics.failureBreakdown[k]} occurrence(s)`);
      embed.addFields({
        name: 'Failure Taxonomies & Classifications',
        value: breakdownLines.join('\n').slice(0, 1024),
        inline: false
      });
    } else {
      embed.addFields({
        name: 'Failure Taxonomies & Classifications',
        value: '• No failure classifications recorded in this server.',
        inline: false
      });
    }

    if (metrics.recentFailures.length > 0) {
      const recentLines = metrics.recentFailures.map((f, i) => `\`${i + 1}.\` "${f.prompt.slice(0, 40)}" — \`${f.category}\``);
      embed.addFields({
        name: 'Recent Identified Issues',
        value: recentLines.join('\n').slice(0, 1024),
        inline: false
      });
    }

    embed.setFooter({ text: 'Inference Provider: Groq (zero-cost) • Export evaluation dataset using the button below' });

    const extraRows = [];
    if (access.canView) {
      const exportRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('dash:learning:export')
          .setLabel('Export Evaluation Dataset (JSONL)')
          .setEmoji('📦')
          .setStyle(ButtonStyle.Secondary)
      );
      extraRows.push(exportRow);
    }

    return { embed, extraRows };
  }

  // =========================================================================
  // INTERACTION DISPATCHER & MUTATION HANDLERS
  // =========================================================================

  /**
   * Intercepts and processes all dashboard interactions starting with 'dash:'.
   */
  static async handleInteraction(interaction) {
    if (!interaction.customId?.startsWith('dash:')) return false;

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({
        content: '⚠️ Dashboard interactions must be used within a server.',
        ephemeral: true
      }).catch(() => {});
      return true;
    }

    const member = interaction.member;
    const user = interaction.user;
    const access = this.getAccessLevel(guild, member, user);

    const parts = interaction.customId.split(':');
    const actionType = parts[1]; // 'nav', 'page', 'action', 'toggle', 'modal', 'modal_submit', 'modlog', 'music', 'queue', 'catalog'

    try {
      // 1. Navigation Select Menu
      if (actionType === 'nav' && interaction.isStringSelectMenu()) {
        const targetPage = interaction.values?.[0] || 'overview';
        const payload = await this.buildDashboardPayload(guild, member, user, targetPage);
        await interaction.update(payload);
        return true;
      }

      // 2. Direct Page Button Click
      if (actionType === 'page') {
        const targetPage = parts[2] || 'overview';
        const payload = await this.buildDashboardPayload(guild, member, user, targetPage);
        await interaction.update(payload);
        return true;
      }

      // 3. Catalog Pagination
      if (actionType === 'catalog' && parts[2] === 'page') {
        const pageIdx = parseInt(parts[3], 10) || 0;
        const payload = await this.buildDashboardPayload(guild, member, user, 'catalog', { pageIndex: pageIdx });
        await interaction.update(payload);
        return true;
      }

      // 4. Refresh Button
      if (actionType === 'action' && parts[2] === 'refresh') {
        const currentPage = parts[3] || 'overview';
        const payload = await this.buildDashboardPayload(guild, member, user, currentPage);
        await interaction.update(payload);
        return true;
      }

      // 5. Open Modal for Moderation Configuration
      if (actionType === 'modal' && parts[2] === 'moderation') {
        if (!access.canEdit) {
          await interaction.reply({ content: '⚠️ You lack permission to modify server moderation settings.', ephemeral: true });
          return true;
        }

        const config = GuildConfigService.getConfig(guild.id);
        const modal = new ModalBuilder()
          .setCustomId('dash:modal_submit:moderation')
          .setTitle('Configure Moderation Policy')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('default_timeout')
                .setLabel('Default Timeout (Minutes, 1 - 40320)')
                .setStyle(TextInputStyle.Short)
                .setValue(String(config.moderationSettings?.defaultTimeoutMinutes || 10))
                .setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('warning_threshold')
                .setLabel('Warning Escalation Threshold (1 - 20)')
                .setStyle(TextInputStyle.Short)
                .setValue(String(config.moderationSettings?.warningThreshold || 3))
                .setRequired(true)
            )
          );

        await interaction.showModal(modal);
        return true;
      }

      // 6. Handle Modal Submit for Moderation
      if (actionType === 'modal_submit' && parts[2] === 'moderation' && interaction.isModalSubmit()) {
        if (!access.canEdit) {
          await interaction.reply({ content: '⚠️ You lack permission to modify server settings.', ephemeral: true });
          return true;
        }

        const rawTimeout = interaction.fields.getTextInputValue('default_timeout');
        const rawThreshold = interaction.fields.getTextInputValue('warning_threshold');

        const timeoutSetting = getSettingById('moderation.defaultTimeoutMinutes');
        const thresholdSetting = getSettingById('moderation.warningThreshold');

        timeoutSetting.setValue(guild.id, rawTimeout, user);
        thresholdSetting.setValue(guild.id, rawThreshold, user);

        // Read back verified outcome
        const payload = await this.buildDashboardPayload(guild, member, user, 'moderation');
        await interaction.update(payload);
        return true;
      }

      // 7. Toggle Settings (Kick confirm, Ban confirm, Admin only, Default deny)
      if (actionType === 'toggle') {
        if (!access.canEdit) {
          await interaction.reply({ content: '⚠️ You lack permission to modify server settings.', ephemeral: true });
          return true;
        }

        const settingKey = parts[2];
        const targetState = parts[3] === 'on';

        if (settingKey === 'kick_confirm') {
          const setting = getSettingById('moderation.requireKickConfirmation');
          setting.setValue(guild.id, targetState, user);
        } else if (settingKey === 'ban_confirm') {
          const setting = getSettingById('moderation.requireBanConfirmation');
          setting.setValue(guild.id, targetState, user);
        } else if (settingKey === 'admin_only') {
          const setting = getSettingById('policy.adminOnlyPolicyChanges');
          setting.setValue(guild.id, targetState, user);
        } else if (settingKey === 'default_deny') {
          const setting = getSettingById('policy.defaultDeny');
          setting.setValue(guild.id, targetState, user);
        }

        // Return verified updated page
        const returnPage = (settingKey === 'kick_confirm' || settingKey === 'ban_confirm') ? 'moderation' : 'roles';
        const payload = await this.buildDashboardPayload(guild, member, user, returnPage);
        await interaction.update(payload);
        return true;
      }

      // 8. Modlog Channel Selection
      if (actionType === 'modlog' && parts[2] === 'set_channel' && interaction.isChannelSelectMenu()) {
        if (!access.canEdit) {
          await interaction.reply({ content: '⚠️ You lack permission to configure moderation logging.', ephemeral: true });
          return true;
        }

        const selectedChannelId = interaction.values?.[0];
        if (!selectedChannelId) {
          await interaction.reply({ content: '⚠️ No channel was selected.', ephemeral: true });
          return true;
        }

        const setting = getSettingById('modlog.channelId');
        await setting.setValue(guild, selectedChannelId, user);

        const payload = await this.buildDashboardPayload(guild, member, user, 'modlog');
        await interaction.update(payload);
        return true;
      }

      // 9. Modlog Toggle Enable/Disable
      if (actionType === 'modlog' && parts[2] === 'toggle') {
        if (!access.canEdit) {
          await interaction.reply({ content: '⚠️ You lack permission to configure moderation logging.', ephemeral: true });
          return true;
        }

        const enable = parts[3] === 'enable';
        const setting = getSettingById('modlog.enabled');
        await setting.setValue(guild, enable, user);

        const payload = await this.buildDashboardPayload(guild, member, user, 'modlog');
        await interaction.update(payload);
        return true;
      }

      // 10. Modlog Test Delivery Trigger
      if (actionType === 'modlog' && parts[2] === 'test') {
        if (!access.canEdit) {
          await interaction.reply({ content: '⚠️ You lack permission to trigger modlog tests.', ephemeral: true });
          return true;
        }

        const testRes = await ModLogService.testLogChannel(guild);
        if (testRes.success) {
          await interaction.reply({
            content: `✅ **Test Delivery Successful:** Delivered test moderation log entry to <#${testRes.channel.id}>.`,
            ephemeral: true
          });
        } else {
          await interaction.reply({
            content: `❌ **Test Delivery Failed:** ${testRes.error}`,
            ephemeral: true
          });
        }

        return true;
      }

      // 11. Music Controls
      if (actionType === 'music') {
        if (!access.canEdit) {
          await interaction.reply({ content: '⚠️ You lack permission to manage music playback.', ephemeral: true });
          return true;
        }

        const sub = MusicService.getSubscription(guild.id);
        if (!sub) {
          await interaction.reply({ content: '⚠️ No active music playback found in this server.', ephemeral: true });
          return true;
        }

        const cmd = parts[2];
        if (cmd === 'pause') sub.pause();
        else if (cmd === 'resume') sub.resume();
        else if (cmd === 'skip') sub.skip();
        else if (cmd === 'stop') sub.stop();
        else if (cmd === 'leave') sub.destroy();
        else if (cmd === 'shuffle') sub.shuffleQueue();
        else if (cmd === 'clear') sub.clearQueue();
        else if (cmd === 'loop') sub.setLoopMode(sub.loopMode === 'off' ? 'track' : (sub.loopMode === 'track' ? 'queue' : 'off'));

        const payload = await this.buildDashboardPayload(guild, member, user, 'music');
        await interaction.update(payload);
        return true;
      }

      // 12. Task Queue Cancellation
      if (actionType === 'queue' && parts[2] === 'cancel') {
        if (!access.canEdit) {
          await interaction.reply({ content: '⚠️ You lack permission to cancel tasks.', ephemeral: true });
          return true;
        }

        const taskId = parts[3];
        const task = TaskQueue.getTask(taskId);
        if (task && (task.status === TaskQueueState.QUEUED || task.status === TaskQueueState.RUNNING)) {
          TaskQueue.transition(taskId, TaskQueueState.CANCELLED, { reason: `Cancelled by ${user.tag} via dashboard` });
          await interaction.reply({ content: `✅ Task \`${taskId}\` has been cancelled.`, ephemeral: true });
        } else {
          await interaction.reply({ content: `⚠️ Task \`${taskId}\` is no longer active or cannot be cancelled.`, ephemeral: true });
        }

        return true;
      }

      // 13. Continuous Learning Evaluation Dataset Export
      if (actionType === 'learning' && parts[2] === 'export') {
        const dataset = ExperienceStore.exportEvaluationDataset({ guildId: guild.id });
        const sample = dataset.slice(0, 2);
        await interaction.reply({
          content: `📦 **Continuous Learning Dataset Export:**\n• Total Quality-Filtered Records: **${dataset.length}**\n• Format: **ChatML JSONL** (anonymized for offline evaluation & fine-tuning)\n• Provider: Groq free tier is configured for zero-cost runtime inference.\n\n\`\`\`json\n${JSON.stringify(sample, null, 2).slice(0, 1500)}\n\`\`\``,
          ephemeral: true
        });
        return true;
      }

      // Open from Help or Go button
      if (actionType === 'open') {
        const targetPage = parts[2] || 'overview';
        const payload = await this.buildDashboardPayload(guild, member, user, targetPage);
        await interaction.reply({ ...payload, ephemeral: false });
        return true;
      }

      return false;
    } catch (err) {
      logger.error('Error handling dashboard interaction', { customId: interaction.customId, error: err.message, stack: err.stack });
      const errorMsg = `❌ **Dashboard Error:** ${err.message}`;
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: errorMsg, ephemeral: true }).catch(() => {});
      } else {
        await interaction.reply({ content: errorMsg, ephemeral: true }).catch(() => {});
      }
      return true;
    }
  }

  /**
   * Helper to open the dashboard directly from /go or /help.
   */
  static async openDashboard(interaction, initialPage = 'overview') {
    const payload = await this.buildDashboardPayload(
      interaction.guild,
      interaction.member,
      interaction.user,
      initialPage
    );

    if (interaction.deferred) {
      return await interaction.editReply(payload);
    } else if (interaction.replied) {
      return await interaction.followUp(payload);
    } else {
      return await interaction.reply(payload);
    }
  }
}
