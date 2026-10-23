import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { createDb, createPool, runMigrations, type Database } from './client.js';

export interface TestDatabase {
  readonly url: string;
  readonly pool: pg.Pool;
  readonly db: Database;
  /** Closes the pool and drops the database. */
  drop(): Promise<void>;
}

/** Server URL used to create throwaway databases (the role needs CREATEDB). */
export function testServerUrl(): string {
  const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error('Set TEST_DATABASE_URL (or DATABASE_URL) to run database tests');
  }
  return url;
}

/**
 * Creates an isolated, freshly migrated database (`cartignon_test_<random>`) on the server
 * from `serverUrl`, so tests never touch development data or each other.
 */
export async function createTestDatabase(serverUrl = testServerUrl()): Promise<TestDatabase> {
  const name = `cartignon_test_${randomBytes(6).toString('hex')}`;
  const admin = createPool(serverUrl, { max: 1 });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  const db = createDb(pool);
  const drop = async () => {
    await pool.end();
    const cleanup = createPool(serverUrl, { max: 1 });
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  };

  try {
    await runMigrations(db);
  } catch (error) {
    await drop().catch(() => undefined); // keep the migration error, not the cleanup one
    throw error;
  }

  return { url: url.toString(), pool, db, drop };
}
