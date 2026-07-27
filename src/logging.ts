/**
 * Minimal leveled logger writing to stderr.
 *
 * stdout is the MCP transport on a stdio server — anything written there corrupts the
 * JSON-RPC stream — so every diagnostic must go to stderr. This module exists mainly to
 * make that constraint impossible to violate by accident.
 */
import { LOG_LEVELS, type LogLevel } from './config.js';

const SEVERITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/** Keys whose values are replaced with `***` wherever they appear in log context. */
const REDACTED_KEYS = new Set([
  'apikey',
  'api_key',
  'authorization',
  'password',
  'secret',
  'token',
  'connectionstring',
  'externalconnectionstring',
  'internalconnectionstring',
  'psqlcommand',
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
      key,
      REDACTED_KEYS.has(key.toLowerCase()) ? '***' : redact(inner, depth + 1),
    ]),
  );
}

export function createLogger(level: LogLevel, bindings: Record<string, unknown> = {}): Logger {
  const threshold = SEVERITY[level];

  const write = (entryLevel: Exclude<LogLevel, 'silent'>, message: string, context?: Record<string, unknown>): void => {
    if (SEVERITY[entryLevel] < threshold) return;
    const entry = {
      time: new Date().toISOString(),
      level: entryLevel,
      message,
      ...redact({ ...bindings, ...context }, 0)!,
    };
    try {
      process.stderr.write(`${JSON.stringify(entry)}\n`);
    } catch {
      // Logging must never take the server down.
    }
  };

  return {
    debug: (message, context) => write('debug', message, context),
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  };
}

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}
