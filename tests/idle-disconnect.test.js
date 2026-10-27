import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MusicService,
  MusicSubscription,
  countHumanMembers,
  PlaybackLifecycle
} from '../src/music-service.js';

test('Idle Disconnect: countHumanMembers correctly ignores bots and Honey Bot', () => {
  const honeyBotId = 'bot_honey_123';

  // 1. Channel with only Honey Bot and another bot
  const botOnlyChannel = {
    id: 'vc_bots_only',
    members: new Map([
      ['bot_honey_123', { id: 'bot_honey_123', user: { id: 'bot_honey_123', bot: true } }],
      ['bot_other_456', { id: 'bot_other_456', user: { id: 'bot_other_456', bot: true } }]
    ])
  };
  assert.equal(countHumanMembers(botOnlyChannel, honeyBotId), 0);

  // 2. Channel with Honey Bot and 2 humans
  const mixedChannel = {
    id: 'vc_mixed',
    members: new Map([
      ['bot_honey_123', { id: 'bot_honey_123', user: { id: 'bot_honey_123', bot: true } }],
      ['user_human_1', { id: 'user_human_1', user: { id: 'user_human_1', bot: false } }],
      ['user_human_2', { id: 'user_human_2', user: { id: 'user_human_2', bot: false } }]
    ])
  };
  assert.equal(countHumanMembers(mixedChannel, honeyBotId), 2);

  // 3. Channel with only humans
  const humanOnlyChannel = {
    id: 'vc_humans',
    members: new Map([
      ['user_human_1', { id: 'user_human_1', user: { id: 'user_human_1', bot: false } }]
    ])
  };
  assert.equal(countHumanMembers(humanOnlyChannel, honeyBotId), 1);
});

test('Idle Disconnect: Last human leaves -> disconnects after timeout with user feedback', async () => {
  let destroyed = false;
  let sentMessage = null;

  const mockConn = {
    subscribe: () => {},
    on: () => {},
    destroy: () => { destroyed = true; },
    joinConfig: { channelId: 'vc_test_1' }
  };

  const mockTextChannel = {
    send: async (payload) => {
      sentMessage = payload;
      return payload;
    }
  };

  const guildId = 'guild_idle_test_1';
  const sub = new MusicSubscription(mockConn, mockTextChannel, guildId);
  MusicService.subscriptions.set(guildId, sub);

  // Use fast 50ms timeout for testing
  sub.setIdleTimeout(50);

  const emptyVoiceChannel = {
    id: 'vc_test_1',
    members: new Map([
      ['bot_honey', { id: 'bot_honey', user: { id: 'bot_honey', bot: true } }]
    ])
  };

  // Evaluate empty channel -> starts countdown
  sub.evaluateChannelOccupancy(emptyVoiceChannel, 'bot_honey');
  assert.ok(sub.emptyChannelTimer, 'Timer must be active when channel is empty of humans');

  // Wait for countdown to expire
  await new Promise(r => setTimeout(r, 80));

  assert.equal(destroyed, true, 'Voice connection must be destroyed on timeout');
  assert.equal(MusicService.getSubscription(guildId), null, 'Subscription must be removed from MusicService');
  assert.ok(sentMessage, 'Text feedback must be dispatched on idle disconnect');
  assert.ok(sentMessage.embeds[0].data.description.includes('5 continuous minutes'));
});

test('Idle Disconnect: Human returns before timeout -> cancels countdown immediately', async () => {
  let destroyed = false;

  const mockConn = {
    subscribe: () => {},
    on: () => {},
    destroy: () => { destroyed = true; },
    joinConfig: { channelId: 'vc_test_2' }
  };

  const guildId = 'guild_idle_test_2';
  const sub = new MusicSubscription(mockConn, null, guildId);
  MusicService.subscriptions.set(guildId, sub);
  sub.setIdleTimeout(100);

  const emptyChannel = {
    id: 'vc_test_2',
    members: new Map([
      ['bot_honey', { id: 'bot_honey', user: { id: 'bot_honey', bot: true } }]
    ])
  };

  // 1. Human leaves -> starts timer
  sub.evaluateChannelOccupancy(emptyChannel, 'bot_honey');
  assert.ok(sub.emptyChannelTimer);

  // 2. Human returns at 30ms before 100ms expires
  await new Promise(r => setTimeout(r, 30));

  const occupiedChannel = {
    id: 'vc_test_2',
    members: new Map([
      ['bot_honey', { id: 'bot_honey', user: { id: 'bot_honey', bot: true } }],
      ['user_1', { id: 'user_1', user: { id: 'user_1', bot: false } }]
    ])
  };
  sub.evaluateChannelOccupancy(occupiedChannel, 'bot_honey');
  assert.equal(sub.emptyChannelTimer, null, 'Timer must be cancelled when human returns');

  // Wait past original 100ms
  await new Promise(r => setTimeout(r, 100));
  assert.equal(destroyed, false, 'Bot must not disconnect when human returned in time');

  sub.destroy();
});

