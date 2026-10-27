import dns from 'node:dns';
import net from 'node:net';

// 1. Force IPv4-first DNS resolution in Node.js to prevent Gateway handshake stalls in Docker/Render
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // ignore
}

// 2. Disable dual-stack IPv6 auto-select family to prevent Docker IPv6 packet blackhole hangs
try {
  if (typeof net.setDefaultAutoSelectFamily === 'function') {
    net.setDefaultAutoSelectFamily(false);
  }
} catch {
  // ignore
}

import http from 'node:http';
import { Client, GatewayIntentBits, Partials, Events, ActivityType } from 'discord.js';
import { config, validateConfig } from './src/config.js';
import { handleCommandInteraction } from './src/commands.js';
import { TicketManager } from './src/tickets.js';
import { RoleMenuManager } from './src/role-menu.js';
import { SelfRoleManager } from './src/self-roles.js';
import { registerGatewayEventListeners } from './src/gateway-events.js';
import { ActionLedger } from './src/recovery.js';
import { MusicService } from './src/music-service.js';
import { DashboardManager } from './src/dashboard.js';
import { ChannelGuard } from './src/channel-guard.js';
import { HoneypotService } from './src/honeypot-service.js';
import { OnboardingManager } from './src/onboarding.js';
import { ExperienceStore } from './src/experience-store.js';
import { SecurityEngine } from './src/security-engine.js';
import { CaseManager } from './src/case-manager.js';
import { MemberOnboardingManager } from './src/member-onboarding.js';
import { ApplicationManager } from './src/applications.js';
import { WorkflowEngine, WorkflowTrigger } from './src/workflow-engine.js';
import { CommunityUtils } from './src/community-utils.js';
import { TaskScheduler } from './src/scheduler.js';
import { AnalyticsService } from './src/analytics-service.js';
import { TaskQueue } from './src/task-queue.js';
import { Watchdog, WatchdogEvent } from './src/watchdog.js';
import { Logger } from './src/logger.js';
import { StartupManager } from './src/startup-manager.js';
import { InstanceLock } from './src/instance-lock.js';
import { globalLifecycle } from './src/bot-lifecycle.js';
import { defaultPendingTaskManager } from './src/pending-task-manager.js';
import { defaultContextResolutionPipeline } from './src/context-resolution-pipeline.js';

const logger = new Logger('Bot');

let botLoginStatus = 'initializing';
let lastLoginError = null;
let lastDebugInfo = 'No gateway packet received yet';

// Autonomous Health Watchdog Engine
const watchdog = new Watchdog();

