import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreTrack, rankTracks, MusicService } from '../src/music-service.js';
import { ExperienceStore, FailureCategory } from '../src/experience-store.js';
import { DashboardManager, DASHBOARD_PAGES } from '../src/dashboard.js';

test('Music Ranking: scoreTrack prioritizes exact title and artist matches', () => {
  const query = 'CALL OUT MY NAME - By the weeknd';

  const officialTrack = {
    title: 'The Weeknd - Call Out My Name (Official Lyric Video)',
    author: { name: 'The Weeknd', verified: true }
  };

  const karaokeTrack = {
    title: 'Call Out My Name (Karaoke Version)',
    author: { name: 'Sing King' }
  };

  const slowedTrack = {
    title: 'The Weeknd - Call Out My Name (Slowed + Reverb)',
    author: { name: 'RandomUploader' }
  };

  const officialScore = scoreTrack(query, officialTrack);
  const karaokeScore = scoreTrack(query, karaokeTrack);
  const slowedScore = scoreTrack(query, slowedTrack);

  assert.ok(officialScore > karaokeScore, `Official track (${officialScore}) should score higher than karaoke (${karaokeScore})`);
  assert.ok(officialScore > slowedScore, `Official track (${officialScore}) should score higher than slowed (${slowedScore})`);
});

test('Music Ranking: rankTracks sorts songs by relevance to the query', () => {
  const query = 'Starboy - The Weeknd';

  const tracks = [
    { title: 'Starboy (Cover)', author: { name: 'Acoustic Covers' } },
    { title: 'The Weeknd - Starboy (Official Video) ft. Daft Punk', author: { name: 'The Weeknd', verified: true } },
    { title: 'Starboy Karaoke Instrumental', author: { name: 'Karaoke Channel' } }
  ];

  const ranked = rankTracks(query, tracks);
  assert.equal(ranked[0].title, 'The Weeknd - Starboy (Official Video) ft. Daft Punk');
});

test('Continuous Learning: ExperienceStore records execution and failure taxonomies', () => {
  const guildId = 'test_guild_learning_1';
  const execId = `test_exec_${Date.now()}`;

  const record = ExperienceStore.recordExecution({
    executionId: execId,
    guildId,
    userId: 'user_123',
    userPrompt: 'delete channel #secret and token Bot 1234567890abcdef',
    normalizedIntent: 'delete_channel',
    plan: { actions: [{ action: 'delete_channel', target: 'secret' }] },
    capabilities: ['delete_channel'],
    outcome: 'failed',
    errorMessage: 'Missing Permissions: Administrator or ManageChannels required.',
    latencyMs: 150
  });

  assert.ok(record);
  assert.equal(record.executionId, execId);
  assert.equal(record.errorCategory, FailureCategory.PERMISSION_DENIED);
  // Secret token redaction verification
  assert.ok(!record.userPrompt.includes('1234567890abcdef'), 'Secrets must be redacted in prompt');

  // Record user feedback
  const feedbackRes = ExperienceStore.recordFeedback(execId, {
    rating: 'positive',
    comment: 'Truthful permission error'
  });
  assert.equal(feedbackRes.success, true);
  assert.equal(feedbackRes.record.feedback.rating, 'positive');
});

test('Continuous Learning: classifyFailure categorizes errors accurately', () => {
  assert.equal(
    ExperienceStore.classifyFailure('Missing Permissions: Bot cannot manage roles'),
    FailureCategory.PERMISSION_DENIED
  );
  assert.equal(
    ExperienceStore.classifyFailure('No tracks found matching query "unknown"'),
    FailureCategory.INVALID_MUSIC_QUERY
  );
  assert.equal(
    ExperienceStore.classifyFailure('Voice connection timed out after 10000ms'),
    FailureCategory.VOICE_TIMEOUT
  );
  assert.equal(
    ExperienceStore.classifyFailure('Server nuke request blocked unconditionally by anti-nuke invariant'),
    FailureCategory.SECURITY_BLOCKED
  );
  assert.equal(
    ExperienceStore.classifyFailure('Role with name "VIP" does not exist in guild cache'),
    FailureCategory.TARGET_NOT_FOUND
  );
});

test('Continuous Learning: exportEvaluationDataset outputs anonymized ChatML JSONL', () => {
  const guildId = 'test_guild_export_1';

  ExperienceStore.recordExecution({
    executionId: `exec_export_${Date.now()}`,
    guildId,
    userId: '1564281970308030654',
    userPrompt: 'Assign role <@&1564281970308030654> to user <@1209543193562058753>',
    normalizedIntent: 'assign_role',
    plan: { actions: [{ action: 'assign_role', targetRole: '<@&1564281970308030654>', targetMember: '<@1209543193562058753>' }] },
    capabilities: ['assign_role'],
    outcome: 'succeeded'
  });

  const dataset = ExperienceStore.exportEvaluationDataset({ guildId });
  assert.ok(Array.isArray(dataset));
  assert.ok(dataset.length >= 1);

  const entry = dataset[dataset.length - 1];
  assert.equal(entry.messages.length, 3);
  assert.equal(entry.messages[0].role, 'system');
  assert.equal(entry.messages[1].role, 'user');
  assert.equal(entry.messages[2].role, 'assistant');

  // Verify snowflakes are anonymized
  assert.ok(!entry.messages[1].content.includes('1564281970308030654'), 'Snowflake IDs must be anonymized');
  assert.ok(entry.messages[1].content.includes('@Role') || entry.messages[1].content.includes('@User'), 'Mentions should be standardized');
});

test('Interactive Dashboard: Learning page and Music controls are properly registered', async () => {
  assert.ok(DASHBOARD_PAGES.some(p => p.id === 'learning'), 'Learning page must be registered in DASHBOARD_PAGES');
  assert.ok(DASHBOARD_PAGES.some(p => p.id === 'music'), 'Music page must be registered in DASHBOARD_PAGES');

  const mockGuild = {
    id: 'guild_dash_test',
    name: 'Test Server',
    ownerId: 'owner_1',
    members: {
      cache: new Map([['owner_1', { id: 'owner_1', user: { id: 'owner_1', tag: 'Owner#0001' } }]]),
      me: { voice: { channelId: 'vc_123' } }
    }
  };

  const payload = await DashboardManager.buildDashboardPayload(
    mockGuild,
    { id: 'owner_1', permissions: { has: () => true }, roles: { cache: new Map() } },
    { id: 'owner_1', tag: 'Owner#0001' },
    'learning'
  );

  assert.ok(payload.embeds?.length > 0);
  assert.ok(payload.embeds[0].data.title.includes('Continuous Learning & Reliability'));
  assert.ok(payload.components?.length > 0);
});
