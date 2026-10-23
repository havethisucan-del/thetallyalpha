// Windows-only relay between scripts/dev.js and the dev Postgres CLI (ADR-0012 addendum).
//
// dev.js starts this script detached (DETACHED_PROCESS): it is then outside dev.js's console,
// so closing the window sends it no CTRL_CLOSE_EVENT, and outside the kill-on-close job object
// that Node puts non-detached children in, so a killed dev.js does not take Postgres down with it.
// A detached process has no console at all, though, and postgres.exe (spawned by
// embedded-postgres without windowsHide) would then get a new, VISIBLE console window: with
// Windows Terminal as the default terminal, a second terminal window. This relay therefore runs
// `packages/database/dist/cli/dev-server.js <args>` with windowsHide (CREATE_NO_WINDOW): a
// windowless console that postgres.exe inherits.
//
// stdio is inherited, so dev-server.js reads dev.js's stdin pipe directly: when dev.js closes
// it or dies, dev-server.js stops Postgres cleanly (--stop-on-stdin-close). The relay only waits
// and exits with the same code. It must stay alive while Postgres runs (dev-server.js is in its
// job object), so it ignores the signals Node can deliver to it.
//
// Stdlib only; never imports embedded-postgres. Usage: node dev-db-relay.js <dev-server args>.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DB_PKG = path.join(ROOT, 'packages', 'database');
const DEV_SERVER = path.join(DB_PKG, 'dist', 'cli', 'dev-server.js');

for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'])) {
  process.on(signal, () => undefined);
}

const child = spawn(process.execPath, [...process.execArgv, DEV_SERVER, ...process.argv.slice(2)], {
  cwd: DB_PKG,
  stdio: 'inherit',
  windowsHide: true,
});
child.on('error', (error) => {
  console.error(
    JSON.stringify({ level: 'error', msg: 'could not start dev-server.js', error: error.message }),
  );
  process.exit(1);
});
child.on('exit', (code) => {
  process.exit(code ?? 1);
});