// Built-in 24/7 Cloud Web Health-Check Server (Supports Liveness, Readiness, and Subsystem breakdown)
const port = process.env.PORT || 3000;
const server = http.createServer(async (req, res) => {
  const url = req.url ? req.url.split('?')[0] : '/';

  // 1. Liveness Check (/healthz or /live): Confirms hosting process & event loop are alive
  if (url === '/healthz' || url === '/live') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'alive',
      processAlive: true,
      uptimeSeconds: Math.floor(process.uptime()),
      pid: process.pid,
      timestamp: new Date().toISOString()
    }, null, 2));
  }

  // 2. Readiness Check (/ready or /readyz): Confirms Discord gateway is connected & ready and storage is accessible
  // Point external monitoring (e.g. UptimeRobot) to this endpoint for reliable alerts!
  if (url === '/ready' || url === '/readyz') {
    const isReady = watchdog.isSystemReady();
    const statusCode = isReady ? 200 : 503;
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: isReady ? 'ready' : 'not_ready',
      discordReady: watchdog.isDiscordReady(),
      processAlive: watchdog.isProcessAlive(),
      botUser: client?.user ? client.user.tag : null,
      reconnectAttempt: watchdog.reconnectAttempt,
      timestamp: new Date().toISOString()
    }, null, 2));
  }

  // 3. Subsystem Health Breakdown (/health): Independent state tracking across all 10 subsystems (zero secrets)
  if (url === '/health') {
    const detailed = watchdog.getDetailedHealth();
    const statusCode = detailed.overallReady ? 200 : 503;
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(detailed, null, 2));
  }

  // 4. Watchdog Diagnostic Event Log (/health/events)
  if (url === '/health/events') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      timestamp: new Date().toISOString(),
      events: watchdog.getEvents(50)
    }, null, 2));
  }

  // 5. Direct Discord API Test (/test-discord)
  if (url === '/test-discord') {
    try {
      const start = Date.now();
      const resDiscord = await fetch('https://discord.com/api/v10/gateway/bot', {
        headers: { Authorization: `Bot ${config.discord.token}` },
        signal: AbortSignal.timeout(5000)
      });
      const text = await resDiscord.text();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: resDiscord.status, duration: Date.now() - start, body: JSON.parse(text) }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message, code: err.code }));
    }
  }

  // 6. Root Endpoint (Backward Compatible): Distinguishes website availability from Discord bot health
  const isDiscordReady = Boolean(client && client.isReady());
  const statusCode = isDiscordReady ? 200 : 503;

  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    websiteStatus: 'online',
    discordStatus: isDiscordReady ? 'connected' : 'offline',
    discordReady: isDiscordReady,
    bot: client.user ? client.user.tag : botLoginStatus,
    discordTokenConfigured: Boolean(config.discord.token),
    geminiKeyConfigured: Boolean(config.ai.gemini.apiKey),
    loginError: lastLoginError,
    gatewayDebug: lastDebugInfo,
    uptime: Math.floor(process.uptime()),
    zeroCostAI: config.ai.provider,
    endpoints: {
      liveness: '/healthz',
      readiness: '/readyz',
      subsystems: '/health',
      events: '/health/events'
    }
  }, null, 2));
});

server.on('error', (err) => {
  logger.warn(`Health check server port ${port} busy or error: ${err.message}`);
});

// Keep-Alive Self-Pinger: Prevents free cloud hosts (Render, Koyeb, Railway) from idling after 15 minutes
function setupKeepAlive() {
  const url = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL;
  if (!url) {
    logger.info('Keep-alive: No external URL detected. Set APP_URL or RENDER_EXTERNAL_URL in environment to enable auto-ping, or use an external pinger like UptimeRobot.');
    return;
  }

  const pingIntervalMs = 10 * 60 * 1000; // Ping every 10 minutes (well before Render's 15-minute idle spin-down)
  logger.info(`Keep-alive self-pinger initialized for ${url} (interval: 10m)`);

  setTimeout(async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      logger.info(`Keep-alive initial self-ping to ${url} status: ${res.status}`);
    } catch (err) {
      logger.warn(`Keep-alive initial ping warning: ${err.message}`);
    }
  }, 60000);

  setInterval(async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      logger.info(`Keep-alive self-ping sent to ${url} (status: ${res.status})`);
    } catch (err) {
      logger.warn(`Keep-alive ping warning: ${err.message}`);
    }
  }, pingIntervalMs);
}

server.listen(port, '0.0.0.0', () => {
  logger.info(`🌐 24/7 Cloud health-check endpoint listening on port ${port} (0.0.0.0)`);
  setupKeepAlive();
});

// Validate configuration before starting
const validation = validateConfig();
if (!validation.valid) {
  logger.warn('Configuration issues detected:', { issues: validation.issues });
}

// Initialize Discord Client with essential guild administration intents and partials
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction
  ],
  presence: {
    status: 'online',
    activities: [{ name: '/go <instruction>', type: ActivityType.Playing }]
  }
});

// Attach client to Autonomous Health Watchdog
watchdog.client = client;
client.watchdog = watchdog;

// Voice state update listener for automatic music cleanup and 5-minute idle disconnect
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  try {
    MusicService.handleVoiceStateUpdate(oldState, newState, client.user?.id);
  } catch (err) {
    logger.error('Error in VoiceStateUpdate handler', { error: err.message });
  }
});

