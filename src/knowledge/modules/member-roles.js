/**
 * Module 4: Member and Role Management
 * 
 * Defines capabilities, constraints, phrasing, and hierarchy rules for Discord roles and members.
 */

export const ROLE_AND_MEMBER_CAPABILITIES = {
  create_role: {
    action: 'create_role',
    category: 'ROLES',
    description: 'Creates a new role with optional custom color, hoist, and mentionable settings.',
    phrasings: [
      'create a blue VIP role',
      'make a role called VIP and set it to blue',
      'create role Moderators with color #3498DB',
      'add a new role called Events, make it purple'
    ],
    requiredArgs: ['name'],
    optionalArgs: ['color', 'hoist', 'mentionable'],
    constraints: {
      maxRolesPerGuild: 250,
      nameMaxLength: 100,
      validHexRegex: /^#?[0-9a-fA-F]{6}$/
    },
    riskLevel: 'LOW',
    isReversible: true,
    undoAction: 'delete_role'
  },
  edit_role: {
    action: 'edit_role',
    category: 'ROLES',
    description: 'Modifies an existing role attributes such as color, name, or hoist display.',
    phrasings: [
      'change VIP role color to gold',
      'rename role Member to Regular',
      'make Moderators role hoisted'
    ],
    requiredArgs: ['targetRole'],
    optionalArgs: ['name', 'color', 'hoist', 'mentionable'],
    constraints: {
      hierarchyCheckRequired: true
    },
    riskLevel: 'LOW',
    isReversible: true
  },
  delete_role: {
    action: 'delete_role',
    category: 'ROLES',
    description: 'Permanently deletes a role from the server.',
    phrasings: [
      'delete role OldStaff',
      'remove the VIP role from server',
      'delete roles A, B and C'
    ],
    requiredArgs: ['targetRole'],
    constraints: {
      hierarchyCheckRequired: true,
      cannotDeleteManagedRoles: true // Bot integration roles, nitro booster role, @everyone
    },
    riskLevel: 'HIGH',
    requiresConfirmation: true,
    isReversible: false
  },
  assign_role: {
    action: 'assign_role',
    category: 'ROLES',
    description: 'Assigns a role to a specified guild member.',
    phrasings: [
      'give Alex the VIP role',
      'assign role @Moderator to @user',
      'give that role to Alex too',
      'promote Alex to VIP'
    ],
    requiredArgs: ['targetMember', 'targetRole'],
    constraints: {
      hierarchyCheckRequired: true,
      targetMustBeInGuild: true
    },
    riskLevel: 'LOW',
    isReversible: true,
    undoAction: 'remove_role'
  },
  remove_role: {
    action: 'remove_role',
    category: 'ROLES',
    description: 'Removes a role from a specified guild member.',
    phrasings: [
      'take the moderator role away from Alex',
      'remove VIP from @Alex',
      'demote Alex from Moderator',
      'strip Alex of VIP'
    ],
    requiredArgs: ['targetMember', 'targetRole'],
    constraints: {
      hierarchyCheckRequired: true
    },
    riskLevel: 'LOW',
    isReversible: true,
    undoAction: 'assign_role'
  },
  change_nickname: {
    action: 'change_nickname',
    category: 'ROLES',
    description: 'Changes the server nickname of a specified guild member.',
    phrasings: [
      'I want Alex to show up as Night Owl',
      'change Alex nickname to Shadow',
      'set nickname of @user to Ace'
    ],
    requiredArgs: ['targetMember', 'nickname'],
    constraints: {
      hierarchyCheckRequired: true,
      nicknameMaxLength: 32,
      cannotChangeOwnerNickname: true
    },
    riskLevel: 'LOW',
    isReversible: true,
    undoAction: 'remove_nickname'
  },
  remove_nickname: {
    action: 'remove_nickname',
    category: 'ROLES',
    description: 'Resets a member server nickname back to their global username.',
    phrasings: [
      'reset Alex nickname',
      'clear nickname for @user'
    ],
    requiredArgs: ['targetMember'],
    riskLevel: 'LOW',
    isReversible: true
  }
};
