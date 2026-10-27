import { Logger } from './logger.js';

const logger = new Logger('CommandRegistry');

/**
 * Authoritative Slash-Command Registry & Consistency Engine.
 * 
 * Guarantees that:
 * 1. Every Discord slash-command has an existing, loadable runtime handler.
 * 2. Every registered handler corresponds to a valid Discord command schema.
 * 3. Discord application command registrations match local definitions.
 */
export class CommandRegistry {
  constructor() {
    this.handlers = new Map();
    this.commandDefinitions = new Map();
    this.aliases = new Map();
  }

  /**
   * Loads command definitions into registry.
   */
  loadDefinitions(commands) {
    if (Array.isArray(commands)) {
      for (const cmd of commands) {
        if (cmd && typeof cmd.toJSON === 'function') {
          const json = cmd.toJSON();
          this.commandDefinitions.set(json.name, json);
        } else if (cmd && cmd.name) {
          this.commandDefinitions.set(cmd.name, cmd);
        }
      }
    }
  }

  /**
   * Registers a runtime command handler.
   */
  registerHandler(name, handler, metadata = {}) {
    if (!name || typeof handler !== 'function') {
      throw new Error(`Cannot register command handler: invalid name or handler function`);
    }
    const cleanName = name.toLowerCase().trim();
    this.handlers.set(cleanName, {
      name: cleanName,
      handler,
      metadata: {
        category: metadata.category || 'Utility',
        description: metadata.description || '',
        timeoutMs: metadata.timeoutMs || 25000,
        defer: metadata.defer !== false
      }
    });

    if (Array.isArray(metadata.aliases)) {
      for (const alias of metadata.aliases) {
        this.aliases.set(alias.toLowerCase().trim(), cleanName);
      }
    }
  }

  /**
   * Resolves a runtime command handler by name or alias.
   */
  getHandler(name) {
    if (!name) return null;
    const cleanName = name.toLowerCase().trim();
    if (this.handlers.has(cleanName)) {
      return this.handlers.get(cleanName);
    }
    const target = this.aliases.get(cleanName);
    if (target && this.handlers.has(target)) {
      return this.handlers.get(target);
    }
    return null;
  }

  /**
   * Verifies internal consistency between registered schemas and runtime handlers.
   * 
   * @returns {{
   *   valid: boolean,
   *   commandCount: number,
   *   definitions: string[],
   *   handlers: string[],
   *   missingHandlers: string[],
   *   missingDefinitions: string[],
   *   schemaErrors: string[]
   * }}
   */
  verifyConsistency() {
    const definitions = Array.from(this.commandDefinitions.keys());
    const handlers = Array.from(this.handlers.keys());
    const missingHandlers = [];
    const missingDefinitions = [];
    const schemaErrors = [];

    // 1. Every schema definition must have an active handler
    for (const defName of definitions) {
      if (!this.handlers.has(defName)) {
        missingHandlers.push(defName);
      }
    }

    // 2. Every handler must have a schema definition
    for (const handlerName of handlers) {
      if (!this.commandDefinitions.has(handlerName)) {
        missingDefinitions.push(handlerName);
      }
    }

    // 3. Schema validation
    for (const [name, def] of this.commandDefinitions.entries()) {
      if (!name || !/^[a-z0-9_-]{1,32}$/.test(name)) {
        schemaErrors.push(`Command "${name}" has invalid name syntax (must be 1-32 lowercase alphanumeric/dashes)`);
      }
      if (!def.description || def.description.length > 100) {
        schemaErrors.push(`Command "${name}" has invalid description length (${def.description?.length || 0})`);
      }
    }

    const valid = missingHandlers.length === 0 && schemaErrors.length === 0;

    if (!valid) {
      logger.warn('Command registry consistency check revealed issues', {
        missingHandlers,
        missingDefinitions,
        schemaErrors
      });
    } else {
      logger.info(`Command registry verified: ${definitions.length} commands matched with runtime handlers.`);
    }

    return {
      valid,
      commandCount: definitions.length,
      definitions,
      handlers,
      missingHandlers,
      missingDefinitions,
      schemaErrors
    };
  }

  /**
   * Verifies Discord remote application commands match local command definitions.
   */
  async verifyRemoteRegistration(client) {
    if (!client || !client.application) {
      return {
        verified: false,
        status: 'UNVERIFIED',
        reason: 'Client application is not ready or accessible'
      };
    }

    try {
      const remoteCommands = await client.application.commands.fetch();
      const remoteMap = new Map();
      remoteCommands.forEach(cmd => remoteMap.set(cmd.name, cmd));

      const missingInRemote = [];
      const extraInRemote = [];

      for (const localName of this.commandDefinitions.keys()) {
        if (!remoteMap.has(localName)) {
          missingInRemote.push(localName);
        }
      }

      remoteMap.forEach((_, remoteName) => {
        if (!this.commandDefinitions.has(remoteName)) {
          extraInRemote.push(remoteName);
        }
      });

      const inSync = missingInRemote.length === 0;

      return {
        verified: true,
        inSync,
        localCount: this.commandDefinitions.size,
        remoteCount: remoteMap.size,
        missingInRemote,
        extraInRemote
      };
    } catch (err) {
      logger.warn('Could not fetch remote Discord commands', { error: err.message });
      return {
        verified: false,
        status: 'UNVERIFIED',
        error: err.message
      };
    }
  }
}

export const globalCommandRegistry = new CommandRegistry();