// Reaction Role Listeners: messageReactionAdd & messageReactionRemove
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (reaction.partial) {
      await reaction.fetch().catch(() => {});
    }
    await SelfRoleManager.handleReactionAdd(reaction, user);
    await CommunityUtils.handleReaction(reaction, user, client);
  } catch (err) {
    logger.error('Error in MessageReactionAdd handler', { error: err.message });
  }
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
  try {
    if (reaction.partial) {
      await reaction.fetch().catch(() => {});
    }
    await SelfRoleManager.handleReactionRemove(reaction, user);
  } catch (err) {
    logger.error('Error in MessageReactionRemove handler', { error: err.message });
  }
});

// Register external gateway moderation event listeners
registerGatewayEventListeners(client);

// Debug and Gateway status listeners
client.on('debug', (info) => {
  lastDebugInfo = info;
  logger.info(`[Discord Debug] ${info}`);
});

client.on('warn', (warning) => {
  logger.warn(`[Discord Warning] ${warning}`);
});

client.on('error', (err) => {
  lastLoginError = err.message;
  watchdog.trackError({ context: 'discord_client_error', error: err.message });
  logger.error('Discord Client Error:', { error: err.message });
});

client.on('shardError', (err, shardId) => {
  lastLoginError = `Shard ${shardId} Error: ${err.message}`;
  watchdog.recordEvent(WatchdogEvent.GATEWAY_DISCONNECT, 'error', { shardId, error: err.message });
  logger.error(`Discord Shard ${shardId} Error:`, { error: err.message });
});

client.on('shardDisconnect', (event, shardId) => {
  lastLoginError = `Shard ${shardId} disconnected (code: ${event?.code || 'unknown'})`;
  botLoginStatus = 'disconnected';
  watchdog.recordEvent(WatchdogEvent.GATEWAY_DISCONNECT, 'warn', { shardId, code: event?.code });
  logger.warn(`Discord Shard ${shardId} disconnected. Triggering reconnect check in 10s...`);
  scheduleReconnect(10000);
});

client.on('shardResume', (shardId, replayedEvents) => {
  botLoginStatus = 'connected';
  lastLoginError = null;
  watchdog.recordEvent(WatchdogEvent.GATEWAY_RECONNECT, 'info', { shardId, replayedEvents });
  logger.info(`Discord Shard ${shardId} connection resumed (${replayedEvents} events replayed).`);
  try {
    client.user?.setPresence({
      activities: [{ name: '/go <instruction>', type: ActivityType.Playing }],
      status: 'online'
    });
  } catch {}
});

// Event: Client Ready
client.once(Events.ClientReady, async (readyClient) => {
  botLoginStatus = 'connected';
  logger.info(`✅ Agent online as ${readyClient.user.tag}`);
  logger.info(`🤖 Zero-Cost AI Provider: ${config.ai.provider.toUpperCase()} (${config.ai[config.ai.provider]?.model || 'default'})`);
  
  // Set custom activity
  readyClient.user.setPresence({
    activities: [{ name: '/go <instruction>', type: ActivityType.Playing }],
    status: 'online'
  });

  // Load and reconcile action history
  ActionLedger.loadAllHistory(readyClient);

  // Reconcile in-flight tasks from persistent storage
  try {
    await TaskQueue.reconcileOnStartup(readyClient);
  } catch (err) {
    logger.error('Error reconciling task queue on startup', { error: err.message });
  }

  // Start background monitoring engines
  CaseManager.startScheduler(readyClient);
  TaskScheduler.startScheduler(readyClient);

  watchdog.recordEvent(WatchdogEvent.GATEWAY_RECONNECT, 'info', {
    user: readyClient.user.tag,
    guilds: readyClient.guilds.cache.size
  });
});

