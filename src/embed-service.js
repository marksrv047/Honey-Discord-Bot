import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  PermissionFlagsBits
} from 'discord.js';
import { resolveColor } from './color-utils.js';
import { Logger } from './logger.js';
import { ActionLedger } from './recovery.js';

const logger = new Logger('EmbedService');

export const DISCORD_EMBED_LIMITS = {
  TITLE_MAX: 256,
  DESCRIPTION_MAX: 4096,
  FIELDS_MAX: 25,
  FIELD_NAME_MAX: 256,
  FIELD_VALUE_MAX: 1024,
  FOOTER_TEXT_MAX: 2048,
  AUTHOR_NAME_MAX: 256,
  TOTAL_CHARS_MAX: 6000,
  EMBEDS_PER_MESSAGE_MAX: 10
};

export const EMBED_TEMPLATES = {
  announcement: {
    color: '#E67E22',
    defaultTitle: '📢 Server Announcement',
    defaultFooter: 'Server Announcement'
  },
  rules: {
    color: '#3498DB',
    defaultTitle: '📜 Server Rules & Guidelines',
    defaultFooter: 'Please adhere to Discord Terms of Service and Community Guidelines'
  },
  welcome: {
    color: '#2ECC71',
    defaultTitle: '👋 Welcome to the Server!',
    defaultFooter: 'Enjoy your stay and have fun!'
  },
  information: {
    color: '#5865F2',
    defaultTitle: 'ℹ️ Server Information & Guide',
    defaultFooter: 'Server Guide'
  },
  faq: {
    color: '#9B59B6',
    defaultTitle: '❓ Frequently Asked Questions',
    defaultFooter: 'Need more help? Contact our moderation team.'
  },
  event: {
    color: '#E91E63',
    defaultTitle: '🎉 Community Event',
    defaultFooter: 'Mark your calendars and join in!'
  },
  self_role: {
    color: '#9B59B6',
    defaultTitle: '🎭 Role Selection',
    defaultFooter: 'Click the buttons or select options below to toggle roles.'
  }
};

export class EmbedService {
  /**
   * Builds a Discord EmbedBuilder according to specs and template options.
   * Enforces all Discord character limits.
   */
  static buildEmbed(options = {}) {
    const templateName = options.template ? String(options.template).toLowerCase() : null;
    const template = templateName && EMBED_TEMPLATES[templateName] ? EMBED_TEMPLATES[templateName] : null;

    const embed = new EmbedBuilder();

    // 1. Color
    const rawColor = options.color || options.hexColor || template?.color || '#5865F2';
    const resolvedColor = resolveColor(rawColor) || 0x5865F2;
    embed.setColor(resolvedColor);

    // 2. Title & URL
    const title = options.title || template?.defaultTitle || null;
    if (title) {
      embed.setTitle(String(title).slice(0, DISCORD_EMBED_LIMITS.TITLE_MAX));
    }
    if (options.url && typeof options.url === 'string' && options.url.startsWith('http')) {
      embed.setURL(options.url);
    }

    // 3. Description
    const description = options.description || options.message || options.content || '';
    if (description) {
      embed.setDescription(String(description).slice(0, DISCORD_EMBED_LIMITS.DESCRIPTION_MAX));
    }

    // 4. Author
    if (options.author) {
      if (typeof options.author === 'string') {
        embed.setAuthor({ name: options.author.slice(0, DISCORD_EMBED_LIMITS.AUTHOR_NAME_MAX) });
      } else if (typeof options.author === 'object') {
        const authorObj = {
          name: String(options.author.name || 'Author').slice(0, DISCORD_EMBED_LIMITS.AUTHOR_NAME_MAX)
        };
        if (options.author.iconURL || options.author.icon_url) {
          authorObj.iconURL = options.author.iconURL || options.author.icon_url;
        }
        if (options.author.url) {
          authorObj.url = options.author.url;
        }
        embed.setAuthor(authorObj);
      }
    }

    // 5. Thumbnail
    const thumbnail = options.thumbnail || options.thumbnailUrl || options.thumbnail_url;
    if (thumbnail && typeof thumbnail === 'string' && thumbnail.startsWith('http')) {
      embed.setThumbnail(thumbnail);
    }

    // 6. Image
    const image = options.image || options.imageUrl || options.image_url;
    if (image && typeof image === 'string' && image.startsWith('http')) {
      embed.setImage(image);
    }

    // 7. Fields (up to 25 fields)
    if (Array.isArray(options.fields) && options.fields.length > 0) {
      const validFields = [];
      for (const field of options.fields.slice(0, DISCORD_EMBED_LIMITS.FIELDS_MAX)) {
        if (!field || typeof field !== 'object') continue;
        const name = String(field.name || 'Field').slice(0, DISCORD_EMBED_LIMITS.FIELD_NAME_MAX);
        const value = String(field.value || '\u200B').slice(0, DISCORD_EMBED_LIMITS.FIELD_VALUE_MAX);
        const inline = Boolean(field.inline);
        validFields.push({ name, value, inline });
      }
      if (validFields.length > 0) {
        embed.addFields(validFields);
      }
    }

    // 8. Footer
    const footerText = options.footer?.text || options.footer || template?.defaultFooter;
    if (footerText) {
      const footerObj = { text: String(footerText).slice(0, DISCORD_EMBED_LIMITS.FOOTER_TEXT_MAX) };
      if (options.footer?.iconURL || options.footer?.icon_url) {
        footerObj.iconURL = options.footer.iconURL || options.footer.icon_url;
      }
      embed.setFooter(footerObj);
    }

    // 9. Timestamp
    if (options.timestamp === true || options.timestamp === 'now') {
      embed.setTimestamp();
    } else if (options.timestamp) {
      try {
        embed.setTimestamp(new Date(options.timestamp));
      } catch {
        embed.setTimestamp();
      }
    }

    return embed;
  }

