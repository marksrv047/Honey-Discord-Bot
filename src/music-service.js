import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  StreamType,
  entersState,
  getVoiceConnection
} from '@discordjs/voice';
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { Ytdl } from '@distube/ytdl-core';
import play from 'play-dl';
import ffmpegPath from 'ffmpeg-static';
import { Logger } from './logger.js';

if (ffmpegPath && !process.env.FFMPEG_PATH) {
  process.env.FFMPEG_PATH = ffmpegPath;
}

const logger = new Logger('MusicService');
const ytdl = new Ytdl();

/**
 * Formats seconds into MM:SS or HH:MM:SS
 */
export function formatDuration(seconds) {
  const total = Math.max(0, parseInt(seconds, 10) || 0);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Generates an ASCII audio progress bar
 */
export function buildProgressBar(currentSec, totalSec, barLength = 15) {
  if (!totalSec || totalSec <= 0) return '🔘' + '─'.repeat(barLength);
  const progress = Math.min(1, Math.max(0, currentSec / totalSec));
  const progressIndex = Math.round(progress * barLength);
  let bar = '';
  for (let i = 0; i <= barLength; i++) {
    if (i === progressIndex) {
      bar += '🔘';
    } else {
      bar += '─';
    }
  }
  return bar;
}

/**
 * Intelligent similarity ranking scoring for music search results.
 * Prioritizes exact title and artist matches, official releases, and penalizes covers/parodies.
 */
export function scoreTrack(query, track) {
  const q = String(query || '').toLowerCase().trim();
  const title = String(track.title || track.name || '').toLowerCase();
  const author = String(track.author?.name || track.channel?.name || track.author || '').toLowerCase();

  let score = 0;

  // Exact title match
  if (title === q) score += 100;
  else if (title.includes(q)) score += 50;

  // Word-level matching
  const qWords = q.split(/[\s-]+/).filter(w => w.length > 2);
  let matchedWords = 0;
  for (const w of qWords) {
    if (title.includes(w)) matchedWords++;
    if (author.includes(w)) score += 20;
  }
  score += (matchedWords / Math.max(1, qWords.length)) * 40;

  // Artist match bonus
  if (author && (q.includes(author) || author.includes(q))) {
    score += 35;
  }

  // Official channel bonus
  if (track.author?.verified || track.badges?.includes('Official Artist Channel') || /official\s+(audio|video|lyric)/i.test(title)) {
    score += 25;
  }

  // Penalize covers, karaoke, and slowed versions unless requested
  if (!/cover/i.test(q) && /cover\b/i.test(title)) score -= 30;
  if (!/remix/i.test(q) && /remix\b/i.test(title)) score -= 20;
  if (!/karaoke/i.test(q) && /karaoke\b/i.test(title)) score -= 40;
  if (!/slowed/i.test(q) && /slowed\b/i.test(title)) score -= 25;
  if (!/live/i.test(q) && /live\b/i.test(title)) score -= 15;

  return score;
}

export function rankTracks(query, tracks) {
  if (!Array.isArray(tracks) || tracks.length <= 1) return tracks || [];
  return [...tracks].sort((a, b) => scoreTrack(query, b) - scoreTrack(query, a));
}

/**
 * MusicSubscription manages per-guild voice connection, player, and queue state.
 */
export class MusicSubscription {
  constructor(voiceConnection, textChannel, guildId) {
    this.voiceConnection = voiceConnection;
    this.textChannel = textChannel;
    this.guildId = guildId;

    this.audioPlayer = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause
      }
    });

    this.queue = [];
    this.currentTrack = null;
    this.currentResource = null;
    this.volume = 1.0;
    this.isPaused = false;
    this.loopMode = 'off'; // 'off' | 'track' | 'queue'
    this.idleTimer = null;
    this.startedAt = 0;
    this.pausedAt = 0;
    this.totalPausedDuration = 0;

    this.voiceConnection.subscribe(this.audioPlayer);

    this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
      this.handleTrackEnded();
    });

    this.audioPlayer.on('error', (err) => {
      logger.error('AudioPlayer playback error', { guildId: this.guildId, error: err.message });
      this.handleTrackEnded();
    });

    this.voiceConnection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.voiceConnection, VoiceConnectionStatus.Signalling, 5000),
          entersState(this.voiceConnection, VoiceConnectionStatus.Connecting, 5000)
        ]);
      } catch {
        this.destroy();
      }
    });

    this.resetIdleTimer();
  }

  resetIdleTimer() {
    this.clearIdleTimer();
    // 5 minutes idle timeout before leaving voice channel
    this.idleTimer = setTimeout(() => {
      logger.info('Idle disconnect timer expired', { guildId: this.guildId });
      this.destroy();
    }, 5 * 60 * 1000);
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  getElapsedSeconds() {
    if (!this.startedAt) return 0;
    if (this.isPaused && this.pausedAt) {
      return Math.floor((this.pausedAt - this.startedAt - this.totalPausedDuration) / 1000);
    }
    return Math.floor((Date.now() - this.startedAt - this.totalPausedDuration) / 1000);
  }

  async handleTrackEnded() {
    if (this.loopMode === 'track' && this.currentTrack) {
      await this.startPlayback(this.currentTrack);
      return;
    }

    if (this.loopMode === 'queue' && this.currentTrack) {
      this.queue.push(this.currentTrack);
    }

    if (this.queue.length > 0) {
      const nextTrack = this.queue.shift();
      await this.startPlayback(nextTrack);
    } else {
      this.currentTrack = null;
      this.currentResource = null;
      this.startedAt = 0;
      this.resetIdleTimer();
    }
  }

  async startPlayback(track) {
    this.clearIdleTimer();
    this.currentTrack = track;
    this.isPaused = false;
    this.totalPausedDuration = 0;

    try {
      let stream;
      try {
        stream = await ytdl.download(track.url, {
          filter: (format) => format.hasAudio && !format.hasVideo,
          quality: 'highestaudio',
          highWaterMark: 1 << 25
        });
      } catch (ytdlErr) {
        logger.warn('ytdl download failed, attempting play-dl fallback', { error: ytdlErr.message });
        const playStream = await play.stream(track.url);
        stream = playStream.stream;
      }

      if (stream && typeof stream.on === 'function') {
        stream.on('error', (streamErr) => {
          logger.error('Audio stream error', { guildId: this.guildId, error: streamErr.message });
        });
      }

      this.currentResource = createAudioResource(stream, {
        inlineVolume: true,
        inputType: StreamType.Arbitrary
      });

      if (this.currentResource.volume) {
        this.currentResource.volume.setVolume(this.volume);
      }

      this.audioPlayer.play(this.currentResource);
      this.startedAt = Date.now();
      logger.info('Started music playback', { guildId: this.guildId, title: track.title });
    } catch (err) {
      logger.error('Failed to create audio resource for track', { error: err.message, track: track.title });
      this.handleTrackEnded();
    }
  }

  pause() {
    if (this.isPaused || !this.currentTrack) return false;
    const paused = this.audioPlayer.pause();
    if (paused) {
      this.isPaused = true;
      this.pausedAt = Date.now();
    }
    return paused;
  }

  resume() {
    if (!this.isPaused || !this.currentTrack) return false;
    const unpaused = this.audioPlayer.unpause();
    if (unpaused) {
      this.isPaused = false;
      if (this.pausedAt) {
        this.totalPausedDuration += Date.now() - this.pausedAt;
        this.pausedAt = 0;
      }
    }
    return unpaused;
  }

  skip() {
    if (!this.currentTrack && this.queue.length === 0) return null;
    const skipped = this.currentTrack;
    this.audioPlayer.stop(); // triggers AudioPlayerStatus.Idle -> handleTrackEnded
    return skipped;
  }

  stop() {
    this.queue = [];
    this.currentTrack = null;
    this.audioPlayer.stop();
    this.destroy();
  }

  setVolume(newVolume) {
    this.volume = Math.max(0, Math.min(1.5, newVolume));
    if (this.currentResource && this.currentResource.volume) {
      this.currentResource.volume.setVolume(this.volume);
    }
    return Math.round(this.volume * 100);
  }

  shuffleQueue() {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
    return this.queue.length;
  }

  clearQueue() {
    const count = this.queue.length;
    this.queue = [];
    return count;
  }

  setLoopMode(mode) {
    if (['off', 'track', 'queue'].includes(mode)) {
      this.loopMode = mode;
    }
    return this.loopMode;
  }

  destroy() {
    this.clearIdleTimer();
    try {
      this.audioPlayer.stop(true);
    } catch {}
    try {
      this.voiceConnection.destroy();
    } catch {}
    MusicService.subscriptions.delete(this.guildId);
  }
}