// Event: Message handling (SecurityEngine, ChannelGuard, FAQs & Analytics)
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // Track channel message volume in privacy-conscious analytics
  if (message.guild) {
    AnalyticsService.recordMessage(message.guild.id, message.channel.id);
  }

  // 0. Pending Task Follow-up check: process natural answers to outstanding questions in this channel
  if (message.guild && message.author && !message.content.startsWith('/')) {
    const activeTask = defaultPendingTaskManager.getPendingTask(
      message.guild.id,
      message.author.id,
      message.channel.id
    );
    if (activeTask) {
      try {
        const resolution = await defaultContextResolutionPipeline.resolve(message.content, {
          guild: message.guild,
          member: message.member,
          user: message.author,
          channel: message.channel,
          interaction: null,
          executionContext: { guild: message.guild, invokingMember: message.member, invokingUser: message.author }
        });
        if (resolution.handled) {
          if (resolution.message) {
            await message.reply({ content: resolution.message }).catch(() => {});
          }
          return;
        }
      } catch (err) {
        logger.error('Error handling chat message pending task resolution', { error: err.message });
      }
    }
  }

  // 1. Comprehensive Anti-Spam & ChannelGuard / Honeypot
  try {
    const securityCheck = await SecurityEngine.evaluateMessage(message, client);
    if (securityCheck.isViolation) {
      if (message.guild) AnalyticsService.recordSpamBlock(message.guild.id);
      return; // Message handled and blocked
    }

    const handled = await HoneypotService.handleMessage(message, client);
    if (!handled) {
      await ChannelGuard.handleMessage(message, client);
    }
  } catch (err) {
    logger.error('Error in Honeypot / ChannelGuard / Security message handler', { error: err.message });
  }

  // 2. Community Auto-Responses / FAQ
  try {
    const autoReplied = await CommunityUtils.checkAutoResponse(message);
    if (autoReplied) return;
  } catch {}

  // 3. Automation Workflow Trigger on Message Create
  if (message.guild) {
    WorkflowEngine.trigger(WorkflowTrigger.MESSAGE_CREATE, {
      guild: message.guild,
      channel: message.channel,
      message,
      user: message.author,
      member: message.member
    }).catch(() => {});
  }

  // 4. Mention response in chat
  if (message.mentions.has(client.user)) {
    await message.reply(`Hello <@${message.author.id}>. I am Honey, a server administration assistant. Use \`/go <instruction>\` to execute server changes, or \`/diagnose\` for diagnostics.`).catch(() => {});
  }
});

// Event: GuildMemberAdd -> Anti-Raid detection, member onboarding & auto-roles
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    if (member.guild) {
      AnalyticsService.recordJoin(member.guild.id);
      await SecurityEngine.handleMemberJoin(member, client);
      await MemberOnboardingManager.handleMemberJoin(member, client);
      await WorkflowEngine.trigger(WorkflowTrigger.MEMBER_JOIN, {
        guild: member.guild,
        member,
        user: member.user
      });
    }
  } catch (err) {
    logger.error('Error handling GuildMemberAdd', { guildId: member.guild?.id, error: err.message });
  }
});

// Event: GuildMemberRemove -> Farewell notifications & member departure analytics
client.on(Events.GuildMemberRemove, async (member) => {
  try {
    if (member.guild) {
      AnalyticsService.recordLeave(member.guild.id);
      await MemberOnboardingManager.handleMemberLeave(member);
      await WorkflowEngine.trigger(WorkflowTrigger.MEMBER_LEAVE, {
        guild: member.guild,
        member,
        user: member.user
      });
    }
  } catch (err) {
    logger.error('Error handling GuildMemberRemove', { guildId: member.guild?.id, error: err.message });
  }
});

// Event: Guild Create -> Automatic Onboarding Setup Flow
client.on(Events.GuildCreate, async (guild) => {
  try {
    await OnboardingManager.handleGuildCreate(guild);
  } catch (err) {
    logger.error('Error handling GuildCreate onboarding', { guildId: guild?.id, error: err.message });
  }
});

