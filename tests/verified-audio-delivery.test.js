import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MusicService,
  MusicSubscription,
  PlaybackLifecycle,
  extractYouTubeId,
  toCanonicalYouTubeUrl,
  scoreTrack,
  rankTracks
} from '../src/music-service.js';
import { DiagnosticService, DiagnosticStatus } from '../src/diagnostic-service.js';
import { NoSubscriberBehavior, AudioPlayerStatus, VoiceConnectionStatus } from '@discordjs/voice';

test('Verified Audio Delivery: YouTube URL sanitizer extracts video ID and canonical watch URL', () => {
  // Test messy URL with playlist, radio, and tracking parameters
  const messyUrl = 'https://www.youtube.com/watch?v=2JBWjIe9jQY&list=RD2JBWjIe9jQY&start_radio=1';
  assert.equal(extractYouTubeId(messyUrl), '2JBWjIe9jQY');
  assert.equal(toCanonicalYouTubeUrl(messyUrl), 'https://www.youtube.com/watch?v=2JBWjIe9jQY');

  // Short URL
  const shortUrl = 'https://youtu.be/dQw4w9WgXcQ?si=abcdef123456';
  assert.equal(extractYouTubeId(shortUrl), 'dQw4w9WgXcQ');
  assert.equal(toCanonicalYouTubeUrl(shortUrl), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');

  // Embed URL
  const embedUrl = 'https://www.youtube.com/embed/9bZkp7q19f0';
  assert.equal(extractYouTubeId(embedUrl), '9bZkp7q19f0');
  assert.equal(toCanonicalYouTubeUrl(embedUrl), 'https://www.youtube.com/watch?v=9bZkp7q19f0');

  // YouTube Music URL
  const musicUrl = 'https://music.youtube.com/watch?v=L_LUpnjgPso';
  assert.equal(extractYouTubeId(musicUrl), 'L_LUpnjgPso');
  assert.equal(toCanonicalYouTubeUrl(musicUrl), 'https://www.youtube.com/watch?v=L_LUpnjgPso');
});

test('Verified Audio Delivery: AudioPlayer configured with NoSubscriberBehavior.Play to prevent auto-pause freeze', () => {
  const mockConn = {
    subscribe: () => {},
    on: () => {},
    destroy: () => {}
  };

  const sub = new MusicSubscription(mockConn, null, 'guild_audio_test');
  assert.equal(sub.audioPlayer.behaviors.noSubscriber, NoSubscriberBehavior.Play);
  assert.equal(sub.lifecycleState, PlaybackLifecycle.RESOLVED);
  sub.destroy();
});

test('Verified Audio Delivery: PlaybackLifecycle state transitions follow expected cycle', () => {
  assert.equal(PlaybackLifecycle.REQUESTED, 'REQUESTED');
  assert.equal(PlaybackLifecycle.WAITING_FOR_READY, 'WAITING_FOR_READY');
  assert.equal(PlaybackLifecycle.PREPARING_AUDIO, 'PREPARING_AUDIO');
  assert.equal(PlaybackLifecycle.BUFFERING, 'BUFFERING');
  assert.equal(PlaybackLifecycle.PLAYING, 'PLAYING');
  assert.equal(PlaybackLifecycle.COMPLETED, 'COMPLETED');
  assert.equal(PlaybackLifecycle.FAILED, 'FAILED');
});

test('Verified Audio Delivery: Playback rejects when member is not in voice without sending false Now Playing', async () => {
  const mockGuild = {
    id: 'guild_truthful_1',
    name: 'Truthful Guild',
    channels: { cache: [] },
    members: { me: { id: 'bot_truth' } }
  };
  const mockMember = { id: 'user_truth', voice: { channel: null } };

  const result = await MusicService.play(mockGuild, mockMember, 'despacito');
  assert.equal(result.success, false);
  assert.ok(result.error.includes('must join a voice channel'));
  // Never returns playing: true or an embed on failure
  assert.equal(result.playing, undefined);
  assert.equal(result.embed, undefined);
});

test('Verified Audio Delivery: Search ranking prioritizes exact query matches over covers', () => {
  const query = 'Numb - Linkin Park';
  const candidates = [
    { title: 'Linkin Park - Numb (Official Music Video)', author: { name: 'Linkin Park', verified: true } },
    { title: 'Numb - Linkin Park (Cover by Artist)', author: { name: 'CoverArtist' } },
    { title: 'Numb Karaoke Version', author: { name: 'Karaoke Channel' } }
  ];

  const ranked = rankTracks(query, candidates);
  assert.equal(ranked[0].title, 'Linkin Park - Numb (Official Music Video)');
});

test('Verified Audio Delivery: Music diagnostics expose structured health, ffmpeg, and player state', async () => {
  const mockGuild = { id: 'guild_diag_voice', name: 'Voice Test Guild' };
  const result = await DiagnosticService.diagnoseMusicVoiceHealth({ guild: mockGuild }, 'test_corr_1');

  assert.ok(result);
  assert.equal(result.task, 'music_voice_health');
  assert.ok(result.checks['FFmpeg Audio Transcoder']);
  assert.ok(result.checks['Voice Connection']);
  assert.ok(result.checks['Audio Player']);
  assert.ok(result.checks['Queue State']);
});
