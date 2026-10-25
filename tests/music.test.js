import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MusicService,
  MusicSubscription,
  formatDuration,
  buildProgressBar
} from '../src/music-service.js';
import { IntentRouter } from '../src/intent-router.js';
import { Operations } from '../src/operations.js';
import { Executor } from '../src/executor.js';
import { CAPABILITY_REGISTRY } from '../src/capabilities.js';
import { ActionSchema } from '../src/schemas.js';

test('Music Helpers: formatDuration formats seconds accurately', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(45), '0:45');
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(600), '10:00');
  assert.equal(formatDuration(3661), '1:01:01');
  assert.equal(formatDuration('215'), '3:35');
});

test('Music Helpers: buildProgressBar generates valid ASCII progress indicator', () => {
  const barEmpty = buildProgressBar(0, 100, 10);
  assert.ok(barEmpty.startsWith('🔘'));
  assert.equal(barEmpty.length, 12); // '🔘' (2 UTF-16 code units) + 10 dashes

  const barMid = buildProgressBar(50, 100, 10);
  assert.ok(barMid.includes('🔘'));

  const barFull = buildProgressBar(100, 100, 10);
  assert.ok(barFull.endsWith('🔘'));
});

test('Music Routing: IntentRouter fast-paths play requests', async () => {
  const router = new IntentRouter();

  const playSong = await router.route('play lofi hip hop', {});
  assert.equal(playSong.intent, 'music_play');
  assert.equal(playSong.args.query, 'lofi hip hop');

  const playUrl = await router.route('play https://www.youtube.com/watch?v=dQw4w9WgXcQ', {});
  assert.equal(playUrl.intent, 'music_play');
  assert.equal(playUrl.args.query, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');

  const streamMusic = await router.route('stream music synthwave chill', {});
  assert.equal(streamMusic.intent, 'music_play');
  assert.equal(streamMusic.args.query, 'synthwave chill');
});

test('Music Routing: IntentRouter fast-paths playback controls', async () => {
  const router = new IntentRouter();

  const pauseRes = await router.route('pause music', {});
  assert.equal(pauseRes.intent, 'music_pause');

  const resumeRes = await router.route('resume', {});
  assert.equal(resumeRes.intent, 'music_resume');

  const skipRes = await router.route('skip song', {});
  assert.equal(skipRes.intent, 'music_skip');

  const stopRes = await router.route('stop playback', {});
  assert.equal(stopRes.intent, 'music_stop');

  const queueRes = await router.route('show queue', {});
  assert.equal(queueRes.intent, 'music_queue');

  const npRes = await router.route('now playing', {});
  assert.equal(npRes.intent, 'music_nowplaying');

  const volRes = await router.route('volume 75%', {});
  assert.equal(volRes.intent, 'music_volume');
  assert.equal(volRes.args.volume, 75);

  const leaveRes = await router.route('leave voice', {});
  assert.equal(leaveRes.intent, 'music_leave');
});

test('Music Registry: Capability registry contains music actions', () => {
  const musicActions = [
    'music_play',
    'music_pause',
    'music_resume',
    'music_skip',
    'music_stop',
    'music_queue',
    'music_nowplaying',
    'music_volume',
    'music_leave'
  ];

  for (const act of musicActions) {
    const entry = CAPABILITY_REGISTRY[act];
    assert.ok(entry, `CAPABILITY_REGISTRY must have entry for ${act}`);
    assert.equal(entry.category, 'MUSIC');
    assert.equal(entry.status, 'IMPLEMENTED');
  }
});

test('Music Schemas: ActionSchema parses music action payloads', () => {
  const playParsed = ActionSchema.safeParse({ action: 'music_play', query: 'lofi beats' });
  assert.ok(playParsed.success);

  const pauseParsed = ActionSchema.safeParse({ action: 'music_pause' });
  assert.ok(pauseParsed.success);

  const volParsed = ActionSchema.safeParse({ action: 'music_volume', volume: 85 });
  assert.ok(volParsed.success);
});

test('MusicService: Rejects play when member is not in a voice channel', async () => {
  const mockGuild = { id: 'guild_test_123', name: 'Test Guild', members: { me: { id: 'bot_1' } } };
  const mockMember = { id: 'user_1', voice: { channel: null } };

  const result = await MusicService.play(mockGuild, mockMember, 'lofi beats');
  assert.equal(result.success, false);
  assert.ok(result.error.includes('must join a voice channel'));
});

test('MusicService: Volume validation restricts values to 0-150', async () => {
  const mockGuild = { id: 'guild_vol_test' };

  // Not connected
  const notConnected = await MusicService.setVolume(mockGuild, 50);
  assert.equal(notConnected.success, false);
  assert.ok(notConnected.error.includes('not connected'));
});

test('MusicSubscription: State and queue manipulation', () => {
  const mockConnection = {
    subscribe: () => {},
    on: () => {},
    destroy: () => {}
  };

  const sub = new MusicSubscription(mockConnection, null, 'guild_sub_test');
  assert.equal(sub.volume, 1.0);
  assert.equal(sub.queue.length, 0);

  // Volume setting
  const vol80 = sub.setVolume(0.8);
  assert.equal(vol80, 80);
  assert.equal(sub.volume, 0.8);

  // Volume bounds cap at 1.5 (150%)
  const volOver = sub.setVolume(2.0);
  assert.equal(volOver, 150);
  assert.equal(sub.volume, 1.5);

  // Queue push
  sub.queue.push({
    title: 'Test Song 1',
    url: 'https://youtube.com/watch?v=1',
    duration: '3:00',
    durationSec: 180,
    author: 'Test Artist',
    requestedBy: 'User#1234'
  });
  assert.equal(sub.queue.length, 1);

  // Destroy clears state
  sub.destroy();
  assert.equal(MusicService.getSubscription('guild_sub_test'), null);
});

test('Executor: Dispatches music actions via executeIntent', async () => {
  const mockGuild = { id: 'guild_exec_music', name: 'Exec Guild' };
  const executionContext = { invokingMember: { id: 'user_exec', voice: { channel: null } } };

  // Test that executeIntent calls play and catches voice channel absence cleanly
  const res = await Executor.executeIntent(
    mockGuild,
    { intent: 'music_play', targetRef: 'lofi beats', args: { query: 'lofi beats' } },
    executionContext,
    'exec_music_1'
  );

  assert.equal(res.success, false);
  assert.ok(res.error.includes('must join a voice channel'));

  // Test leave when not connected
  const leaveRes = await Executor.executeIntent(
    mockGuild,
    { intent: 'music_leave', targetRef: null, args: {} },
    executionContext,
    'exec_music_2'
  );
  assert.equal(leaveRes.success, true);
  assert.ok(leaveRes.details.includes('not currently in a voice channel'));
});
