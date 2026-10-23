import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type ProxyOptions } from 'vite';

const DEFAULT_API_PROXY_TARGET = 'http://127.0.0.1:2567';

const DEFAULT_WEB_HOST = '127.0.0.1';
/** Same-origin path prefix for the Colyseus routes (`VITE_GAME_SERVER_URL=/colyseus`). */
const COLYSEUS_PREFIX = '/colyseus';

export default defineConfig(({ mode }) => {
  // Only VITE_-prefixed variables are read; the proxy target is used by the dev/preview server
  // and is never referenced from client code, so it does not end up in the bundle.
  const env = loadEnv(mode, import.meta.dirname, 'VITE_');
  const target = env['VITE_API_PROXY_TARGET'] || DEFAULT_API_PROXY_TARGET;
  // Set by `pnpm dev:lan` (scripts/dev.js), never by the client: bind address of the dev server
  // and whether the proxy adds X-Forwarded-For (the game server then runs with
  // TRUSTED_PROXY=loopback so each LAN device gets its own rate-limit bucket).
  const host = process.env['WEB_HOST'] || DEFAULT_WEB_HOST;
  const lan = process.env['CARTIGNON_LAN'] === '1';

  // The game server checks the Origin header of state-changing requests and WebSocket upgrades,
  // so the browser's Origin is forwarded unchanged (changeOrigin stays false).
  const proxy: Record<string, ProxyOptions> = {
    '/api': { target, changeOrigin: false, xfwd: lan },
    '/healthz': { target, changeOrigin: false, xfwd: lan },
    '/readyz': { target, changeOrigin: false, xfwd: lan },
    // Colyseus matchmaking (POST /matchmake/*) and room WebSockets (/<processId>/<roomId>)
    // through the page's own origin, so a LAN device only needs the web port.
    [`${COLYSEUS_PREFIX}/`]: {
      target,
      changeOrigin: false,
      xfwd: lan,
      ws: true,
      rewrite: (path) => path.slice(COLYSEUS_PREFIX.length) || '/',
    },
  };

  return {
    // `pnpm build:static` (ADR-0017): relative asset URLs so the bundle works from any host path.
    base: mode === 'static' ? './' : '/',
    plugins: [react(), tailwindcss()],
    server: { host, port: 5173, strictPort: true, proxy },
    preview: { host, port: 4173, strictPort: true, proxy },
    // Phaser (~1.4 MB minified) lives in its own lazily loaded chunk for the match screen only.
    // No source maps in the static (Pages) build: they would only add ~14 MB to the download.
    build: { sourcemap: mode !== 'static', chunkSizeWarningLimit: 1600 },
    // Module workers (the solo-mode bot worker imports workspace ES modules); Vite's default is 'iife'.
    worker: { format: 'es' },
  };
});
