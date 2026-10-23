// Local play in one command (`pnpm dev`): dev Postgres + migrations + apps/server + apps/web.
//
//   1. If nothing listens on 127.0.0.1:POSTGRES_PORT, build packages and start the embedded dev
//      Postgres (packages/database dist/cli/dev-server.js start) as a child process and wait for
//      its "postgres ready" line. A server that is already reachable (e.g. `pnpm db:start` in
//      another terminal) is reused and never stopped by this script, except a Postgres orphaned
//      by an earlier dev.js (scripts/dev-db-owner.js), which is stopped cleanly first.
//      The Postgres child is detached from the console (on Windows through
//      scripts/dev-db-relay.js, which gives it a windowless console; own session on POSIX):
//      closing the window therefore cannot kill it mid-write. It stops when
//      dev.js closes its stdin (`--stop-on-stdin-close`), which also happens when dev.js itself
//      is killed, e.g. by Windows ~5 s after the console window was closed.
//   2. Apply migrations (dist/cli/migrate.js).
//   3. Run `pnpm dev:app` (server + web, stdin ignored so Vite does not hang).
//   4. On Ctrl+C, Ctrl+Break, terminal close (SIGHUP), or when any child exits: stop the apps
//      and, in parallel, the Postgres this script started (close its stdin -> pg_ctl stop -m
//      fast), falling back to `dev-server.js stop` and then force-killing after timeouts.
//
// `pnpm dev:lan` (`--lan`) runs the same lifecycle for LAN play-testing (ADR-0013): Vite binds to
// 0.0.0.0, the client reaches Colyseus through the Vite proxy (VITE_GAME_SERVER_URL=/colyseus),
// ALLOWED_ORIGINS gains http://<lan-ip>:5173, Vite adds X-Forwarded-For and the server trusts it
// from loopback (per-device rate limits), and a banner prints the URLs to open. LAN_HOST
// overrides the detected address. The game server itself stays on its configured HOST/PORT.
//
// Stdlib only; this file never imports embedded-postgres (it only spawns the existing CLIs).
// Run with `node --env-file-if-exists=.env scripts/dev.js` from the repo root.
import { execFile, spawn } from 'node:child_process';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearOwner, findOrphan, pidAlive, postmasterPid, writeOwner } from './dev-db-owner.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DB_PKG = path.join(ROOT, 'packages', 'database');
const DEV_SERVER = path.join(DB_PKG, 'dist', 'cli', 'dev-server.js');
const MIGRATE = path.join(DB_PKG, 'dist', 'cli', 'migrate.js');
const DB_RELAY = path.join(ROOT, 'scripts', 'dev-db-relay.js'); // Windows only, see startDb
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const ENV_FILE = path.join(ROOT, '.env');
const IS_WINDOWS = process.platform === 'win32';

const DB_HOST = '127.0.0.1';
const DB_READY_TIMEOUT_MS = 180_000; // first run initialises the data directory
const DB_CLEAN_STOP_MS = 15_000; // pg_ctl stop -m fast normally takes well under a second
const DB_STOP_TIMEOUT_MS = 6_000; // fallback `dev-server.js stop`
const ORPHAN_STOP_MS = 20_000;
const APP_GRACE_MS = 1_500;

const LAN = process.argv.includes('--lan');
const WEB_PORT = 5173; // apps/web/vite.config.ts (strictPort)
const DEFAULT_ALLOWED_ORIGINS = 'http://127.0.0.1:5173,http://localhost:5173'; // apps/server
const APP_READY_TIMEOUT_MS = 120_000;
// Adapters that are rarely the Wi-Fi/Ethernet the other device is on.
const VIRTUAL_ADAPTER =
  /vethernet|virtualbox|vmware|hyper-v|wsl|docker|loopback|tailscale|zerotier|vpn|\btap\b|\btun\b/i;

/** @param {'info' | 'error'} level @param {string} msg @param {Record<string, unknown>} [extra] */
function log(level, msg, extra = {}) {
  const line = JSON.stringify({ level, msg, source: 'dev', ...extra });
  try {
    if (level === 'error') console.error(line);
    else console.log(line);
  } catch {
    // console already gone (terminal closed): keep shutting down
  }
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Node with the root .env (if any), like the package scripts use. @param {string[]} args */
function nodeArgs(args) {
  return [`--env-file-if-exists=${ENV_FILE}`, ...args];
}

/** Runs a node script to completion with inherited output; resolves to its exit code. */
function runNode(/** @type {string[]} */ args, /** @type {string} */ cwd = ROOT) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', (error) => {
      log('error', 'could not start process', { args, error: errorMessage(error) });
      resolve(1);
    });
    child.on('exit', (code) => {
      resolve(code ?? 1);
    });
  });
}

