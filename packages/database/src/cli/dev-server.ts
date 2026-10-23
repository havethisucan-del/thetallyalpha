import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

// Local development PostgreSQL (embedded binaries, no Docker). Development only:
// `embedded-postgres` is a devDependency and nothing in production imports this file.
//   start  foreground server; first run initialises <repo>/.data/postgres
//          --stop-on-stdin-close: also stop cleanly when stdin closes (used by scripts/dev.js)
//   stop   fast, clean shutdown of a server started by `start` (from another terminal)
// Logs one JSON line per event and never prints the password.

const HOST = '127.0.0.1';
// dist/cli/dev-server.js -> repo root is four levels up.
const DATA_DIR = fileURLToPath(new URL('../../../../.data/postgres', import.meta.url));

const INVALID_PASSWORD = '28P01';
const INVALID_AUTHORIZATION = '28000';
const PASSWORD_HINT =
  '.data/postgres keeps the password it was first initialised with; set that POSTGRES_PASSWORD in .env';
const HALF_INITIALISED_HINT =
  'stop postgres, delete .data/postgres (destroys local dev data) and run pnpm db:start again';

type Level = 'info' | 'error';
function log(level: Level, msg: string, extra: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, msg, ...extra });
  if (level === 'error') console.error(line);
  else console.log(line);
}

