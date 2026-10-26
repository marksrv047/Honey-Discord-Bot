/**
 * Module 10: Dashboard and Configuration
 * 
 * Defines interactive Discord control dashboard access, guild policy controls,
 * honeypot/anti-spam toggles, and operator role management.
 */

export const DASHBOARD_AND_CONFIG_CAPABILITIES = {
  open_dashboard: {
    action: 'open_dashboard',
    category: 'DASHBOARD',
    description: 'Launches the interactive Discord UI dashboard with live navigation buttons and select menus.',
    phrasings: [
      'open the dashboard',
      'show server settings',
      'launch control panel',
      'bot dashboard',
      'interactive config center',
      'view server config'
    ],
    pages: [
      'Overview: Server summary, health, and quick actions',
      'Channels: Text, voice, and category management',
      'Roles: Role creation, coloring, and hierarchy audit',
      'Moderation: Active timeouts, warnings, and bans',
      'Modlog: Security audit stream and log destination',
      'Honeypot & Security: Spam filters, invite blocks, quarantine',
      'Music: Player controls, queue preview, volume, and looping',
      'Continuous Learning: Verified execution records and feedback dataset'
    ],
    riskLevel: 'LOW',
    isDestructive: false
  },
  configure_guild_policy: {
    action: 'configure_guild_policy',
    category: 'CONFIG',
    description: 'Updates server-specific automation policies such as honeypot channel or anti-spam rules.',
    phrasings: [
      'set honeypot channel to #trap',
      'enable strict anti-spam filtering',
      'add @Moderator to operator roles'
    ],
    riskLevel: 'LOW',
    isReversible: true
  },
  inspect_guild_policy: {
    action: 'inspect_guild_policy',
    category: 'CONFIG',
    description: 'Displays current configuration, security policies, and feature flags for the guild.',
    phrasings: [
      'show current server policies',
      'inspect bot configuration',
      'what are our anti-spam settings'
    ],
    riskLevel: 'LOW',
    isDestructive: false
  }
};