test('Idle Disconnect: Human leaves again -> fresh countdown starts', async () => {
  const mockConn = {
    subscribe: () => {},
    on: () => {},
    destroy: () => {},
    joinConfig: { channelId: 'vc_test_3' }
  };

  const guildId = 'guild_idle_test_3';
  const sub = new MusicSubscription(mockConn, null, guildId);
  sub.setIdleTimeout(200);

  const emptyChannel = {
    id: 'vc_test_3',
    members: new Map([
      ['bot_honey', { id: 'bot_honey', user: { id: 'bot_honey', bot: true } }]
    ])
  };

  const occupiedChannel = {
    id: 'vc_test_3',
    members: new Map([
      ['bot_honey', { id: 'bot_honey', user: { id: 'bot_honey', bot: true } }],
      ['user_1', { id: 'user_1', user: { id: 'user_1', bot: false } }]
    ])
  };

  // Human leaves -> timer 1 starts
  sub.evaluateChannelOccupancy(emptyChannel, 'bot_honey');
  const t1 = sub.emptyChannelTimerStartedAt;
  assert.ok(t1 > 0);

  // Human joins -> cancels
  sub.evaluateChannelOccupancy(occupiedChannel, 'bot_honey');
  assert.equal(sub.emptyChannelTimer, null);

  // Small delay
  await new Promise(r => setTimeout(r, 20));

  // Human leaves again -> fresh timer 2 starts
  sub.evaluateChannelOccupancy(emptyChannel, 'bot_honey');
  const t2 = sub.emptyChannelTimerStartedAt;
  assert.ok(t2 >= t1, 'Fresh timer must have updated start timestamp');
  assert.ok(sub.emptyChannelTimer);

  sub.destroy();
});

test('Idle Disconnect: Other bots remain in voice channel -> still disconnects after timeout', async () => {
  let destroyed = false;

  const mockConn = {
    subscribe: () => {},
    on: () => {},
    destroy: () => { destroyed = true; },
    joinConfig: { channelId: 'vc_test_bots' }
  };

  const guildId = 'guild_idle_test_bots';
  const sub = new MusicSubscription(mockConn, null, guildId);
  sub.setIdleTimeout(50);

  const botsOnlyChannel = {
    id: 'vc_test_bots',
    members: new Map([
      ['bot_honey', { id: 'bot_honey', user: { id: 'bot_honey', bot: true } }],
      ['bot_music_2', { id: 'bot_music_2', user: { id: 'bot_music_2', bot: true } }],
      ['bot_moderator', { id: 'bot_moderator', user: { id: 'bot_moderator', bot: true } }]
    ])
  };

  sub.evaluateChannelOccupancy(botsOnlyChannel, 'bot_honey');
  assert.ok(sub.emptyChannelTimer, 'Bots must not count as humans');

  await new Promise(r => setTimeout(r, 80));
  assert.equal(destroyed, true, 'Channel with only bots must disconnect after timeout');
});

test('Idle Disconnect: Human remains in channel -> no disconnect even if playback is idle or paused', async () => {
  let destroyed = false;

  const mockConn = {
    subscribe: () => {},
    on: () => {},
    destroy: () => { destroyed = true; },
    joinConfig: { channelId: 'vc_test_human_stays' }
  };

  const guildId = 'guild_idle_test_human';
  const sub = new MusicSubscription(mockConn, null, guildId);
  sub.setIdleTimeout(50);

  const occupiedChannel = {
    id: 'vc_test_human_stays',
    members: new Map([
      ['bot_honey', { id: 'bot_honey', user: { id: 'bot_honey', bot: true } }],
      ['user_active', { id: 'user_active', user: { id: 'user_active', bot: false } }]
    ])
  };

  sub.isPaused = true;
  sub.lifecycleState = PlaybackLifecycle.COMPLETED;
  sub.evaluateChannelOccupancy(occupiedChannel, 'bot_honey');

  assert.equal(sub.emptyChannelTimer, null, 'No timer while human is present');
  await new Promise(r => setTimeout(r, 80));
  assert.equal(destroyed, false, 'Must not disconnect while human is present');

  sub.destroy();
});

