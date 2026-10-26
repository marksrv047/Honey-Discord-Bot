/**
 * Module 15: Context Resolution and Conversational References
 * 
 * Rules and pronoun binders for resolving anaphoric references
 * ("it", "that role", "the channel", "him", "her", "again", "instead")
 * using recent guild interaction history.
 */

export const CONTEXT_RESOLUTION_RULES = {
  pronounMappings: {
    'it': ['lastReferencedChannel', 'lastReferencedRole', 'lastReferencedMember', 'activeTrack'],
    'that role': ['lastCreatedRole', 'lastReferencedRole'],
    'the role': ['lastCreatedRole', 'lastReferencedRole'],
    'that channel': ['lastCreatedChannel', 'lastReferencedChannel'],
    'the channel': ['lastCreatedChannel', 'lastReferencedChannel'],
    'him': ['lastReferencedMember'],
    'her': ['lastReferencedMember'],
    'them': ['lastReferencedMember'],
    'that user': ['lastReferencedMember']
  },

  phrases: [
    {
      pattern: /^(?:do\s+that\s+again|repeat\s+(?:that|last\s+action))$/i,
      type: 'REPEAT_LAST_ACTION'
    },
    {
      pattern: /^(?:change|make)\s+it\s+(?:to\s+)?([#\w]+)(?:\s+instead)?$/i,
      type: 'MODIFY_LAST_ENTITY_PROPERTY'
    },
    {
      pattern: /^(?:make\s+it\s+private|lock\s+it)$/i,
      type: 'LOCK_LAST_CHANNEL'
    },
    {
      pattern: /^give\s+(?:that|the)\s+role\s+to\s+(@?\w+)(?:\s+too)?$/i,
      type: 'ASSIGN_LAST_ROLE_TO_NEW_MEMBER'
    },
    {
      pattern: /^(?:skip|pause|resume|stop)\s+it$/i,
      type: 'MUSIC_PLAYER_CONTROL'
    },
    {
      pattern: /^do\s+the\s+same\s+thing\s+in\s+this\s+channel$/i,
      type: 'APPLY_PREVIOUS_ACTION_TO_CURRENT_CHANNEL'
    }
  ],

  guildIsolation: {
    rule: 'ALL context resolution MUST be scoped strictly to the current guild ID. Never share references between servers.',
    maxContextAgeMinutes: 15
  }
};
