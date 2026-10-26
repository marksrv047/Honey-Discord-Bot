/**
 * Module 11: Diagnostics and Troubleshooting
 * 
 * Defines health verification, latency probes, permission audits,
 * and deterministic self-repair operations.
 */

export const DIAGNOSTICS_CAPABILITIES = {
  audit_server: {
    action: 'audit_server',
    category: 'DIAGNOSTICS',
    description: 'Runs comprehensive server security and configuration audit.',
    phrasings: [
      'audit the server',
      'check server security settings',
      'audit roles and permissions',
      'find security weaknesses'
    ],
    riskLevel: 'LOW',
    isDestructive: false
  },
  diagnose_system: {
    action: 'diagnose',
    category: 'DIAGNOSTICS',
    description: 'Inspects internal bot health across all subsystems without performing mutations.',
    phrasings: [
      'diagnose',
      'run diagnostics',
      'check bot health',
      'is the bot running normally',
      'test groq connection and latency'
    ],
    componentsChecked: [
      'Discord Gateway ping & WebSocket status',
      'Groq Free Inference API connectivity and response latency',
      'FFmpeg binary availability for voice transcoding',
      'Voice connection states across active guilds',
      'TaskQueue concurrency and lock health',
      'Disk persistence and data file integrity'
    ],
    riskLevel: 'LOW',
    isDestructive: false
  }
};
