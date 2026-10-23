// `pnpm share`: packs the repository into out/cartignon-share-YYYYMMDD.zip for a LAN playtest on
// another PC (docs/PLAYTEST.md, ADR-0013).
//
// Left out: dependencies, build/test output, local data and secrets (node_modules, dist,
// coverage, test-results, playwright-report, .data, *.tsbuildinfo, .env and .env.* except
// .env.example, key files), version control (.git), the output folder itself (out), and the
// AI-assistant working files a player does not need (.claude, docs/handoffs,
// CLAUDE_CODE_FRAMEWORK_PROMPT_GENERIC.md).
//
// Stdlib only (zlib deflate + crc32, Node >= 22.2): no external zip tool or dependency. The
// archive is checked after writing: the script fails if a forbidden path got in. Entries carry
// Unix modes (0755 for *.command/*.sh launchers, 0644 otherwise) and the launchers' line endings
// are checked (LF for the Mac script, CRLF for the .bat), ADR-0014.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = path.join(ROOT, 'out');

/** Directory names skipped at any depth. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.data',
  'dist',
  'coverage',
  'test-results',
  'playwright-report',
  '.vite',
]);
/** Repo-relative paths (forward slashes) skipped entirely. */
const SKIP_PATHS = new Set([
  'out',
  '.claude',
  'docs/handoffs',
  'CLAUDE_CODE_FRAMEWORK_PROMPT_GENERIC.md',
]);
const SECRET_FILE = /(^\.env(\..*)?$|\.env$|^\.envrc$|^\.pgpass$|\.(pem|key|p12|pfx)$)/i;
const JUNK_FILE = /(\.tsbuildinfo$|^\.DS_Store$|^Thumbs\.db$)/i;

/** Stored as executable (mode 0755) so macOS can run them after unzipping (ADR-0014). */
const EXECUTABLE_FILE = /\.(command|sh)$/;
const MODE_EXECUTABLE = 0o100755; // regular file, rwxr-xr-x
const MODE_REGULAR = 0o100644; // regular file, rw-r--r--
/** Central directory "version made by": host 3 (Unix, so the external attributes carry the mode) | spec 2.0. */
const MADE_BY_UNIX = (3 << 8) | 20;

/** @param {string} rel */
function fileMode(rel) {
  return EXECUTABLE_FILE.test(rel) ? MODE_EXECUTABLE : MODE_REGULAR;
}

/** @param {string} name */
function skipFile(name) {
  if (name === '.env.example') return false;
  return SECRET_FILE.test(name) || JUNK_FILE.test(name);
}

/** Repo-relative file paths to pack, sorted. @returns {string[]} */
function collect(/** @type {string} */ dir = '', /** @type {string[]} */ acc = []) {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (SKIP_PATHS.has(rel)) continue;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collect(rel, acc);
    } else if (entry.isFile() && !skipFile(entry.name)) {
      acc.push(rel);
    }
  }
  return acc.sort();
}

/** MS-DOS date/time of a Date. */
function dosTime(/** @type {Date} */ d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** Writes a plain (non-zip64) zip archive; entries are deflated unless that does not help. */
function buildZip(/** @type {string[]} */ files) {
  /** @type {Buffer[]} */
  const chunks = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    const data = readFileSync(abs);
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const name = Buffer.from(rel, 'utf8');
    const { time, date } = dosTime(statSync(abs).mtime);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(MADE_BY_UNIX, 4); // version made by
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(stored ? 0 : 8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    // extra/comment length, disk start, internal attributes: 0. External attributes: Unix mode
    // in the high 16 bits (MS-DOS attribute byte 0 = normal file).
    entry.writeUInt32LE(fileMode(rel) * 0x1_0000, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    chunks.push(local, name, body);
    offset += local.length + name.length + body.length;
    if (offset > 0xffff_ffff) throw new Error('archive larger than 4 GiB (zip64 not supported)');
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  if (files.length > 0xffff) throw new Error('too many files for a non-zip64 archive');
  return Buffer.concat([...chunks, centralBuffer, end]);
}

/**
 * Entries of the archive's central directory: name, "version made by" and Unix mode.
 * @param {Buffer} zip
 */
function listZip(zip) {
  const endAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(endAt + 10);
  let at = zip.readUInt32LE(endAt + 16);
  /** @type {{ name: string, madeBy: number, mode: number }[]} */
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const nameLength = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    entries.push({
      name: zip.toString('utf8', at + 46, at + 46 + nameLength),
      madeBy: zip.readUInt16LE(at + 4),
      mode: zip.readUInt32LE(at + 38) >>> 16,
    });
    at += 46 + nameLength + extra;
  }
  return entries;
}

/**
 * Launcher line endings: a CR breaks the Mac shell script, a bare LF can confuse cmd.exe.
 * @param {string[]} files @returns {string[]} problems
 */
function lineEndingProblems(files) {
  /** @type {string[]} */
  const problems = [];
  for (const rel of files) {
    if (!/\.(command|sh|bat)$/.test(rel)) continue;
    const text = readFileSync(path.join(ROOT, rel), 'latin1');
    if (/\.(command|sh)$/.test(rel) && text.includes('\r')) {
      problems.push(`${rel} contains CR characters (must use LF line endings)`);
    }
    if (rel.endsWith('.bat') && /(^|[^\r])\n/.test(text)) {
      problems.push(`${rel} has LF-only line endings (must use CRLF)`);
    }
  }
  return problems;
}

function main() {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const archiveName = `cartignon-share-${stamp}`;
  const files = collect();
  const lineEndings = lineEndingProblems(files);
  if (lineEndings.length > 0) {
    console.error(`refusing to write: ${lineEndings.join('; ')}`);
    process.exit(1);
  }
  // Entries sit at the archive root: Explorer's "Extract All" puts them in a folder named after
  // the zip.
  const zip = buildZip(files);
  const entries = listZip(zip);

  const forbidden = entries
    .map((entry) => entry.name)
    .filter((name) => {
      const parts = name.split('/');
      const base = parts[parts.length - 1] ?? '';
      return parts.some((p) => SKIP_DIRS.has(p)) || skipFile(base);
    });
  if (forbidden.length > 0) {
    console.error(`refusing to write: forbidden entries ${forbidden.join(', ')}`);
    process.exit(1);
  }
  const wrongMode = entries.filter(
    (entry) => entry.madeBy !== MADE_BY_UNIX || entry.mode !== fileMode(entry.name),
  );
  if (wrongMode.length > 0) {
    console.error(`refusing to write: wrong mode on ${wrongMode.map((e) => e.name).join(', ')}`);
    process.exit(1);
  }
  for (const entry of entries.filter((e) => EXECUTABLE_FILE.test(e.name))) {
    console.log(`executable: ${entry.name} (mode ${entry.mode.toString(8)})`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const target = path.join(OUT_DIR, `${archiveName}.zip`);
  writeFileSync(target, zip);
  const mib = (zip.length / (1024 * 1024)).toFixed(2);
  console.log(`wrote ${target}`);
  console.log(`${files.length} files, ${mib} MiB (${zip.length} bytes)`);
  console.log('Send this zip to your friend together with docs/PLAYTEST.md (it is inside too).');
}

main();