function fail(msg: string, extra: Record<string, unknown> = {}): never {
  log('error', msg, extra);
  process.exit(1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/** pg_ctl from the platform binaries package that embedded-postgres depends on. */
async function pgCtlPath(): Promise<string> {
  const os = platform() === 'win32' ? 'windows' : platform();
  const fromEmbedded = createRequire(import.meta.resolve('embedded-postgres'));
  const entry = fromEmbedded.resolve(`@embedded-postgres/${os}-${arch()}`);
  const binaries = (await import(pathToFileURL(entry).href)) as { pg_ctl?: unknown };
  if (typeof binaries.pg_ctl !== 'string') throw new Error('pg_ctl binary not found');
  return binaries.pg_ctl;
}

/** Fast shutdown (rolls back open transactions, checkpoints). Returns false if none ran. */
function stopServer(pgCtl: string): boolean {
  try {
    execFileSync(pgCtl, ['stop', '-D', DATA_DIR, '-m', 'fast', '-w', '-t', '60'], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** PID of the running postmaster, from the first line of postmaster.pid. */
function postmasterPid(): number | undefined {
  try {
    const first = readFileSync(path.join(DATA_DIR, 'postmaster.pid'), 'utf8').split('\n')[0];
    const pid = Number(first);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function settings() {
  const password = process.env['POSTGRES_PASSWORD'];
  if (password === undefined || password === '') {
    fail('POSTGRES_PASSWORD is not set: copy .env.example to .env and set a local password');
  }
  const portText = process.env['POSTGRES_PORT'] ?? '55432';
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    fail('POSTGRES_PORT is not a valid port', { value: portText });
  }
  return {
    user: process.env['POSTGRES_USER'] || 'cartignon',
    database: process.env['POSTGRES_DB'] || 'cartignon',
    password,
    port,
  };
}

async function start(stopOnStdinClose: boolean): Promise<void> {
  const { user, database, password, port } = settings();
  const pgCtl = await pgCtlPath();
  const server = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    port,
    user,
    password,
    authMethod: 'scram-sha-256',
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    // Loopback TCP only; an empty unix_socket_directories disables Unix-domain sockets.
    postgresFlags: ['-c', `listen_addresses=${HOST}`, '-c', 'unix_socket_directories='],
    onLog: (message) => {
      for (const line of message.split(/\r?\n/)) {
        if (line.trim() !== '') log('info', line.trim(), { source: 'postgres' });
      }
    },
    onError: (error) => {
      log('error', errorMessage(error), { source: 'postgres' });
    },
  });

  // embedded-postgres hard-kills the server on exit on Windows (taskkill /f). Run a clean
  // pg_ctl fast shutdown first: prepended so it runs before the library's own signal hook.
  let liveness: NodeJS.Timeout | undefined = undefined;
  const shutdown = (signal: string) => {
    clearInterval(liveness);
    log('info', 'stopping postgres', { signal });
    log('info', stopServer(pgCtl) ? 'postgres stopped' : 'postgres was not running');
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) {
    process.prependListener(signal, shutdown);
  }
  // scripts/dev.js runs this detached from its console (on Windows via scripts/dev-db-relay.js)
  // and relays the output through pipes.
  // Its parent may disappear (window closed, process killed): a broken pipe must not crash this
  // process, because the library's exit hook would then hard-kill the server.
  process.stdout.on('error', () => undefined);
  process.stderr.on('error', () => undefined);
  if (stopOnStdinClose) {
    // The parent closes stdin to request a stop; the OS closes it when the parent dies.
    let stopped = false;
    const stopFromParent = () => {
      if (stopped) return;
      stopped = true;
      shutdown('stdin closed');
      process.exit(0);
    };
    process.stdin.on('end', stopFromParent);
    process.stdin.on('close', stopFromParent);
    process.stdin.on('error', stopFromParent);
    process.stdin.resume();
  }

  if (!existsSync(path.join(DATA_DIR, 'PG_VERSION'))) {
    log('info', 'initialising data directory (first run)', { dataDir: DATA_DIR, user });
    await mkdir(path.dirname(DATA_DIR), { recursive: true });
    try {
      await server.initialise();
    } catch (error) {
      fail('initialising the data directory failed', {
        error: errorMessage(error),
        hint: HALF_INITIALISED_HINT,
      });
    }
  }

  try {
    await server.start();
  } catch (error) {
    fail('postgres failed to start (see postgres log lines above)', {
      error: error instanceof Error ? error.message : undefined,
      hint: `port ${port} may be in use; if .data/postgres is incomplete: ${HALF_INITIALISED_HINT}`,
    });
  }

  const client = server.getPgClient('postgres', HOST);
  try {
    await client.connect();
    const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (found.rowCount === 0) {
      await client.query(`CREATE DATABASE ${client.escapeIdentifier(database)}`);
      log('info', 'database created', { database });
    }
  } catch (error) {
    stopServer(pgCtl);
    const code = (error as { code?: unknown }).code;
    fail('database setup failed', {
      error: errorMessage(error),
      ...(code === INVALID_PASSWORD || code === INVALID_AUTHORIZATION
        ? { hint: PASSWORD_HINT }
        : {}),
    });
  } finally {
    await client.end().catch(() => undefined);
  }

  log('info', 'postgres ready', { host: HOST, port, user, database, dataDir: DATA_DIR });

  // Exit when the server goes away on its own (`pnpm db:stop`, crash), not only on signals.
  const pid = postmasterPid();
  if (pid === undefined) {
    stopServer(pgCtl);
    fail('postgres is running but postmaster.pid is unreadable', { dataDir: DATA_DIR });
  }
  liveness = setInterval(() => {
    if (isAlive(pid)) return;
    clearInterval(liveness);
    const clean = postmasterPid() === undefined;
    log(clean ? 'info' : 'error', clean ? 'postgres stopped' : 'postgres exited unexpectedly');
    process.exit(clean ? 0 : 1);
  }, 1_000);
}

async function stop(): Promise<void> {
  const pgCtl = await pgCtlPath();
  const pid = postmasterPid();
  if (pid === undefined) {
    log('info', 'postgres is not running', { dataDir: DATA_DIR });
    return;
  }
  if (!isAlive(pid)) {
    // Left behind by a crash or a killed process; Postgres removes it on the next start.
    log('info', 'postgres is not running (stale postmaster.pid)', { dataDir: DATA_DIR, pid });
    return;
  }
  if (!stopServer(pgCtl)) fail('pg_ctl stop failed', { dataDir: DATA_DIR, pid });
  log('info', 'postgres stopped', { dataDir: DATA_DIR });
}

const command = process.argv[2] ?? 'start';
try {
  if (command === 'start') await start(process.argv.includes('--stop-on-stdin-close'));
  else if (command === 'stop') await stop();
  else fail('unknown command (expected start or stop)', { command });
} catch (error) {
  fail('dev database failed', { error: errorMessage(error) });
}
