// Starts and stops the full local stack for the end-to-end tests: a throwaway PostgreSQL (the
// database package's ephemeral-postgres helper, in its own child process), migrations, the built
// game server and a `vite preview` of a production web build made into a temporary directory
// (so the developer's apps/web/dist is never touched). Every process is spawned directly with
// `node` (no pnpm/shell wrappers), so killing the child really stops it on Windows too.
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, rmSync, type WriteStream } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const HOST = '127.0.0.1';
export const SERVER_PORT = 2567;
export const WEB_PORT = 4173;
export const WEB_ORIGIN = `http://${HOST}:${WEB_PORT}`;
const SERVER_ORIGIN = `http://${HOST}:${SERVER_PORT}`;
export const LOG_DIR = path.join(ROOT, 'playwright-report', 'e2e-stack');

const POSTGRES_READY_MS = 120_000;
const SERVICE_READY_MS = 60_000;
const STOP_MS = 20_000;

interface Managed {
  readonly name: string;
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  readonly log: WriteStream;
}

function log(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: 'info', scope: 'e2e-stack', msg, ...extra }));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves true if something already accepts TCP connections on the port. */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: HOST, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function start(
  name: string,
  args: readonly string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    stdin?: 'pipe' | 'ignore';
    /** false keeps stdout out of the log file (the Postgres helper prints its URL there). */
    logStdout?: boolean;
  },
): Managed {
  mkdirSync(LOG_DIR, { recursive: true });
  const logFile = createWriteStream(path.join(LOG_DIR, `${name}.log`), { flags: 'w' });
  const child = spawn(process.execPath, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: [options.stdin ?? 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (options.logStdout !== false) child.stdout?.pipe(logFile, { end: false });
  child.stderr?.pipe(logFile, { end: false });
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      resolve(code);
    });
    child.once('error', () => {
      resolve(null);
    });
  });
  running.add(child);
  void exited.then(() => running.delete(child));
  return { name, child, exited, log: logFile };
}

// Last resort if the runner exits without teardown (e.g. Ctrl+C): kill what is still running.
// The Postgres helper also stops on its own once its stdin pipe closes with this process.
const running = new Set<ChildProcess>();
process.once('exit', () => {
  for (const child of running) child.kill();
});

async function waitForHttp(url: string, managed: Managed, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const { child } = managed;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`${managed.name} exited during startup (see ${LOG_DIR})`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await delay(250);
  }
  throw new Error(`${managed.name} not ready at ${url} after ${timeoutMs} ms (see ${LOG_DIR})`);
}

/** Stops the process (gracefully if a way is given, else kill) and returns its exit code. */
async function stopProcess(managed: Managed, graceful?: () => void): Promise<number | null> {
  const { child } = managed;
  if (child.exitCode === null && child.signalCode === null) {
    if (graceful) graceful();
    else child.kill();
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      managed.exited,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          resolve('timeout');
        }, STOP_MS);
      }),
    ]);
    clearTimeout(timer);
    if (result === 'timeout') {
      child.kill('SIGKILL');
      await managed.exited;
      log('process force-killed', { name: managed.name });
    }
  }
  const code = await managed.exited;
  await new Promise<void>((resolve) => managed.log.end(resolve));
  return code;
}

async function startPostgres(): Promise<{ managed: Managed; url: string }> {
  const script = path.join(ROOT, 'packages', 'database', 'test', 'ephemeral-postgres.ts');
  // stdin stays open: closing it is the helper's signal to stop Postgres and delete its data.
  const managed = start('postgres', [script], { cwd: ROOT, stdin: 'pipe', logStdout: false });
  const { child } = managed;
  let stdout = '';
  let timer: NodeJS.Timeout | undefined;
  const url = await new Promise<string | undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, POSTGRES_READY_MS);
    void managed.exited.then(() => {
      resolve(undefined);
    });
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline !== -1) {
        const line = JSON.parse(stdout.slice(0, newline)) as { url: string };
        resolve(line.url);
      }
    });
  });
  clearTimeout(timer);
  if (url === undefined) {
    await stopProcess(managed, () => child.stdin?.end());
    throw new Error(`embedded postgres failed to start (see ${LOG_DIR})`);
  }
  return { managed, url };
}

