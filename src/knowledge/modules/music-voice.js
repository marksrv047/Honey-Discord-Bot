/**
 * Module 9: Music and Voice Operations
 * 
 * Defines voice connection handling, audio playback, queue controls,
 * query resolution vs direct URL handling, and truthful playback verification.
 */

export const MUSIC_CAPABILITIES = {
  voice_join: {
    action: 'voice_join',
    category: 'MUSIC',
    description: 'Connects the bot to a designated voice channel with self-deafen enabled.',
    phrasings: [
      'connect to voice channel General',
      'join voice Lounge',
      'join my voice channel',
      'come to voice chat'
    ],
    requiredArgs: ['channel'],
    constraints: {
      selfDeafMandatory: true
    },
    riskLevel: 'LOW',
    isReversible: true,
    undoAction: 'music_leave'
  },
  music_play: {
    action: 'music_play',
    category: 'MUSIC',
    description: 'Searches for a track or resolves a direct URL and queues it for audio playback.',
    phrasings: [
      'play Bohemian Rhapsody',
      'put on The Weeknd - Call Out My Name',
      'play this link https://youtube.com/watch?v=...',
      'find the original version of this song and play it',
      'blast lofi beats',
      'drop a beat in voice'
    ],
    requiredArgs: ['query'],
    optionalArgs: ['channel'],
    constraints: {
      mustValidateVoiceConnection: true,
      maxQueueSize: 100
    },
    riskLevel: 'LOW',
    verificationMethod: 'AUDIO_PLAYER_PLAYING_STATE',
    truthRule: 'NEVER fabricate track metadata or report success before the audio player is actively playing.'
  },
  music_pause: {
    action: 'music_pause',
    category: 'MUSIC',
    description: 'Pauses active audio playback.',
    phrasings: [
      'pause it',
      'pause the music',
      'hold the music'
    ],
    riskLevel: 'LOW',
    isReversible: true,
    undoAction: 'music_resume'
  },
  music_resume: {
    action: 'music_resume',
    category: 'MUSIC',
    description: 'Resumes previously paused audio playback.',
    phrasings: [
      'resume',
      'resume the music',
      'unpause',
      'continue playing'
    ],
    riskLevel: 'LOW',
    isReversible: true,
    undoAction: 'music_pause'
  },
  music_skip: {
    action: 'music_skip',
    category: 'MUSIC',
    description: 'Skips the currently playing track to the next item in the queue.',
    phrasings: [
      'skip this track',
      'skip it',
      'next song',
      'play the next one'
    ],
    riskLevel: 'LOW',
    isReversible: false
  },
  music_stop: {
    action: 'music_stop',
    category: 'MUSIC',
    description: 'Stops playback and clears the active music queue.',
    phrasings: [
      'stop the music',
      'stop playing',
      'shut off the music'
    ],
    riskLevel: 'LOW',
    isReversible: false
  },
  music_queue: {
    action: 'music_queue',
    category: 'MUSIC',
    description: 'Displays current track and upcoming items in the playback queue.',
    phrasings: [
      'what’s in the queue',
      'show the queue',
      'list upcoming songs',
      'queue'
    ],
    riskLevel: 'LOW',
    isDestructive: false
  },
  music_leave: {
    action: 'music_leave',
    category: 'MUSIC',
    description: 'Disconnects the bot from the active voice channel and destroys voice resources.',
    phrasings: [
      'leave voice',
      'disconnect from voice chat',
      'leave the call',
      'stop the music and leave'
    ],
    riskLevel: 'LOW',
    isReversible: true
  },
  music_volume: {
    action: 'music_volume',
    category: 'MUSIC',
    description: 'Adjusts playback volume percentage.',
    phrasings: [
      'set volume to 80',
      'turn the music down to 50%',
      'crank the volume to 100'
    ],
    requiredArgs: ['volume'],
    constraints: {
      minVolume: 0,
      maxVolume: 150
    },
    riskLevel: 'LOW'
  },
  music_loop: {
    action: 'music_loop',
    category: 'MUSIC',
    description: 'Cycles audio loop modes between off, single track, and entire queue.',
    phrasings: [
      'loop this song',
      'repeat the queue',
      'toggle loop'
    ],
    riskLevel: 'LOW'
  },
  music_shuffle: {
    action: 'music_shuffle',
    category: 'MUSIC',
    description: 'Randomizes the ordering of upcoming tracks in the music queue.',
    phrasings: [
      'shuffle the queue',
      'randomize the songs',
      'shuffle playlist'
    ],
    riskLevel: 'LOW'
  }
};
