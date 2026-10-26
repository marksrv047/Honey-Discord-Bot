/**
 * Module 14: Error Recovery and Undo
 * 
 * Defines the reversibility matrix, inverse operations, state snapshot requirements,
 * and recovery workflows for administrative actions.
 */

export const REVERSIBILITY_MATRIX = {
  create_role: {
    isReversible: true,
    inverseAction: 'delete_role',
    inverseArgMapping: (args, result) => ({ targetRole: result?.roleId || args.name })
  },
  delete_role: {
    isReversible: false,
    reason: 'Role color and name can be recreated, but original snowflake ID and member assignments cannot be restored.'
  },
  assign_role: {
    isReversible: true,
    inverseAction: 'remove_role',
    inverseArgMapping: (args) => ({ targetMember: args.targetMember, targetRole: args.targetRole })
  },
  remove_role: {
    isReversible: true,
    inverseAction: 'assign_role',
    inverseArgMapping: (args) => ({ targetMember: args.targetMember, targetRole: args.targetRole })
  },
  create_channel: {
    isReversible: true,
    inverseAction: 'delete_channel',
    inverseArgMapping: (args, result) => ({ targetChannel: result?.channelId || args.name })
  },
  delete_channel: {
    isReversible: false,
    reason: 'Discord permanently deletes channel history and messages upon channel deletion.'
  },
  rename_channel: {
    isReversible: true,
    inverseAction: 'rename_channel',
    inverseArgMapping: (args, result, beforeState) => ({ targetChannel: args.targetChannel, newName: beforeState?.previousName })
  },
  lock_channel: {
    isReversible: true,
    inverseAction: 'unlock_channel',
    inverseArgMapping: (args) => ({ targetChannel: args.targetChannel })
  },
  unlock_channel: {
    isReversible: true,
    inverseAction: 'lock_channel',
    inverseArgMapping: (args) => ({ targetChannel: args.targetChannel })
  },
  timeout_member: {
    isReversible: true,
    inverseAction: 'remove_timeout',
    inverseArgMapping: (args) => ({ targetMember: args.targetMember })
  },
  ban_member: {
    isReversible: true,
    inverseAction: 'unban_member',
    inverseArgMapping: (args) => ({ targetUser: args.targetMember })
  },
  purge_messages: {
    isReversible: false,
    reason: 'Discord purge deletes messages permanently from API servers.'
  }
};
