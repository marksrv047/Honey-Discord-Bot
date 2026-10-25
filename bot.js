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
import { Client, GatewayIntentBits, Events, ActivityType } from 'discord.js';
import { config, validateConfig } from './src/config.js';
import { handleCommandInteraction } from './src/commands.js';
import { TicketManager } from './src/tickets.js';
import { RoleMenuManager } from './src/role-menu.js';
import { Logger } from './src/logger.js';

const logger = new Logger('Bot');

let botLoginStatus = 'initializing';
let lastLoginError = null;
let lastDebugInfo = 'No gateway packet received yet';

// Built-in 24/7 Cloud Web Health-Check Server (Required for Koyeb, Render, etc.)
const port = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'online',
    bot: client.user ? client.user.tag : botLoginStatus,
    discordTokenConfigured: Boolean(config.discord.token),
    geminiKeyConfigured: Boolean(config.ai.gemini.apiKey),
    loginError: lastLoginError,
    gatewayDebug: lastDebugInfo,
    uptime: Math.floor(process.uptime()),
    zeroCostAI: config.ai.provider
  }, null, 2));
});

server.on('error', (err) => {
  logger.warn(`Health check server port ${port} busy or error: ${err.message}`);
});

server.listen(port, () => {
  logger.info(`🌐 24/7 Cloud health-check endpoint listening on port ${port}`);
});

// Validate configuration before starting
const validation = validateConfig();
if (!validation.valid) {
  logger.warn('Configuration issues detected:', { issues: validation.issues });
}

// Initialize Discord Client with essential guild administration intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

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
  logger.error('Discord Client Error:', { error: err.message });
});

client.on('shardError', (err, shardId) => {
  lastLoginError = `Shard ${shardId} Error: ${err.message}`;
  logger.error(`Discord Shard ${shardId} Error:`, { error: err.message });
});

// Event: Client Ready
client.once(Events.ClientReady, (readyClient) => {
  botLoginStatus = 'connected';
  logger.info(`✅ Agent online as ${readyClient.user.tag}`);
  logger.info(`🤖 Zero-Cost AI Provider: ${config.ai.provider.toUpperCase()} (${config.ai[config.ai.provider]?.model || 'default'})`);
  
  // Set custom activity
  readyClient.user.setPresence({
    activities: [{ name: '/go <instruction>', type: ActivityType.Playing }],
    status: 'online'
  });
});

// Event: Interaction Dispatcher
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // 1. Handle Slash Commands (/go, /undo, /diagnostics)
    if (interaction.isChatInputCommand()) {
      await handleCommandInteraction(interaction);
      return;
    }

    // 2. Handle Persistent Ticket Buttons (Open Ticket / Close Ticket)
    if (interaction.isButton()) {
      const handled = await TicketManager.handleButtonInteraction(interaction);
      if (handled) return;
    }

    // 3. Handle Self-Assignable Role Dropdowns
    if (interaction.isStringSelectMenu()) {
      const handled = await RoleMenuManager.handleSelectMenuInteraction(interaction);
      if (handled) return;
    }
  } catch (err) {
    logger.error('Unhandled interaction error', { error: err.message, stack: err.stack });
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ An unhandled system error occurred.', ephemeral: true }).catch(() => {});
    }
  }
});

// Graceful Shutdown & Process Diagnostics
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection', { reason: reason instanceof Error ? reason.message : reason });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
});

const shutdown = () => {
  logger.info('Shutting down agent cleanly...');
  client.destroy();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Log in
if (config.discord.token) {
  logger.info('Attempting login to Discord Gateway...');
  client.login(config.discord.token.trim()).catch(err => {
    lastLoginError = err.message;
    botLoginStatus = 'failed_login: ' + err.message;
    logger.error('Failed to log in to Discord', { error: err.message });
  });
} else {
  botLoginStatus = 'missing_token';
  lastLoginError = 'DISCORD_TOKEN environment variable is missing in Render Environment settings.';
  logger.error('DISCORD_TOKEN is not set in environment. Bot cannot connect to Discord.');
}
