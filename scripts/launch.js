// Double-click launcher (`Start The Tally.bat` on Windows, `Start The Tally.command` on macOS):
// local play on one machine for someone who has only installed Node.js (README.md,
// ADR-0014).
//
//   1. Checks the Node version against package.json "engines", warns about long Windows paths,
//      and refuses to start when the ports are already taken (another copy still running).
//   2. pnpm is never installed globally: every pnpm command runs through
//      `npx --yes pnpm@<packageManager version>`. npx puts the directory holding that pnpm on PATH
//      for its descendants, so scripts/dev.js (which spawns `pnpm run dev:app` by name) finds the
//      same pnpm.
//   3. First run (or a changed pnpm-lock.yaml): `pnpm install --frozen-lockfile`; success is
//      recorded in node_modules/.cartignon-launch.json (hash of the lockfile).
//   4. Creates .env from .env.example with a random local database password (never overwrites).
//   5. Runs `pnpm dev` (scripts/dev.js: Postgres + migrations + server + web, ADR-0012), waits
//      until web and game server answer, opens the default browser and prints what to do.
//      Closing the window or Ctrl+C stops everything; dev.js does the cleanup.
//
// Stdlib only. Run with `node scripts/launch.js` from anywhere (paths are relative to the repo).
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findOrphan } from './dev-db-owner.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const IS_WINDOWS = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const ENV_FILE = path.join(ROOT, '.env');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
const DATA_DIR = path.join(ROOT, '.data');
const LOCKFILE = path.join(ROOT, 'pnpm-lock.yaml');
const MARKER = path.join(ROOT, 'node_modules', '.cartignon-launch.json');
const PASSWORD_PLACEHOLDER = 'replace-with-local-password';
const WEB_PORT = 5173; // apps/web/vite.config.ts (strictPort)
const WEB_URL = `http://localhost:${WEB_PORT}`;
const READY_TIMEOUT_MS = 15 * 60_000; // first start builds the code and creates the database
// Longest path below the repo after `pnpm install` is ~200 characters; Windows' classic limit
// is 260, so a repo path much longer than this breaks the install or the build.
const MAX_WINDOWS_ROOT_LENGTH = 60;
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

/** @param {string} text */
function say(text) {
  try {
    console.log(text);
  } catch {
    // console already gone (window closed)
  }
}

/** Prints a framed message. @param {string[]} lines */
function box(lines) {
  const width = Math.max(...lines.map((line) => line.length)) + 4;
  const bar = '='.repeat(width);
  say(['', bar, ...lines.map((line) => (line === '' ? '' : `  ${line}`)), bar, ''].join('\n'));
}

/** Prints a framed problem description and exits non-zero. @param {string[]} lines @returns {never} */
function fail(lines) {
  box(['PROBLEM', '', ...lines]);
  process.exit(1);
}

/** @returns {{ engines?: { node?: string }, packageManager?: string }} */
function packageJson() {
  // A BOM (added by some Windows editors) is not valid JSON.
  return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
}

/** "24.11.0" -> [24, 11, 0]. @param {string} version */
function parseVersion(version) {
  return version
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
}

/** a >= b for [major, minor, patch]. @param {number[]} a @param {number[]} b */
function versionAtLeast(a, b) {
  for (let i = 0; i < 3; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

function checkNode() {
  const range = packageJson().engines?.node ?? '';
  const match = /^>=\s*(\d+\.\d+\.\d+)$/.exec(range.trim());
  if (match === null || match[1] === undefined) return; // unknown format: let pnpm judge
  const required = match[1];
  if (versionAtLeast(parseVersion(process.version), parseVersion(required))) return;
  fail([
    `This game needs Node.js ${required} or newer; this computer has ${process.version}.`,
    '',
    'Install the current "LTS" version from https://nodejs.org (default options),',
    'then close this window and start the game again.',
  ]);
}

/** "pnpm@12.14.0" from package.json "packageManager". */
function pnpmSpec() {
  const spec = packageJson().packageManager ?? '';
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(spec)) {
    fail([`package.json "packageManager" is not an exact pnpm version: "${spec}".`]);
  }
  return spec;
}

function checkPathLength() {
  if (!IS_WINDOWS || ROOT.length <= MAX_WINDOWS_ROOT_LENGTH) return;
  box([
    'WARNING: this folder path is long:',
    ROOT,
    '',
    'Windows cannot handle very long file paths, so the installation may fail here.',
    'If it does: move the game folder to a short path such as C:\\Games\\cartignon',
    '(the folder that contains "Start The Tally.bat") and start it from there.',
  ]);
}

/** The few KEY=value lines of .env the launcher needs (no quotes or expansion). */
function readEnvFile() {
  /** @type {Record<string, string>} */
  const values = {};
  if (!existsSync(ENV_FILE)) return values;
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) values[match[1]] = match[2];
  }
  return values;
}