// Event: Interaction Dispatcher
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // 1. Handle Slash Commands (/go, /undo, /diagnose, /modlog, /help, etc.)
    if (interaction.isChatInputCommand()) {
      await handleCommandInteraction(interaction, { watchdog });
      return;
    }

    // 2. Handle Autocomplete interactions
    if (interaction.isAutocomplete()) {
      await interaction.respond([]).catch(() => {});
      return;
    }

    // 2a. Handle First-Run Setup & Permission Onboarding Interactions (Buttons, Select Menus)
    if (interaction.customId?.startsWith('setup:')) {
      const handled = await OnboardingManager.handleInteraction(interaction);
      if (handled) return;
    }

    // 2b. Handle Interactive Dashboard Components (Buttons, Select Menus, Modals)
    if (interaction.customId?.startsWith('dash:')) {
      const handled = await DashboardManager.handleInteraction(interaction);
      if (handled) return;
    }

    // 2c. Handle Interactive Honeypot Components (Buttons, Select Menus)
    if (interaction.customId?.startsWith('honeypot:')) {
      const handled = await HoneypotService.handleInteraction(interaction);
      if (handled) return;
    }

    // 2c. Handle Continuous Learning User Feedback Buttons
    if (interaction.isButton() && interaction.customId?.startsWith('feedback:')) {
      const parts = interaction.customId.split(':');
      const rating = parts[1] === 'up' ? 'positive' : 'negative';
      const execId = parts[2];

      const res = ExperienceStore.recordFeedback(execId, {
        rating,
        userId: interaction.user.id
      });

      if (res.success) {
        await interaction.reply({
          content: rating === 'positive'
            ? '✨ **Feedback Received:** Thank you! Honey Bot recorded this verified execution into continuous learning memory.'
            : '📝 **Feedback Recorded:** Honey Bot logged this issue into its continuous learning failure taxonomy for reliability improvements.',
          ephemeral: true
        }).catch(() => {});
      } else {
        await interaction.reply({
          content: '⚠️ This execution session has expired or is no longer in feedback memory.',
          ephemeral: true
        }).catch(() => {});
      }
      return;
    }

    // 2d. Handle Modals (Tickets, Applications)
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'ticket_create_modal') {
        const handled = await TicketManager.handleModalSubmit(interaction);
        if (handled) return;
      }
      if (interaction.customId?.startsWith('app:submit:')) {
        const handled = await ApplicationManager.handleModalSubmit(interaction);
        if (handled) return;
      }
    }

    // 3. Handle Persistent Ticket Buttons, Self-Role Buttons & Confirmation Buttons
    if (interaction.isButton()) {
      // Verification workflow
      if (interaction.customId === 'onboard:verify_member') {
        const handled = await MemberOnboardingManager.handleVerificationInteraction(interaction);
        if (handled) return;
      }

      // Application review buttons
      if (interaction.customId?.startsWith('app:')) {
        const handled = await ApplicationManager.handleButtonInteraction(interaction);
        if (handled) return;
      }

      // Community buttons (Polls, Suggestions, Event RSVPs)
      if (interaction.customId?.startsWith('poll:')) {
        const handled = await CommunityUtils.handleVote(interaction);
        if (handled) return;
      }
      if (interaction.customId?.startsWith('sug:')) {
        const handled = await CommunityUtils.handleSuggestionInteraction(interaction);
        if (handled) return;
      }
      if (interaction.customId?.startsWith('rsvp:')) {
        const handled = await TaskScheduler.handleRsvpInteraction(interaction);
        if (handled) return;
      }

      if (interaction.customId?.startsWith('role:')) {
        const handled = await SelfRoleManager.handleButtonInteraction(interaction);
        if (handled) return;
      }

      const handled = await TicketManager.handleButtonInteraction(interaction);
      if (handled) return;

      // Confirmation buttons are handled directly by ConfirmationManager collector.
      if (interaction.customId?.startsWith('confirm_') || interaction.customId?.startsWith('cancel_')) {
        return;
      }

      // Any other unhandled button: acknowledge ephemerally to prevent "The application did not respond"
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: '⚠️ This button interaction is no longer active.',
          ephemeral: true
        }).catch(() => {});
        return;
      }
    }

    // 4. Handle Self-Assignable Role Dropdowns
    if (interaction.isStringSelectMenu()) {
      const handled = await RoleMenuManager.handleSelectMenuInteraction(interaction);
      if (handled) return;

      // Any other unhandled select menu: acknowledge ephemerally
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: '⚠️ This selection menu is no longer active.',
          ephemeral: true
        }).catch(() => {});
        return;
      }
    }

    // 5. Acknowledge any other repliable interaction to prevent 3-second timeout
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: '⚠️ This interaction is not currently supported.',
        ephemeral: true
      }).catch(() => {});
    }
  } catch (err) {
    logger.error('Unhandled interaction error', { error: err.message, stack: err.stack });
    watchdog.trackError({ context: 'interaction_error', command: interaction?.commandName || 'interaction', error: err.message });
    try {
      if (interaction.deferred) {
        await interaction.editReply({ content: '❌ An unhandled system error occurred.', embeds: [], components: [] }).catch(() => {});
      } else if (!interaction.replied && interaction.isRepliable()) {
        await interaction.reply({ content: '❌ An unhandled system error occurred.', ephemeral: true }).catch(() => {});
      }
    } catch {
      // Ignore secondary error reporting failures
    }
  }
});

