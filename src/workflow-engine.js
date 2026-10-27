import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { Logger } from './logger.js';
import { ModLogService } from './mod-log.js';
import { checkRoleHierarchy } from './permissions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = new Logger('WorkflowEngine');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const WORKFLOWS_FILE = path.join(DATA_DIR, 'automation-workflows.json');

export const WorkflowTrigger = Object.freeze({
  MEMBER_JOIN: 'MEMBER_JOIN',
  MEMBER_LEAVE: 'MEMBER_LEAVE',
  MESSAGE_CREATE: 'MESSAGE_CREATE',
  TICKET_OPEN: 'TICKET_OPEN',
  SECURITY_ALERT: 'SECURITY_ALERT',
  SCHEDULED_CRON: 'SCHEDULED_CRON'
});

export const WorkflowConditionType = Object.freeze({
  HAS_ROLE: 'HAS_ROLE',
  NOT_HAS_ROLE: 'NOT_HAS_ROLE',
  IN_CHANNEL: 'IN_CHANNEL',
  CONTENT_CONTAINS: 'CONTENT_CONTAINS',
  IS_BOT: 'IS_BOT',
  ACCOUNT_AGE_DAYS_LESS: 'ACCOUNT_AGE_DAYS_LESS'
});

export const WorkflowActionType = Object.freeze({
  SEND_MESSAGE: 'SEND_MESSAGE',
  SEND_EMBED: 'SEND_EMBED',
  ASSIGN_ROLE: 'ASSIGN_ROLE',
  REMOVE_ROLE: 'REMOVE_ROLE',
  TIMEOUT_MEMBER: 'TIMEOUT_MEMBER',
  DELETE_MESSAGE: 'DELETE_MESSAGE'
});

/**
 * WorkflowEngine
 * Event-driven automated server workflow orchestration engine:
 * Trigger -> Conditions -> Actions -> Verification -> Recovery
 */
