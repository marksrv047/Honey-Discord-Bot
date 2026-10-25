import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePlan,
  CreateRoleSchema,
  CreateChannelSchema,
  TimeoutMemberSchema,
  BanMemberSchema,
  SetupTicketSystemSchema
} from '../src/schemas.js';

test('Schemas: CreateRoleSchema validates valid and invalid hex colors', () => {
  const valid = CreateRoleSchema.safeParse({
    action: 'create_role',
    name: 'Moderator',
    color: '#3498DB',
    hoist: true,
    permissions: ['ManageChannels', 'KickMembers']
  });
  assert.equal(valid.success, true);

  const invalidColor = CreateRoleSchema.safeParse({
    action: 'create_role',
    name: 'Moderator',
    color: 'not-a-color'
  });
  assert.equal(invalidColor.success, false);
});

test('Schemas: CreateChannelSchema validates channel types and defaults', () => {
  const valid = CreateChannelSchema.safeParse({
    action: 'create_channel',
    name: 'general-chat',
    type: 'GUILD_TEXT',
    slowmodeSeconds: 5
  });
  assert.equal(valid.success, true);
  if (valid.success) {
    assert.equal(valid.data.isPrivate, false);
  }

  const invalidType = CreateChannelSchema.safeParse({
    action: 'create_channel',
    name: 'invalid',
    type: 'NON_EXISTENT_TYPE'
  });
  assert.equal(invalidType.success, false);
});

test('Schemas: TimeoutMemberSchema enforces duration bounds', () => {
  const valid = TimeoutMemberSchema.safeParse({
    action: 'timeout_member',
    targetMember: 'user123',
    durationMinutes: 60
  });
  assert.equal(valid.success, true);

  const zeroDuration = TimeoutMemberSchema.safeParse({
    action: 'timeout_member',
    targetMember: 'user123',
    durationMinutes: 0 // Min is 1
  });
  assert.equal(zeroDuration.success, false);
});

test('Schemas: validatePlan validates complete administrative plans', () => {
  const rawPlan = {
    thoughtProcess: 'Creating VIP category and role',
    isHighImpact: false,
    actions: [
      {
        action: 'create_role',
        name: 'VIP',
        color: '#F1C40F',
        hoist: true
      },
      {
        action: 'create_channel',
        name: 'vip-lounge',
        type: 'GUILD_TEXT',
        isPrivate: true,
        allowedRoles: ['VIP']
      }
    ]
  };

  const validation = validatePlan(rawPlan);
  assert.equal(validation.success, true);
});

test('Schemas: validatePlan rejects unknown actions or malformed objects', () => {
  const invalidPlan = {
    thoughtProcess: 'Malicious action test',
    actions: [
      {
        action: 'destroy_database', // Unknown action
        target: 'all'
      }
    ]
  };

  const validation = validatePlan(invalidPlan);
  assert.equal(validation.success, false);
});
