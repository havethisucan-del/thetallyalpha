// Ownership record for the dev Postgres that scripts/dev.js starts (ADR-0012 addendum).
//
// dev.js runs Postgres detached from the console, so closing the console window does not kill it
// mid-write. If dev.js itself is then killed before its clean stop finishes, the database keeps
// running ("orphan"). dev.js writes .data/dev-postgres-owner.json (its own PID and the postmaster
// PID) once Postgres is ready and removes it after a clean stop. A later start treats a running
// Postgres as an orphan only when ALL of these hold:
//   - the owner file exists,
//   - .data/postgres/postmaster.pid names the same, still running postmaster,
//   - the dev.js process that wrote the owner file no longer exists.
// The orphan is then stopped with `pg_ctl stop -D .data/postgres` (dev-server.js stop), which can
// only signal the postmaster of that data directory; nothing here kills a process by PID.
//
// Stdlib only; shared by scripts/dev.js and scripts/launch.js.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OWNER_FILE = path.join(ROOT, '.data', 'dev-postgres-owner.json');
const POSTMASTER_PID = path.join(ROOT, '.data', 'postgres', 'postmaster.pid');

/** PID of the running (or crashed) postmaster from postmaster.pid, else undefined. */
export function postmasterPid() {
  try {
    const pid = Number(readFileSync(POSTMASTER_PID, 'utf8').split('\n')[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** @param {number} pid */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: exists but belongs to someone else.
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}

/** Records that this process (dev.js) owns the running dev Postgres. @param {number} pmPid */
export function writeOwner(pmPid) {
  try {
    writeFileSync(
      OWNER_FILE,
      `${JSON.stringify({ launcherPid: process.pid, postmasterPid: pmPid })}\n`,
    );
  } catch {
    // best effort: without it a later orphan is reported as "port busy" instead of recovered
  }
}

export function clearOwner() {
  rmSync(OWNER_FILE, { force: true });
}

/** @returns {{ launcherPid: number, postmasterPid: number } | undefined} */
function readOwner() {
  try {
    const value = JSON.parse(readFileSync(OWNER_FILE, 'utf8'));
    if (Number.isInteger(value?.launcherPid) && Number.isInteger(value?.postmasterPid)) {
      return value;
    }
  } catch {
    // missing or unreadable
  }
  return undefined;
}

/**
 * The postmaster PID of a dev Postgres left running by a dev.js that no longer exists, else
 * undefined (no owner file, a different or dead postmaster, or its owner is still running).
 */
export function findOrphan() {
  const owner = readOwner();
  if (owner === undefined) return undefined;
  const pid = postmasterPid();
  if (pid === undefined || pid !== owner.postmasterPid || !pidAlive(pid)) return undefined;
  if (pidAlive(owner.launcherPid)) return undefined;
  return pid;
}
