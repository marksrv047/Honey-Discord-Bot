import http from 'node:http';
import { Client, GatewayIntentBits, Events, ActivityType } from 'discord.js';
import { config, validateConfig } from './src/config.js';
import { handleCommandInteraction } from './src/commands.js';
import { TicketManager } from './src/tickets.js';
import { Logger } from './src/logger.js';

const logger = new Logger('Bot');

// Built-in 24/7 Cloud Web Health-Check Server (Required for Koyeb, Render, etc.)
const port = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'online',
    bot: client.user ? client.user.tag : 'initializing',
    uptime: Math.floor(process.uptime()),
    zeroCostAI: config.ai.provider
  }));
});

server.listen(port, () => {
  logger.info(`🌐 24/7 Cloud health-check endpoint listening on port ${port}`);
});

// Validate configuration before starting
const validation = validateConfig();
if (!validation.valid) {
  logger.warn('Configuration issues detected:', { issues: validation.issues });
}

// Initialize Discord Client with necessary administrative intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // Required for moderation and role assignment
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Event: Client Ready
client.once(Events.ClientReady, (readyClient) => {
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
  client.login(config.discord.token).catch(err => {
    logger.error('Failed to log in to Discord', { error: err.message });
  });
} else {
  logger.warn('DISCORD_TOKEN is not set. Bot will not connect to Discord until .env is configured.');
}
