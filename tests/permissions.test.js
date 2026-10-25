import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import {
  checkUserAuthorization,
  checkRoleHierarchy,
  auditServerPermissions
} from '../src/permissions.js';

test('Permissions: checkUserAuthorization allows Guild Owner unconditionally', () => {
  const mockMember = {
    id: 'owner_123',
    guild: { ownerId: 'owner_123' },
    permissions: { has: () => false }
  };

  const auth = checkUserAuthorization(mockMember, [{ action: 'ban_member', targetMember: 'bad_user' }]);
  assert.equal(auth.authorized, true);
});

test('Permissions: checkUserAuthorization blocks user missing required permission', () => {
  const mockMember = {
    id: 'member_456',
    guild: { ownerId: 'owner_123' },
    permissions: { has: (perm) => perm !== PermissionFlagsBits.BanMembers && perm !== PermissionFlagsBits.Administrator }
  };

  const auth = checkUserAuthorization(mockMember, [{ action: 'ban_member', targetMember: 'bad_user' }]);
  assert.equal(auth.authorized, false);
  assert.match(auth.reason, /missing the following Discord permissions/);
});

test('Permissions: checkUserAuthorization blocks administrator whose role is below the bot', () => {
  const mockMember = {
    id: 'admin_user',
    guild: {
      ownerId: 'owner_123',
      members: {
        me: { id: 'bot_id', roles: { highest: { name: 'Honey Bot', position: 20 } } }
      }
    },
    permissions: { has: (perm) => perm === PermissionFlagsBits.Administrator },
    roles: { highest: { name: 'Junior Admin', position: 10 } }
  };

  const auth = checkUserAuthorization(mockMember, []);
  assert.equal(auth.authorized, false);
  assert.match(auth.reason, /Role Hierarchy Restriction/);
});

test('Permissions: checkUserAuthorization allows administrator whose role is above the bot', () => {
  const mockMember = {
    id: 'admin_user',
    guild: {
      ownerId: 'owner_123',
      members: {
        me: { id: 'bot_id', roles: { highest: { name: 'Honey Bot', position: 20 } } }
      }
    },
    permissions: { has: (perm) => perm === PermissionFlagsBits.Administrator },
    roles: { highest: { name: 'Senior Admin', position: 30 } }
  };

  const auth = checkUserAuthorization(mockMember, []);
  assert.equal(auth.authorized, true);
});

test('Permissions: checkRoleHierarchy blocks mutating a role higher than the bot', () => {
  const mockGuild = {
    members: {
      me: {
        id: 'bot_id',
        roles: { highest: { name: 'Bot Role', position: 10 } }
      }
    },
    roles: {
      cache: new Map()
    }
  };

  const targetRole = { id: 'admin_role_id', name: 'Admin', position: 15, managed: false };
  const actionObj = { action: 'delete_role', targetRole: 'Admin' };

  const check = checkRoleHierarchy(mockGuild, actionObj, targetRole);
  assert.equal(check.valid, false);
  assert.match(check.reason, /Hierarchy Error/);
});

test('Permissions: checkRoleHierarchy prevents kicking or banning the server owner', () => {
  const mockGuild = {
    ownerId: 'owner_999',
    members: {
      me: {
        id: 'bot_id',
        roles: { highest: { name: 'Bot Role', position: 50 } }
      }
    }
  };

  const targetMember = {
    id: 'owner_999',
    user: { tag: 'Owner#0001' },
    roles: { highest: { name: 'Owner Role', position: 1 } }
  };

  const actionObj = { action: 'ban_member', targetMember: 'owner_999' };
  const check = checkRoleHierarchy(mockGuild, actionObj, targetMember);
  assert.equal(check.valid, false);
  assert.match(check.reason, /Target is the Server Owner/);
});

test('Permissions: checkRoleHierarchy prevents bot from moderating itself', () => {
  const mockGuild = {
    ownerId: 'owner_999',
    members: {
      me: {
        id: 'bot_id',
        roles: { highest: { name: 'Bot Role', position: 50 } }
      }
    }
  };

  const targetMember = {
    id: 'bot_id',
    user: { tag: 'AdminAgent#0000' },
    roles: { highest: { name: 'Bot Role', position: 50 } }
  };

  const actionObj = { action: 'kick_member', targetMember: 'bot_id' };
  const check = checkRoleHierarchy(mockGuild, actionObj, targetMember);
  assert.equal(check.valid, false);
  assert.match(check.reason, /Target is the bot itself/);
});

test('Permissions: auditServerPermissions flags @everyone with Administrator or BanMembers', () => {
  const mockGuild = {
    roles: {
      everyone: {
        permissions: {
          has: (flag) => flag === PermissionFlagsBits.Administrator || flag === PermissionFlagsBits.BanMembers
        }
      }
    },
    channels: {
      cache: new Map()
    }
  };

  const issues = auditServerPermissions(mockGuild);
  assert.equal(issues.length, 2);
  assert.match(issues[0], /Administrator/);
  assert.match(issues[1], /Ban Members/);
});
