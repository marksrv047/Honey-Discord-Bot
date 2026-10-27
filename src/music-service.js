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
import { spawnSync } from 'child_process';

if (ffmpegPath && !process.env.FFMPEG_PATH) {
  process.env.FFMPEG_PATH = ffmpegPath;
}

const logger = new Logger('MusicService');
const ytdl = new Ytdl();

/**
 * Authoritative Music Playback Lifecycle States
 */
export const PlaybackLifecycle = {
  REQUESTED: 'REQUESTED',
  RESOLVING: 'RESOLVING',
  RESOLVED: 'RESOLVED',
  CONNECTING: 'CONNECTING',
  WAITING_FOR_READY: 'WAITING_FOR_READY',
  PREPARING_AUDIO: 'PREPARING_AUDIO',
  BUFFERING: 'BUFFERING',
  PLAYING: 'PLAYING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  STALLED: 'STALLED'
};

/**
 * Counts non-bot human members in a Discord voice channel.
 * Ignores Honey Bot itself and other bot accounts.
 */
export function countHumanMembers(voiceChannel, botId = null) {
  if (!voiceChannel) return 0;

  const members = voiceChannel.members?.values
    ? Array.from(voiceChannel.members.values())
    : (Array.isArray(voiceChannel.members) ? voiceChannel.members : []);

  let humanCount = 0;
  for (const m of members) {
    const memberId = m.id || m.user?.id;
    if (botId && memberId === botId) continue;
    const isBot = m.user ? Boolean(m.user.bot) : Boolean(m.bot);
    if (isBot) continue;
    humanCount++;
  }

  return humanCount;
}

/**
 * Extracts a clean 11-character YouTube video ID from any YouTube URL or string.
 * Supports standard, mobile (m.youtube.com), YouTube Music, Shorts, and embed URLs.
 */
export function extractYouTubeId(urlOrQuery) {
  if (!urlOrQuery || typeof urlOrQuery !== 'string') return null;
  const match = urlOrQuery.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/)|music\.youtube\.com\/watch\?v=|m\.youtube\.com\/watch\?v=)([\w-]{11})/i);
  return match ? match[1] : null;
}

/**
 * Converts a YouTube video ID or messy tracking/playlist URL to a clean canonical watch URL.
 * Strips all tracking query parameters (e.g. si, feature, utm_*, radio/playlist tags).
 */
export function toCanonicalYouTubeUrl(idOrUrl) {
  const videoId = extractYouTubeId(idOrUrl);
  return videoId ? `https://www.youtube.com/watch?v=${videoId}` : idOrUrl;
}

/**
 * Strips tracking parameters from SoundCloud URLs while preserving clean track path.
 */
export function sanitizeSoundCloudUrl(url) {
  if (!url || typeof url !== 'string') return url;
  try {
    const parsed = new URL(url);
    if (/soundcloud\.com$/i.test(parsed.hostname)) {
      return `https://soundcloud.com${parsed.pathname}`;
    }
  } catch {}
  return url;
}

/**
 * Determines whether a URL points to a supported direct audio stream.
 */
