import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { checkDatabase, runMigrations, schema } from '../src/index.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';

let t: TestDatabase;
let created: TestDatabase | undefined;

beforeAll(async () => {
  created = await createTestDatabase(inject('testDatabaseUrl'));
  t = created;
});

afterAll(async () => {
  await created?.drop();
});

/** Postgres error code of a rejected statement (drizzle wraps the driver error in `cause`). */
async function pgErrorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
  return undefined;
}

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

async function newIdentity(): Promise<string> {
  const [row] = await t.db
    .insert(schema.identities)
    .values({ displayName: 'Guest-TEST' })
    .returning({ id: schema.identities.id });
  if (!row) throw new Error('insert failed');
  return row.id;
}

async function newMatch(): Promise<string> {
  const [row] = await t.db
    .insert(schema.matches)
    .values({ kind: 'casual', rulesId: 'synthetic', rulesVersion: '1' })
    .returning({ id: schema.matches.id });
  if (!row) throw new Error('insert failed');
  return row.id;
}

describe('migrations', () => {
  it('apply to a fresh database and are idempotent on re-run', async () => {
    await runMigrations(t.db);
    const tables = await t.db.execute<{ table_name: string }>(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      'identities',
      'match_actions',
      'match_participants',
      'match_snapshots',
      'matches',
      'sessions',
    ]);
  });

  it('readiness probe reports a reachable database', async () => {
    expect(await checkDatabase(t.pool)).toBe(true);
  });
});

describe('constraints that back infrastructure guarantees', () => {
  it('session token hashes are unique', async () => {
    const identityId = await newIdentity();
    const session = {
      identityId,
      tokenHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 1e6),
    };
    await t.db.insert(schema.sessions).values(session);
    expect(await pgErrorCode(t.db.insert(schema.sessions).values(session))).toBe(UNIQUE_VIOLATION);
  });

  it('a seat is taken once and an identity sits once per match; seats are 0/1', async () => {
    const matchId = await newMatch();
    const [a, b] = [await newIdentity(), await newIdentity()];
    const seat = (s: number, identityId: string) =>
      t.db
        .insert(schema.matchParticipants)
        .values({ matchId, seat: s, identityId, pauseBudgetMs: 180_000 });
    await seat(0, a);
    expect(await pgErrorCode(seat(0, b))).toBe(UNIQUE_VIOLATION);
    expect(await pgErrorCode(seat(1, a))).toBe(UNIQUE_VIOLATION);
    expect(await pgErrorCode(seat(2, b))).toBe(CHECK_VIOLATION);
  });

  it('an action id is accepted once and a revision is written once', async () => {
    const matchId = await newMatch();
    const actionId = randomUUID();
    const action = { type: 'increment', v: 1, payload: { amount: 1 } };
    await t.db
      .insert(schema.matchActions)
      .values({ matchId, revision: 1, actionId, seat: 0, action });
    // Retry of the same action id at the next revision → idempotency key violation.
    expect(
      await pgErrorCode(
        t.db
          .insert(schema.matchActions)
          .values({ matchId, revision: 2, actionId, seat: 0, action }),
      ),
    ).toBe(UNIQUE_VIOLATION);
    // A different action racing for the same revision → primary key violation.
    expect(
      await pgErrorCode(
        t.db
          .insert(schema.matchActions)
          .values({ matchId, revision: 1, actionId: randomUUID(), seat: 1, action }),
      ),
    ).toBe(UNIQUE_VIOLATION);
  });

  it('match status, end time and outcome stay consistent', async () => {
    const matchId = await newMatch();
    const update = (values: Partial<typeof schema.matches.$inferInsert>) =>
      t.db
        .update(schema.matches)
        .set(values)
        .where(sql`${schema.matches.id} = ${matchId}`);
    expect(await pgErrorCode(update({ status: 'finished' }))).toBe(CHECK_VIOLATION);
    expect(await pgErrorCode(update({ outcome: { result: 'draw', reason: 'x' } }))).toBe(
      CHECK_VIOLATION,
    );
    await update({ status: 'aborted', endedAt: new Date() });
  });

  it('snapshot revision and RNG state are range-checked', async () => {
    const VALID_RNG = '0123456789abcdef0123456789abcdef';
    const matchId = await newMatch();
    expect(
      await pgErrorCode(
        t.db
          .insert(schema.matchSnapshots)
          .values({ matchId, revision: -1, rngState: VALID_RNG, state: {} }),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await pgErrorCode(
        t.db
          .insert(schema.matchSnapshots)
          .values({ matchId, revision: 0, rngState: '4294967295', state: {} }),
      ),
    ).toBe(CHECK_VIOLATION);
    for (const rngState of ['0'.repeat(32), 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33)]) {
      expect(
        await pgErrorCode(
          t.db.insert(schema.matchSnapshots).values({ matchId, revision: 0, rngState, state: {} }),
        ),
      ).toBe(CHECK_VIOLATION);
    }
    await t.db
      .insert(schema.matchSnapshots)
      .values({ matchId, revision: 0, rngState: VALID_RNG, state: {} });
  });
});
