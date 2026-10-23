import { z } from 'zod';
import type { TrustedProxy } from './security/client-ip.js';

const DEFAULT_ALLOWED_ORIGINS = 'http://127.0.0.1:5173,http://localhost:5173';

/** Rules modules a new match can be started with (`MATCH_RULES`). */
export const MATCH_RULES_IDS = ['cartignon', 'synthetic'] as const;
export type MatchRulesId = (typeof MATCH_RULES_IDS)[number];

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** An origin is scheme://host[:port] with nothing else (exactly what browsers send). */
function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const originList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ''),
  )
  .refine((origins) => origins.length > 0, 'must list at least one origin')
  .refine(
    (origins) => origins.every(isOrigin),
    'every entry must be an origin like http://host:port',
  );

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.coerce.number().int().min(0).max(65_535).default(2567),
  HOST: z.string().min(1).default('127.0.0.1'),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((value) => /^postgres(ql)?:\/\//.test(value), 'must be a postgres:// URL'),
  ALLOWED_ORIGINS: originList.optional(),
  COOKIE_SECURE: booleanString.optional(),
  TRUSTED_PROXY: z.enum(['none', 'loopback']).default('none'),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  ROOM_IDLE_TIMEOUT_MINUTES: z.coerce.number().positive().max(1440).default(10),
  ROOM_FINISHED_TTL_SECONDS: z.coerce.number().positive().max(86_400).default(60),
  ROOM_MAX_LIFETIME_MINUTES: z.coerce.number().positive().max(10_080).default(720),
  SEAT_CLAIM_TIMEOUT_SECONDS: z.coerce.number().positive().max(3600).default(60),
  TURN_TIMEOUT_SECONDS: z.coerce.number().positive().max(86_400).default(900),
  CHOICE_TIMEOUT_SECONDS: z.coerce.number().positive().max(86_400).default(60),
  PAUSE_BUDGET_SECONDS: z.coerce.number().positive().max(86_400).default(180),
  MAX_LIVE_ROOMS: z.coerce.number().int().min(1).max(1_000_000).default(1000),
  MATCH_RULES: z.enum(MATCH_RULES_IDS).default('cartignon'),
});

export interface Config {
  readonly production: boolean;
  readonly port: number;
  readonly host: string;
  readonly databaseUrl: string;
  readonly allowedOrigins: readonly string[];
  readonly cookieSecure: boolean;
  readonly trustedProxy: TrustedProxy;
  readonly sessionTtlDays: number;
  readonly logLevel: LogLevel;
  /** Dispose a room after this long with nobody connected. */
  readonly roomIdleTimeoutMs: number;
  /** Dispose a room this long after its match finished. */
  readonly roomFinishedTtlMs: number;
  /** Hard cap on a room's lifetime, whatever its state. */
  readonly roomMaxLifetimeMs: number;
  /** A lobby seat whose holder is not connected for this long is released. */
  readonly seatClaimTimeoutMs: number;
  /** R7 turn clock per turn (RD-25). */
  readonly turnTimeoutMs: number;
  /** R7 choice clock for a non-turn seat answering a choice (RD-164). */
  readonly choiceTimeoutMs: number;
  /** R7 pause budget per seat per match while disconnected (RD-41). */
  readonly pauseBudgetMs: number;
  readonly maxLiveRooms: number;
  /** Rules module for new matches; resumed matches use the module named by their snapshot. */
  readonly matchRules: MatchRulesId;
}

export class ConfigError extends Error {}

/**
 * Reads and validates the environment. Throws `ConfigError` naming the invalid variables; the
 * message never contains values (DATABASE_URL carries a password).
 *
 * With NODE_ENV=production the server fails closed: ALLOWED_ORIGINS must be set explicitly
 * and contain only https origins, COOKIE_SECURE must be true, and MATCH_RULES must not be
 * `synthetic` (a test-only rules module).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings like unset so `.env` placeholders such as `PORT=` use the default.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );
  const parsed = envSchema.safeParse(cleaned);
  const problems = parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join('.') || '(env)'}: ${issue.message}`);

  if (parsed.success) {
    const e = parsed.data;
    if (e.NODE_ENV === 'production') {
      if (e.ALLOWED_ORIGINS === undefined) {
        problems.push('ALLOWED_ORIGINS: must be set explicitly in production');
      } else if (!e.ALLOWED_ORIGINS.every((origin) => origin.startsWith('https://'))) {
        problems.push('ALLOWED_ORIGINS: only https origins are allowed in production');
      }
      if (e.COOKIE_SECURE !== true) {
        problems.push('COOKIE_SECURE: must be true in production');
      }
      if (e.MATCH_RULES === 'synthetic') {
        problems.push('MATCH_RULES: synthetic rules are not allowed in production');
      }
    }
  }
  if (!parsed.success || problems.length > 0) {
    throw new ConfigError(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }

  const e = parsed.data;
  const production = e.NODE_ENV === 'production';
  return {
    production,
    port: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    allowedOrigins: e.ALLOWED_ORIGINS ?? originList.parse(DEFAULT_ALLOWED_ORIGINS),
    cookieSecure: e.COOKIE_SECURE ?? false,
    trustedProxy: e.TRUSTED_PROXY,
    sessionTtlDays: e.SESSION_TTL_DAYS,
    logLevel: e.LOG_LEVEL,
    roomIdleTimeoutMs: Math.round(e.ROOM_IDLE_TIMEOUT_MINUTES * 60_000),
    roomFinishedTtlMs: Math.round(e.ROOM_FINISHED_TTL_SECONDS * 1000),
    roomMaxLifetimeMs: Math.round(e.ROOM_MAX_LIFETIME_MINUTES * 60_000),
    seatClaimTimeoutMs: Math.round(e.SEAT_CLAIM_TIMEOUT_SECONDS * 1000),
    turnTimeoutMs: Math.max(1, Math.round(e.TURN_TIMEOUT_SECONDS * 1000)),
    choiceTimeoutMs: Math.max(1, Math.round(e.CHOICE_TIMEOUT_SECONDS * 1000)),
    pauseBudgetMs: Math.max(1, Math.round(e.PAUSE_BUDGET_SECONDS * 1000)),
    maxLiveRooms: e.MAX_LIVE_ROOMS,
    matchRules: e.MATCH_RULES,
  };
}