/** Runs a short-lived node process to completion. */
async function run(
  name: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<void> {
  const managed = start(name, args, options);
  const code = await managed.exited;
  await new Promise<void>((resolve) => managed.log.end(resolve));
  if (code !== 0) throw new Error(`${name} failed (exit ${String(code)}, see ${LOG_DIR})`);
}

const WEB_DIR = path.join(ROOT, 'apps', 'web');
const VITE = path.join(WEB_DIR, 'node_modules', 'vite', 'bin', 'vite.js');

/** Starts everything; returns the teardown. On a startup failure, whatever started is stopped. */
export async function startStack(): Promise<() => Promise<void>> {
  for (const port of [SERVER_PORT, WEB_PORT]) {
    if (await portInUse(port)) {
      throw new Error(`port ${port} is already in use; stop the process using it first`);
    }
  }

  const outDir = await mkdtemp(path.join(tmpdir(), 'cartignon-e2e-web-'));
  const started: { managed: Managed; graceful?: () => void; mustExitCleanly?: boolean }[] = [];
  const teardown = async () => {
    // Reverse start order: web, server, then Postgres (which needs its stdin closed).
    const failures: string[] = [];
    for (const entry of started.reverse()) {
      const code = await stopProcess(entry.managed, entry.graceful);
      if (entry.mustExitCleanly === true && code !== 0) {
        failures.push(`${entry.managed.name} exited with ${String(code)}`);
      }
    }
    started.length = 0;
    rmSync(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (failures.length > 0) {
      throw new Error(`stack cleanup failed: ${failures.join(', ')} (see ${LOG_DIR})`);
    }
    log('stack stopped');
  };

  try {
    const t0 = Date.now();
    const pg = await startPostgres();
    started.push({
      managed: pg.managed,
      graceful: () => pg.managed.child.stdin?.end(),
      mustExitCleanly: true, // exit 0 means Postgres stopped and its directory was removed
    });
    log('postgres ready', { ms: Date.now() - t0 });

    await run('migrate', [path.join('dist', 'cli', 'migrate.js')], {
      cwd: path.join(ROOT, 'packages', 'database'),
      env: { ...process.env, DATABASE_URL: pg.url },
    });
    log('migrations applied');

    const server = start('server', [path.join('dist', 'main.js')], {
      cwd: path.join(ROOT, 'apps', 'server'),
      env: {
        ...process.env,
        DATABASE_URL: pg.url,
        PORT: String(SERVER_PORT),
        HOST,
        ALLOWED_ORIGINS: WEB_ORIGIN,
        COOKIE_SECURE: 'false',
        LOG_LEVEL: 'info',
        // The e2e specs drive the synthetic counter; the server defaults to Cartignon (R6).
        MATCH_RULES: 'synthetic',
      },
    });
    started.push({ managed: server });
    await waitForHttp(`${SERVER_ORIGIN}/readyz`, server, SERVICE_READY_MS);
    log('server ready', { port: SERVER_PORT });

    const viteEnv = {
      ...process.env,
      VITE_API_PROXY_TARGET: SERVER_ORIGIN,
      // Baked into the bundle: the browser opens its Colyseus WebSocket to the game server.
      VITE_GAME_SERVER_URL: SERVER_ORIGIN,
    };
    await run('web-build', [VITE, 'build', '--outDir', outDir, '--emptyOutDir'], {
      cwd: WEB_DIR,
      env: viteEnv,
    });
    log('web built', { ms: Date.now() - t0 });

    const web = start(
      'web',
      [VITE, 'preview', '--outDir', outDir, '--port', String(WEB_PORT), '--strictPort'],
      { cwd: WEB_DIR, env: viteEnv },
    );
    started.push({ managed: web });
    await waitForHttp(`${WEB_ORIGIN}/readyz`, web, SERVICE_READY_MS);
    log('web ready', { origin: WEB_ORIGIN, ms: Date.now() - t0 });
  } catch (error) {
    await teardown().catch((cleanupError: unknown) => {
      console.error(cleanupError);
    });
    throw error;
  }
  return teardown;
}