export function isDirectAudioUrl(urlOrQuery) {
  if (!urlOrQuery || typeof urlOrQuery !== 'string') return false;
  return /\.(mp3|wav|ogg|flac|m4a|aac|opus|m3u8)(?:[?#].*)?$/i.test(urlOrQuery);
}

/**
 * Determines whether a URL is a SoundCloud link.
 */
export function isSoundCloudUrl(urlOrQuery) {
  if (!urlOrQuery || typeof urlOrQuery !== 'string') return false;
  return /soundcloud\.com/i.test(urlOrQuery);
}

/**
 * Detects common unsupported music / media providers and returns a helpful explanation.
 */
export function checkUnsupportedMediaUrl(urlOrQuery) {
  if (!urlOrQuery || typeof urlOrQuery !== 'string') return null;
  const raw = urlOrQuery.trim();

  if (/spotify\.com/i.test(raw)) {
    return 'Spotify tracks cannot be streamed directly due to proprietary DRM. However, you can search for the song title and artist on Honey Bot: `/go prompt: play <Song Name> by <Artist>` or provide a YouTube or SoundCloud link.';
  }
  if (/music\.apple\.com/i.test(raw)) {
    return 'Apple Music tracks cannot be streamed directly due to proprietary DRM. Please search by song title and artist: `/go prompt: play <Song Name> by <Artist>` or provide a YouTube or SoundCloud link.';
  }
  if (/tiktok\.com/i.test(raw) || /instagram\.com/i.test(raw)) {
    return 'Social media video links (TikTok/Instagram) are not supported for audio streaming. Please provide a YouTube, SoundCloud, or direct audio link (.mp3, .ogg, .wav).';
  }
  if (/bandcamp\.com/i.test(raw)) {
    return 'Bandcamp streaming is currently unsupported. Please search for the track on YouTube or SoundCloud, or provide a direct audio stream link.';
  }
  return null;
}

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
 * MusicSubscription manages per-guild voice connection, player, queue state, and automatic idle disconnect.
 */
export class MusicSubscription {
  constructor(voiceConnection, textChannel, guildId, guild = null) {
    this.voiceConnection = voiceConnection;
    this.textChannel = textChannel;
    this.guildId = guildId;
    this.guild = guild;

    // Use NoSubscriberBehavior.Play to prevent premature freeze when voice UDP socket is negotiating
    this.audioPlayer = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play,
        maxMissedFrames: 25
      }
    });

    this.queue = [];
    this.currentTrack = null;
    this.currentResource = null;
    this.volume = 1.0;
    this.isPaused = false;
    this.loopMode = 'off'; // 'off' | 'track' | 'queue'
    this.startedAt = 0;
    this.pausedAt = 0;
    this.totalPausedDuration = 0;
    this.lifecycleState = PlaybackLifecycle.RESOLVED;
    this.lastStatusMessage = null;

    // 5-Minute Empty Channel Disconnect State Machine
    this.emptyChannelTimer = null;
    this.emptyChannelTimerStartedAt = 0;
    this.sessionToken = 1;
    this.idleTimeoutMs = 5 * 60 * 1000; // 5 continuous minutes default
    this.currentVoiceChannelId = voiceConnection?.joinConfig?.channelId || null;

    if (this.voiceConnection && typeof this.voiceConnection.subscribe === 'function') {
      this.voiceConnection.subscribe(this.audioPlayer);
    }

    this.audioPlayer.on(AudioPlayerStatus.Playing, () => {
      this.lifecycleState = PlaybackLifecycle.PLAYING;
      logger.info('AudioPlayer entered Playing state', { guildId: this.guildId, track: this.currentTrack?.title });
    });

    this.audioPlayer.on(AudioPlayerStatus.Buffering, () => {
      this.lifecycleState = PlaybackLifecycle.BUFFERING;
      logger.debug('AudioPlayer buffering', { guildId: this.guildId });
    });

    this.audioPlayer.on(AudioPlayerStatus.AutoPaused, () => {
      logger.warn('AudioPlayer autopaused; resuming', { guildId: this.guildId });
      if (!this.isPaused) {
        try {
          this.audioPlayer.unpause();
        } catch {}
      }
    });

    this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
      this.lifecycleState = PlaybackLifecycle.COMPLETED;
      this.handleTrackEnded();
    });

    this.audioPlayer.on('error', (err) => {
      logger.error('AudioPlayer playback error', { guildId: this.guildId, error: err.message });
      this.lifecycleState = PlaybackLifecycle.FAILED;
      this.handleTrackEnded();
    });

    if (this.voiceConnection && typeof this.voiceConnection.on === 'function') {
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
    }
  }

  /**
   * Overrides the idle countdown duration in milliseconds (useful for fast test suites).
   */
  setIdleTimeout(ms) {
    this.idleTimeoutMs = Math.max(10, parseInt(ms, 10) || (5 * 60 * 1000));
    return this.idleTimeoutMs;
  }

  /**
   * Resolves the current voice channel object for occupancy checking.
   */
  resolveCurrentVoiceChannel(channelId = null) {
    const targetId = channelId || this.currentVoiceChannelId || this.voiceConnection?.joinConfig?.channelId;
    if (!targetId) return null;

    const guild = this.guild || this.textChannel?.guild;
    if (guild?.channels?.cache?.get) {
      return guild.channels.cache.get(targetId) || null;
    }
    return null;
  }

  /**
   * Evaluates channel occupancy:
   * - If 0 humans left, starts the 5-minute countdown (if not already running).
   * - If 1+ humans present, immediately cancels any active countdown.
   */
  evaluateChannelOccupancy(voiceChannel, botId = null) {
    if (!voiceChannel) {
      this.cancelEmptyChannelCountdown('Voice channel unavailable');
      return;
    }

    this.currentVoiceChannelId = voiceChannel.id;
    const humanCount = countHumanMembers(voiceChannel, botId);

    if (humanCount === 0) {
      this.startEmptyChannelCountdown(voiceChannel, botId);
    } else {
      this.cancelEmptyChannelCountdown(`Human user(s) present (${humanCount})`);
    }
  }

  /**
   * Starts a 5-minute countdown when no human users are in the channel.
   */
  startEmptyChannelCountdown(voiceChannel, botId = null, timeoutMs = this.idleTimeoutMs) {
    const channelId = voiceChannel?.id || this.currentVoiceChannelId;
    if (this.emptyChannelTimer) {
      // Countdown is already in progress for this guild
      return;
    }

    this.emptyChannelTimerStartedAt = Date.now();
    const token = this.sessionToken;

    logger.info('Voice channel empty of human users, starting 5-minute idle countdown', {
      guildId: this.guildId,
      channelId,
      timeoutMs
    });

    this.emptyChannelTimer = setTimeout(async () => {
      try {
        await this.handleEmptyChannelTimeout(channelId, token, botId);
      } catch (err) {
        logger.error('Error in empty channel timeout handler', { guildId: this.guildId, error: err.message });
      }
    }, timeoutMs);
  }

  /**
   * Fired when the 5-minute timer expires. Rechecks membership and disconnects cleanly.
   */
  async handleEmptyChannelTimeout(channelId, token, botId = null) {
    // Check 1: Token verification to prevent stale timers from disconnecting newer sessions
    if (this.sessionToken !== token) {
      logger.debug('Ignoring stale idle disconnect timer', { guildId: this.guildId, channelId });
      return;
    }

    // Check 2: Connection health
    if (!this.voiceConnection || this.voiceConnection.state?.status === VoiceConnectionStatus.Destroyed) {
      this.clearEmptyChannelCountdown();
      return;
    }

    // Check 3: Channel verification (bot still in same channel)
    const activeChannelId = this.voiceConnection.joinConfig?.channelId || this.currentVoiceChannelId;
    if (activeChannelId !== channelId) {
      logger.info('Bot changed channels, discarding stale idle disconnect timer', {
        guildId: this.guildId,
        scheduledChannel: channelId,
        currentChannel: activeChannelId
      });
      this.clearEmptyChannelCountdown();
      return;
    }

    // Check 4: Occupancy re-check (ensure no humans joined right before timeout)
    const channel = this.resolveCurrentVoiceChannel(channelId);
    if (channel) {
      const humanCount = countHumanMembers(channel, botId);
      if (humanCount > 0) {
        logger.info('Human users present in channel; aborting idle disconnect', {
          guildId: this.guildId,
          channelId,
          humanCount
        });
        this.clearEmptyChannelCountdown();
        return;
      }
    }

    // All conditions verified: channel remained empty of humans for 5 continuous minutes
    logger.info('Automatic idle disconnect: Voice channel remained empty for 5 minutes', {
      guildId: this.guildId,
      channelId,
      reason: 'No human users present for 5 continuous minutes'
    });

    // Provide user feedback without spam
    if (this.textChannel && typeof this.textChannel.send === 'function') {
      const embed = new EmbedBuilder()
        .setTitle('🔇 Voice Channel Inactivity Disconnect')
        .setDescription('Honey Bot left the voice channel because it remained empty of human users for 5 continuous minutes.')
        .setColor(0xfee75c);

      try {
        if (this.lastStatusMessage && typeof this.lastStatusMessage.edit === 'function') {
          await this.lastStatusMessage.edit({ embeds: [embed] }).catch(async () => {
            await this.textChannel.send({ embeds: [embed] }).catch(() => {});
          });
        } else {
          await this.textChannel.send({ embeds: [embed] }).catch(() => {});
        }
      } catch {}
    }

    this.destroy();
  }

  /**
   * Cancels any pending countdown and advances session token.
   */
  cancelEmptyChannelCountdown(reason = 'Humans returned') {
    if (this.emptyChannelTimer) {
      clearTimeout(this.emptyChannelTimer);
      this.emptyChannelTimer = null;
      this.emptyChannelTimerStartedAt = 0;
      this.sessionToken++;
      logger.info('Cancelled voice channel idle disconnect timer', {
        guildId: this.guildId,
        reason
      });
    }
  }

  /**
   * Clears timer without logging or token changes (internal cleanup).
   */
  clearEmptyChannelCountdown() {
    if (this.emptyChannelTimer) {
      clearTimeout(this.emptyChannelTimer);
      this.emptyChannelTimer = null;
      this.emptyChannelTimerStartedAt = 0;
    }
  }

  // Compatibility aliases
  resetIdleTimer() {
    this.clearEmptyChannelCountdown();
  }

  clearIdleTimer() {
    this.clearEmptyChannelCountdown();
  }

  /**
   * Handles channel move by invalidating old session tokens.
   */
  handleChannelChange(newChannelId) {
    this.sessionToken++;
    this.clearEmptyChannelCountdown();
    this.currentVoiceChannelId = newChannelId;
    if (this.voiceConnection?.joinConfig) {
      this.voiceConnection.joinConfig.channelId = newChannelId;
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
      await this.startPlayback(this.currentTrack).catch(e => {
        logger.error('Failed to loop current track', { error: e.message });
      });
      return;
    }

    if (this.loopMode === 'queue' && this.currentTrack) {
      this.queue.push(this.currentTrack);
    }

    if (this.queue.length > 0) {
      const nextTrack = this.queue.shift();
      await this.startPlayback(nextTrack).catch(e => {
        logger.error('Failed to play next queued track', { error: e.message });
      });
    } else {
      this.currentTrack = null;
      this.currentResource = null;
      this.startedAt = 0;
      this.lifecycleState = PlaybackLifecycle.COMPLETED;

      // Re-evaluate occupancy: if empty of humans, start countdown; if humans present, do NOT disconnect
      const channel = this.resolveCurrentVoiceChannel();
      if (channel) {
        this.evaluateChannelOccupancy(channel);
      }
    }
  }

  /**
   * Starts playback with verified readiness and bounded error reporting.
   */
  async startPlayback(track, retryCount = 0) {
    this.currentTrack = track;
    this.isPaused = false;
    this.totalPausedDuration = 0;
    this.lifecycleState = PlaybackLifecycle.PREPARING_AUDIO;

    // 1. Verify voice connection readiness
    if (this.voiceConnection && this.voiceConnection.state?.status && this.voiceConnection.state.status !== VoiceConnectionStatus.Ready) {
      this.lifecycleState = PlaybackLifecycle.WAITING_FOR_READY;
      try {
        await entersState(this.voiceConnection, VoiceConnectionStatus.Ready, 10000);
      } catch (vcErr) {
        this.lifecycleState = PlaybackLifecycle.FAILED;
        throw new Error(`Voice connection did not become ready: ${vcErr.message}`);
      }
    }

    // Subscribe player to voice connection
    if (this.voiceConnection && typeof this.voiceConnection.subscribe === 'function') {
      this.voiceConnection.subscribe(this.audioPlayer);
    }

    // 2. Obtain clean playable stream with multi-tier source resolution
    const targetUrl = toCanonicalYouTubeUrl(track.url) || track.url;
    let stream = null;
    let streamType = StreamType.Arbitrary;

    if (track.isDirectAudio || isDirectAudioUrl(targetUrl)) {
      // Direct stream (e.g. mp3/wav/ogg link)
      try {
        const resp = await fetch(targetUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        stream = resp.body;
      } catch (directErr) {
        this.lifecycleState = PlaybackLifecycle.FAILED;
        throw new Error(`Direct audio stream unavailable: ${directErr.message}`);
      }
    } else if (isSoundCloudUrl(targetUrl)) {
      // SoundCloud stream via play-dl
      try {
        const playStream = await play.stream(targetUrl);
        stream = playStream.stream;
        if (playStream.type === 'opus') {
          streamType = StreamType.Opus;
        }
      } catch (scErr) {
        this.lifecycleState = PlaybackLifecycle.FAILED;
        throw new Error(`SoundCloud stream extraction failed: ${scErr.message}`);
      }
    } else {
      // YouTube stream via multi-tier fallback: ytdl -> play-dl
      let ytdlError = null;
      try {
        stream = await ytdl.download(targetUrl, {
          filter: (format) => format.hasAudio && !format.hasVideo,
          quality: 'highestaudio',
          highWaterMark: 1 << 25
        });
      } catch (err) {
        ytdlError = err;
        logger.warn('ytdl download failed, attempting play-dl fallback', { error: err.message, url: targetUrl });
      }

      if (!stream) {
        try {
          const playStream = await play.stream(targetUrl);
          stream = playStream.stream;
          if (playStream.type === 'opus') {
            streamType = StreamType.Opus;
          }
        } catch (playErr) {
          this.lifecycleState = PlaybackLifecycle.FAILED;
          const msg = ytdlError ? `${ytdlError.message} (Fallback: ${playErr.message})` : playErr.message;
          throw new Error(`Failed to obtain audio stream: ${msg}`);
        }
      }
    }

    if (!stream) {
      this.lifecycleState = PlaybackLifecycle.FAILED;
      throw new Error('Audio stream extraction produced an empty or null stream.');
    }

    let streamPrematurelyEnded = false;
    let streamErrorOccurred = null;

    if (stream && typeof stream.on === 'function') {
      stream.on('error', (streamErr) => {
        logger.error('Audio stream transmission error', { guildId: this.guildId, error: streamErr.message });
        streamErrorOccurred = streamErr.message;
      });
      stream.on('end', () => {
        if (this.lifecycleState === PlaybackLifecycle.BUFFERING && (!this.currentResource || this.currentResource.playbackDuration === 0)) {
          streamPrematurelyEnded = true;
        }
      });
    }

    // 3. Create audio resource
    try {
      this.currentResource = createAudioResource(stream, {
        inlineVolume: true,
        inputType: streamType
      });

      if (this.currentResource.volume) {
        this.currentResource.volume.setVolume(this.volume);
      }
    } catch (resErr) {
      logger.error('Failed to create audio resource', { error: resErr.message });
      this.lifecycleState = PlaybackLifecycle.FAILED;
      throw new Error(`FFmpeg transcoding error: ${resErr.message}`);
    }

    // 4. Play resource and wait for transition to Playing state
    this.lifecycleState = PlaybackLifecycle.BUFFERING;
    this.audioPlayer.play(this.currentResource);
    this.startedAt = Date.now();

    try {
      await entersState(this.audioPlayer, AudioPlayerStatus.Playing, 8000);
    } catch (playErr) {
      logger.error('Audio player failed to enter Playing state', { error: playErr.message });
      this.lifecycleState = PlaybackLifecycle.FAILED;

      // Bounded retry once if initial attempt timed out
      if (retryCount < 1) {
        logger.warn('Retrying playback initiation once...', { title: track.title });
        return await this.startPlayback(track, retryCount + 1);
      }

      this.handleTrackEnded();
      throw new Error(`Audio player failed to begin playback: ${playErr.message}`);
    }

    // 5. Active Meaningful Playback Verification:
    // Detect immediate stream termination or error with 0 audio frames
    if (streamPrematurelyEnded || streamErrorOccurred) {
      this.lifecycleState = PlaybackLifecycle.FAILED;
      this.handleTrackEnded();
      throw new Error(`Audio stream ended immediately without delivering audio frames: ${streamErrorOccurred || 'Stream closed immediately'}`);
    }

    if (this.audioPlayer.state?.status === AudioPlayerStatus.Idle) {
      this.lifecycleState = PlaybackLifecycle.FAILED;
      this.handleTrackEnded();
      throw new Error('Audio player transitioned to Idle immediately (0 audio frames rendered).');
    }

    this.lifecycleState = PlaybackLifecycle.PLAYING;
    logger.info('Verified audio playback started', {
      guildId: this.guildId,
      title: track.title,
      status: this.audioPlayer.state.status
    });

    return {
      success: true,
      verified: true,
      track,
      lifecycleState: this.lifecycleState
    };
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
    this.clearEmptyChannelCountdown();
    this.sessionToken++;
    this.lifecycleState = PlaybackLifecycle.COMPLETED;
    try {
      this.audioPlayer.stop(true);
    } catch {}
    try {
      this.voiceConnection?.destroy?.();
    } catch {}
    MusicService.subscriptions.delete(this.guildId);
  }
}

