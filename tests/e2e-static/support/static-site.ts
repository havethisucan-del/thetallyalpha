// Builds the static (GitHub Pages) web bundle into a temporary directory and serves it under a
// sub-path, the way Pages serves a project site at https://<user>.github.io/<repo>/ (ADR-0017).
// No game server, no Postgres, no proxy: a plain file server, so any `/api` or WebSocket call the
// bundle makes would fail here just as it would on Pages. apps/web/dist is never touched.
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { mkdtemp, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WEB_DIR = path.join(ROOT, 'apps', 'web');
const VITE = path.join(WEB_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
const HOST = '127.0.0.1';
/** Differs from the main e2e preview (4173), so both suites can run side by side. */
export const STATIC_PORT = 4174;
export const STATIC_ORIGIN = `http://${HOST}:${STATIC_PORT}`;
/** The repo-name segment of a Pages project site. */
export const SUB_PATH = '/the-tally/';
export const SITE_URL = `${STATIC_ORIGIN}${SUB_PATH}`;
export const LOG_DIR = path.join(ROOT, 'playwright-report', 'e2e-static');

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function log(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: 'info', scope: 'e2e-static', msg, ...extra }));
}

/** `vite build --mode static` into `outDir` (spawned with node directly, no shell). */
async function buildStatic(outDir: string): Promise<void> {
  mkdirSync(LOG_DIR, { recursive: true });
  const logFile = createWriteStream(path.join(LOG_DIR, 'web-build.log'), { flags: 'w' });
  const child = spawn(
    process.execPath,
    [VITE, 'build', '--mode', 'static', '--outDir', outDir, '--emptyOutDir'],
    { cwd: WEB_DIR, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  child.stdout.pipe(logFile, { end: false });
  child.stderr.pipe(logFile, { end: false });
  const code = await new Promise<number | null>((resolve) => {
    child.once('exit', resolve);
    child.once('error', () => {
      resolve(null);
    });
  });
  await new Promise<void>((resolve) => logFile.end(resolve));
  if (code !== 0) throw new Error(`static web build failed (exit ${String(code)}, see ${LOG_DIR})`);
}

/** Serves files under `siteDir` at SUB_PATH only; everything else is a 404, like Pages. */
function serve(siteDir: string): Promise<Server> {
  const server = createServer((req, res) => {
    void (async () => {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', STATIC_ORIGIN).pathname);
      if (pathname === SUB_PATH.slice(0, -1)) {
        res.writeHead(301, { Location: SUB_PATH }).end();
        return;
      }
      if (!pathname.startsWith(SUB_PATH) || (req.method !== 'GET' && req.method !== 'HEAD')) {
        res.writeHead(404).end();
        return;
      }
      let file = path.resolve(siteDir, `.${pathname.slice(SUB_PATH.length - 1)}`);
      if (file !== siteDir && !file.startsWith(siteDir + path.sep)) {
        res.writeHead(404).end();
        return;
      }
      try {
        if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
        const size = (await stat(file)).size;
        res.writeHead(200, {
          'Content-Type':
            CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
          'Content-Length': size,
          'Cache-Control': 'no-store',
        });
        if (req.method === 'HEAD') res.end();
        else createReadStream(file).pipe(res);
      } catch {
        res.writeHead(404).end();
      }
    })();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(STATIC_PORT, HOST, () => {
      resolve(server);
    });
  });
}

/** Builds and serves the static site; the returned function stops the server and cleans up. */
export async function startStaticSite(): Promise<() => Promise<void>> {
  const t0 = Date.now();
  const siteDir = await mkdtemp(path.join(tmpdir(), 'cartignon-e2e-static-'));
  const cleanup = () => {
    rmSync(siteDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  let server: Server;
  try {
    await buildStatic(siteDir);
    log('static web built', { ms: Date.now() - t0 });
    server = await serve(siteDir);
  } catch (error) {
    cleanup();
    throw error;
  }
  log('static site ready', { url: SITE_URL, ms: Date.now() - t0 });
  return async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    cleanup();
    log('static site stopped');
  };
}