  /**
   * Validates total characters across an array of embeds to stay within Discord's 6,000 char message limit.
   */
  static calculateTotalCharacters(embeds) {
    let total = 0;
    for (const emb of embeds) {
      const data = emb.data || emb;
      if (data.title) total += data.title.length;
      if (data.description) total += data.description.length;
      if (data.footer?.text) total += data.footer.text.length;
      if (data.author?.name) total += data.author.name.length;
      if (Array.isArray(data.fields)) {
        for (const f of data.fields) {
          total += (f.name?.length || 0) + (f.value?.length || 0);
        }
      }
    }
    return total;
  }

  /**
   * Splits an array of embeds or oversized descriptions into batches that fit Discord message limits.
   */
  static chunkEmbedsForDelivery(embeds) {
    const batches = [];
    let currentBatch = [];
    let currentChars = 0;

    for (const emb of embeds) {
      const embChars = EmbedService.calculateTotalCharacters([emb]);

      if (currentBatch.length >= DISCORD_EMBED_LIMITS.EMBEDS_PER_MESSAGE_MAX || (currentChars + embChars > DISCORD_EMBED_LIMITS.TOTAL_CHARS_MAX && currentBatch.length > 0)) {
        batches.push(currentBatch);
        currentBatch = [];
        currentChars = 0;
      }

      currentBatch.push(emb);
      currentChars += embChars;
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    return batches;
  }

  /**
   * Builds interactive component rows (buttons or select menus) if specified in options.
   */
  static buildComponents(componentsOptions = []) {
    if (!Array.isArray(componentsOptions) || componentsOptions.length === 0) return [];

    const rows = [];
    let currentButtonRow = new ActionRowBuilder();

    for (const comp of componentsOptions) {
      if (comp.type === 'select' || comp.type === 'string_select' || comp.options) {
        // Select menu takes full row
        const select = new StringSelectMenuBuilder()
          .setCustomId(comp.customId || `select_${Date.now()}`)
          .setPlaceholder(comp.placeholder || 'Select an option...');

        const opts = (comp.options || []).map(o => {
          const optBuilder = new StringSelectMenuOptionBuilder()
            .setLabel(String(o.label || o.value || 'Option').slice(0, 100))
            .setValue(String(o.value || o.label || 'val').slice(0, 100));
          if (o.description) optBuilder.setDescription(String(o.description).slice(0, 100));
          if (o.emoji) optBuilder.setEmoji(o.emoji);
          return optBuilder;
        });

        if (opts.length > 0) {
          select.addOptions(opts.slice(0, 25));
          rows.push(new ActionRowBuilder().addComponents(select));
        }
      } else {
        // Button
        if (currentButtonRow.components.length >= 5) {
          rows.push(currentButtonRow);
          currentButtonRow = new ActionRowBuilder();
        }

        let style = ButtonStyle.Secondary;
        if (comp.style === 'Primary' || comp.style === 'primary') style = ButtonStyle.Primary;
        if (comp.style === 'Success' || comp.style === 'success') style = ButtonStyle.Success;
        if (comp.style === 'Danger' || comp.style === 'danger') style = ButtonStyle.Danger;
        if (comp.style === 'Link' || comp.style === 'link' || comp.url) style = ButtonStyle.Link;

        const btn = new ButtonBuilder()
          .setLabel(String(comp.label || comp.text || 'Action').slice(0, 80))
          .setStyle(style);

        if (style === ButtonStyle.Link && comp.url) {
          btn.setURL(comp.url);
        } else {
          btn.setCustomId(comp.customId || `btn_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`);
        }

        if (comp.emoji) {
          try {
            btn.setEmoji(comp.emoji);
          } catch {}
        }

        currentButtonRow.addComponents(btn);
      }
    }

    if (currentButtonRow.components.length > 0) {
      rows.push(currentButtonRow);
    }

    return rows.slice(0, 5); // Max 5 action rows
  }

  /**
   * Publishes rich embeds to a designated channel.
   */
  static async publishEmbed(guild, channelRef, options = {}, context = {}) {
    if (!channelRef) {
      return {
        success: false,
        error: 'Destination channel is required to publish an embed.',
        clarificationNeeded: 'Please specify the channel where the embed should be published (e.g. #announcements, #rules).'
      };
    }

    const cleanRef = String(channelRef).replace(/^[<#>]/g, '').trim().toLowerCase();
    const channelsList = guild.channels?.cache ? (typeof guild.channels.cache.find === 'function' ? guild.channels.cache : Array.from(guild.channels.cache.values())) : [];
    const channel = typeof context.resolveTarget === 'function'
      ? await context.resolveTarget(cleanRef, 'channel')
      : (typeof channelsList.find === 'function' ? channelsList.find(c => c.id === cleanRef || c.name?.toLowerCase() === cleanRef) : null);

    if (!channel) {
      return {
        success: false,
        error: `Channel "${channelRef}" not found in server.`,
        action: 'publish_embed'
      };
    }

    // Permission Check
    const botMember = guild.members?.me;
    if (botMember && typeof channel.permissionsFor === 'function') {
      const perms = channel.permissionsFor(botMember);
      if (!perms.has(PermissionFlagsBits.ViewChannel)) {
        return { success: false, error: `Bot lacks "View Channel" permission in #${channel.name}.` };
      }
      if (!perms.has(PermissionFlagsBits.SendMessages)) {
        return { success: false, error: `Bot lacks "Send Messages" permission in #${channel.name}.` };
      }
      if (!perms.has(PermissionFlagsBits.EmbedLinks)) {
        return { success: false, error: `Bot lacks "Embed Links" permission in #${channel.name}.` };
      }
    }

    // Prepare embeds array (support single embed or multiple embeds in options.embeds)
    let embedBuilders = [];
    if (Array.isArray(options.embeds) && options.embeds.length > 0) {
      embedBuilders = options.embeds.map(e => EmbedService.buildEmbed(e));
    } else {
      embedBuilders = [EmbedService.buildEmbed(options)];
    }

    // Prepare components
    const componentRows = EmbedService.buildComponents(options.components || options.buttons);

    // Chunk into Discord message batches if > 10 embeds or > 6000 chars
    const batches = EmbedService.chunkEmbedsForDelivery(embedBuilders);
    const sentMessages = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const payload = { embeds: batch };

      // Attach components to the last batch message
      if (i === batches.length - 1 && componentRows.length > 0) {
        payload.components = componentRows;
      }
      if (options.content) {
        payload.content = options.content;
      }

      const sent = await channel.send(payload);
      sentMessages.push(sent);

      if (context.executionId && guild.id) {
        ActionLedger.recordCreatedResource(context.executionId, 'message', sent.id, `Embed in #${channel.name}`, guild.id);
      }
    }

    return {
      success: true,
      action: 'publish_embed',
      channelId: channel.id,
      channelName: channel.name,
      messageId: sentMessages[0]?.id,
      messagesSent: sentMessages.length,
      embedCount: embedBuilders.length,
      details: `Published ${embedBuilders.length} embed(s) to #${channel.name}.`,
      verified: true
    };
  }

  /**
   * Edits an existing bot-authored embed message.
   */
  static async editEmbed(guild, channelRef, messageId, options = {}, context = {}) {
    if (!channelRef || !messageId) {
      return { success: false, error: 'Both channel and messageId are required to edit an embed.' };
    }

    const cleanRef = String(channelRef).replace(/^[<#>]/g, '').trim().toLowerCase();
    const channelsList = guild.channels?.cache ? (typeof guild.channels.cache.find === 'function' ? guild.channels.cache : Array.from(guild.channels.cache.values())) : [];
    const channel = typeof context.resolveTarget === 'function'
      ? await context.resolveTarget(cleanRef, 'channel')
      : (typeof channelsList.find === 'function' ? channelsList.find(c => c.id === cleanRef || c.name?.toLowerCase() === cleanRef) : null);

    if (!channel) {
      return { success: false, error: `Channel "${channelRef}" not found.` };
    }

    let targetMessage = null;
    try {
      targetMessage = await channel.messages.fetch(messageId);
    } catch (err) {
      return { success: false, error: `Could not fetch message ${messageId} in #${channel.name}: ${err.message}` };
    }

    if (!targetMessage) {
      return { success: false, error: `Message ${messageId} not found in #${channel.name}.` };
    }

    if (targetMessage.author.id !== guild.client.user?.id) {
      return { success: false, error: 'Cannot edit message: Discord only permits bots to edit messages they authored.' };
    }

    // Build replacement embeds
    let embedBuilders = [];
    if (Array.isArray(options.embeds) && options.embeds.length > 0) {
      embedBuilders = options.embeds.map(e => EmbedService.buildEmbed(e));
    } else {
      embedBuilders = [EmbedService.buildEmbed(options)];
    }

    const componentRows = EmbedService.buildComponents(options.components || options.buttons);
    const editPayload = { embeds: embedBuilders };
    if (componentRows.length > 0) {
      editPayload.components = componentRows;
    }
    if (options.content !== undefined) {
      editPayload.content = options.content;
    }

    await targetMessage.edit(editPayload);

    return {
      success: true,
      action: 'edit_embed',
      channelId: channel.id,
      channelName: channel.name,
      messageId: targetMessage.id,
      details: `Successfully updated embed message in #${channel.name}.`,
      verified: true
    };
  }
}
