/**
 * Module 12: Multi-Step Task Planning
 * 
 * Defines dependency resolution, DAG planning, execution sequences,
 * and prerequisite failure cascades for complex multi-operation requests.
 */

export const MULTI_STEP_PLANNING_RULES = {
  dependencyTypes: {
    ENTITY_CREATION_BEFORE_ASSIGNMENT: {
      description: 'An entity must be created and its ID resolved before it can be assigned or configured.',
      example: 'create_role -> assign_role',
      prerequisiteMap: {
        assign_role: ['create_role'],
        move_channel_to_category: ['create_channel', 'create_category'],
        send_announcement: ['create_channel']
      }
    },
    VOICE_CONNECTION_BEFORE_PLAYBACK: {
      description: 'Voice channel connection must be established before audio player can stream audio.',
      example: 'voice_join -> music_play',
      prerequisiteMap: {
        music_play: ['voice_join']
      }
    },
    CHANNEL_CREATION_BEFORE_PERMISSION_OVERWRITE: {
      description: 'Channel must exist before custom role overwrites or lock can be applied.',
      example: 'create_channel -> lock_channel'
    }
  },

  failureBehavior: {
    CASCADING_SKIP: 'If an upstream step fails or is skipped, all downstream steps that depend on its produced entity MUST be skipped immediately.',
    PARTIAL_COMPLETION_REPORT: 'The final status report must truthfully indicate which steps succeeded and which were skipped due to prerequisite failure.'
  },

  canonicalPlans: [
    {
      request: 'Create a role called Events, make it purple, and assign it to Alex',
      steps: [
        { action: 'create_role', args: { name: 'Events', color: '#9B59B6' }, produces: 'role' },
        { action: 'assign_role', args: { targetMember: 'Alex', targetRole: '$Events' }, dependsOn: ['create_role'] }
      ]
    },
    {
      request: 'Create a private staff channel and give moderators access',
      steps: [
        { action: 'create_channel', args: { name: 'staff-channel', type: 'GUILD_TEXT' }, produces: 'channel' },
        { action: 'lock_channel', args: { targetChannel: '$staff-channel' }, dependsOn: ['create_channel'] }
      ]
    },
    {
      request: 'Join my voice channel, find this song, and play it',
      steps: [
        { action: 'voice_join', args: { channel: 'current' }, produces: 'voice_connection' },
        { action: 'music_play', args: { query: 'this song' }, dependsOn: ['voice_join'] }
      ]
    },
    {
      request: 'Pause the music, clear the queue, and leave the voice channel',
      steps: [
        { action: 'music_pause', args: {} },
        { action: 'music_stop', args: {} },
        { action: 'music_leave', args: {} }
      ]
    }
  ]
};