// Graceful Shutdown & Process Diagnostics
process.on('unhandledRejection', (reason) => {
  const errMsg = reason instanceof Error ? reason.message : String(reason);
  watchdog.trackError({ context: 'unhandled_rejection', error: errMsg });
  logger.error('Unhandled Promise Rejection', { reason: errMsg });
});

process.on('uncaughtException', (err) => {
  watchdog.trackError({ context: 'uncaught_exception', error: err.message });
  logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
});

const shutdown = () => {
  logger.info('Shutting down agent cleanly...');
  try {
    InstanceLock.release();
    watchdog.stop();
    TaskQueue.shutdown();
    CaseManager.stopScheduler();
    TaskScheduler.stopScheduler();
    MusicService.shutdownAll();
  } catch {}
  client.destroy();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Auto-Reconnecting Discord Gateway Login Engine
let reconnectTimer = null;
let isReconnecting = false;

function scheduleReconnect(delayMs = 15000) {
  if (isReconnecting || (client && client.isReady())) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);

  logger.info(`Scheduling Discord reconnect in ${Math.round(delayMs / 1000)}s...`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    await startDiscordLogin();
  }, delayMs);
}

async function startDiscordLogin() {
  if (!config.discord.token) {
    botLoginStatus = 'missing_token';
    lastLoginError = 'DISCORD_TOKEN environment variable is missing.';
    logger.error('DISCORD_TOKEN is not set in environment. Bot cannot connect to Discord.');
    return;
  }

  if (client.isReady()) {
    botLoginStatus = 'connected';
    return;
  }

  isReconnecting = true;
  logger.info('Attempting login to Discord Gateway...');
  try {
    await client.login(config.discord.token.trim());
    botLoginStatus = 'connected';
    lastLoginError = null;
  } catch (err) {
    lastLoginError = err.message;
    botLoginStatus = 'failed_login: ' + err.message;
    logger.error('Failed to log in to Discord', { error: err.message });
    scheduleReconnect(15000);
  } finally {
    isReconnecting = false;
  }
}

// Atomic Startup Manager Execution
const startupManager = new StartupManager({
  lifecycle: globalLifecycle,
  client,
  watchdog
});

startupManager.runStartup().then(() => {
  // Start watchdog monitor once startup completes
  watchdog.start();
}).catch(err => {
  logger.error('StartupManager execution error', { error: err.message });
  watchdog.start();
});