export class WorkflowEngine {
  static _workflows = new Map(); // guildId -> Map(workflowId -> WorkflowRecord)
  static _executionHistory = new Map(); // guildId -> Array<ExecutionLog>
  static _isLoaded = false;
  static _storagePath = WORKFLOWS_FILE;

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
        logger.error('Failed to create data directory for workflows', { error: err.message });
      }
    }
  }

  static loadAll() {
    if (this._isLoaded) return;
    this._ensureDataDir();

    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const parsed = JSON.parse(raw);
        this._workflows.clear();

        for (const [guildId, list] of Object.entries(parsed)) {
          const map = new Map();
          if (Array.isArray(list)) {
            for (const wf of list) {
              map.set(wf.id, wf);
            }
          }
          this._workflows.set(guildId, map);
        }
      }
      this._isLoaded = true;
    } catch (err) {
      logger.error('Failed to load workflows from disk', { error: err.message });
      this._isLoaded = true;
    }
  }

  static saveAll() {
    this._ensureDataDir();
    try {
      const serializable = {};
      for (const [guildId, map] of this._workflows.entries()) {
        serializable[guildId] = Array.from(map.values());
      }
      const tmpFile = `${this.storagePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpFile, JSON.stringify(serializable, null, 2), 'utf8');
      fs.renameSync(tmpFile, this.storagePath);
    } catch (err) {
      logger.error('Failed to save workflows to disk', { error: err.message });
    }
  }

  /**
   * Registers and validates a new workflow definition.
   */
  static registerWorkflow(guildId, {
    name,
    description = '',
    trigger,
    conditions = [],
    actions = [],
    enabled = true
  }) {
    this.loadAll();

    if (!name || !trigger) {
      throw new Error('Workflow requires a name and a valid trigger.');
    }
    if (!Object.values(WorkflowTrigger).includes(trigger)) {
      throw new Error(`Unsupported trigger "${trigger}".`);
    }
    if (!Array.isArray(actions) || actions.length === 0) {
      throw new Error('Workflow must define at least one action.');
    }

    const id = `WF-${Math.floor(1000 + Math.random() * 9000)}`;
    const workflow = {
      id,
      guildId,
      name,
      description,
      trigger,
      conditions,
      actions,
      enabled: Boolean(enabled),
      createdAt: new Date().toISOString(),
      runCount: 0,
      lastRunAt: null
    };

    if (!this._workflows.has(guildId)) {
      this._workflows.set(guildId, new Map());
    }
    this._workflows.get(guildId).set(id, workflow);
    this.saveAll();

    logger.info(`Registered workflow "${name}" [${id}] for guild ${guildId}`);
    return workflow;
  }

  static getWorkflow(guildId, id) {
    this.loadAll();
    return this._workflows.get(guildId)?.get(id) || null;
  }

  static listWorkflows(guildId) {
    this.loadAll();
    const map = this._workflows.get(guildId);
    return map ? Array.from(map.values()) : [];
  }

  static deleteWorkflow(guildId, id) {
    this.loadAll();
    const map = this._workflows.get(guildId);
    if (!map || !map.has(id)) return false;
    map.delete(id);
    this.saveAll();
    return true;
  }

  /**
   * Evaluates conditions against context.
   */
  static evaluateConditions(conditions, context) {
    if (!Array.isArray(conditions) || conditions.length === 0) return true;

    for (const cond of conditions) {
      switch (cond.type) {
        case WorkflowConditionType.HAS_ROLE:
          if (!context.member?.roles?.cache?.has(cond.roleId)) return false;
          break;
        case WorkflowConditionType.NOT_HAS_ROLE:
          if (context.member?.roles?.cache?.has(cond.roleId)) return false;
          break;
        case WorkflowConditionType.IN_CHANNEL:
          if (context.channel?.id !== cond.channelId) return false;
          break;
        case WorkflowConditionType.CONTENT_CONTAINS:
          if (!context.message?.content?.toLowerCase().includes(String(cond.keyword).toLowerCase())) return false;
          break;
        case WorkflowConditionType.IS_BOT:
          const isBot = Boolean(context.user?.bot || context.member?.user?.bot);
          if (isBot !== Boolean(cond.value)) return false;
          break;
        case WorkflowConditionType.ACCOUNT_AGE_DAYS_LESS:
          if (context.user?.createdAt) {
            const ageDays = (Date.now() - context.user.createdAt.getTime()) / (1000 * 60 * 60 * 24);
            if (ageDays >= Number(cond.days)) return false;
          }
          break;
        default:
          break;
      }
    }
    return true;
  }

  /**
   * Executes a triggered workflow sequence.
   */
  static async trigger(triggerType, context) {
    if (!context || !context.guild) return [];
    this.loadAll();

    const guildId = context.guild.id;
    const guildWorkflows = this._workflows.get(guildId);
    if (!guildWorkflows) return [];

    const executed = [];

    for (const wf of guildWorkflows.values()) {
      if (!wf.enabled || wf.trigger !== triggerType) continue;

      // 1. Evaluate conditions
      const matches = this.evaluateConditions(wf.conditions, context);
      if (!matches) continue;

      logger.info(`Executing workflow "${wf.name}" [${wf.id}] on trigger ${triggerType}`);
      const executionResult = {
        workflowId: wf.id,
        workflowName: wf.name,
        actionsExecuted: 0,
        succeeded: true,
        errors: []
      };

      // 2. Execute actions sequentially
      for (const act of wf.actions) {
        try {
          await this._executeAction(act, context);
          executionResult.actionsExecuted++;
        } catch (actErr) {
          executionResult.succeeded = false;
          executionResult.errors.push(actErr.message);
          logger.error(`Workflow ${wf.id} action error`, { error: actErr.message, action: act.type });
        }
      }

      wf.runCount = (wf.runCount || 0) + 1;
      wf.lastRunAt = new Date().toISOString();
      executed.push(executionResult);

      // Record in guild history (bounded to 50 entries)
      if (!this._executionHistory.has(guildId)) {
        this._executionHistory.set(guildId, []);
      }
      const hist = this._executionHistory.get(guildId);
      hist.unshift({
        ...executionResult,
        timestamp: new Date().toISOString()
      });
      if (hist.length > 50) hist.pop();
    }

    this.saveAll();
    return executed;
  }

  static async _executeAction(action, context) {
    const guild = context.guild;

    switch (action.type) {
      case WorkflowActionType.SEND_MESSAGE: {
        const channel = guild.channels.cache.get(action.channelId) || context.channel;
        if (channel && channel.isTextBased()) {
          const content = String(action.content || '')
            .replace(/\{user\}/g, context.user ? `<@${context.user.id}>` : '')
            .replace(/\{server\}/g, guild.name);
          await channel.send({ content });
        }
        break;
      }
      case WorkflowActionType.SEND_EMBED: {
        const channel = guild.channels.cache.get(action.channelId) || context.channel;
        if (channel && channel.isTextBased()) {
          const embed = new EmbedBuilder()
            .setTitle(action.title || 'Automated Notice')
            .setDescription(action.description || '')
            .setColor(action.color || 0xFEE75C);
          await channel.send({ embeds: [embed] });
        }
        break;
      }
      case WorkflowActionType.ASSIGN_ROLE: {
        const member = context.member;
        const role = guild.roles.cache.get(action.roleId);
        if (member && role && guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
          const hierarchy = checkRoleHierarchy(guild, { action: 'assign_role' }, role);
          if (hierarchy.valid !== false) {
            await member.roles.add(role, `Automated workflow: ${action.reason || 'Auto-assignment'}`);
          }
        }
        break;
      }
      case WorkflowActionType.REMOVE_ROLE: {
        const member = context.member;
        const role = guild.roles.cache.get(action.roleId);
        if (member && role && guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
          const hierarchy = checkRoleHierarchy(guild, { action: 'remove_role' }, role);
          if (hierarchy.valid !== false) {
            await member.roles.remove(role, `Automated workflow: ${action.reason || 'Auto-removal'}`);
          }
        }
        break;
      }
      case WorkflowActionType.TIMEOUT_MEMBER: {
        const member = context.member;
        const durationMs = (action.durationMinutes || 10) * 60 * 1000;
        if (member && member.moderatable) {
          await member.timeout(durationMs, `Automated workflow: ${action.reason || 'Workflow trigger'}`);
        }
        break;
      }
      case WorkflowActionType.DELETE_MESSAGE: {
        if (context.message && context.message.deletable) {
          await context.message.delete().catch(() => {});
        }
        break;
      }
      default:
        logger.warn(`Unknown action type: ${action.type}`);
        break;
    }
  }
}