/** True when something accepts TCP connections on 127.0.0.1:port. */
function portOpen(/** @type {number} */ port) {
  return new Promise((resolve) => {
    const socket = connect({ host: DB_HOST, port });
    const done = (/** @type {boolean} */ open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1_000, () => {
      done(false);
    });
    socket.once('connect', () => {
      done(true);
    });
    socket.once('error', () => {
      done(false);
    });
  });
}

/** @param {import('node:child_process').ChildProcess} child */
function isRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

/** Resolves once the child has exited, or after `ms` (resolving to whether it exited). */
function waitForExit(/** @type {import('node:child_process').ChildProcess} */ child, ms) {
  if (!isRunning(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Force-kills a process and all its descendants. @param {number} pid */
function killTree(pid) {
  return new Promise((resolve) => {
    if (IS_WINDOWS) {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {
        resolve(undefined);
      });
      return;
    }
    try {
      process.kill(-pid, 'SIGKILL'); // POSIX children run in their own process group
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    resolve(undefined);
  });
}

/** 10/8, 172.16/12, 192.168/16. @param {string} ip */
function isPrivateIpv4(ip) {
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * @typedef {{ ip: string, adapter: string, virtual: boolean }} LanAddress
 */

/**
 * IPv4 addresses other devices may reach, best first: LAN_HOST if set, otherwise non-internal,
 * non-link-local addresses; real (physical-looking) adapters before virtual ones (Hyper-V/WSL
 * vEthernet, VirtualBox, VMware, Docker, VPN), private ranges before public ones.
 * @returns {LanAddress[]}
 */
function lanAddresses() {
  const override = process.env['LAN_HOST']?.trim();
  if (override) return [{ ip: override, adapter: 'LAN_HOST', virtual: false }];
  /** @type {(LanAddress & { score: number })[]} */
  const found = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || entry.address.startsWith('169.254.')) {
        continue;
      }
      const virtual = VIRTUAL_ADAPTER.test(name);
      const score = (virtual ? 2 : 0) + (isPrivateIpv4(entry.address) ? 0 : 1);
      found.push({ ip: entry.address, adapter: name, virtual, score });
    }
  }
  return found
    .sort((x, y) => x.score - y.score)
    .map(({ ip, adapter, virtual }) => ({ ip, adapter, virtual }));
}

/**
 * Banner lines for the addresses: real adapters only; virtual ones (which other devices on the
 * Wi-Fi cannot reach) appear, labelled, only when no real adapter has an address.
 * @param {LanAddress[]} addresses
 */
function lanUrlLines(addresses) {
  const real = addresses.filter((address) => !address.virtual);
  if (addresses.length === 0) {
    return ['No LAN IPv4 address found; set LAN_HOST=<this PC address> in .env.'];
  }
  if (real.length === 0) {
    return [
      'Only virtual network adapters have an address; other devices probably cannot reach them.',
      'Connect this PC to the Wi-Fi/network, or set LAN_HOST=<this PC address> in .env.',
      ...addresses.map(
        (address) => `  http://${address.ip}:${WEB_PORT}  (virtual adapter: ${address.adapter})`,
      ),
    ];
  }
  return [
    `Open on BOTH devices (same Wi-Fi/network):  http://${real[0]?.ip ?? ''}:${WEB_PORT}`,
    ...real
      .slice(1)
      .map(
        (address) => `If that one fails, try:                     http://${address.ip}:${WEB_PORT}`,
      ),
  ];
}

/**
 * Child environment for `--lan`: overrides win over .env because Node's --env-file never
 * replaces variables that are already set.
 * @param {string[]} ips
 */
function lanEnv(ips) {
  const base = process.env['ALLOWED_ORIGINS']?.trim() || DEFAULT_ALLOWED_ORIGINS;
  const origins = new Set(base.split(',').map((origin) => origin.trim()));
  for (const ip of ips) origins.add(`http://${ip}:${WEB_PORT}`);
  return {
    ...process.env,
    CARTIGNON_LAN: '1',
    WEB_HOST: '0.0.0.0',
    VITE_GAME_SERVER_URL: '/colyseus',
    ALLOWED_ORIGINS: [...origins].filter((origin) => origin !== '').join(','),
    TRUSTED_PROXY: 'loopback',
  };
}

/** Waits until web and game server accept connections, then prints the URLs to open. */
async function printLanBanner(/** @type {LanAddress[]} */ addresses) {
  const serverPort = Number(process.env['PORT'] || 2567);
  const deadline = Date.now() + APP_READY_TIMEOUT_MS;
  while (Date.now() < deadline && stopping === undefined) {
    if ((await portOpen(WEB_PORT)) && (await portOpen(serverPort))) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (stopping !== undefined) return;
  const lines = [
    'The Tally LAN playtest is running.',
    '',
    ...lanUrlLines(addresses),
    `On this PC you can also use:                http://localhost:${WEB_PORT}`,
    '',
    'Second player on the same device: use a private/incognito window.',
    'Allow Node.js on Private networks if Windows Firewall asks. Stop with Ctrl+C.',
  ];
  const width = Math.max(...lines.map((line) => line.length)) + 4;
  const bar = '='.repeat(width);
  try {
    console.log(
      ['', bar, ...lines.map((line) => (line === '' ? '' : `  ${line}`)), bar, ''].join('\n'),
    );
  } catch {
    // console gone
  }
}

// ---------------------------------------------------------------------------------------------

/** @type {import('node:child_process').ChildProcess | undefined} */
let db; // only set when this script started Postgres
/** @type {import('node:child_process').ChildProcess | undefined} */
let app;
/** @type {Promise<never> | undefined} */
let stopping;

async function stopApp() {
  if (app === undefined || !isRunning(app) || app.pid === undefined) return;
  // On a console Ctrl+C the apps received it too; give them a moment, then kill the tree
  // (pnpm -> tsx/vite would otherwise survive on Windows).
  if (await waitForExit(app, APP_GRACE_MS)) return;
  await killTree(app.pid);
  await waitForExit(app, 2_000);
}

/** `dev-server.js stop` (pg_ctl stop -m fast on .data/postgres); resolves to success. */
function runDbStop() {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      nodeArgs([DEV_SERVER, 'stop']),
      { cwd: DB_PKG, timeout: DB_STOP_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null) {
          log('error', 'clean postgres stop failed', {
            error: errorMessage(error),
            output: stderr.trim(),
          });
        } else log('info', 'clean postgres stop finished', { output: stdout.trim() });
        resolve(error === null);
      },
    );
  });
}

