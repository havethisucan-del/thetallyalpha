import { sql } from 'drizzle-orm';
import {
  char,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** Account kinds. Upgrading a guest later adds a value here; the identity id never changes. */
export const identityKind = pgEnum('identity_kind', ['guest']);

export const identities = pgTable('identities', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: identityKind('kind').notNull().default('guest'),
  displayName: varchar('display_name', { length: 32 }).notNull(),
  createdAt: createdAt(),
});

/** Opaque session credentials. Only the SHA-256 (hex) of the token is stored. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    identityId: uuid('identity_id')
      .notNull()
      .references(() => identities.id, { onDelete: 'cascade' }),
    tokenHash: char('token_hash', { length: 64 }).notNull().unique(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('sessions_identity_idx').on(t.identityId)],
);

export const matchKind = pgEnum('match_kind', ['private', 'casual']);
export const matchStatus = pgEnum('match_status', ['active', 'finished', 'aborted']);

/**
 * One row per started match (created exactly once, when both seats are Ready). The terminal
 * transition (`active` → `finished`/`aborted`) is a guarded UPDATE, so it can happen only once.
 */
export const matches = pgTable(
  'matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: matchKind('kind').notNull(),
    status: matchStatus('status').notNull().default('active'),
    rulesId: text('rules_id').notNull(),
    rulesVersion: text('rules_version').notNull(),
    outcome: jsonb('outcome'),
    createdAt: createdAt(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    index('matches_status_idx').on(t.status),
    check('matches_ended_consistent', sql`(${t.status} = 'active') = (${t.endedAt} IS NULL)`),
    check('matches_outcome_only_finished', sql`${t.outcome} IS NULL OR ${t.status} = 'finished'`),
  ],
);

export const matchParticipants = pgTable(
  'match_participants',
  {
    matchId: uuid('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    seat: smallint('seat').notNull(),
    identityId: uuid('identity_id')
      .notNull()
      .references(() => identities.id),
    /** Reconnection pause budget fixed at match start, so config changes never alter it. */
    pauseBudgetMs: integer('pause_budget_ms').notNull(),
    /** Cumulative pause consumed. Only ever increases. */
    pauseUsedMs: integer('pause_used_ms').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.matchId, t.seat] }),
    unique('match_participants_identity_uq').on(t.matchId, t.identityId),
    index('match_participants_identity_idx').on(t.identityId),
    check('match_participants_seat', sql`${t.seat} IN (0, 1)`),
    check('match_participants_pause', sql`${t.pauseUsedMs} >= 0 AND ${t.pauseBudgetMs} >= 0`),
  ],
);

/** Latest authoritative snapshot per match (no event sourcing). */
export const matchSnapshots = pgTable(
  'match_snapshots',
  {
    matchId: uuid('match_id')
      .primaryKey()
      .references(() => matches.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    /** game-core `Rng.getState()`: 128-bit xoshiro128** state as 32 lowercase hex chars. */
    rngState: text('rng_state').notNull(),
    state: jsonb('state').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('match_snapshots_revision', sql`${t.revision} >= 0`),
    check(
      'match_snapshots_rng',
      sql`${t.rngState} ~ '^[0-9a-f]{32}$' AND ${t.rngState} <> '00000000000000000000000000000000'`,
    ),
  ],
);

/**
 * Accepted actions. UNIQUE (match_id, action_id) makes client retries idempotent;
 * PK (match_id, revision) makes concurrent writers for the same revision impossible.
 */
export const matchActions = pgTable(
  'match_actions',
  {
    matchId: uuid('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    actionId: uuid('action_id').notNull(),
    seat: smallint('seat').notNull(),
    action: jsonb('action').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.matchId, t.revision] }),
    unique('match_actions_action_id_uq').on(t.matchId, t.actionId),
    check('match_actions_revision', sql`${t.revision} >= 1`),
    check('match_actions_seat', sql`${t.seat} IN (0, 1)`),
  ],
);
