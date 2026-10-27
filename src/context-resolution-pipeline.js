import { resolveColor } from './color-utils.js';
import { Logger } from './logger.js';
import { defaultPendingTaskManager, PendingTaskStatus } from './pending-task-manager.js';
import { defaultConversationMemoryManager } from './conversation-memory.js';
import { Executor } from './executor.js';
import { checkUserAuthorization, checkBotPermissions } from './permissions.js';
import { ConfirmationManager } from './confirmations.js';
import { SecurityGate } from './security-gate.js';
import { formatSingleOutcome } from './format-response.js';

const logger = new Logger('ContextResolutionPipeline');

export class ContextResolutionPipeline {
  constructor(options = {}) {
    this.taskManager = options.taskManager || defaultPendingTaskManager;
    this.memoryManager = options.memoryManager || defaultConversationMemoryManager;
    this.stats = {
      resolvedFollowUps: 0,
      cancelledTasks: 0,
      topicSwitches: 0,
      correctionsApplied: 0,
      anaphoraResolved: 0,
      ambiguousClarifications: 0,
      concurrentLockBlocks: 0,
      unauthorizedBlocks: 0
    };
  }

  /**
   * Resolves incoming prompt against active pending tasks and conversational memory.
   * 
   * @param {string} rawPrompt Raw user message or slash command prompt
   * @param {object} scope { guild, member, user, channel, interaction, executionContext }
   * @returns {Promise<{
   *   handled: boolean,
   *   outcome?: 'executed' | 'cancelled' | 'clarification' | 'unauthorized' | 'failed' | 'topic_switch',
   *   message?: string,
   *   result?: any,
   *   task?: any,
   *   resolvedPrompt?: string,
   *   contextual?: boolean
   * }>}
   */
  async resolve(rawPrompt, scope = {}) {
    if (!rawPrompt || typeof rawPrompt !== 'string') {
      return { handled: false, resolvedPrompt: rawPrompt };
    }

    const cleanPrompt = rawPrompt.trim();
    const guild = scope.guild;
    const user = scope.user || scope.invokingUser || scope.member?.user;
    const member = scope.member;
    const channel = scope.channel;
    const guildId = guild?.id;
    const userId = user?.id;
    const channelId = channel?.id;

    if (!guildId || !userId) {
      return { handled: false, resolvedPrompt: cleanPrompt };
    }

    // Step 1: Record user message in short-term conversation memory
    this.memoryManager.recordUserMessage(guildId, userId, channelId, cleanPrompt);

    // Step 2: Check for active pending tasks waiting for user input
    const pendingTask = this.taskManager.getPendingTask(guildId, userId, channelId);

    // Step 3: Handle explicit cancellations
    if (this._isCancellation(cleanPrompt)) {
      if (pendingTask) {
        this.taskManager.cancelTask(pendingTask.taskId, 'Cancelled by user directive');
        this.stats.cancelledTasks++;
        const reply = '❌ **Task Cancelled:** The pending operation has been cancelled.';
        this.memoryManager.recordBotResponse(guildId, userId, channelId, reply, { action: 'cancel' });
        return {
          handled: true,
          outcome: 'cancelled',
          message: reply,
          task: pendingTask
        };
      }
    }

    // Step 4: Handle active pending task follow-up
    if (pendingTask) {
      // Check if user is explicitly switching topics ("forget that, create a channel instead")
      const topicSwitchMatch = cleanPrompt.match(/^(?:forget\s+(?:that|it)|never\s*mind|cancel\s+that)[,\s]+(?:and\s+)?(?:let'?s\s+)?(.+)$/i);
      if (topicSwitchMatch) {
        this.taskManager.cancelTask(pendingTask.taskId, 'Cancelled due to topic change');
        this.stats.topicSwitches++;
        const newInstruction = topicSwitchMatch[1].trim();
        logger.info('User switched topic from pending task', { oldTask: pendingTask.taskId, newInstruction });
        return {
          handled: false,
          outcome: 'topic_switch',
          resolvedPrompt: newInstruction,
          contextual: false
        };
      }

      // Check if the user is performing a completely unrelated standalone operation
      // (e.g. "play music", "show dashboard", "help", "list channels") while keeping the pending task alive
      if (this._isUnrelatedCommand(cleanPrompt, pendingTask)) {
        logger.info('Detected unrelated standalone command while task is pending. Preserving task.', { taskId: pendingTask.taskId });
        return {
          handled: false,
          resolvedPrompt: cleanPrompt,
          contextual: false
        };
      }

      // Process follow-up or correction on the active pending task
      const resolution = await this._processPendingTaskInput(cleanPrompt, pendingTask, scope);
      if (resolution.handled) {
        return resolution;
      }
    }

    // Step 5: Check pronoun / anaphoric references using Layer A & Layer C context
    const anaphora = this._resolveAnaphora(cleanPrompt, guildId, userId, channelId, scope);
    if (anaphora.handled) {
      return anaphora;
    }
    if (anaphora.resolvedPrompt && anaphora.resolvedPrompt !== cleanPrompt) {
      this.stats.anaphoraResolved++;
      return {
        handled: false,
        resolvedPrompt: anaphora.resolvedPrompt,
        contextual: true
      };
    }

    return {
      handled: false,
      resolvedPrompt: cleanPrompt,
      contextual: false
    };
  }

  /**
   * Evaluates input against the active pending task (answers to clarifications or corrections).
   */
  async _processPendingTaskInput(prompt, task, scope) {
    const { guild, member, user, channel, interaction, executionContext } = scope;
    const guildId = guild?.id;
    const userId = user?.id;
    const channelId = channel?.id;

    // Check concurrency lock: do not allow duplicate concurrent executions
    if (!this.taskManager.acquireLock(task.taskId)) {
      this.stats.concurrentLockBlocks++;
      return {
        handled: true,
        outcome: 'failed',
        message: '⏳ **Task In Progress:** This task is currently being executed. Please wait.'
      };
    }

    try {
      let isAnswer = false;
      const missing = [...task.missingParams];

      // 1. Check for corrections: "Actually, make it red" / "Change the name to Elite"
      const correction = this._extractCorrection(prompt, task, guild);
      if (correction) {
        this.stats.correctionsApplied++;
        if (correction.color) {
          task.collectedParams.color = correction.color;
          task.missingParams = task.missingParams.filter(p => p !== 'color');
          isAnswer = true;
        }
        if (correction.name) {
          task.collectedParams.name = correction.name;
          task.targetName = correction.name;
          task.missingParams = task.missingParams.filter(p => p !== 'name');
          isAnswer = true;
        }
        if (correction.permissions) {
          task.collectedParams.permissions = correction.permissions;
          task.missingParams = task.missingParams.filter(p => p !== 'permissions');
          isAnswer = true;
        }
      }

      // 2. If not a correction, check direct answer to outstanding clarification
      if (!isAnswer) {
        const targetParam = task.missingParams[0];

        if (targetParam === 'color' || (!targetParam && missing.includes('color'))) {
          const resolvedColor = resolveColor(prompt);
          if (resolvedColor) {
            task.collectedParams.color = resolvedColor;
            task.missingParams = task.missingParams.filter(p => p !== 'color');
            isAnswer = true;
          }
        }

        if (!isAnswer && (targetParam === 'name' || (!targetParam && missing.includes('name')))) {
          const cleanName = prompt.replace(/^["']|["']$/g, '').trim();
          if (cleanName && cleanName.length > 0 && cleanName.length <= 100) {
            task.collectedParams.name = cleanName;
            task.targetName = cleanName;
            task.missingParams = task.missingParams.filter(p => p !== 'name');
            isAnswer = true;
          }
        }

        if (!isAnswer && (targetParam === 'duration' || (!targetParam && missing.includes('duration')))) {
          const duration = this._parseDuration(prompt);
          if (duration !== null) {
            task.collectedParams.durationMinutes = duration;
            task.missingParams = task.missingParams.filter(p => p !== 'duration');
            isAnswer = true;
          }
        }

        if (!isAnswer && (targetParam === 'targetMember' || (!targetParam && missing.includes('targetMember')))) {
          const target = prompt.trim();
          if (target) {
            task.collectedParams.targetMember = target;
            task.targetName = target;
            task.missingParams = task.missingParams.filter(p => p !== 'targetMember');
            isAnswer = true;
          }
        }

        if (!isAnswer && (targetParam === 'actionChoice' || (!targetParam && missing.includes('actionChoice')))) {
          const modChoice = prompt.toLowerCase();
          if (modChoice.includes('ban')) {
            task.action = 'ban_member';
            task.missingParams = task.missingParams.filter(p => p !== 'actionChoice');
            isAnswer = true;
          } else if (modChoice.includes('kick')) {
            task.action = 'kick_member';
            task.missingParams = task.missingParams.filter(p => p !== 'actionChoice');
            isAnswer = true;
          } else if (modChoice.includes('timeout')) {
            task.action = 'timeout_member';
            task.missingParams = task.missingParams.filter(p => p !== 'actionChoice');
            task.missingParams.push('duration');
            task.clarificationQuestion = `How long would you like to timeout ${task.targetName || 'the member'} for?`;
            this.taskManager.updateTask(task.taskId, {
              action: task.action,
              missingParams: task.missingParams,
              clarificationQuestion: task.clarificationQuestion
            });
            const reply = `❓ **Clarification Needed:**\n${task.clarificationQuestion}`;
            this.memoryManager.recordBotResponse(guildId, userId, channelId, reply, { action: task.action, taskId: task.taskId });
            return { handled: true, outcome: 'clarification', message: reply, task };
          }
        }
      }

      // If the input was NOT an answer to this task, release lock and let normal processing continue
      if (!isAnswer) {
        return { handled: false };
      }

      this.stats.resolvedFollowUps++;

      // Check if more parameters are still missing
      if (task.missingParams.length > 0) {
        const nextMissing = task.missingParams[0];
        let nextQuestion = `Please provide the missing ${nextMissing} for this operation.`;
        if (nextMissing === 'color') {
          nextQuestion = `What color should the ${task.targetName || 'new role'} role have?`;
        } else if (nextMissing === 'name') {
          nextQuestion = `What name would you like to give to the ${task.action.replace('_', ' ')}?`;
        } else if (nextMissing === 'duration') {
          nextQuestion = `How long should the timeout last (e.g. 10m, 1h, 1d)?`;
        }

        task.clarificationQuestion = nextQuestion;
        this.taskManager.updateTask(task.taskId, {
          collectedParams: task.collectedParams,
          missingParams: task.missingParams,
          clarificationQuestion: nextQuestion,
          extendTtl: true
        });

        const reply = `❓ **Clarification Needed:**\n${nextQuestion}`;
        this.memoryManager.recordBotResponse(guildId, userId, channelId, reply, { action: task.action, taskId: task.taskId });
        return {
          handled: true,
          outcome: 'clarification',
          message: reply,
          task
        };
      }

      // All parameters collected! Transition to READY and execute
      task.status = PendingTaskStatus.READY;
      this.taskManager.updateTask(task.taskId, { status: PendingTaskStatus.READY });

      // Step: Strictly Re-validate User Authorization immediately before execution!
      if (member && !member.guild && guild) {
        member.guild = guild;
      }
      const userAuth = checkUserAuthorization(member, [{ action: task.action }]);
      if (!userAuth.authorized) {
        this.stats.unauthorizedBlocks++;
        this.taskManager.failTask(task.taskId, `Unauthorized: ${userAuth.reason}`);
        const reply = `🛑 **Unauthorized:** ${userAuth.reason}`;
        this.memoryManager.recordBotResponse(guildId, userId, channelId, reply, { action: task.action, outcome: 'denied' });
        return {
          handled: true,
          outcome: 'unauthorized',
          message: reply,
          task
        };
      }

      // Step: Verify Bot Permissions
      const botAuth = checkBotPermissions(guild, [{ action: task.action }]);
      if (!botAuth.capable) {
        this.taskManager.failTask(task.taskId, `Bot lacks permission: ${botAuth.reason}`);
        const reply = `⚠️ **Bot Permission Error:** ${botAuth.reason}`;
        this.memoryManager.recordBotResponse(guildId, userId, channelId, reply, { action: task.action, outcome: 'failed' });
        return {
          handled: true,
          outcome: 'failed',
          message: reply,
          task
        };
      }

      // Step: High-Impact Confirmation Check
      const isHighImpact = Boolean(task.constraints?.isHighImpact || ConfirmationManager.isHighImpactAction(task.action));
      if (isHighImpact && interaction) {
        const confirmed = await ConfirmationManager.requestConfirmation(interaction, {
          thoughtProcess: `Pending task follow-up execution: ${task.action}`,
          actions: [{ action: task.action, ...task.collectedParams }]
        });
        if (!confirmed) {
          this.taskManager.cancelTask(task.taskId, 'Confirmation rejected');
          const reply = '🛑 **Operation Cancelled:** Confirmation was not granted.';
          return { handled: true, outcome: 'cancelled', message: reply, task };
        }
      }

      // Step: Execute Task
      task.status = PendingTaskStatus.EXECUTING;
      const executionId = executionContext?.executionId || `exec_${Date.now()}`;
      const actionObj = {
        action: task.action,
        targetRole: task.action.includes('role') ? (task.targetName || task.collectedParams.name) : undefined,
        targetChannel: task.action.includes('channel') ? (task.targetName || task.collectedParams.name) : undefined,
        targetMember: task.action.includes('member') ? (task.targetName || task.collectedParams.targetMember) : undefined,
        targetRef: task.targetName,
        ...task.collectedParams
      };

      const opResult = await Executor.executeIntent(
        guild,
        {
          intent: task.action,
          targetRef: task.targetName,
          args: actionObj,
          thought: `Executed pending task ${task.taskId}`
        },
        executionContext || { guild, invokingMember: member, invokingUser: user },
        executionId
      );

      if (opResult.success) {
        this.taskManager.completeTask(task.taskId, opResult);

        // Record in Layer C (Entity & Action Context)
        if (task.action === 'create_role') {
          this.memoryManager.recordEntity(guildId, 'role', {
            id: opResult.resourceId || opResult.role?.id,
            name: task.targetName || task.collectedParams.name,
            color: task.collectedParams.color
          });
        } else if (task.action === 'create_channel') {
          this.memoryManager.recordEntity(guildId, 'channel', {
            id: opResult.resourceId || opResult.channel?.id,
            name: task.targetName || task.collectedParams.name
          });
        }
        this.memoryManager.recordAction(guildId, {
          action: task.action,
          targetRef: task.targetName,
          outcome: 'succeeded',
          details: opResult.details
        });

        const outcomeText = formatSingleOutcome(task.action, opResult, {
          ...actionObj,
          name: task.targetName || task.collectedParams.name
        });

        this.memoryManager.recordBotResponse(guildId, userId, channelId, outcomeText, {
          action: task.action,
          taskId: task.taskId,
          outcome: 'succeeded'
        });

        return {
          handled: true,
          outcome: 'executed',
          success: true,
          message: outcomeText,
          result: opResult,
          task
        };
      } else {
        this.taskManager.failTask(task.taskId, opResult.error || 'Execution failed');
        const reply = `⚠️ **Execution Error:** ${opResult.error || 'Operation failed'}`;
        this.memoryManager.recordBotResponse(guildId, userId, channelId, reply, {
          action: task.action,
          taskId: task.taskId,
          outcome: 'failed'
        });
        return {
          handled: true,
          outcome: 'failed',
          success: false,
          message: reply,
          result: opResult,
          task
        };
      }
    } finally {
      this.taskManager.releaseLock(task.taskId);
    }
  }

  /**
   * Resolves conversational references and pronouns ("it", "that role", "delete the one we just created").
   */
  _resolveAnaphora(prompt, guildId, userId, channelId, scope) {
    const clean = prompt.trim();
    const lastRole = this.memoryManager.getLastEntity(guildId, 'role');
    const lastChannel = this.memoryManager.getLastEntity(guildId, 'channel');
    const lastAction = this.memoryManager.getLastAction(guildId);

    // 1. "Make it blue" / "Change that to red" / "Change its color to purple"
    const colorMatch = clean.match(/^(?:actually[,\s]+)?(?:make|change|set)\s+(?:it|that|its\s+color|color)\s+(?:to\s+)?([#\w]+)(?:\s+instead)?$/i);
    if (colorMatch) {
      const colorVal = resolveColor(colorMatch[1]);
      if (colorVal && lastRole) {
        return {
          handled: false,
          resolvedPrompt: `edit role ${lastRole.name} color ${colorVal}`,
          contextual: true
        };
      }
    }

    // 2. "Actually, call it Elite" / "Rename it to Elite" / "Change name to Elite"
    const renameMatch = clean.match(/^(?:actually[,\s]+)?(?:call\s+it|rename\s+(?:it|that)\s+to|change\s+name\s+to)\s+["']?([^"']+)["']?$/i);
    if (renameMatch) {
      const newName = renameMatch[1].trim();
      if (lastRole) {
        return {
          handled: false,
          resolvedPrompt: `rename role ${lastRole.name} to ${newName}`,
          contextual: true
        };
      } else if (lastChannel) {
        return {
          handled: false,
          resolvedPrompt: `rename channel ${lastChannel.name} to ${newName}`,
          contextual: true
        };
      }
    }

    // 3. "Give it the same permissions" / "Give it the same permissions as Moderator"
    const permMatch = clean.match(/^(?:give\s+it\s+the\s+same\s+permissions|use\s+the\s+same\s+permissions)(?:\s+as\s+(@?[\w.-]+))?$/i);
    if (permMatch && lastRole && scope.guild) {
      const refRoleName = permMatch[1] ? permMatch[1].replace(/^@/, '').trim() : null;
      if (refRoleName) {
        const rolesCache = scope.guild.roles?.cache;
        const allRoles = typeof rolesCache?.values === 'function'
          ? Array.from(rolesCache.values())
          : (Array.isArray(rolesCache) ? rolesCache : []);
        const matches = allRoles.filter(r => r.name?.toLowerCase() === refRoleName.toLowerCase());
        if (matches && matches.length > 1) {
          this.stats.ambiguousClarifications++;
          return {
            handled: true,
            outcome: 'clarification',
            message: `❓ **Clarification Needed:** I found multiple roles named "${refRoleName}" (${matches.map(r => r.id).join(', ')}). Which one would you like to copy permissions from?`
          };
        }
      }
    }

    // 4. "Delete the one we just created" / "Delete it"
    if (/^(?:delete|remove)\s+(?:the\s+one\s+we\s+just\s+created|the\s+created\s+one|what\s+we\s+just\s+made)$/i.test(clean)) {
      if (lastAction?.action === 'create_role' && lastRole) {
        return {
          handled: false,
          resolvedPrompt: `delete role ${lastRole.name}`,
          contextual: true
        };
      }
      if (lastAction?.action === 'create_channel' && lastChannel) {
        return {
          handled: false,
          resolvedPrompt: `delete channel ${lastChannel.name}`,
          contextual: true
        };
      }
    }

    // 5. "Do the same for the other channel"
    const sameChannelMatch = clean.match(/^do\s+the\s+same\s+(?:thing\s+)?for\s+(?:the\s+other\s+channel|#?([\w.-]+))$/i);
    if (sameChannelMatch && lastAction?.action) {
      const otherChannel = sameChannelMatch[1] || 'general';
      return {
        handled: false,
        resolvedPrompt: `${lastAction.action} in channel #${otherChannel}`,
        contextual: true
      };
    }

    return { handled: false, resolvedPrompt: clean };
  }

  _isCancellation(prompt) {
    return /^(?:cancel(?:\s+that|\s+the\s+task)?|never\s*mind|forget\s+(?:it|that)|stop\s+that|abort)$/i.test(prompt.trim());
  }

  _isUnrelatedCommand(prompt, pendingTask) {
    const clean = prompt.trim().toLowerCase();
    // Commands that should not be absorbed into a pending administrative task
    if (/^(?:play|skip|pause|resume|queue|np|nowplaying|stop|volume)\b/i.test(clean)) return true;
    if (/^(?:help|diagnose|dashboard|status|ping|uptime)\b/i.test(clean)) return true;
    if (/^(?:list\s+channels|list\s+roles|audit\s+server)\b/i.test(clean)) return true;
    return false;
  }

  _extractCorrection(prompt, task, guild) {
    const clean = prompt.trim();

    // 1. Color correction: "Actually, make it blue", "Change color to red", "Make it #FF0000"
    const colorMatch = clean.match(/^(?:actually[,\s]+)?(?:make|change|set)\s+(?:it|that|the\s+color|color)?\s+(?:to\s+)?([#\w]+)(?:\s+instead)?$/i);
    if (colorMatch) {
      const color = resolveColor(colorMatch[1]);
      if (color) return { color };
    }

    // 2. Name correction: "Change the name to Elite", "Actually, call it Elite"
    const nameMatch = clean.match(/^(?:actually[,\s]+)?(?:change\s+(?:the\s+)?name\s+to|call\s+it|rename\s+(?:it\s+)?to)\s+["']?([^"']+)["']?$/i);
    if (nameMatch) {
      return { name: nameMatch[1].trim() };
    }

    // 3. Permission inheritance: "Use the same permissions as VIP"
    const permMatch = clean.match(/^(?:use|give\s+it)\s+the\s+same\s+permissions\s+as\s+(@?[\w.-]+)$/i);
    if (permMatch && guild) {
      const refRoleName = permMatch[1].replace(/^@/, '').trim().toLowerCase();
      const role = guild.roles?.cache?.find(r => r.name.toLowerCase() === refRoleName);
      if (role) {
        return { permissions: role.permissions?.toArray ? role.permissions.toArray() : [] };
      }
    }

    return null;
  }

  _parseDuration(str) {
    if (!str) return null;
    const clean = str.trim().toLowerCase();
    const match = clean.match(/^(\d+)\s*(m(?:in(?:ute)?s?)?|h(?:(?:ou)?rs?)?|d(?:ays?)?|s(?:ec(?:ond)?s?)?)?$/i);
    if (!match) return null;

    const val = parseInt(match[1], 10);
    const unit = match[2] ? match[2][0] : 'm';

    if (unit === 'm') return val;
    if (unit === 'h') return val * 60;
    if (unit === 'd') return val * 1440;
    if (unit === 's') return Math.max(1, Math.round(val / 60));
    return val;
  }

  getStats() {
    return {
      ...this.stats,
      taskManager: this.taskManager.getStats(),
      memoryManager: this.memoryManager.getStats()
    };
  }
}

export const defaultContextResolutionPipeline = new ContextResolutionPipeline();
