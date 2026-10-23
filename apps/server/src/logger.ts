import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import type { LogLevel } from './config.js';

export type { Logger };

/**
 * Structured JSON logs (stdout unless a destination is given). Redaction is a safety net:
 * call sites must not log cookies, tokens, tickets, passwords, connection strings or message
 * payloads in the first place.
 */
export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  const options: LoggerOptions = {
    level,
    base: { service: 'cartignon-server' },
    redact: {
      paths: [
        'cookie',
        'cookies',
        'token',
        'ticket',
        'password',
        'databaseUrl',
        'DATABASE_URL',
        'authorization',
        'headers.cookie',
        'headers.authorization',
        'headers["set-cookie"]',
        '*.cookie',
        '*.token',
        '*.ticket',
        '*.password',
        '*.databaseUrl',
        '*.headers.cookie',
        '*.headers.authorization',
        '*.headers["set-cookie"]',
      ],
      censor: '[redacted]',
    },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}

/**
 * Adapter for Colyseus' logger slot. Colyseus logs plain strings; its `info` output is
 * framework chatter (including a misleading "instance onAuth ignored" notice), so it is
 * demoted to debug.
 */
export function colyseusLogger(
  logger: Logger,
): Record<'debug' | 'info' | 'warn' | 'error' | 'trace', (...args: unknown[]) => void> {
  const child = logger.child({ component: 'colyseus' });
  const text = (args: unknown[]) =>
    args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ');
  return {
    trace: (...args) => {
      child.trace(text(args));
    },
    debug: (...args) => {
      child.debug(text(args));
    },
    info: (...args) => {
      child.debug(text(args));
    },
    warn: (...args) => {
      child.warn(text(args));
    },
    error: (...args) => {
      child.error(text(args));
    },
  };
}