async function stopDb() {
  if (db === undefined) return;
  const child = db;
  // Clean path: closing stdin makes dev-server.js run pg_ctl stop -m fast and exit. It runs in
  // the detached child, so it completes even if Windows kills this process meanwhile.
  child.stdin?.end();
  if (await waitForExit(child, DB_CLEAN_STOP_MS)) {
    if (postmasterPid() === undefined) clearOwner();
    return;
  }
  log('error', 'postgres did not stop in time; trying pg_ctl stop directly');
  await runDbStop();
  const pid = postmasterPid();
  if (pid !== undefined && pidAlive(pid)) {
    log('error', 'postgres still running after stop; killing it', { pid });
    await killTree(pid);
  }
  if (!(await waitForExit(child, 2_000)) && child.pid !== undefined) await killTree(child.pid);
  clearOwner();
}

/**
 * Stops a dev Postgres left running by an earlier dev.js that no longer exists (see
 * scripts/dev-db-owner.js). Returns false if it is still running afterwards.
 * @param {number} port @param {number} pid
 */
async function stopOrphan(port, pid) {
  log('info', 'found the dev postgres of an earlier run still running; stopping it cleanly', {
    port,
    pid,
  });
  await runDbStop();
  const deadline = Date.now() + ORPHAN_STOP_MS;
  while (Date.now() < deadline) {
    if (!pidAlive(pid) && !(await portOpen(port))) {
      clearOwner();
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/**
 * Stops everything this script started, once, then exits.
 * @param {string} reason
 * @param {number} exitCode
 * @returns {Promise<never>}
 */
function shutdown(reason, exitCode) {
  stopping ??= (async () => {
    log('info', 'shutting down', { reason });
    // In parallel: a closed Windows console leaves only ~5 s before this process is killed.
    await Promise.all([stopApp(), stopDb()]);
    log('info', db === undefined ? 'stopped (reused postgres left running)' : 'stopped');
    process.exit(exitCode);
  })();
  return stopping;
}

// A closed console turns writes into errors; they must not crash the shutdown.
process.stdout.on('error', () => undefined);
process.stderr.on('error', () => undefined);

for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'])) {
  process.on(signal, () => {
    if (stopping !== undefined) log('info', 'already shutting down', { signal });
    void shutdown(signal, 130);
  });
}

/** Starts the dev Postgres child and resolves when it reports ready; exits on failure. */
async function startDb() {
  log('info', 'building workspace packages (tsc -b)');
  if ((await runNode([TSC, '-b', 'apps/server', 'packages/database'])) !== 0) {
    log('error', 'build failed; not starting postgres');
    process.exit(1);
  }

  log('info', 'starting dev postgres');
  // Detached: POSIX gives the child its own session (a terminal hang-up does not reach it);
  // Windows keeps it out of this console (no CTRL_CLOSE_EVENT on window close) and out of the
  // kill-on-close job object Node puts non-detached children in (a killed dev.js would otherwise
  // hard-kill Postgres). On Windows the detached child is scripts/dev-db-relay.js, which runs
  // dev-server.js in a windowless console; without it postgres.exe would open a visible one.
  // Output is relayed through pipes; stdin is the stop channel (closed = stop cleanly).
  const startArgs = [DEV_SERVER, 'start', '--stop-on-stdin-close'];
  const entry = IS_WINDOWS ? [DB_RELAY, ...startArgs.slice(1)] : startArgs;
  const child = spawn(process.execPath, nodeArgs(entry), {
    cwd: DB_PKG,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    windowsHide: true,
  });
  db = child;
  child.stdin?.on('error', () => undefined); // child gone: nothing to signal
  child.stderr?.on('data', (/** @type {Buffer} */ chunk) => {
    process.stderr.write(chunk);
  });

  const ready = await new Promise((resolve) => {
    let buffer = '';
    let settled = false;
    const settle = (/** @type {boolean} */ value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      log('error', 'postgres did not become ready in time', { timeoutMs: DB_READY_TIMEOUT_MS });
      settle(false);
    }, DB_READY_TIMEOUT_MS);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (/** @type {string} */ chunk) => {
      process.stdout.write(chunk);
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      if (lines.some((line) => line.includes('"msg":"postgres ready"'))) settle(true);
    });
    child.on('error', (error) => {
      log('error', 'could not start the dev postgres process', { error: errorMessage(error) });
      settle(false);
    });
    child.once('exit', (code) => {
      if (settled) return;
      log('error', 'dev postgres exited before it was ready (see its log lines above)', { code });
      settle(false);
    });
  });
  if (!ready) await shutdown('postgres failed to start', 1);

  const pid = postmasterPid();
  if (pid !== undefined) writeOwner(pid);

  child.on('exit', (code) => {
    if (stopping === undefined) void shutdown('postgres exited unexpectedly', code || 1);
  });
}

