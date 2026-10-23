// Child process started by global-setup.ts (run with Node's built-in type stripping, so only
// erasable TypeScript here). It owns one throwaway PostgreSQL: prints a single JSON line
// `{"url": ...}` on stdout when ready, and stops the server and deletes its directory when stdin
// closes (normal teardown, or the parent dying). It runs in its own process because
// embedded-postgres registers async-exit-hook, whose `beforeExit` hook calls process.exit(0) and
// would mask Vitest's failing exit code.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { arch, platform, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';

const run = promisify(execFile);

const HOST = '127.0.0.1';
const USER = 'postgres';
const START_ATTEMPTS = 3;
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const BIND_FAILURE = /could not bind|address already in use|could not create any TCP\/IP sockets/i;

let output = '';
const remember = (message: unknown) => {
  output += message instanceof Error ? message.message : String(message);
};

/** Resolves with `fallback` if `promise` has not settled within `ms`. */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      resolve(fallback);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/** Asks the OS for a free loopback port (tiny race window; bind failures are retried). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, HOST, () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('no free port'));
        else resolve(address.port);
      });
    });
  });
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

const databaseDir = await mkdtemp(path.join(tmpdir(), 'cartignon-pg-'));
const pgCtl = await pgCtlPath();
// Last-resort cleanup for every exit path (Postgres has been stopped or killed by then).
process.on('exit', () => {
  try {
    rmSync(databaseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    process.stderr.write(`embedded postgres: could not remove ${databaseDir}\n`);
  }
});

/** PID of the postmaster, from the first line of postmaster.pid. */
function postmasterPid(): number | undefined {
  try {
    const first = readFileSync(path.join(databaseDir, 'postmaster.pid'), 'utf8').split('\n')[0];
    const pid = Number(first);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Windows only: force-kills postgres.exe processes still parented to `postmaster` (children can
 * outlive a hard-killed postmaster). On POSIX, children exit on postmaster death by themselves.
 */
async function killOrphans(postmaster: number): Promise<void> {
  if (platform() !== 'win32') return;
  const filter = `Name='postgres.exe' AND ParentProcessId=${postmaster}`;
  const script =
    `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object ` +
    '{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }';
  try {
    const args = ['-NoProfile', '-NonInteractive', '-Command', script];
    const { stdout } = await run('powershell.exe', args);
    const killed = stdout.split(/\s+/).filter((pid) => pid !== '');
    if (killed.length > 0) {
      process.stderr.write(`embedded postgres: killed orphaned processes ${killed.join(', ')}\n`);
    }
  } catch {
    process.stderr.write('embedded postgres: could not check for orphaned processes\n');
  }
}

/** Clean fast shutdown via pg_ctl (also ends background workers); hard kill as fallback. */
async function stopServer(instance: EmbeddedPostgres): Promise<void> {
  const postmaster = postmasterPid();
  const seconds = String(STOP_TIMEOUT_MS / 1000);
  try {
    await run(pgCtl, ['stop', '-D', databaseDir, '-m', 'fast', '-w', '-t', seconds]);
    // The library still holds the exited child; its exit hook would otherwise run
    // `taskkill /f /t` on that PID, which Windows may already have reused.
    (instance as unknown as { process?: unknown }).process = undefined;
  } catch {
    // Not stopped cleanly: the library's taskkill /f /t (Windows) or SIGINT (POSIX).
    await within(instance.stop(), STOP_TIMEOUT_MS, undefined);
  }
  if (postmaster !== undefined) await killOrphans(postmaster);
}

const password = randomBytes(24).toString('hex');
const create = (port: number) =>
  new EmbeddedPostgres({
    databaseDir,
    port,
    user: USER,
    password,
    authMethod: 'scram-sha-256',
    persistent: true, // the directory is removed by this script, with retries
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    // Loopback TCP only; an empty unix_socket_directories disables Unix-domain sockets.
    // io_method=sync: no asynchronous I/O worker processes that could outlive the server.
    postgresFlags: [
      '-c',
      `listen_addresses=${HOST}`,
      '-c',
      'unix_socket_directories=',
      '-c',
      'io_method=sync',
    ],
    onLog: remember,
    onError: remember,
  });

function fail(reason: string): never {
  process.stderr.write(`embedded postgres: ${reason}\n${output}\n`);
  process.exit(1);
}

let server: EmbeddedPostgres | undefined;
let port = 0;

// Registered before startup so a parent that dies early is noticed too. On process.exit the
// library's own exit hook kills any Postgres it started; the 'exit' handler removes the dir.
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  if (server !== undefined) await stopServer(server);
  process.exit(0);
};
process.stdin.on('end', () => void shutdown());
process.stdin.on('close', () => void shutdown());
process.stdin.resume();
try {
  for (let attempt = 1; server === undefined; attempt++) {
    port = await freePort();
    const candidate = create(port);
    if (attempt === 1) await candidate.initialise();
    const logStart = output.length;
    const started = await within(
      candidate.start().then(
        () => 'ready' as const,
        () => 'exited' as const,
      ),
      START_TIMEOUT_MS,
      'timeout' as const,
    );
    if (started === 'ready') {
      server = candidate;
    } else if (started === 'timeout') {
      await stopServer(candidate);
      fail(`not ready after ${START_TIMEOUT_MS} ms`);
    } else if (!BIND_FAILURE.test(output.slice(logStart)) || attempt >= START_ATTEMPTS) {
      // The child already exited, so stop() would wait forever for an 'exit' that has fired.
      const crashed = postmasterPid();
      if (crashed !== undefined) await killOrphans(crashed);
      fail(`exited during startup (attempt ${attempt})`);
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : 'startup failed');
}

const url = new URL(`postgres://${HOST}`);
url.port = String(port);
url.username = USER;
url.password = password;
url.pathname = '/postgres';
process.stdout.write(`${JSON.stringify({ url: url.toString(), port })}\n`);
