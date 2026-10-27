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
import { HoneypotRetentionService } from './honeypot-retention.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = new Logger('Scheduler');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const SCHEDULER_FILE = path.join(DATA_DIR, 'scheduled-tasks.json');

/**
 * TaskScheduler
 * Persistent job queue and event coordinator for reminders, scheduled announcements,
 * recurring intervals, and Discord scheduled events with RSVP management.
 */
export class TaskScheduler {
  static _tasks = new Map(); // taskId -> TaskRecord
  static _events = new Map(); // eventId -> EventRecord
  static _isLoaded = false;
  static _storagePath = SCHEDULER_FILE;
  static _sweepInterval = null;

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
        logger.error('Failed to create data directory for scheduler', { error: err.message });
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
        this._tasks.clear();
        this._events.clear();

        if (parsed.tasks) {
          for (const [id, t] of Object.entries(parsed.tasks)) {
            this._tasks.set(id, t);
          }
        }
        if (parsed.events) {
          for (const [id, e] of Object.entries(parsed.events)) {
            this._events.set(id, e);
          }
        }
      }
      this._isLoaded = true;
    } catch (err) {
      logger.error('Failed to load scheduler records from disk', { error: err.message });
      this._isLoaded = true;
    }
  }

  static saveAll() {
    this._ensureDataDir();
    try {
      const serializable = {
        tasks: Object.fromEntries(this._tasks),
        events: Object.fromEntries(this._events)
      };
      const tmpFile = `${this.storagePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpFile, JSON.stringify(serializable, null, 2), 'utf8');
      fs.renameSync(tmpFile, this.storagePath);
    } catch (err) {
      logger.error('Failed to save scheduler records to disk', { error: err.message });
    }
  }

  // =========================================================================
  // 1. REMINDERS & SCHEDULED ANNOUNCEMENTS
  // =========================================================================
  static scheduleReminder(guildId, channelId, userId, message, targetTime) {
    this.loadAll();
    const taskId = `REMIND-${Math.floor(1000 + Math.random() * 9000)}`;
    const task = {
      id: taskId,
      type: 'REMINDER',
      guildId,
      channelId,
      userId,
      message,
      targetTime: new Date(targetTime).toISOString(),
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    this._tasks.set(taskId, task);
    this.saveAll();
    logger.info(`Scheduled reminder [${taskId}] for <@${userId}> at ${task.targetTime}`);
    return task;
  }

  static scheduleAnnouncement(guildId, channelId, { title, content, color, authorId }, targetTime) {
    this.loadAll();
    const taskId = `ANNOUNCE-${Math.floor(1000 + Math.random() * 9000)}`;
    const task = {
      id: taskId,
      type: 'ANNOUNCEMENT',
      guildId,
      channelId,
      title,
      content,
      color: color || 0xFEE75C,
      authorId,
      targetTime: new Date(targetTime).toISOString(),
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    this._tasks.set(taskId, task);
    this.saveAll();
    logger.info(`Scheduled announcement [${taskId}] at ${task.targetTime}`);
    return task;
  }

  static listTasks(guildId, status = 'pending') {
    this.loadAll();
    return Array.from(this._tasks.values())
      .filter(t => t.guildId === guildId && (!status || t.status === status))
      .sort((a, b) => new Date(a.targetTime) - new Date(b.targetTime));
  }

  static cancelTask(guildId, taskId) {
    this.loadAll();
    const task = this._tasks.get(taskId);
    if (!task || task.guildId !== guildId) return false;
    task.status = 'cancelled';
    this.saveAll();
    return true;
  }

  // =========================================================================
  // 2. DISCORD EVENTS & RSVP
  // =========================================================================
  static async createCommunityEvent(channel, { title, description, startTime, location, creator }) {
    if (!channel || !title || !startTime) throw new Error('Events require channel, title, and start time.');

    const eventId = `EVENT-${Math.floor(1000 + Math.random() * 9000)}`;
    const eventRecord = {
      id: eventId,
      guildId: channel.guild?.id || channel.guildId,
      channelId: channel.id,
      title,
      description,
      location: location || 'Discord Server',
      startTime: new Date(startTime).toISOString(),
      creatorId: creator?.id || 'admin',
      creatorTag: creator?.tag || 'Staff',
      rsvps: {
        attending: [],
        maybe: [],
        declined: []
      },
      createdAt: new Date().toISOString()
    };

    const embed = this._renderEventEmbed(eventRecord);
    const buttons = this._buildEventButtons(eventRecord);

    const msg = await channel.send({ embeds: [embed], components: [buttons] });
    eventRecord.messageId = msg.id;

    this.loadAll();
    this._events.set(eventId, eventRecord);
    this.saveAll();

    return eventRecord;
  }

  static _renderEventEmbed(evt) {
    const unixTimestamp = Math.floor(new Date(evt.startTime).getTime() / 1000);

    const embed = new EmbedBuilder()
      .setTitle(`📅 Community Event: ${evt.title}`)
      .setDescription(evt.description || 'Join us for this server event!')
      .setColor(0x3498DB)
      .addFields(
        { name: 'Start Time', value: `<t:${unixTimestamp}:F> (<t:${unixTimestamp}:R>)`, inline: true },
        { name: 'Location', value: evt.location, inline: true },
        { name: 'RSVP Summary', value: `✅ **Attending:** ${evt.rsvps.attending.length}\n❓ **Maybe:** ${evt.rsvps.maybe.length}\n❌ **Declined:** ${evt.rsvps.declined.length}` }
      )
      .setFooter({ text: `Event ID: ${evt.id} • Organized by ${evt.creatorTag}` })
      .setTimestamp(new Date(evt.startTime));

    return embed;
  }

  static _buildEventButtons(evt) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rsvp:attending:${evt.id}`)
        .setLabel(`Attending (${evt.rsvps.attending.length})`)
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`rsvp:maybe:${evt.id}`)
        .setLabel(`Maybe (${evt.rsvps.maybe.length})`)
        .setEmoji('❓')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`rsvp:declined:${evt.id}`)
        .setLabel(`Can't Go (${evt.rsvps.declined.length})`)
        .setEmoji('❌')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  static async handleRsvpInteraction(interaction) {
    if (!interaction.isButton() || !interaction.customId.startsWith('rsvp:')) return false;

    this.loadAll();
    const parts = interaction.customId.split(':');
    const response = parts[1]; // 'attending' | 'maybe' | 'declined'
    const eventId = parts[2];

    const evt = this._events.get(eventId);
    if (!evt) {
      await interaction.reply({ content: '⚠️ Event record not found.', ephemeral: true });
      return true;
    }

    const userId = interaction.user.id;
    evt.rsvps.attending = evt.rsvps.attending.filter(id => id !== userId);
    evt.rsvps.maybe = evt.rsvps.maybe.filter(id => id !== userId);
    evt.rsvps.declined = evt.rsvps.declined.filter(id => id !== userId);

    evt.rsvps[response].push(userId);
    this.saveAll();

    const embed = this._renderEventEmbed(evt);
    const buttons = this._buildEventButtons(evt);
    await interaction.update({ embeds: [embed], components: [buttons] });
    return true;
  }

  // =========================================================================
  // 3. BACKGROUND SWEEPER
  // =========================================================================
  static async checkPendingTasks(client) {
    if (!client) return;
    this.loadAll();
    const now = Date.now();

    for (const [id, task] of this._tasks.entries()) {
      if (task.status === 'pending' && new Date(task.targetTime).getTime() <= now) {
        task.status = 'executed';
        task.executedAt = new Date().toISOString();

        try {
          const guild = client.guilds.cache.get(task.guildId) || await client.guilds.fetch(task.guildId).catch(() => null);
          if (guild) {
            const channel = guild.channels.cache.get(task.channelId) || await guild.channels.fetch(task.channelId).catch(() => null);
            if (channel && channel.isTextBased()) {
              if (task.type === 'REMINDER') {
                await channel.send({
                  content: `⏰ **Reminder for <@${task.userId}>:**\n${task.message}`
                });
              } else if (task.type === 'ANNOUNCEMENT') {
                const embed = new EmbedBuilder()
                  .setTitle(task.title || 'Official Announcement')
                  .setDescription(task.content || '')
                  .setColor(task.color || 0xFEE75C)
                  .setFooter({ text: 'Scheduled Community Broadcast' })
                  .setTimestamp();
                await channel.send({ embeds: [embed] });
              }
            }
          }
        } catch (err) {
          logger.error(`Error executing task ${id}`, { error: err.message });
          task.error = err.message;
        }
      }
    }

    this.saveAll();

    // Automated periodic cleanup of expired Honeypot security log messages
    if (client) {
      await HoneypotRetentionService.cleanupExpired(client).catch(() => {});
    }
  }

  static startScheduler(client, intervalMs = 20000) {
    if (this._sweepInterval) clearInterval(this._sweepInterval);
    this._sweepInterval = setInterval(() => {
      this.checkPendingTasks(client).catch(err => {
        logger.error('Error in scheduler interval sweep', { error: err.message });
      });
    }, intervalMs);
    if (typeof this._sweepInterval?.unref === 'function') {
      this._sweepInterval.unref();
    }
    this.checkPendingTasks(client).catch(() => {});
  }

  static stopScheduler() {
    if (this._sweepInterval) {
      clearInterval(this._sweepInterval);
      this._sweepInterval = null;
    }
  }
}
