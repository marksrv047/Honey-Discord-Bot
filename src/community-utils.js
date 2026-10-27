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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = new Logger('CommunityUtils');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const COMMUNITY_FILE = path.join(DATA_DIR, 'community-utils.json');

/**
 * CommunityUtils
 * High-utility community engagement suite:
 * - Interactive Button Polls with live percentage bars
 * - Server Suggestions System with Upvote/Downvote and Staff Review
 * - Starboard with customizable reaction threshold
 * - FAQ & Auto-Responders
 */
export class CommunityUtils {
  static _polls = new Map();         // pollId -> PollRecord
  static _suggestions = new Map();   // suggestionId -> SuggestionRecord
  static _starboardConfig = new Map(); // guildId -> StarboardConfig
  static _starboardMessages = new Map(); // `${guildId}:${messageId}` -> starboardPostId
  static _autoResponses = new Map(); // guildId -> Array<AutoResponse>
  static _isLoaded = false;
  static _storagePath = COMMUNITY_FILE;

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
        logger.error('Failed to create data directory for community utils', { error: err.message });
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
        this._polls.clear();
        this._suggestions.clear();
        this._starboardConfig.clear();
        this._starboardMessages.clear();
        this._autoResponses.clear();

        if (parsed.polls) {
          for (const [id, p] of Object.entries(parsed.polls)) this._polls.set(id, p);
        }
        if (parsed.suggestions) {
          for (const [id, s] of Object.entries(parsed.suggestions)) this._suggestions.set(id, s);
        }
        if (parsed.starboardConfig) {
          for (const [gId, conf] of Object.entries(parsed.starboardConfig)) this._starboardConfig.set(gId, conf);
        }
        if (parsed.starboardMessages) {
          for (const [key, pId] of Object.entries(parsed.starboardMessages)) this._starboardMessages.set(key, pId);
        }
        if (parsed.autoResponses) {
          for (const [gId, list] of Object.entries(parsed.autoResponses)) this._autoResponses.set(gId, list);
        }
      }
      this._isLoaded = true;
    } catch (err) {
      logger.error('Failed to load community utils from disk', { error: err.message });
      this._isLoaded = true;
    }
  }

  static saveAll() {
    this._ensureDataDir();
    try {
      const serializable = {
        polls: Object.fromEntries(this._polls),
        suggestions: Object.fromEntries(this._suggestions),
        starboardConfig: Object.fromEntries(this._starboardConfig),
        starboardMessages: Object.fromEntries(this._starboardMessages),
        autoResponses: Object.fromEntries(this._autoResponses)
      };
      const tmpFile = `${this.storagePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpFile, JSON.stringify(serializable, null, 2), 'utf8');
      fs.renameSync(tmpFile, this.storagePath);
    } catch (err) {
      logger.error('Failed to save community utils to disk', { error: err.message });
    }
  }

  // =========================================================================
  // 1. POLLS
  // =========================================================================
  static async createPoll(channel, { question, options, creator, multiSelect = false }) {
    if (!channel || !question || !Array.isArray(options) || options.length < 2) {
      throw new Error('Polls require a question and at least 2 options.');
    }

    const pollId = `POLL-${Math.floor(1000 + Math.random() * 9000)}`;
    const letters = ['🇦', '🇧', '🇨', '🇩', '🇪'];
    const pollOptions = options.slice(0, 5).map((opt, i) => ({
      index: i,
      label: opt,
      emoji: letters[i],
      votes: [] // userIds
    }));

    const pollRecord = {
      pollId,
      guildId: channel.guild?.id || channel.guildId,
      channelId: channel.id,
      question,
      options: pollOptions,
      creatorId: creator?.id || 'admin',
      creatorTag: creator?.tag || 'Staff',
      multiSelect: Boolean(multiSelect),
      isOpen: true,
      createdAt: new Date().toISOString()
    };

    const embed = this._renderPollEmbed(pollRecord);
    const rows = this._buildPollButtons(pollRecord);

    const msg = await channel.send({ embeds: [embed], components: rows });
    pollRecord.messageId = msg.id;

    this.loadAll();
    this._polls.set(pollId, pollRecord);
    this.saveAll();

    return pollRecord;
  }

  static _renderPollEmbed(poll) {
    const totalVotes = poll.options.reduce((acc, o) => acc + o.votes.length, 0);

    const embed = new EmbedBuilder()
      .setTitle(`📊 Community Poll: ${poll.question}`)
      .setColor(poll.isOpen ? 0xFEE75C : 0x7F8C8D)
      .setFooter({ text: `Poll ID: ${poll.pollId} • Created by ${poll.creatorTag} • ${poll.isOpen ? 'Active' : 'Closed'}` });

    let desc = poll.isOpen ? 'Click the corresponding letter button below to vote!\n\n' : '**This poll is now closed.** Final results:\n\n';

    for (const opt of poll.options) {
      const count = opt.votes.length;
      const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
      const barFilled = Math.round(pct / 10);
      const bar = '█'.repeat(barFilled) + '░'.repeat(10 - barFilled);
      desc += `${opt.emoji} **${opt.label}**\n${bar} **${pct}%** (${count} votes)\n\n`;
    }

    embed.setDescription(desc);
    return embed;
  }

  static _buildPollButtons(poll) {
    if (!poll.isOpen) return [];
    const row = new ActionRowBuilder();
    for (const opt of poll.options) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`poll:vote:${poll.pollId}:${opt.index}`)
          .setEmoji(opt.emoji)
          .setLabel(opt.label.slice(0, 40))
          .setStyle(ButtonStyle.Secondary)
      );
    }
    return [row];
  }

  static async handleVote(interaction) {
    if (!interaction.isButton() || !interaction.customId.startsWith('poll:vote:')) return false;

    this.loadAll();
    const parts = interaction.customId.split(':');
    const pollId = parts[2];
    const optionIndex = parseInt(parts[3], 10);

    const poll = this._polls.get(pollId);
    if (!poll || !poll.isOpen) {
      await interaction.reply({ content: '⚠️ This poll is closed or no longer available.', ephemeral: true });
      return true;
    }

    const userId = interaction.user.id;
    const targetOption = poll.options[optionIndex];
    if (!targetOption) return false;

    // Toggle vote or single vote
    if (targetOption.votes.includes(userId)) {
      targetOption.votes = targetOption.votes.filter(id => id !== userId);
    } else {
      if (!poll.multiSelect) {
        for (const opt of poll.options) {
          opt.votes = opt.votes.filter(id => id !== userId);
        }
      }
      targetOption.votes.push(userId);
    }

    this.saveAll();

    // Update message
    const updatedEmbed = this._renderPollEmbed(poll);
    await interaction.update({ embeds: [updatedEmbed] });
    return true;
  }

  // =========================================================================
  // 2. SUGGESTIONS
  // =========================================================================
  static async submitSuggestion(channel, { content, author }) {
    if (!channel || !content) throw new Error('Suggestion requires a channel and content.');

    const sugId = `SUG-${Math.floor(1000 + Math.random() * 9000)}`;
    const record = {
      id: sugId,
      guildId: channel.guild?.id || channel.guildId,
      channelId: channel.id,
      authorId: author.id,
      authorTag: author.tag,
      content,
      status: 'PENDING',
      upvotes: [],
      downvotes: [],
      createdAt: new Date().toISOString()
    };

    const embed = this._renderSuggestionEmbed(record);
    const buttons = this._buildSuggestionButtons(record);

    const msg = await channel.send({ embeds: [embed], components: [buttons] });
    record.messageId = msg.id;

    this.loadAll();
    this._suggestions.set(sugId, record);
    this.saveAll();

    return record;
  }

  static _renderSuggestionEmbed(record) {
    const statusColors = {
      PENDING: 0xFEE75C,
      APPROVED: 0x57F287,
      DENIED: 0xED4245,
      IMPLEMENTED: 0x5865F2
    };

    const embed = new EmbedBuilder()
      .setTitle(`💡 Suggestion [${record.id}] — Status: ${record.status}`)
      .setDescription(record.content)
      .setColor(statusColors[record.status] || 0xFEE75C)
      .addFields(
        { name: 'Submitted by', value: `<@${record.authorId}> (${record.authorTag})`, inline: true },
        { name: 'Community Score', value: `👍 **${record.upvotes.length}** | 👎 **${record.downvotes.length}**`, inline: true }
      )
      .setTimestamp();

    if (record.reviewedBy) {
      embed.addFields({ name: 'Staff Reviewer', value: `<@${record.reviewedBy.id}> (${record.reviewedBy.tag})` });
    }

    return embed;
  }

  static _buildSuggestionButtons(record) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`sug:up:${record.id}`)
        .setLabel(`Upvote (${record.upvotes.length})`)
        .setEmoji('👍')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`sug:down:${record.id}`)
        .setLabel(`Downvote (${record.downvotes.length})`)
        .setEmoji('👎')
        .setStyle(ButtonStyle.Secondary)
    );

    return row;
  }

  static async handleSuggestionInteraction(interaction) {
    if (!interaction.isButton() || !interaction.customId.startsWith('sug:')) return false;

    this.loadAll();
    const parts = interaction.customId.split(':');
    const action = parts[1]; // 'up' | 'down' | 'review'
    const sugId = parts[2];

    const record = this._suggestions.get(sugId);
    if (!record) {
      await interaction.reply({ content: '⚠️ Suggestion record not found.', ephemeral: true });
      return true;
    }

    const userId = interaction.user.id;

    if (action === 'up') {
      record.downvotes = record.downvotes.filter(id => id !== userId);
      if (record.upvotes.includes(userId)) {
        record.upvotes = record.upvotes.filter(id => id !== userId);
      } else {
        record.upvotes.push(userId);
      }
    } else if (action === 'down') {
      record.upvotes = record.upvotes.filter(id => id !== userId);
      if (record.downvotes.includes(userId)) {
        record.downvotes = record.downvotes.filter(id => id !== userId);
      } else {
        record.downvotes.push(userId);
      }
    }

    this.saveAll();

    const embed = this._renderSuggestionEmbed(record);
    const buttons = this._buildSuggestionButtons(record);
    await interaction.update({ embeds: [embed], components: [buttons] });
    return true;
  }

  // =========================================================================
  // 3. STARBOARD
  // =========================================================================
  static getStarboardConfig(guildId) {
    this.loadAll();
    return this._starboardConfig.get(guildId) || {
      enabled: false,
      channelId: null,
      threshold: 3,
      emoji: '⭐'
    };
  }

  static setStarboardConfig(guildId, conf) {
    this.loadAll();
    this._starboardConfig.set(guildId, {
      ...this.getStarboardConfig(guildId),
      ...conf
    });
    this.saveAll();
    return this.getStarboardConfig(guildId);
  }

  static async handleReaction(reaction, user, client) {
    if (!reaction || reaction.emoji?.name !== '⭐' || !reaction.message.guild) return;
    const guild = reaction.message.guild;
    const config = this.getStarboardConfig(guild.id);
    if (!config.enabled || !config.channelId) return;

    if (reaction.count < config.threshold) return;

    const message = reaction.message;
    const key = `${guild.id}:${message.id}`;
    if (this._starboardMessages.has(key)) return; // Already posted

    const starboardChannel = guild.channels.cache.get(config.channelId);
    if (!starboardChannel || !starboardChannel.isTextBased()) return;

    const embed = new EmbedBuilder()
      .setAuthor({
        name: message.author?.tag || 'User',
        iconURL: message.author?.displayAvatarURL ? message.author.displayAvatarURL() : undefined
      })
      .setDescription(message.content || '*(Image or Attachment)*')
      .setColor(0xFEE75C)
      .addFields(
        { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
        { name: 'Original', value: `[Jump to Message](${message.url})`, inline: true }
      )
      .setFooter({ text: `⭐ ${reaction.count} | ID: ${message.id}` })
      .setTimestamp(message.createdAt);

    if (message.attachments && message.attachments.size > 0) {
      const firstAttachment = message.attachments.first();
      if (firstAttachment.contentType?.startsWith('image/')) {
        embed.setImage(firstAttachment.url);
      }
    }

    const post = await starboardChannel.send({ embeds: [embed] });
    this._starboardMessages.set(key, post.id);
    this.saveAll();
    logger.info(`Posted starboard message ${message.id} to #${starboardChannel.name}`);
  }

  // =========================================================================
  // 4. AUTO-RESPONSES
  // =========================================================================
  static getAutoResponses(guildId) {
    this.loadAll();
    return this._autoResponses.get(guildId) || [];
  }

  static addAutoResponse(guildId, { trigger, response, isExact = false }) {
    this.loadAll();
    const list = this.getAutoResponses(guildId);
    const item = {
      id: `FAQ-${Date.now().toString(36)}`,
      trigger: String(trigger).toLowerCase().trim(),
      response: String(response),
      isExact: Boolean(isExact)
    };
    list.push(item);
    this._autoResponses.set(guildId, list);
    this.saveAll();
    return item;
  }

  static async checkAutoResponse(message) {
    if (!message || !message.guild || message.author?.bot) return false;
    const list = this.getAutoResponses(message.guild.id);
    if (list.length === 0) return false;

    const text = message.content.toLowerCase().trim();
    for (const item of list) {
      const matched = item.isExact ? text === item.trigger : text.includes(item.trigger);
      if (matched) {
        await message.reply(item.response).catch(() => {});
        return true;
      }
    }
    return false;
  }
}