function ensureEnvFile() {
  if (existsSync(ENV_FILE)) return;
  if (existsSync(DATA_DIR)) {
    fail([
      'The settings file ".env" is missing, but the game database folder ".data" exists.',
      'The database password was stored in .env when the database was first created,',
      'so a new .env would not match it.',
      '',
      'Either put the old .env file back into this folder,',
      'or delete the ".data" folder (this deletes the local game data: guests, rooms)',
      'and start the game again; a new .env and database are then created.',
    ]);
  }
  const password = randomBytes(16).toString('hex'); // 32 characters, letters and digits only
  const example = readFileSync(ENV_EXAMPLE, 'utf8');
  const content = example.split(PASSWORD_PLACEHOLDER).join(password);
  const filled = (/** @type {string} */ key) =>
    new RegExp(`^${key}=.*${password}`, 'm').test(content);
  if (!filled('POSTGRES_PASSWORD') || !filled('DATABASE_URL')) {
    fail(['.env.example has an unexpected format; could not create .env.']);
  }
  writeFileSync(ENV_FILE, content, { flag: 'wx' }); // never overwrites an existing file
  say('Created .env with a new random local database password.');
}

/** True when something accepts TCP connections on 127.0.0.1:port. @param {number} port */
function portOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
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

/** @param {Record<string, string>} env */
function ports(env) {
  return [
    { port: Number(env['POSTGRES_PORT'] || 55432), what: 'database' },
    { port: Number(env['PORT'] || 2567), what: 'game server' },
    { port: WEB_PORT, what: 'web page' },
  ];
}

/** @param {Record<string, string>} env */
async function checkPortsFree(env) {
  const busy = [];
  for (const entry of ports(env)) {
    if (!(await portOpen(entry.port))) continue;
    // A database left running by an earlier start whose window was closed: dev.js stops it
    // cleanly before starting a new one (scripts/dev-db-owner.js).
    if (entry.what === 'database' && findOrphan() !== undefined) {
      say('Found the game database still running from an earlier start; it is stopped first.');
      continue;
    }
    busy.push(`${String(entry.port)} (${entry.what})`);
  }
  if (busy.length === 0) return;
  fail([
    `Another program is already using port ${busy.join(', ')}.`,
    'Most likely the game is already running in another window.',
    '',
    `If it is: use that window (the game is at ${WEB_URL}), or close it and start again.`,
    'If no other game window is open: restart the computer and start again.',
  ]);
}

/** Environment for children: the running node's folder first on PATH (npx needs `node`). */
function childEnv() {
  const env = { ...process.env };
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  env[key] = [path.dirname(process.execPath), env[key] ?? ''].join(path.delimiter);
  return env;
}

/**
 * npm's npx entry point bundled with the running node (official installers, nvm, Homebrew):
 * run with this node directly, so no shell or .cmd shim is involved. Undefined if not found.
 */
