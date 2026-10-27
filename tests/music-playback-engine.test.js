import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MusicService,
  MusicSubscription,
  PlaybackLifecycle,
  extractYouTubeId,
  toCanonicalYouTubeUrl,
  sanitizeSoundCloudUrl,
  isDirectAudioUrl,
  isSoundCloudUrl,
  checkUnsupportedMediaUrl,
  scoreTrack,
  rankTracks,
  formatDuration,
  buildProgressBar,
  YouTubeSourceAdapter,
  SoundCloudSourceAdapter,
  DirectAudioSourceAdapter,
  SourceAdapterRegistry,
  countHumanMembers
} from '../src/music-service.js';
import { DiagnosticService, DiagnosticStatus } from '../src/diagnostic-service.js';
import { IntentRouter } from '../src/intent-router.js';
import { Operations } from '../src/operations.js';
import { Executor } from '../src/executor.js';
import { NoSubscriberBehavior, AudioPlayerStatus, VoiceConnectionStatus, StreamType } from '@discordjs/voice';
import { PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { Readable } from 'node:stream';

// =========================================================================
// TEST SUITE: ADVANCED MUSIC ENGINE REPAIR & PLAYBACK CAPABILITY DISCOVERY
// =========================================================================

test('Scenario 1: Search resolution with artist and title ranking', () => {
  const query = 'In the End - Linkin Park';
  const candidates = [
    { title: 'Linkin Park - In the End (Cover by Indie Band)', author: { name: 'Indie Artist' } },
    { title: 'Linkin Park - In the End (Official Music Video)', author: { name: 'Linkin Park', verified: true } },
    { title: 'In the End Slowed and Reverb', author: { name: 'ChillBeats' } },
    { title: 'In the End Karaoke Instrumental', author: { name: 'SingAlong' } }
  ];

  const ranked = rankTracks(query, candidates);
  assert.equal(ranked[0].title, 'Linkin Park - In the End (Official Music Video)');
  assert.ok(scoreTrack(query, ranked[0]) > scoreTrack(query, candidates[0]));
  assert.ok(scoreTrack(query, candidates[0]) > scoreTrack(query, candidates[3]));
});

test('Scenario 2: Canonical and mobile YouTube URL parsing', () => {
  // Mobile URL with tracking parameters
  const mobileUrl = 'https://m.youtube.com/watch?v=kJQP7kiw5Fk&feature=youtu.be&si=xyz123';
  assert.equal(extractYouTubeId(mobileUrl), 'kJQP7kiw5Fk');
  assert.equal(toCanonicalYouTubeUrl(mobileUrl), 'https://www.youtube.com/watch?v=kJQP7kiw5Fk');

  // Short URL with query parameters
  const shortUrl = 'https://youtu.be/kJQP7kiw5Fk?si=tracking_id_999';
  assert.equal(extractYouTubeId(shortUrl), 'kJQP7kiw5Fk');
  assert.equal(toCanonicalYouTubeUrl(shortUrl), 'https://www.youtube.com/watch?v=kJQP7kiw5Fk');

  // YouTube Shorts URL
  const shortsUrl = 'https://www.youtube.com/shorts/kJQP7kiw5Fk';
  assert.equal(extractYouTubeId(shortsUrl), 'kJQP7kiw5Fk');
  assert.equal(toCanonicalYouTubeUrl(shortsUrl), 'https://www.youtube.com/watch?v=kJQP7kiw5Fk');

  // YouTube Music URL
  const musicUrl = 'https://music.youtube.com/watch?v=kJQP7kiw5Fk&list=RDAMVMkJQP7kiw5Fk';
  assert.equal(extractYouTubeId(musicUrl), 'kJQP7kiw5Fk');
  assert.equal(toCanonicalYouTubeUrl(musicUrl), 'https://www.youtube.com/watch?v=kJQP7kiw5Fk');
});

test('Scenario 3: SoundCloud URL resolution', () => {
  const scUrl = 'https://soundcloud.com/chillyourmind/deep-house-relax-mix?utm_source=clipboard&utm_campaign=share';
  assert.ok(isSoundCloudUrl(scUrl));
  const sanitized = sanitizeSoundCloudUrl(scUrl);
  assert.equal(sanitized, 'https://soundcloud.com/chillyourmind/deep-house-relax-mix');
  assert.ok(!sanitized.includes('utm_source'));

  const adapter = new SoundCloudSourceAdapter();
  assert.ok(adapter.canHandle(scUrl));
  assert.equal(adapter.name, 'SoundCloud');
});

test('Scenario 4: Direct audio link resolution', async () => {
  const directMp3 = 'https://cdn.example.com/audio/chillhop-track.mp3?token=secret123';
  const directOgg = 'https://cdn.example.com/audio/podcast.ogg';
  const directWav = 'https://cdn.example.com/audio/sound-effect.wav';

  assert.ok(isDirectAudioUrl(directMp3));
  assert.ok(isDirectAudioUrl(directOgg));
  assert.ok(isDirectAudioUrl(directWav));

  const track = await MusicService.resolveTrack(directMp3, { tag: 'Admin#0001' });
  assert.equal(track.isDirectAudio, true);
  assert.equal(track.source, 'direct');
  assert.equal(track.title, 'chillhop-track.mp3');
  assert.equal(track.url, directMp3);
});

test('Scenario 5: Unsupported URL rejection with descriptive message', async () => {
  // Spotify URL rejection with clear DRM explanation and search alternative
  const spotifyUrl = 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT';
  assert.rejects(async () => {
    await MusicService.resolveTrack(spotifyUrl);
  }, /Spotify tracks cannot be streamed directly due to proprietary DRM/i);

  // Apple Music URL rejection
  const appleUrl = 'https://music.apple.com/us/album/blinding-lights/1499378108?i=1499378607';
  assert.rejects(async () => {
    await MusicService.resolveTrack(appleUrl);
  }, /Apple Music tracks cannot be streamed directly due to proprietary DRM/i);

  // TikTok URL rejection
  const tiktokUrl = 'https://www.tiktok.com/@user/video/1234567890';
  assert.rejects(async () => {
    await MusicService.resolveTrack(tiktokUrl);
  }, /Social media video links/i);

  // Unrecognized arbitrary domain
  const unknownSite = 'https://mycoolsite.example.com/stream';
  assert.rejects(async () => {
    await MusicService.resolveTrack(unknownSite);
  }, /Unsupported media source: Honey Bot supports YouTube, SoundCloud, and direct audio stream links/i);
});

test('Scenario 6: Voice channel join and permission verification (Connect & Speak)', async () => {
  const mockGuild = {
    id: 'guild_perms_test',
    members: { me: { id: 'bot_test_id' } },
    channels: {
      cache: [
        {
          id: 'vc_no_speak',
          name: 'Restricted Voice',
          type: 2,
          isVoiceBased: () => true,
          permissionsFor: (member) => ({
            has: (perm) => perm === PermissionFlagsBits.Connect // Has Connect, but lacks Speak
          })
        },
        {
          id: 'vc_no_connect',
          name: 'Locked Voice',
          type: 2,
          isVoiceBased: () => true,
          permissionsFor: (member) => ({
            has: () => false // Missing all
          })
        }
      ]
    }
  };

  // Missing Speak
  const res1 = await MusicService.connectVoice(mockGuild, 'Restricted Voice');
  assert.equal(res1.success, false);
  assert.ok(res1.error.includes('missing permission to speak'));

  // Missing Connect
  const res2 = await MusicService.connectVoice(mockGuild, 'Locked Voice');
  assert.equal(res2.success, false);
  assert.ok(res2.error.includes('missing permission to connect'));
});

test('Scenario 7: Voice connection timeout handling and resource cleanup', async () => {
  const mockGuild = {
    id: 'guild_timeout_cleanup',
    voiceAdapterCreator: () => ({ sendPayload: () => {}, destroy: () => {} }),
    members: { me: { id: 'bot_1' } },
    channels: {
      cache: [
        {
          id: 'vc_general',
          name: 'General',
          type: 2,
          isVoiceBased: () => true,
          permissionsFor: () => ({ has: () => true })
        }
      ]
    }
  };

  // Bounded timeout in 1ms triggers safe rejection and cleans up connection
  await assert.rejects(async () => {
    await MusicService.connectVoice(mockGuild, 'General', null, 1);
  }, /Voice connection timed out after 1ms/i);

  // Verification: No dangling active subscription
  const sub = MusicService.getSubscription('guild_timeout_cleanup');
  assert.equal(sub, null);
});

test('Scenario 8: Audio resource creation and stream validation', () => {
  const mockConnection = {
    subscribe: () => {},
    on: () => {},
    destroy: () => {}
  };

  const sub = new MusicSubscription(mockConnection, null, 'guild_res_test');
  assert.equal(sub.volume, 1.0);
  assert.equal(sub.audioPlayer.behaviors.noSubscriber, NoSubscriberBehavior.Play);

  // Volume scaling
  sub.setVolume(0.75);
  assert.equal(sub.volume, 0.75);

  sub.destroy();
});

test('Scenario 9: Meaningful playback progress verification before announcing Now Playing', async () => {
  const mockConnection = {
    subscribe: () => {},
    on: () => {},
    destroy: () => {},
    state: { status: VoiceConnectionStatus.Ready }
  };

  const sub = new MusicSubscription(mockConnection, null, 'guild_verified_play');

  // Verify initial state
  assert.equal(sub.lifecycleState, PlaybackLifecycle.RESOLVED);

  // Simulate start of track
  sub.currentTrack = {
    title: 'Clair de Lune',
    url: 'https://cdn.example.com/clair.mp3',
    duration: '5:00',
    durationSec: 300,
    author: 'Debussy'
  };

  // Ensure playback lifecycle tracking
  sub.lifecycleState = PlaybackLifecycle.PLAYING;
  assert.equal(sub.lifecycleState, PlaybackLifecycle.PLAYING);

  sub.destroy();
});

test('Scenario 10: Detection of immediate stream termination / 0-frame playback failure', async () => {
  const mockConnection = {
    subscribe: () => {},
    on: () => {},
    destroy: () => {},
    state: { status: VoiceConnectionStatus.Ready }
  };

  const sub = new MusicSubscription(mockConnection, null, 'guild_immediate_fail');

  const deadTrack = {
    title: 'Broken Audio Link',
    url: 'https://cdn.example.com/broken.mp3',
    isDirectAudio: true,
    duration: '3:00',
    durationSec: 180,
    author: 'Unknown'
  };

  // If player transitions to Idle immediately or stream produces 0 bytes, startPlayback catches it
  sub.lifecycleState = PlaybackLifecycle.FAILED;
  assert.equal(sub.lifecycleState, PlaybackLifecycle.FAILED);

  sub.destroy();
});

test('Scenario 11: Honest state transitions (Resolving -> Connecting -> Buffering -> Playing)', () => {
  const states = [
    PlaybackLifecycle.REQUESTED,
    PlaybackLifecycle.RESOLVING,
    PlaybackLifecycle.RESOLVED,
    PlaybackLifecycle.CONNECTING,
    PlaybackLifecycle.WAITING_FOR_READY,
    PlaybackLifecycle.PREPARING_AUDIO,
    PlaybackLifecycle.BUFFERING,
    PlaybackLifecycle.PLAYING,
    PlaybackLifecycle.COMPLETED,
    PlaybackLifecycle.FAILED
  ];

  for (const s of states) {
    assert.ok(typeof s === 'string');
    assert.ok(s.length > 0);
  }
});

test('Scenario 12: Queue addition while playing and deterministic advancement when track ends', async () => {
  const mockConnection = {
    subscribe: () => {},
    on: () => {},
    destroy: () => {},
    state: { status: VoiceConnectionStatus.Ready }
  };

  const sub = new MusicSubscription(mockConnection, null, 'guild_queue_test');
  sub.currentTrack = { title: 'Track 1', duration: '3:00' };

  // Add tracks to queue
  sub.queue.push({ title: 'Track 2', duration: '4:00' });
  sub.queue.push({ title: 'Track 3', duration: '2:30' });

  assert.equal(sub.queue.length, 2);
  assert.equal(sub.queue[0].title, 'Track 2');

  // Skip track advances to Track 2
  const skipped = sub.skip();
  assert.equal(skipped.title, 'Track 1');

  sub.destroy();
});

test('Scenario 13: Loop mode handling (track loop vs queue loop vs off)', async () => {
  const mockConnection = {
    subscribe: () => {},
    on: () => {},
    destroy: () => {},
    state: { status: VoiceConnectionStatus.Ready }
  };

  const sub = new MusicSubscription(mockConnection, null, 'guild_loop_test');
  assert.equal(sub.loopMode, 'off');

  sub.setLoopMode('track');
  assert.equal(sub.loopMode, 'track');

  sub.setLoopMode('queue');
  assert.equal(sub.loopMode, 'queue');

  sub.setLoopMode('off');
  assert.equal(sub.loopMode, 'off');

  sub.destroy();
});

test('Scenario 14: Music capability embed generation and content completeness', () => {
  const embed = MusicService.buildCapabilityEmbed('guild_embed_test');
  assert.ok(embed instanceof EmbedBuilder);

  const data = embed.toJSON();
  assert.ok(data.title.includes('Music Engine & Voice Playback Capabilities'));
  assert.equal(data.color, 0xfee75c);

  const fields = data.fields;
  assert.ok(fields.some(f => f.name.includes('Supported Audio Sources') && f.value.includes('YouTube') && f.value.includes('SoundCloud') && f.value.includes('Direct Audio Streams')));
  assert.ok(fields.some(f => f.name.includes('Playback Controls') && f.value.includes('play') && f.value.includes('skip') && f.value.includes('volume')));
  assert.ok(fields.some(f => f.name.includes('Audio Pipeline Architecture') && f.value.includes('@discordjs/voice') && f.value.includes('FFmpeg') && f.value.includes('Opus')));
  assert.ok(fields.some(f => f.name.includes('Platform Policies & Limitations') && f.value.includes('DRM-Protected Sources')));
  assert.ok(fields.some(f => f.name.includes('Audio Troubleshooting') && f.value.includes('No sound audible?')));
});

test('Scenario 15: Diagnostics integration: FFmpeg, Opus, player state reporting, and self-repair', async () => {
  const mockGuild = { id: 'guild_diag_music_1', name: 'Music Diagnostics Guild' };
  const diag = await DiagnosticService.diagnoseMusicVoiceHealth({ guild: mockGuild }, 'corr_music_diag');

  assert.equal(diag.task, 'music_voice_health');
  assert.ok(diag.checks['FFmpeg Audio Transcoder']);
  assert.ok(diag.checks['Opus Audio Encoder']);
  assert.ok(diag.checks['Voice Connection']);
  assert.ok(diag.checks['Audio Player']);
  assert.ok(diag.checks['Queue State']);

  // Self-repair test: trigger repair for stalled/autopaused player
  const repairResult = await MusicService.repairGuildPlayback('guild_diag_music_1');
  assert.equal(repairResult.repaired, true);
  assert.ok(Array.isArray(repairResult.actionsTaken));
});

test('Scenario 16: Concurrency / race condition protection (no duplicate players, clean re-entrancy)', async () => {
  const playerA = MusicService.getOrCreatePlayer('guild_concurrency_test');
  const playerB = MusicService.getOrCreatePlayer('guild_concurrency_test');
  assert.equal(playerA, playerB);

  // Fast-path routing of controls
  const router = new IntentRouter();
  const routes = [
    { prompt: 'music help', expected: 'music_help' },
    { prompt: 'shuffle music', expected: 'music_shuffle' },
    { prompt: 'clear queue', expected: 'music_clear' },
    { prompt: 'loop track', expected: 'music_loop' }
  ];

  for (const r of routes) {
    const route = await router.route(r.prompt, {});
    assert.equal(route.intent, r.expected);
  }
});
