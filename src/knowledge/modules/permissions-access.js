/**
 * Module 6: Permissions and Access Control
 * 
 * Defines permission bitfields, role permission overwrites, channel privacy models,
 * and access control enforcement rules.
 */

export const DISCORD_PERMISSION_FLAGS = {
  Administrator: { bit: 8n, description: 'Bypasses all channel-specific permissions' },
  ManageGuild: { bit: 32n, description: 'Change guild settings, integrations, and server details' },
  ManageRoles: { bit: 268435456n, description: 'Create, edit, and assign roles lower than highest bot role' },
  ManageChannels: { bit: 16n, description: 'Create, edit, delete, and reorder channels' },
  KickMembers: { bit: 2n, description: 'Expel lower-ranking members' },
  BanMembers: { bit: 4n, description: 'Permanently ban lower-ranking members' },
  ManageMessages: { bit: 8192n, description: 'Delete messages from others and pin messages' },
  ModerateMembers: { bit: 1099511627776n, description: 'Issue communication timeouts up to 28 days' },
  ViewChannel: { bit: 1024n, description: 'Allow members to view channel' },
  SendMessages: { bit: 2048n, description: 'Allow members to send messages in text channels' },
  Connect: { bit: 1048576n, description: 'Join voice channels' },
  Speak: { bit: 2097152n, description: 'Speak in voice channels' }
};

export const PRIVACY_AND_ACCESS_PATTERNS = {
  make_private: {
    intent: 'lock_channel',
    description: 'Restrict channel visibility or write permissions so regular members cannot view or participate.',
    phrasings: [
      'can you make this room private',
      'set up a channel where only moderators can post',
      'let everyone view this channel but only staff post in it',
      'hide this channel from regular members',
      'make #announcements read-only for members'
    ],
    overwritesRequired: {
      denyForEveryone: ['SendMessages'],
      allowForStaff: ['ViewChannel', 'SendMessages']
    }
  },
  make_public: {
    intent: 'unlock_channel',
    description: 'Restore default visibility and participation permissions for regular members.',
    phrasings: [
      'make this room public again',
      'allow everyone to chat here',
      'open this channel to all members'
    ]
  }
};
