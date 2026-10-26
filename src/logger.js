import crypto from 'node:crypto';

/**
 * Redacts sensitive tokens/keys from strings and objects.
 */
export function redactSecrets(data) {
  if (typeof data === 'string') {
    return data
      .replace(/(?:Bot|Bearer)\s+[A-Za-z0-9._-]{8,}/gi, '[REDACTED_DISCORD_TOKEN]')
      .replace(/AIzaSy[A-Za-z0-9_-]{20,60}/g, '[REDACTED_GEMINI_KEY]')
      .replace(/gsk_[A-Za-z0-9_-]{20,}/g, '[REDACTED_GROQ_KEY]')
      .replace(/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}/g, '[REDACTED_TOKEN]');
  }

  if (Array.isArray(data)) {
    return data.map(redactSecrets);
  }

  if (data && typeof data === 'object') {
    const copy = {};
    for (const [key, value] of Object.entries(data)) {
      if (/token|secret|key|password|auth/i.test(key) && typeof value === 'string') {
        copy[key] = '[REDACTED]';
      } else {
        copy[key] = redactSecrets(value);
      }
    }
    return copy;
  }

  return data;
}

/**
 * Structured Logger with execution IDs and timestamping.
 */
export class Logger {
  constructor(context = 'AdminAgent') {
    this.context = context;
  }

  static generateExecutionId() {
    return 'exec_' + Math.random().toString(36).substring(2, 9);
  }

  static redactSecrets(data) {
    return redactSecrets(data);
  }

  format(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const cleanMeta = redactSecrets(meta);
    const metaStr = Object.keys(cleanMeta).length > 0 ? ` | ${JSON.stringify(cleanMeta)}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] [${this.context}] ${message}${metaStr}`;
  }

  info(message, meta) {
    console.log(this.format('info', message, meta));
  }

  warn(message, meta) {
    console.warn(this.format('warn', message, meta));
  }

  error(message, meta) {
    console.error(this.format('error', message, meta));
  }

  debug(message, meta) {
    if (process.env.DEBUG === 'true') {
      console.debug(this.format('debug', message, meta));
    }
  }
}

export const defaultLogger = new Logger('System');
