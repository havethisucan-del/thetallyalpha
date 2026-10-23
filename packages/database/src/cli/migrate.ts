import { createDb, createPool, runMigrations } from '../client.js';

// One-off migration runner (dev: `pnpm db:migrate`; production: the `migrate` Compose service).
// Logs one JSON line per event and never prints the connection string.
const url = process.env['DATABASE_URL'];
if (url === undefined || url === '') {
  console.error(JSON.stringify({ level: 'error', msg: 'DATABASE_URL is not set' }));
  process.exit(1);
}

const pool = createPool(url, { max: 1, statementTimeoutMs: 120_000 });
try {
  const started = Date.now();
  await runMigrations(createDb(pool));
  console.log(
    JSON.stringify({ level: 'info', msg: 'migrations applied', ms: Date.now() - started }),
  );
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown error';
  console.error(JSON.stringify({ level: 'error', msg: 'migration failed', error: message }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