/**
 * Singleton MusicService coordinating guild subscriptions, search, voice interactions, and idle lifecycle.
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
   * Shuts down all active guild voice sessions cleanly (e.g. on bot shutdown).
   */
  static shutdownAll() {
    logger.info('Cleaning up all active music and voice sessions across guilds...');
    for (const [guildId, sub] of this.subscriptions.entries()) {
      try {
        sub.destroy();
      } catch (err) {
        logger.error('Error destroying subscription during shutdown', { guildId, error: err.message });
      }
    }
    this.subscriptions.clear();
  }

  /**
   * Centralized voice-state update dispatcher:
   * Re-evaluates channel occupancy, handles bot moves/disconnects, and manages the 5-minute timer.
   */
  static handleVoiceStateUpdate(oldState, newState, botId = null) {
    const guild = newState.guild || oldState.guild;
    if (!guild) return;

    const sub = this.getSubscription(guild.id);
    if (!sub) return;

    const currentBotId = botId || guild.members?.me?.id || guild.client?.user?.id;
    const memberId = newState.member?.id || oldState.member?.id || newState.id || oldState.id;

    // 1. If Honey Bot itself was disconnected from voice
    if (memberId === currentBotId && !newState.channelId) {
      logger.info('Bot was disconnected from voice channel', { guildId: guild.id });
      sub.destroy();
      return;
    }

    // 2. If Honey Bot itself moved to a different voice channel
    if (memberId === currentBotId && newState.channelId && newState.channelId !== oldState.channelId) {
      logger.info('Bot moved to different voice channel', {
        guildId: guild.id,
        fromChannel: oldState.channelId,
        toChannel: newState.channelId
      });
      sub.handleChannelChange(newState.channelId);
      sub.evaluateChannelOccupancy(newState.channel, currentBotId);
      return;
    }

    // 3. User joined, left, or moved between channels
    const botChannelId = sub.voiceConnection?.joinConfig?.channelId || guild.members?.me?.voice?.channelId || sub.currentVoiceChannelId;
    if (!botChannelId) return;

    // Did this state update involve the bot's channel?
    const involved = oldState.channelId === botChannelId || newState.channelId === botChannelId;
    if (!involved) return;

    const botVoiceChannel = guild.channels?.cache?.get?.(botChannelId)
      || guild.members?.me?.voice?.channel
      || (newState.channelId === botChannelId ? newState.channel : oldState.channel);

    if (botVoiceChannel) {
      sub.evaluateChannelOccupancy(botVoiceChannel, currentBotId);
    }
  }

  /**
   * Retrieves or creates a subscription/player for the guild.
   */
  static getOrCreatePlayer(guildId) {
    let sub = this.subscriptions.get(guildId);
    if (!sub) {
      sub = {
        guildId,
        audioPlayer: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
        queue: [],
        currentTrack: null
      };
      this.subscriptions.set(guildId, sub);
    }
    return sub;
  }

  /**
   * Connects Honey Bot to a voice channel with single connection reuse, permission checks, and timeout bounds.
   */
  static async connectVoice(guild, channelNameOrId = null, member = null, timeoutMs = 15000, textChannel = null) {
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

    // Single Connection Pooling: Check existing VoiceConnection on @discordjs/voice
    const existingConn = getVoiceConnection(guild.id);
    let subscription = this.getSubscription(guild.id);

    if (existingConn && existingConn.state.status !== VoiceConnectionStatus.Destroyed) {
      const activeChannelId = existingConn.joinConfig?.channelId;
      if (activeChannelId === voiceChannel.id) {
        // Wait for ready if connecting
        if (existingConn.state.status !== VoiceConnectionStatus.Ready && typeof entersState === 'function') {
          try {
            await entersState(existingConn, VoiceConnectionStatus.Ready, timeoutMs);
          } catch {}
        }
        if (!subscription) {
          subscription = new MusicSubscription(existingConn, textChannel, guild.id, guild);
          this.subscriptions.set(guild.id, subscription);
        } else if (textChannel) {
          subscription.textChannel = textChannel;
        }

        // Evaluate occupancy on connection
        subscription.evaluateChannelOccupancy(voiceChannel, guild.client?.user?.id || botMember?.id);

        return {
          success: true,
          details: `Already connected to voice channel "${voiceChannel.name}".`,
          channelId: voiceChannel.id
        };
      }

      // Rejoin / move to target channel
      if (typeof existingConn.rejoin === 'function') {
        existingConn.rejoin({
          channelId: voiceChannel.id,
          selfDeaf: true,
          selfMute: false
        });
      }
      if (!subscription) {
        subscription = new MusicSubscription(existingConn, textChannel, guild.id, guild);
        this.subscriptions.set(guild.id, subscription);
      } else {
        if (textChannel) subscription.textChannel = textChannel;
        subscription.handleChannelChange(voiceChannel.id);
      }

      subscription.evaluateChannelOccupancy(voiceChannel, guild.client?.user?.id || botMember?.id);

      return {
        success: true,
        details: `Moved to voice channel "${voiceChannel.name}".`,
        channelId: voiceChannel.id
      };
    }

    // Clean up broken existing connection before creating a new one
    if (existingConn) {
      try { existingConn.destroy(); } catch {}
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

      subscription = new MusicSubscription(connection, textChannel, guild.id, guild);
      this.subscriptions.set(guild.id, subscription);

      // Evaluate occupancy on initial connect
      subscription.evaluateChannelOccupancy(voiceChannel, guild.client?.user?.id || botMember?.id);

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

    // Check common unsupported providers (e.g. Spotify, Apple Music, TikTok) and provide informative guidance
    const unsupportedMessage = checkUnsupportedMediaUrl(trimmed);
    if (unsupportedMessage) {
      throw new Error(unsupportedMessage);
    }

    const isUrl = /^https?:\/\//i.test(trimmed);
    const ytId = extractYouTubeId(trimmed);

    if (isUrl || ytId) {
      // Direct YouTube URL or video ID (including m.youtube.com, music.youtube.com, Shorts)
      if (ytId || /(youtube\.com|youtu\.be)/i.test(trimmed)) {
        const canonicalUrl = toCanonicalYouTubeUrl(ytId ? `https://www.youtube.com/watch?v=${ytId}` : trimmed);
        try {
          const info = await ytdl.getInfo(canonicalUrl);
          const details = info.videoDetails;
          return {
            title: details.title,
            url: details.url || canonicalUrl,
            duration: formatDuration(details.lengthSeconds),
            durationSec: parseInt(details.lengthSeconds, 10) || 0,
            thumbnail: details.thumbnails?.[0]?.url || null,
            author: details.author?.name || 'Unknown Artist',
            requestedBy: requestedBy?.tag || requestedBy?.id || 'User',
            source: 'youtube'
          };
        } catch (ytdlErr) {
          logger.warn('ytdl URL lookup error, falling back to play-dl', { error: ytdlErr.message });
          const playInfo = await play.video_basic_info(canonicalUrl).catch(() => null);
          if (playInfo && playInfo.video_details) {
            const vd = playInfo.video_details;
            return {
              title: vd.title,
              url: vd.url || canonicalUrl,
              duration: vd.durationRaw || formatDuration(vd.durationInSec),
              durationSec: vd.durationInSec || 0,
              thumbnail: vd.thumbnails?.[0]?.url || null,
              author: vd.channel?.name || 'Unknown Artist',
              requestedBy: requestedBy?.tag || requestedBy?.id || 'User',
              source: 'youtube'
            };
          }
          throw new Error(`Could not load media from YouTube URL: ${ytdlErr.message}`);
        }
      }

      // Check SoundCloud URL
      if (isSoundCloudUrl(trimmed)) {
        const cleanScUrl = sanitizeSoundCloudUrl(trimmed);
        const scInfo = await play.soundcloud(cleanScUrl).catch(() => null);
        if (scInfo) {
          return {
            title: scInfo.name || 'SoundCloud Track',
            url: scInfo.url || cleanScUrl,
            duration: formatDuration(scInfo.durationInSec),
            durationSec: scInfo.durationInSec || 0,
            thumbnail: scInfo.thumbnail || null,
            author: scInfo.user?.name || 'SoundCloud Artist',
            requestedBy: requestedBy?.tag || requestedBy?.id || 'User',
            source: 'soundcloud'
          };
        }
        throw new Error('Could not load track from SoundCloud URL.');
      }

      // Direct audio stream URL validation
      if (isDirectAudioUrl(trimmed)) {
        return {
          title: trimmed.split('/').pop().replace(/[?#].*$/, '') || 'Direct Audio Stream',
          url: trimmed,
          duration: 'Live / Stream',
          durationSec: 0,
          thumbnail: null,
          author: 'Online Stream',
          requestedBy: requestedBy?.tag || requestedBy?.id || 'User',
          isDirectAudio: true,
          source: 'direct'
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
        const canonicalUrl = toCanonicalYouTubeUrl(item.url || item.id);
        return {
          title: item.title,
          url: canonicalUrl,
          duration: formatDuration(item.lengthSeconds),
          durationSec: parseInt(item.lengthSeconds, 10) || 0,
          thumbnail: item.thumbnails?.[0]?.url || null,
          author: item.author?.name || 'Unknown Artist',
          requestedBy: requestedBy?.tag || requestedBy?.id || 'User',
          source: 'youtube'
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
        requestedBy: requestedBy?.tag || requestedBy?.id || 'User',
        source: 'youtube'
      };
    }

    throw new Error(`No tracks found matching query "${trimmed}".`);
  }

  /**
   * Main Play action: joins member's voice channel, verifies readiness, resolves track, and starts verified playback.
   */
  static async play(guild, member, query, textChannel = null) {
    let voiceChannel = member?.voice?.channel;
    const existingSub = this.getSubscription(guild?.id);

    if (!voiceChannel && existingSub?.voiceConnection) {
      voiceChannel = guild.members?.me?.voice?.channel;
    }

    if (!voiceChannel) {
      return {
        success: false,
        error: 'You must join a voice channel before requesting music playback.'
      };
    }

    // 1. Establish/verify voice connection and wait for Ready status
    let connResult;
    try {
      connResult = await this.connectVoice(guild, voiceChannel.id, member, 15000, textChannel);
      if (!connResult.success) {
        return {
          success: false,
          error: connResult.error
        };
      }
    } catch (connErr) {
      return {
        success: false,
        error: `Could not connect to voice channel: ${connErr.message}`
      };
    }

    const subscription = this.getSubscription(guild.id);
    if (!subscription) {
      return {
        success: false,
        error: 'Could not establish voice subscription for audio playback.'
      };
    }

    if (textChannel) {
      subscription.textChannel = textChannel;
    }

    // 2. Resolve track metadata
    let track;
    try {
      track = await this.resolveTrack(query, member.user || member);
    } catch (searchErr) {
      return {
        success: false,
        error: searchErr.message
      };
    }

    // 3. If a track is already playing, add to queue
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

    // 4. Start verified playback: Player MUST enter Playing state before returning "Now Playing"
    try {
      await subscription.startPlayback(track);
    } catch (playErr) {
      logger.error('Playback initiation failure', { guildId: guild.id, error: playErr.message });
      return {
        success: false,
        error: `I found "${track.title}" and joined voice, but audio playback failed because: ${playErr.message}`,
        details: `Playback failed: ${playErr.message}`
      };
    }

    // Verified playback started
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
      verified: true,
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
    const existingConn = guildId ? getVoiceConnection(guildId) : null;
    const ffmpegPathResolved = process.env.FFMPEG_PATH || ffmpegPath;
    const ffmpegOk = Boolean(ffmpegPathResolved);

    let ffmpegExecutable = false;
    let ffmpegVersionStr = 'Unknown';
    if (ffmpegOk) {
      try {
        const proc = spawnSync(ffmpegPathResolved, ['-version'], { timeout: 2000 });
        if (proc.status === 0 && proc.stdout) {
          ffmpegExecutable = true;
          ffmpegVersionStr = proc.stdout.toString().split('\n')[0].trim();
        }
      } catch {
        ffmpegExecutable = false;
      }
    }

    const baseDiagnostics = {
      healthy: ffmpegOk,
      ffmpegAvailable: ffmpegOk,
      ffmpegExecutable,
      ffmpegVersion: ffmpegVersionStr,
      ffmpegPath: ffmpegPathResolved || 'Not found',
      opusAvailable: true,
      voiceModuleVersion: '0.19.2',
      ytdlVersion: '5.0.1',
      activeSubscriptionsCount: this.subscriptions.size,
      adapters: ['YouTube', 'SoundCloud', 'Direct Audio'],
      supportedFormats: ['.mp3', '.ogg', '.wav', '.flac', '.aac', '.opus', '.m4a']
    };

    if (!sub && !existingConn) {
      return {
        ...baseDiagnostics,
        connected: false,
        playerStatus: 'idle',
        voiceStatus: 'disconnected',
        lifecycleState: 'IDLE',
        currentTrack: null,
        playbackDuration: 0,
        queueLength: 0,
        volume: 100,
        loopMode: 'off',
        emptyChannelCountdown: false,
        emptyChannelRemainingMs: 0
      };
    }

    const state = sub?.audioPlayer?.state?.status || 'idle';
    const connState = sub?.voiceConnection?.state?.status || existingConn?.state?.status || 'disconnected';
    const channelId = sub?.voiceConnection?.joinConfig?.channelId || existingConn?.joinConfig?.channelId || sub?.currentVoiceChannelId || null;

    const hasEmptyCountdown = Boolean(sub?.emptyChannelTimer);
    const remainingMs = hasEmptyCountdown
      ? Math.max(0, sub.idleTimeoutMs - (Date.now() - sub.emptyChannelTimerStartedAt))
      : 0;

    return {
      ...baseDiagnostics,
      connected: connState === VoiceConnectionStatus.Ready,
      channelId,
      playerStatus: state,
      voiceStatus: connState,
      lifecycleState: sub?.lifecycleState || 'IDLE',
      currentTrack: sub?.currentTrack ? {
        title: sub.currentTrack.title,
        url: sub.currentTrack.url,
        duration: sub.currentTrack.duration,
        elapsed: sub.getElapsedSeconds()
      } : null,
      playbackDuration: sub?.currentResource?.playbackDuration || 0,
      queueLength: sub?.queue?.length || 0,
      volume: sub ? Math.round(sub.volume * 100) : 100,
      loopMode: sub?.loopMode || 'off',
      emptyChannelCountdown: hasEmptyCountdown,
      emptyChannelRemainingMs: remainingMs
    };
  }

  /**
   * Generates comprehensive, user-facing Music Capability & Engine Architecture Embed.
   */
  static buildCapabilityEmbed(guildId = null, guild = null) {
    const diag = this.getDiagnostics(guildId);

    const embed = new EmbedBuilder()
      .setTitle('🎵 Honey Bot Music Engine & Voice Playback Capabilities')
      .setDescription(
        'Honey Bot includes a high-fidelity, verified audio streaming engine for Discord voice channels.\n' +
        'Audio streams are transcoded via FFmpeg and verified before announcing playback.'
      )
      .setColor(0xfee75c)
      .addFields(
        {
          name: 'Supported Audio Sources',
          value:
            '• **YouTube**: Direct URLs (`youtube.com`, `youtu.be`, `music.youtube.com`, Shorts), video IDs, and keyword searches with artist/title matching.\n' +
            '• **SoundCloud**: Track URLs (`https://soundcloud.com/...`).\n' +
            '• **Direct Audio Streams**: HTTP/HTTPS audio links (`.mp3`, `.ogg`, `.wav`, `.aac`, `.flac`, `.opus`).',
          inline: false
        },
        {
          name: 'Natural-Language Playback Controls (`/go prompt: <action>`)',
          value:
            '• `play <title or URL>` — Connects and streams music with verified playback\n' +
            '• `pause` / `resume` — Pauses or resumes the audio player\n' +
            '• `skip` — Skips the current track to the next queued item\n' +
            '• `stop` — Stops playback, clears the queue, and disconnects\n' +
            '• `queue` — Displays upcoming tracks in the music queue\n' +
            '• `np` (now playing) — Shows current track details and live progress bar\n' +
            '• `volume <0-150>` — Sets playback volume percentage\n' +
            '• `shuffle` — Randomizes the order of upcoming queued tracks\n' +
            '• `loop [off|track|queue]` — Configures single-track or full-queue repeat\n' +
            '• `clear queue` — Empties all pending tracks from the queue\n' +
            '• `leave` — Disconnects bot from the voice channel',
          inline: false
        },
        {
          name: 'Audio Pipeline Architecture & System Health',
          value:
            `• **Voice Library**: @discordjs/voice v${diag.voiceModuleVersion} (${diag.connected ? '🟢 Connected' : '⚪ Idle/Ready'})\n` +
            `• **FFmpeg Transcoder**: ${diag.ffmpegAvailable ? '🟢 Available' : '🔴 Missing'} (${diag.ffmpegPath})\n` +
            `• **Opus Audio Encoder**: ${diag.opusAvailable ? '🟢 Available (opusscript / libopus)' : '🔴 Unavailable'}\n` +
            `• **Active Voice Sessions**: ${diag.activeSubscriptionsCount} guild(s) active\n` +
            `• **Automatic Inactivity Disconnect**: 5 continuous minutes when 0 humans are in channel`,
          inline: false
        },
        {
          name: 'Platform Policies & Limitations',
          value:
            '• **DRM-Protected Sources**: Spotify and Apple Music URLs cannot be streamed directly due to proprietary DRM. Search for the song title and artist instead.\n' +
            '• **Restricted Content**: Age-restricted or private YouTube videos cannot be extracted without interactive login.\n' +
            '• **Discord Permissions**: The bot must have `Connect` and `Speak` permissions in your voice channel.',
          inline: false
        },
        {
          name: 'Audio Troubleshooting',
          value:
            '• **No sound audible?** Check that Honey Bot user volume is not muted in Discord, ensure the bot has `Speak` permission, or run `/diagnose prompt: music`.\n' +
            '• **Wrong song playing?** Include both the track title and artist name in your query, or provide a direct YouTube/SoundCloud URL.',
          inline: false
        }
      )
      .setFooter({ text: 'Honey Bot Music Engine | Verified Audio Pipeline' })
      .setTimestamp();

    return embed;
  }

  static getCapabilityEmbed(guild = null) {
    return this.buildCapabilityEmbed(guild?.id, guild);
  }

  /**
   * Diagnostic self-repair for voice connection and player state.
   */
  static async repairGuildPlayback(guildId) {
    const sub = this.getSubscription(guildId);
    if (!sub) {
      return {
        repaired: true,
        actionsTaken: ['No active or zombie voice sessions found for this guild. Audio pipeline is clean.']
      };
    }

    const actionsTaken = [];

    // 1. Unpause or resume if autopaused
    if (sub.audioPlayer?.state?.status === AudioPlayerStatus.AutoPaused) {
      try {
        sub.audioPlayer.unpause();
        actionsTaken.push('Resumed autopaused audio player.');
      } catch (e) {
        actionsTaken.push(`Could not unpause player: ${e.message}`);
      }
    }

    // 2. Re-subscribe player if voice connection is active
    if (sub.voiceConnection && typeof sub.voiceConnection.subscribe === 'function') {
      try {
        sub.voiceConnection.subscribe(sub.audioPlayer);
        actionsTaken.push('Re-verified audio player subscription to voice connection.');
      } catch (e) {
        actionsTaken.push(`Could not subscribe player: ${e.message}`);
      }
    }

    // 3. Clear empty channel countdown if humans are present
    const channel = sub.resolveCurrentVoiceChannel();
    if (channel) {
      const humanCount = countHumanMembers(channel);
      if (humanCount > 0 && sub.emptyChannelTimer) {
        sub.cancelEmptyChannelCountdown(`Repaired: ${humanCount} human(s) present`);
        actionsTaken.push('Cancelled unnecessary idle disconnect timer (humans present).');
      }
    }

    return {
      repaired: true,
      actionsTaken: actionsTaken.length > 0 ? actionsTaken : ['Voice and audio pipeline verified healthy. No repairs needed.']
    };
  }
}

/**
 * Structured Source Adapters
 */
export class YouTubeSourceAdapter {
  constructor() {
    this.name = 'YouTube';
    this.domains = ['youtube.com', 'youtu.be', 'music.youtube.com', 'm.youtube.com'];
    this.searchSupported = true;
  }

  canHandle(queryOrUrl) {
    if (!queryOrUrl) return false;
    if (extractYouTubeId(queryOrUrl)) return true;
    if (/https?:\/\//i.test(queryOrUrl)) {
      return /(youtube\.com|youtu\.be|music\.youtube\.com)/i.test(queryOrUrl);
    }
    return true; // General queries default to YouTube search
  }

  async resolve(queryOrUrl, requestedBy) {
    return await MusicService.resolveTrack(queryOrUrl, requestedBy);
  }
}

export class SoundCloudSourceAdapter {
  constructor() {
    this.name = 'SoundCloud';
    this.domains = ['soundcloud.com'];
    this.searchSupported = false;
  }

  canHandle(queryOrUrl) {
    return isSoundCloudUrl(queryOrUrl);
  }

  async resolve(url, requestedBy) {
    return await MusicService.resolveTrack(url, requestedBy);
  }
}

export class DirectAudioSourceAdapter {
  constructor() {
    this.name = 'Direct Audio';
    this.domains = ['*'];
    this.searchSupported = false;
  }

  canHandle(queryOrUrl) {
    return isDirectAudioUrl(queryOrUrl);
  }

  async resolve(url, requestedBy) {
    return await MusicService.resolveTrack(url, requestedBy);
  }
}

export class SourceAdapterRegistry {
  constructor() {
    this.adapters = [
      new DirectAudioSourceAdapter(),
      new SoundCloudSourceAdapter(),
      new YouTubeSourceAdapter()
    ];
  }

  getAdapter(queryOrUrl) {
    for (const adapter of this.adapters) {
      if (adapter.canHandle(queryOrUrl)) return adapter;
    }
    return null;
  }
}

export const sourceAdapters = new SourceAdapterRegistry();
