import { REST, Routes } from 'discord.js';
import { slashCommands } from './src/commands.js';
import { config } from './src/config.js';
import { Logger } from './src/logger.js';

const logger = new Logger('DeployCommands');

if (!config.discord.token || !config.discord.clientId) {
  logger.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(config.discord.token);
const commandsData = slashCommands.map(cmd => cmd.toJSON());

async function deploy() {
  try {
    logger.info(`Started refreshing ${commandsData.length} application (/) commands...`);

    if (config.discord.guildId) {
      // Guild-specific registration (instant update, ideal for development/testing)
      const data = await rest.put(
        Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
        { body: commandsData }
      );
      logger.info(`✅ Successfully registered ${data.length} commands to Guild ID: ${config.discord.guildId}`);
    } else {
      // Global registration (takes up to 1 hour to propagate across all servers)
      const data = await rest.put(
        Routes.applicationCommands(config.discord.clientId),
        { body: commandsData }
      );
      logger.info(`✅ Successfully registered ${data.length} commands globally.`);
    }
  } catch (err) {
    logger.error('Failed to deploy application commands', { error: err.message });
    process.exit(1);
  }
}

deploy();