function npxCli() {
  const dir = path.dirname(process.execPath);
  const candidates = IS_WINDOWS
    ? [path.join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js')]
    : [path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')];
  return candidates.find((file) => existsSync(file));
}

/** @type {import('node:child_process').ChildProcess | undefined} */
let child;
let stopRequested = false;

/**
 * Runs `npx --yes <pnpm spec> <args>` with inherited output (stdin ignored: nothing here reads
 * it, and on Windows a Ctrl+C would otherwise leave a "Terminate batch job?" prompt waiting).
 * @param {string} spec @param {string[]} args
 */
function runPnpm(spec, args) {
  const cli = npxCli();
  const npxArgs = ['--yes', spec, ...args];
  /** @type {import('node:child_process').SpawnOptions} */
  const options = { cwd: ROOT, env: childEnv(), stdio: ['ignore', 'inherit', 'inherit'] };
  // Fallback: npx from PATH. On Windows that is a .cmd shim, which only a shell can run; the
  // command line is built from constants and package.json's validated "packageManager".
  const proc =
    cli !== undefined
      ? spawn(process.execPath, [cli, ...npxArgs], options)
      : IS_WINDOWS
        ? spawn(`npx ${npxArgs.join(' ')}`, { ...options, shell: true })
        : spawn('npx', npxArgs, options);
  child = proc;
  const exited = new Promise((resolve) => {
    proc.on('error', (error) => {
      say(`Could not start npx: ${error.message}`);
      resolve(1);
    });
    proc.on('exit', (code) => {
      resolve(code ?? 1);
    });
  });
  return { proc, exited: /** @type {Promise<number>} */ (exited) };
}

function lockHash() {
  return createHash('sha256').update(readFileSync(LOCKFILE)).digest('hex');
}

function installUpToDate() {
  try {
    return JSON.parse(readFileSync(MARKER, 'utf8')).lockHash === lockHash();
  } catch {
    return false;
  }
}

/**
 * Cheap reachability check before the first install: can the package registry's host name be
 * resolved? (npm_config_registry is honoured.) A failed lookup almost always means "offline".
 */
async function registryReachable() {
  let host = 'registry.npmjs.org';
  try {
    host = new URL(process.env['npm_config_registry'] || DEFAULT_REGISTRY).hostname;
  } catch {
    // keep the default
  }
  try {
    await Promise.race([
      lookup(host),
      new Promise((_resolve, reject) => setTimeout(reject, 5_000)),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} spec */
async function ensureInstalled(spec) {
  if (installUpToDate()) return;
  if (!(await registryReachable())) {
    fail([
      'No internet connection.',
      '',
      'The first start downloads what the game needs (a few hundred MB) and therefore',
      'needs the internet. Connect this computer to the internet and start the game again.',
      'Later starts work offline.',
    ]);
  }
  box([
    'First start: downloading and installing what the game needs.',
    'This takes a few minutes and needs an internet connection.',
  ]);
  const { exited } = runPnpm(spec, ['install', '--frozen-lockfile']);
  const code = await exited;
  if (stopRequested) process.exit(0);
  if (code !== 0) {
    fail([
      `Installing failed (exit code ${String(code)}); see the messages above.`,
      'Check the internet connection and start the game again.',
      ...(IS_WINDOWS && ROOT.length > MAX_WINDOWS_ROOT_LENGTH
        ? ['The folder path is long: move the game folder to e.g. C:\\Games\\cartignon.']
        : []),
    ]);
  }
  writeFileSync(MARKER, `${JSON.stringify({ lockHash: lockHash() })}\n`);
}

/** True when GET url answers with a 2xx status. @param {string} url */
async function httpOk(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

function openBrowser() {
  const [command, args] = IS_WINDOWS
    ? ['cmd', ['/d', '/c', 'start', '""', WEB_URL]]
    : [IS_MAC ? 'open' : 'xdg-open', [WEB_URL]];
  try {
    const opener = spawn(command, args, {
      stdio: 'ignore',
      detached: !IS_WINDOWS,
      windowsHide: true,
      windowsVerbatimArguments: IS_WINDOWS,
    });
    opener.on('error', () => {
      say(`Could not open the browser automatically; open ${WEB_URL} yourself.`);
    });
    opener.unref();
  } catch {
    say(`Could not open the browser automatically; open ${WEB_URL} yourself.`);
  }
}

/** @param {Record<string, string>} env */
async function waitAndOpen(env) {
  const serverPort = Number(env['PORT'] || 2567);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (child !== undefined && child.exitCode === null && !stopRequested) {
    if (
      (await httpOk(`http://127.0.0.1:${String(WEB_PORT)}/`)) &&
      (await httpOk(`http://127.0.0.1:${String(serverPort)}/healthz`))
    ) {
      openBrowser();
      const privateKeys = IS_MAC
        ? 'Safari/Chrome: Cmd+Shift+N, Firefox: Cmd+Shift+P'
        : 'Chrome/Edge: Ctrl+Shift+N, Firefox: Ctrl+Shift+P';
      box([
        'THE TALLY IS RUNNING',
        '',
        `Your browser should now open ${WEB_URL}`,
        '(if it does not, open that address yourself).',
        '',
        'Second player: open the same address in a private/incognito window',
        `(${privateKeys}). Each window is its own player.`,
        'One player creates a room, the other joins with the invite code.',
        '',
        'To stop the game: press Ctrl+C here, or simply close this window.',
      ]);
      return;
    }
    if (Date.now() > deadline) {
      say(
        `Still not ready after ${String(READY_TIMEOUT_MS / 60_000)} minutes; see the messages above.`,
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

// Ctrl+C / window close reach every process in the console (or terminal process group); dev.js
// does the shutdown. The launcher only waits for it, then exits.
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'])) {
  process.on(signal, () => {
    stopRequested = true;
    // SIGTERM is usually sent to this process alone: pass it on.
    if (signal === 'SIGTERM' && child !== undefined && child.exitCode === null) {
      child.kill('SIGTERM');
    }
  });
}

async function main() {
  checkNode();
  const spec = pnpmSpec();
  say(`The Tally launcher (Node ${process.version}, ${spec}, folder ${ROOT})`);
  checkPathLength();
  ensureEnvFile();
  const env = readEnvFile();
  await checkPortsFree(env);
  await ensureInstalled(spec);

  box([
    'Starting the game. The first start takes a few minutes',
    '(it builds the game and creates the local database). Please wait.',
  ]);
  const { exited } = runPnpm(spec, ['dev']);
  void waitAndOpen(env);
  const code = await exited;
  if (stopRequested) {
    say('The Tally stopped.');
    process.exit(0);
  }
  if (code !== 0) {
    fail([`The game stopped with an error (exit code ${String(code)}); see the messages above.`]);
  }
  process.exit(0);
}

main().catch((/** @type {unknown} */ error) => {
  fail([`Launcher error: ${error instanceof Error ? error.message : String(error)}`]);
});
