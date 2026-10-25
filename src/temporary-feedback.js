import { Logger } from './logger.js';

const logger = new Logger('TemporaryFeedback');

/**
 * Shared Temporary Feedback Utility.
 * Manages clean, ephemeral-feeling in-channel confirmations with bounded automatic deletion.
 * - Default delay: 7 seconds (clamped to 5–10s range)
 * - Safe error handling: ignores Unknown Message (10008) or Missing Permissions (50013)
 * - Never affects permanent moderation log entries
 */
export class TemporaryFeedback {
  static DEFAULT_DELAY_MS = 7000;
  static MIN_DELAY_MS = 5000;
  static MAX_DELAY_MS = 10000;

  /**
   * Clamps a specified delay into the approved 5-10 second window (5000ms - 10000ms).
   * Accepts delay either in seconds (e.g. 7) or milliseconds (e.g. 7000).
   */
  static clampDelay(delay = TemporaryFeedback.DEFAULT_DELAY_MS) {
    let num = Number(delay);
    if (isNaN(num)) return TemporaryFeedback.DEFAULT_DELAY_MS;
    if (num < 100) num = num * 1000; // Treat values < 100 as seconds
    return Math.min(Math.max(num, TemporaryFeedback.MIN_DELAY_MS), TemporaryFeedback.MAX_DELAY_MS);
  }

  /**
   * Safely deletes a message without throwing unhandled rejections on 10008 or 50013.
   */
  static async safeDeleteMessage(message) {
    if (!message || typeof message.delete !== 'function') return false;
    try {
      await message.delete();
      return true;
    } catch (err) {
      if (err.code !== 10008 && err.code !== 50013) {
        logger.warn('Failed to delete temporary feedback message', { code: err.code, error: err.message });
      }
      return false;
    }
  }

  /**
   * Schedules deletion of a bot-authored message after a constrained delay.
   */
  static scheduleDeletion(message, delay = TemporaryFeedback.DEFAULT_DELAY_MS) {
    if (!message || typeof message.delete !== 'function') {
      return null;
    }

    const effectiveDelay = TemporaryFeedback.clampDelay(delay);

    return setTimeout(async () => {
      await TemporaryFeedback.safeDeleteMessage(message);
    }, effectiveDelay);
  }

  /**
   * Sends a temporary feedback message to a Discord channel and schedules its deletion.
   */
  static async sendTemporary(channel, contentOrOptions, delayMs = TemporaryFeedback.DEFAULT_DELAY_MS) {
    if (!channel || typeof channel.send !== 'function') {
      return null;
    }

    try {
      const payload = typeof contentOrOptions === 'string' ? { content: contentOrOptions } : contentOrOptions;
      const message = await channel.send(payload);
      TemporaryFeedback.scheduleDeletion(message, delayMs);
      return message;
    } catch (err) {
      logger.warn('Failed to send temporary channel message', { error: err.message });
      return null;
    }
  }

  /**
   * Edits an interaction reply and, if possible, schedules its deletion.
   * If interaction reply cannot be deleted directly, attempts to fetch and delete.
   */
  static async editAndScheduleDeletion(interaction, contentOrOptions, delayMs = TemporaryFeedback.DEFAULT_DELAY_MS) {
    if (!interaction) return null;

    try {
      const payload = typeof contentOrOptions === 'string' ? { content: contentOrOptions, embeds: [], components: [] } : contentOrOptions;
      const replyMessage = await interaction.editReply(payload);
      if (replyMessage && typeof replyMessage.delete === 'function') {
        TemporaryFeedback.scheduleDeletion(replyMessage, delayMs);
      }
      return replyMessage;
    } catch (err) {
      logger.warn('Failed to edit or schedule deletion of interaction reply', { error: err.message });
      return null;
    }
  }
}