/**
 * Singleton MusicService coordinating guild subscriptions, search, and voice interactions.
 */
export class MusicService {
  static subscriptions = new Map();

  /**
   * Retrieves active music subscription for guild
   */
  static getSubscription(guildId) {
    return this.subscriptions.get(guildId) || null;
  }

  /**
   * Retrieves or creates a subscription/player for the guild.
   */
  static getOrCreatePlayer(guildId) {
    let sub = this.subscriptions.get(guildId);
    if (!sub) {
      sub = {
        guildId,
        audioPlayer: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } }),
        queue: [],
        currentTrack: null
      };
      this.subscriptions.set(guildId, sub);
    }
    return sub;
  }

  /**
   * Connects Honey Bot to a voice channel with permission checks and timeout bounds.
   */
  static async connectVoice(guild, channelNameOrId = null, member = null, timeoutMs = 5000) {
    if (!guild) {
      return { success: false, error: 'Valid guild context required to join voice channel.' };
    }

    let voiceChannel = null;
    const channelsList = guild.channels?.cache
      ? (typeof guild.channels.cache.values === 'function' ? Array.from(guild.channels.cache.values()) : (Array.isArray(guild.channels.cache) ? guild.channels.cache : []))
      : [];

    if (channelNameOrId) {
      const cleanTarget = String(channelNameOrId).toLowerCase().trim().replace(/^#/, '');
      const normalize = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const normTarget = normalize(cleanTarget);

      voiceChannel = channelsList.find(c => {
        if (!c.isVoiceBased?.() && c.type !== 2 && c.type !== 'GUILD_VOICE') return false;
        if (c.id === channelNameOrId) return true;
        const normName = normalize(c.name);
        return (
          c.name?.toLowerCase() === cleanTarget ||
          c.name?.toLowerCase().includes(cleanTarget) ||
          cleanTarget.includes(c.name?.toLowerCase()) ||
          (normTarget.length >= 3 && (normName === normTarget || normName.includes(normTarget) || normTarget.includes(normName)))
        );
      });
    }

    if (!voiceChannel && member?.voice?.channel) {
      voiceChannel = member.voice.channel;
    }

    if (!voiceChannel) {
      return {
        success: false,
        error: channelNameOrId
          ? `Could not find voice channel "${channelNameOrId}" in this server.`
          : 'You must join a voice channel or specify a channel name (e.g. "/go prompt: Join General voice").'
      };
    }

    const botMember = guild.members?.me;
    if (botMember && typeof voiceChannel.permissionsFor === 'function') {
      const perms = voiceChannel.permissionsFor(botMember);
      if (!perms.has(PermissionFlagsBits.Connect)) {
        return {
          success: false,
          error: `Bot is missing permission to connect to voice channel "${voiceChannel.name}". Please grant "Connect".`
        };
      }
      if (!perms.has(PermissionFlagsBits.Speak)) {
        return {
          success: false,
          error: `Bot is missing permission to speak in voice channel "${voiceChannel.name}". Please grant "Speak".`
        };
      }
    }

    let subscription = this.getSubscription(guild.id);
    if (subscription) {
      const connChannelId = subscription.voiceConnection?.joinConfig?.channelId;
      if (connChannelId === voiceChannel.id) {
        return {
          success: true,
          details: `Already connected to voice channel "${voiceChannel.name}".`,
          channelId: voiceChannel.id
        };
      }
      if (subscription.voiceConnection && typeof subscription.voiceConnection.rejoin === 'function') {
        subscription.voiceConnection.rejoin({
          channelId: voiceChannel.id,
          selfDeaf: true,
          selfMute: false
        });
      }
      return {
        success: true,
        details: `Moved to voice channel "${voiceChannel.name}".`,
        channelId: voiceChannel.id
      };
    }

    try {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false
      });

      if (typeof entersState === 'function') {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Ready, timeoutMs),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Voice connection timed out after ${timeoutMs}ms`)), timeoutMs))
          ]);
        } catch (stateErr) {
          const isTimeout = stateErr.name === 'AbortError' || /aborted|timed?\s*out/i.test(stateErr.message);
          const errMessage = isTimeout ? `Voice connection timed out after ${timeoutMs}ms` : stateErr.message;
          logger.error('Voice connection state timeout', { error: errMessage });
          try { connection.destroy(); } catch {}
          throw new Error(errMessage);
        }
      }

      subscription = new MusicSubscription(connection, null, guild.id);
      this.subscriptions.set(guild.id, subscription);

      return {
        success: true,
        details: `Connected to voice channel "${voiceChannel.name}".`,
        channelId: voiceChannel.id
      };
    } catch (connErr) {
      logger.error('Failed to establish voice connection', { error: connErr.message });
      throw new Error(`Could not join voice channel: ${connErr.message}`);
    }
  }

  /**
   * Resolves search query or URL into structured Track object
   */
  static async resolveTrack(query, requestedBy) {
    const raw = String(query || '').trim();
    const trimmed = raw.replace(/^["'“”`]+|["'“”`]+$/g, '').trim();
    if (!trimmed) {
      throw new Error('Search query or audio URL cannot be empty.');
    }

    const isUrl = /^https?:\/\//i.test(trimmed);

    if (isUrl) {
      // Check YouTube URL
      if (/(youtube\.com|youtu\.be)/i.test(trimmed)) {
        try {
          const info = await ytdl.getInfo(trimmed);
          const details = info.videoDetails;
          return {
            title: details.title,
            url: details.video_url || trimmed,
            duration: formatDuration(details.lengthSeconds),
            durationSec: parseInt(details.lengthSeconds, 10) || 0,
            thumbnail: details.thumbnails?.[0]?.url || null,
            author: details.author?.name || 'Unknown Artist',
            requestedBy: requestedBy?.tag || requestedBy?.id || 'User'
          };
        } catch (ytdlErr) {
          logger.warn('ytdl URL lookup error, falling back to play-dl', { error: ytdlErr.message });
          const playInfo = await play.video_basic_info(trimmed).catch(() => null);
          if (playInfo && playInfo.video_details) {
            const vd = playInfo.video_details;
            return {
              title: vd.title,
              url: vd.url,
              duration: vd.durationRaw || formatDuration(vd.durationInSec),
              durationSec: vd.durationInSec || 0,
              thumbnail: vd.thumbnails?.[0]?.url || null,
              author: vd.channel?.name || 'Unknown Artist',
              requestedBy: requestedBy?.tag || requestedBy?.id || 'User'
            };
          }
          throw new Error(`Could not load media from YouTube URL: ${ytdlErr.message}`);
        }
      }

      // Check SoundCloud URL
      if (/soundcloud\.com/i.test(trimmed)) {
        const scInfo = await play.soundcloud(trimmed).catch(() => null);
        if (scInfo) {
          return {
            title: scInfo.name || 'SoundCloud Track',
            url: scInfo.url,
            duration: formatDuration(scInfo.durationInSec),
            durationSec: scInfo.durationInSec || 0,
            thumbnail: scInfo.thumbnail || null,
            author: scInfo.user?.name || 'SoundCloud Artist',
            requestedBy: requestedBy?.tag || requestedBy?.id || 'User'
          };
        }
        throw new Error('Could not load track from SoundCloud URL.');
      }

      // Direct audio URL validation (must end with audio extension)
      if (/\.(mp3|wav|ogg|flac|m4a|aac|opus|m3u8)(?:[?#].*)?$/i.test(trimmed)) {
        return {
          title: trimmed.split('/').pop().replace(/[?#].*$/, '') || 'Direct Audio Stream',
          url: trimmed,
          duration: 'Live / Stream',
          durationSec: 0,
          thumbnail: null,
          author: 'Online Stream',
          requestedBy: requestedBy?.tag || requestedBy?.id || 'User'
        };
      }

      // Unsupported media URL
      throw new Error('Unsupported media source: Honey Bot supports YouTube, SoundCloud, and direct audio stream links (.mp3, .ogg, .wav).');
    }

    // Keyword Search with intelligent artist + title similarity ranking
    try {
      const rawResults = await ytdl.search(trimmed);
      if (Array.isArray(rawResults) && rawResults.length > 0) {
        const ranked = rankTracks(trimmed, rawResults);
        const item = ranked[0];
        return {
          title: item.title,
          url: item.url,
          duration: formatDuration(item.lengthSeconds),
          durationSec: parseInt(item.lengthSeconds, 10) || 0,
          thumbnail: item.thumbnails?.[0]?.url || null,
          author: item.author?.name || 'Unknown Artist',
          requestedBy: requestedBy?.tag || requestedBy?.id || 'User'
        };
      }
    } catch (ytdlSearchErr) {
      logger.warn('ytdl search error, attempting play-dl search fallback', { error: ytdlSearchErr.message });
    }

    // Fallback to play-dl search with ranking
    const playResults = await play.search(trimmed, { limit: 5 }).catch(() => []);
    if (playResults && playResults.length > 0) {
      const rankedPlay = rankTracks(trimmed, playResults);
      const pItem = rankedPlay[0];
      return {
        title: pItem.title,
        url: pItem.url,
        duration: pItem.durationRaw || formatDuration(pItem.durationInSec),
        durationSec: pItem.durationInSec || 0,
        thumbnail: pItem.thumbnails?.[0]?.url || null,
        author: pItem.channel?.name || 'Unknown Artist',
        requestedBy: requestedBy?.tag || requestedBy?.id || 'User'
      };
    }

    throw new Error(`No tracks found matching query "${trimmed}".`);
  }

  /**
   * Main Play action: joins member's voice channel, resolves track, enqueues or plays immediately.
   */
  static async play(guild, member, query) {
    let subscription = this.getSubscription(guild.id);
    let voiceChannel = member?.voice?.channel;

    if (!voiceChannel && subscription?.voiceConnection) {
      voiceChannel = guild.members?.me?.voice?.channel;
    }

    if (!voiceChannel) {
      return {
        success: false,
        error: 'You must join a voice channel before requesting music playback.'
      };
    }

    const botMember = guild.members.me;

    // Verify bot permissions in voice channel
    if (botMember && typeof voiceChannel.permissionsFor === 'function') {
      const perms = voiceChannel.permissionsFor(botMember);
      if (!perms.has(PermissionFlagsBits.Connect)) {
        return {
          success: false,
          error: `Bot is missing permission to connect to voice channel "${voiceChannel.name}". Please grant "Connect".`
        };
      }
      if (!perms.has(PermissionFlagsBits.Speak)) {
        return {
          success: false,
          error: `Bot is missing permission to speak in voice channel "${voiceChannel.name}". Please grant "Speak".`
        };
      }
    }

    if (!subscription) {
      try {
        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: guild.id,
          adapterCreator: guild.voiceAdapterCreator,
          selfDeaf: true,
          selfMute: false
        });

        subscription = new MusicSubscription(connection, null, guild.id);
        this.subscriptions.set(guild.id, subscription);
      } catch (connErr) {
        logger.error('Failed to join voice channel', { error: connErr.message });
        return {
          success: false,
          error: `Could not join voice channel: ${connErr.message}`
        };
      }
    }

    // Resolve track
    let track;
    try {
      track = await this.resolveTrack(query, member.user || member);
    } catch (searchErr) {
      return {
        success: false,
        error: searchErr.message
      };
    }

    // If something is currently playing, append to queue
    if (subscription.currentTrack) {
      subscription.queue.push(track);
      const position = subscription.queue.length;

      const embed = new EmbedBuilder()
        .setTitle('🎶 Track Added to Queue')
        .setDescription(`**[${track.title}](${track.url})**`)
        .setColor(0xfee75c)
        .addFields(
          { name: 'Position', value: `#${position} in queue`, inline: true },
          { name: 'Duration', value: track.duration, inline: true },
          { name: 'Artist / Channel', value: track.author, inline: true }
        );

      if (track.thumbnail) embed.setThumbnail(track.thumbnail);

      return {
        success: true,
        queued: true,
        position,
        track,
        details: `Queued "${track.title}" (#${position} in queue).`,
        embed
      };
    }

    // Otherwise, play immediately
    await subscription.startPlayback(track);

    const embed = new EmbedBuilder()
      .setTitle('🎵 Now Playing')
      .setDescription(`**[${track.title}](${track.url})**\n\n${buildProgressBar(0, track.durationSec)}\n\`0:00 / ${track.duration}\``)
      .setColor(0xfee75c)
      .addFields(
        { name: 'Artist / Channel', value: track.author, inline: true },
        { name: 'Duration', value: track.duration, inline: true },
        { name: 'Volume', value: `${Math.round(subscription.volume * 100)}%`, inline: true }
      );

    if (track.thumbnail) embed.setThumbnail(track.thumbnail);

    return {
      success: true,
      playing: true,
      track,
      details: `Now playing "${track.title}" in ${voiceChannel.name}.`,
      embed
    };
  }

  /**
   * Pauses current playback
   */
  static async pause(guild) {
    const sub = this.getSubscription(guild.id);
    if (!sub || !sub.currentTrack) {
      return { success: false, error: 'No audio is currently playing in this server.' };
    }
    if (sub.isPaused) {
      return { success: true, details: 'Playback is already paused.' };
    }
    const paused = sub.pause();
    return {
      success: true,
      details: paused ? 'Paused music playback.' : 'Could not pause playback.'
    };
  }

  /**
   * Resumes paused playback
   */
  static async resume(guild) {
    const sub = this.getSubscription(guild.id);
    if (!sub || !sub.currentTrack) {
      return { success: false, error: 'No audio is currently playing in this server.' };
    }
    if (!sub.isPaused) {
      return { success: true, details: 'Playback is not paused.' };
    }
    const resumed = sub.resume();
    return {
      success: true,
      details: resumed ? 'Resumed music playback.' : 'Could not resume playback.'
    };
  }

  /**
   * Skips current track
   */
  static async skip(guild) {
    const sub = this.getSubscription(guild.id);
    if (!sub || !sub.currentTrack) {
      return { success: false, error: 'No audio is currently playing to skip.' };
    }
    const skipped = sub.currentTrack;
    sub.skip();
    return {
      success: true,
      details: `Skipped "${skipped.title}".`
    };
  }

  /**
   * Stops playback, clears queue, and leaves voice channel
   */
  static async stop(guild) {
    const sub = this.getSubscription(guild.id);
    if (!sub) {
      return { success: false, error: 'Honey Bot is not connected to a voice channel in this server.' };
    }
    sub.stop();
    return {
      success: true,
      details: 'Stopped music playback and cleared queue.'
    };
  }

  /**
   * Returns current queue embed and details
   */
  static async getQueue(guild) {
    const sub = this.getSubscription(guild.id);
    if (!sub || (!sub.currentTrack && sub.queue.length === 0)) {
      return { success: true, details: 'The music queue is currently empty.' };
    }

    const elapsed = sub.getElapsedSeconds();
    const current = sub.currentTrack;

    let desc = '';
    if (current) {
      desc += `**Now Playing:**\n[${current.title}](${current.url}) (\`${formatDuration(elapsed)} / ${current.duration}\`)\n\n`;
    }

    if (sub.queue.length > 0) {
      desc += '**Upcoming:**\n';
      const items = sub.queue.slice(0, 10).map((t, idx) => {
        return `\`${idx + 1}.\` [${t.title}](${t.url}) – \`${t.duration}\``;
      });
      desc += items.join('\n');
      if (sub.queue.length > 10) {
        desc += `\n*...and ${sub.queue.length - 10} more track(s)*`;
      }
    } else {
      desc += '*No upcoming tracks in queue.*';
    }

    const embed = new EmbedBuilder()
      .setTitle(`📑 Music Queue for ${guild.name}`)
      .setDescription(desc)
      .setColor(0xfee75c)
      .setFooter({ text: `Total Tracks: ${sub.queue.length + (current ? 1 : 0)} | Volume: ${Math.round(sub.volume * 100)}%` });

    return {
      success: true,
      details: `Music queue has ${sub.queue.length + (current ? 1 : 0)} track(s).`,
      embed
    };
  }

  /**
   * Returns Now Playing details with progress bar
   */
  static async nowPlaying(guild) {
    const sub = this.getSubscription(guild.id);
    if (!sub || !sub.currentTrack) {
      return { success: true, details: 'No audio is currently playing in this server.' };
    }

    const track = sub.currentTrack;
    const elapsed = sub.getElapsedSeconds();
    const bar = buildProgressBar(elapsed, track.durationSec);

    const embed = new EmbedBuilder()
      .setTitle('🎵 Now Playing')
      .setDescription(`**[${track.title}](${track.url})**\n\n${bar}\n\`${formatDuration(elapsed)} / ${track.duration}\``)
      .setColor(0xfee75c)
      .addFields(
        { name: 'Channel / Artist', value: track.author, inline: true },
        { name: 'Status', value: sub.isPaused ? '⏸️ Paused' : '▶️ Playing', inline: true },
        { name: 'Volume', value: `${Math.round(sub.volume * 100)}%`, inline: true }
      );

    if (track.thumbnail) embed.setThumbnail(track.thumbnail);

    return {
      success: true,
      details: `Now playing "${track.title}" (${formatDuration(elapsed)} / ${track.duration}).`,
      embed
    };
  }

  /**
   * Adjusts playback volume (0 to 150%)
   */
  static async setVolume(guild, volumePercent) {
    const sub = this.getSubscription(guild.id);
    if (!sub) {
      return { success: false, error: 'Honey Bot is not connected to a voice channel in this server.' };
    }

    const vol = parseInt(volumePercent, 10);
    if (isNaN(vol) || vol < 0 || vol > 150) {
      return { success: false, error: 'Volume must be a percentage between 0 and 150.' };
    }

    const updated = sub.setVolume(vol / 100);
    return {
      success: true,
      details: `Set playback volume to ${updated}%.`
    };
  }

  /**
   * Disconnects bot from voice
   */
  static async leave(guild) {
    const sub = this.getSubscription(guild.id);
    if (!sub) {
      return { success: true, details: 'Honey Bot is not currently in a voice channel.' };
    }
    sub.destroy();
    return {
      success: true,
      details: 'Disconnected from voice channel.'
    };
  }

  /**
   * Shuffles remaining tracks in the queue
   */
  static async shuffle(guild) {
    const sub = this.getSubscription(guild.id);
    if (!sub) {
      return { success: false, error: 'Honey Bot is not connected to a voice channel in this server.' };
    }
    const count = sub.shuffleQueue();
    return {
      success: true,
      details: `Shuffled ${count} track(s) in queue.`
    };
  }

  /**
   * Clears all pending tracks in the queue
   */
  static async clearQueue(guild) {
    const sub = this.getSubscription(guild.id);
    if (!sub) {
      return { success: false, error: 'Honey Bot is not connected to a voice channel in this server.' };
    }
    const count = sub.clearQueue();
    return {
      success: true,
      details: `Cleared ${count} pending track(s) from the queue.`
    };
  }

  /**
   * Updates playback loop mode ('off' | 'track' | 'queue')
   */
  static async setLoopMode(guild, mode) {
    const sub = this.getSubscription(guild.id);
    if (!sub) {
      return { success: false, error: 'Honey Bot is not connected to a voice channel in this server.' };
    }
    const updated = sub.setLoopMode(mode);
    return {
      success: true,
      details: `Loop mode set to "${updated}".`,
      loopMode: updated
    };
  }

  /**
   * Generates comprehensive audio and voice subsystem diagnostics
   */
  static getDiagnostics(guildId) {
    const sub = this.getSubscription(guildId);
    const ffmpegOk = Boolean(process.env.FFMPEG_PATH || ffmpegPath);

    if (!sub) {
      return {
        connected: false,
        ffmpegAvailable: ffmpegOk,
        ffmpegPath: process.env.FFMPEG_PATH || ffmpegPath || 'Not found',
        playerStatus: 'idle',
        voiceStatus: 'disconnected',
        currentTrack: null,
        queueLength: 0,
        volume: 100,
        loopMode: 'off'
      };
    }

    const state = sub.audioPlayer.state.status;
    const connState = sub.voiceConnection.state.status;

    return {
      connected: connState === 'ready',
      ffmpegAvailable: ffmpegOk,
      ffmpegPath: process.env.FFMPEG_PATH || ffmpegPath || 'Not found',
      playerStatus: state,
      voiceStatus: connState,
      currentTrack: sub.currentTrack ? {
        title: sub.currentTrack.title,
        url: sub.currentTrack.url,
        duration: sub.currentTrack.duration,
        elapsed: sub.getElapsedSeconds()
      } : null,
      queueLength: sub.queue.length,
      volume: Math.round(sub.volume * 100),
      loopMode: sub.loopMode
    };
  }
}