test('Idle Disconnect: Stale timer after channel change does NOT disconnect new session', async () => {
  let destroyed = false;

  const mockConn = {
    subscribe: () => {},
    on: () => {},
    destroy: () => { destroyed = true; },
    joinConfig: { channelId: 'vc_channel_A' }
  };

  const guildId = 'guild_stale_timer_test';
  const sub = new MusicSubscription(mockConn, null, guildId);
  sub.setIdleTimeout(60);

  const channelA = {
    id: 'vc_channel_A',
    members: new Map([['bot_honey', { id: 'bot_honey', user: { id: 'bot_honey', bot: true } }]])
  };

  // 1. Timer starts on Channel A
  sub.evaluateChannelOccupancy(channelA, 'bot_honey');
  assert.ok(sub.emptyChannelTimer);

  // 2. Bot moves to Channel B before timeout
  sub.handleChannelChange('vc_channel_B');
  assert.equal(sub.emptyChannelTimer, null, 'Old timer must be cleared on channel move');
  assert.equal(sub.currentVoiceChannelId, 'vc_channel_B');

  // Channel B has a human
  const channelB = {
    id: 'vc_channel_B',
    members: new Map([
      ['bot_honey', { id: 'bot_honey', user: { id: 'bot_honey', bot: true } }],
      ['user_friend', { id: 'user_friend', user: { id: 'user_friend', bot: false } }]
    ])
  };
  sub.evaluateChannelOccupancy(channelB, 'bot_honey');

  // Wait past original Channel A timeout
  await new Promise(r => setTimeout(r, 100));
  assert.equal(destroyed, false, 'New session on Channel B must remain connected');

  sub.destroy();
});

test('Idle Disconnect: Two guilds have independent timers and do not affect each other', async () => {
  let guild1Destroyed = false;
  let guild2Destroyed = false;

  const conn1 = {
    subscribe: () => {},
    on: () => {},
    destroy: () => { guild1Destroyed = true; },
    joinConfig: { channelId: 'vc_guild_1' }
  };

  const conn2 = {
    subscribe: () => {},
    on: () => {},
    destroy: () => { guild2Destroyed = true; },
    joinConfig: { channelId: 'vc_guild_2' }
  };

  const sub1 = new MusicSubscription(conn1, null, 'guild_multi_1');
  const sub2 = new MusicSubscription(conn2, null, 'guild_multi_2');

  MusicService.subscriptions.set('guild_multi_1', sub1);
  MusicService.subscriptions.set('guild_multi_2', sub2);

  sub1.setIdleTimeout(40);
  sub2.setIdleTimeout(150);

  // Guild 1 is empty -> starts 40ms timer
  sub1.evaluateChannelOccupancy({
    id: 'vc_guild_1',
    members: new Map([['bot_honey', { id: 'bot_honey', user: { id: 'bot_honey', bot: true } }]])
  }, 'bot_honey');

  // Guild 2 has a human -> no timer
  sub2.evaluateChannelOccupancy({
    id: 'vc_guild_2',
    members: new Map([
      ['bot_honey', { id: 'bot_honey', user: { id: 'bot_honey', bot: true } }],
      ['human_2', { id: 'human_2', user: { id: 'human_2', bot: false } }]
    ])
  }, 'bot_honey');

  // Wait 70ms: Guild 1 should be destroyed, Guild 2 must remain connected
  await new Promise(r => setTimeout(r, 70));

  assert.equal(guild1Destroyed, true, 'Guild 1 must disconnect after its timer');
  assert.equal(guild2Destroyed, false, 'Guild 2 must remain connected');

  sub2.destroy();
});

test('Idle Disconnect: MusicService.handleVoiceStateUpdate routes voice state changes', () => {
  let timerStarted = false;

  const mockSub = {
    currentVoiceChannelId: 'vc_bot_ch',
    voiceConnection: { joinConfig: { channelId: 'vc_bot_ch' } },
    evaluateChannelOccupancy: (ch, botId) => {
      timerStarted = true;
    },
    destroy: () => {}
  };

  MusicService.subscriptions.set('guild_vsu_test', mockSub);

  // Someone leaves bot's channel
  const oldState = {
    guild: {
      id: 'guild_vsu_test',
      channels: {
        cache: new Map([
          ['vc_bot_ch', { id: 'vc_bot_ch', members: new Map() }]
        ])
      }
    },
    channelId: 'vc_bot_ch',
    member: { id: 'human_leaving' }
  };

  const newState = {
    guild: {
      id: 'guild_vsu_test',
      channels: {
        cache: new Map([
          ['vc_bot_ch', { id: 'vc_bot_ch', members: new Map() }]
        ])
      }
    },
    channelId: null,
    member: { id: 'human_leaving' }
  };

  MusicService.handleVoiceStateUpdate(oldState, newState, 'bot_honey');
  assert.equal(timerStarted, true, 'handleVoiceStateUpdate must re-evaluate occupancy when member leaves channel');

  MusicService.subscriptions.delete('guild_vsu_test');
});
