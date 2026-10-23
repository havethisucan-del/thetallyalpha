const DEV_GAME_SERVER_URL = 'http://127.0.0.1:2567';

/**
 * Colyseus endpoint. Unset: the local dev server in development, the page's own origin in
 * production (same-origin deployment). An explicitly empty value also means "same origin"; a
 * value starting with `/` is a path on the page's own origin (`pnpm dev:lan` uses `/colyseus`,
 * which the Vite dev server proxies to the game server, WebSockets included).
 */
export function gameServerUrl(): string {
  const configured = import.meta.env.VITE_GAME_SERVER_URL;
  if (configured === undefined) {
    return import.meta.env.DEV ? DEV_GAME_SERVER_URL : window.location.origin;
  }
  const value = configured.trim();
  if (value === '') return window.location.origin;
  return value.startsWith('/') ? `${window.location.origin}${value}` : value;
}

/**
 * ADR-0017: online play (guest session, lobby, Colyseus) exists in every build except the static
 * one (`pnpm build:static`, `vite build --mode static`), which serves solo play only and never
 * contacts a server. Build-time constant, so the online code is dropped from the static bundle.
 */
export const ONLINE_ENABLED: boolean = import.meta.env.MODE !== 'static';

/** The game's user-visible name. */
export const GAME_NAME = 'The Tally';