async function main() {
  const portText = process.env['POSTGRES_PORT'] ?? '55432';
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    log('error', 'POSTGRES_PORT is not a valid port', { value: portText });
    process.exit(1);
  }

  const orphan = (await portOpen(port)) ? findOrphan() : undefined;
  if (orphan !== undefined && !(await stopOrphan(port, orphan))) {
    log('error', 'could not stop the leftover dev postgres; run `pnpm db:stop` and try again', {
      port,
      pid: orphan,
    });
    process.exit(1);
  }

  if (await portOpen(port)) {
    log('info', 'postgres already running; reusing it (will not stop it on exit)', { port });
    if ((await runNode([TSC, '-b', 'apps/server', 'packages/database'])) !== 0) {
      log('error', 'build failed');
      process.exit(1);
    }
  } else {
    await startDb();
  }
  if (stopping !== undefined) return;

  log('info', 'applying migrations');
  if ((await runNode(nodeArgs([MIGRATE]), DB_PKG)) !== 0) {
    log('error', 'migrations failed; check DATABASE_URL in .env');
    await shutdown('migrations failed', 1);
  }
  if (stopping !== undefined) return;

  const addresses = LAN ? lanAddresses() : [];
  // Every detected address stays an allowed origin; the banner only hides the virtual ones.
  const env = LAN ? lanEnv(addresses.map((address) => address.ip)) : process.env;
  if (LAN) {
    log('info', 'LAN mode', { lanAddresses: addresses, allowedOrigins: env['ALLOWED_ORIGINS'] });
  }

  log('info', 'starting server and web (pnpm dev:app)');
  // pnpm is a .cmd/.exe shim on Windows; a shell resolves it. The command line is constant.
  app = spawn('pnpm run dev:app', {
    cwd: ROOT,
    env,
    shell: true,
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: !IS_WINDOWS,
  });
  app.on('error', (error) => {
    log('error', 'could not start pnpm dev:app', { error: errorMessage(error) });
    void shutdown('app failed to start', 1);
  });
  app.on('exit', (code) => {
    if (stopping === undefined) void shutdown('server/web exited', code || 1);
  });
  if (LAN) await printLanBanner(addresses);
}

main().catch(async (/** @type {unknown} */ error) => {
  log('error', 'dev orchestrator failed', { error: errorMessage(error) });
  await shutdown('orchestrator error', 1);
});
