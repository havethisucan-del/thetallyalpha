# Development

## Prerequisites
- Node 24 LTS (`.nvmrc`; Node 26 works locally), pnpm 12.14.0 (`npm i -g pnpm@12.14.0`)
- Nothing else: PostgreSQL 18 runs from the `embedded-postgres` npm package (real binaries in
  user space, no Docker, no admin rights).

## First run
```sh
pnpm install
cp .env.example .env          # then set a local POSTGRES_PASSWORD and the same value in the URLs
pnpm dev                      # first run also initialises .data/postgres
```

## Run the app
```sh
pnpm dev                      # Postgres + migrations + apps/server (127.0.0.1:2567) + apps/web (Vite)
```
`pnpm dev` (`scripts/dev.js`, ADR-0012) builds the
workspace (`tsc -b`), starts the dev Postgres on 127.0.0.1:55432 unless one is already listening
there, waits until it is ready, applies migrations, then runs server + web. Ctrl+C (or Ctrl+Break,
closing the terminal, or server/web exiting) stops everything it started, Postgres included, with a
clean `pg_ctl` fast shutdown. A Postgres you started yourself with `pnpm db:start` is reused and left
running. If Postgres or migrations fail, `pnpm dev` prints the error and exits non-zero with nothing
left running. `pnpm dev:app` runs only server + web, for a database you manage separately.
Open http://127.0.0.1:5173. To play both seats, use two different browsers (or one normal and one
private window) — each gets its own guest session. In dev, `/api` goes through the Vite proxy (same
origin); the Colyseus SDK connects cross-origin to `VITE_GAME_SERVER_URL`.

## Play on the LAN (`pnpm dev:lan`) and share the game (`pnpm share`)
```sh
pnpm dev:lan                  # same as pnpm dev, reachable from other devices on the network
pnpm share                    # writes out/cartignon-share-YYYYMMDD.zip for a friend
```
`pnpm dev:lan` (ADR-0013) runs the `pnpm dev`
lifecycle with Vite on 0.0.0.0:5173 and prints the URL to open (`http://<lan-ip>:5173`). Only that
one port is used: the client talks to Colyseus through the Vite proxy (`/colyseus`, WebSockets
included), and the game server stays on 127.0.0.1:2567. For that run only, `ALLOWED_ORIGINS` gains
`http://<lan-ip>:5173` and the server trusts the proxy's `X-Forwarded-For` (`TRUSTED_PROXY=loopback`);
`.env` is not changed. Set `LAN_HOST` if the detected address is wrong. Windows asks once to allow
Node.js through the firewall: allow it on Private networks. Because a LAN address over http is not a
secure context, `crypto.randomUUID` and `navigator.clipboard` are missing there; the web app
handles that itself (`apps/web/src/lib/secureContext.ts`): action IDs fall back to a v4 UUID built
from `crypto.getRandomValues`, and the lobby hides the "copy invite code" button so the code is
copied by hand. Trusted home networks only.

`pnpm share` packs the repo without `node_modules`, build/test output, `.data`, `.env`/keys, `.git`,
`out/` and the assistant files (`.claude/`, `docs/handoffs/`); the friend double-clicks a
launcher (see the [README](../README.md)).

The zip includes double-click launchers, `Start The Tally.bat` (Windows, CRLF) and
`Start The Tally.command` (macOS, LF, mode 0755 in the zip). Both run `node scripts/launch.js`
(ADR-0014). The launcher runs pnpm through
`npx --yes pnpm@<packageManager>` (no global pnpm needed) and creates `.env` with a random password
if it is missing. It runs `pnpm install --frozen-lockfile` when `pnpm-lock.yaml` changed since the
last launch, then `pnpm dev`, and opens the browser. It also works in a dev checkout. It refuses to
start while ports 55432/2567/5173 are in use, so it never reuses a `pnpm db:start` Postgres.

## Configuration
Server variables live in the root `.env` (template: `.env.example`), read by `apps/server`:

| Variable | Meaning (default in `.env.example`) |
|---|---|
| `PORT`, `HOST` | listen address (`2567`, `127.0.0.1`) |
| `DATABASE_URL` | PostgreSQL connection string |
| `ALLOWED_ORIGINS` | comma-separated Origin allowlist for CSRF, CORS and WebSocket upgrades |
| `COOKIE_SECURE` | `Secure` flag on the session cookie (`false` locally, `true` behind HTTPS) |
| `SESSION_TTL_DAYS` | guest session lifetime (`30`) |
| `LOG_LEVEL` | pino log level (`info`) |
| `ROOM_IDLE_TIMEOUT_MINUTES` | dispose rooms with nobody connected after this time (`10`); never while a match is active |
| `ROOM_MAX_LIFETIME_MINUTES` | hard cap on a room's lifetime (`720`) |
| `TURN_TIMEOUT_SECONDS` | turn clock per turn (`900`); fractions allowed |
| `CHOICE_TIMEOUT_SECONDS` | choice clock of the non-turn seat answering a choice (`60`) |
| `PAUSE_BUDGET_SECONDS` | pause budget per seat per match while disconnected (`180`) |

Web variables: copy `apps/web/.env.example` to `apps/web/.env.local` to override. They are embedded
in the public bundle, so never put secrets there.

| Variable | Meaning |
|---|---|
| `VITE_API_PROXY_TARGET` | dev/preview only: where `/api`, `/healthz`, `/readyz` are proxied (`http://127.0.0.1:2567`) |
| `VITE_GAME_SERVER_URL` | Colyseus URL for the browser SDK; unset = `http://127.0.0.1:2567` in dev and the page origin in production; empty = always the page origin |

## Everyday commands
| Command | What it does |
|---|---|
| `pnpm dev` | starts (or reuses) the dev Postgres, migrates, runs `apps/server` + `apps/web` with hot reload; Ctrl+C stops all of it |
| `pnpm dev:app` | only `apps/server` + `apps/web` (database managed separately, e.g. `pnpm db:start`) |
| `pnpm check` | typecheck + lint + format check + unit tests (no external services) |
| `pnpm test` | unit tests |
| `pnpm test:integration` | integration tests; starts its own throwaway Postgres unless `TEST_DATABASE_URL` is set |
| `pnpm test:e2e` | Playwright (Chromium): starts its own Postgres, server and web build, plays a two-browser private match |
| `pnpm test:e2e:static` | Playwright (Chromium): builds the static solo site and serves it under a sub-path on port 4174, as GitHub Pages does; no Postgres or game server |
| `pnpm build` | builds all workspace packages |
| `pnpm --filter @cartignon/web build:static` | static solo build (no online code, relative asset URLs) into `apps/web/dist`; this is what GitHub Pages deploys |
| `pnpm cards:generate` | regenerates `packages/game-core/data/cards.json` from `docs/cards/*.csv` after editing a CSV (a drift test in `pnpm check` fails until you do) |
| `pnpm db:start` | runs the local dev Postgres alone in the foreground (optional; `pnpm dev` does it) |
| `pnpm db:stop` | clean (fast) shutdown of a running dev Postgres, from another terminal |
| `pnpm db:generate` | create a new migration after editing `packages/database/src/schema.ts` |
| `pnpm db:migrate` | apply pending migrations to `DATABASE_URL` |

## Database
- Schema: `packages/database/src/schema.ts`; migrations are generated SQL in
  `packages/database/migrations/` (committed, never edited after being applied anywhere).
- Dev server (`packages/database/src/cli/dev-server.ts`): data in `<repo>/.data/postgres`
  (git-ignored), listens on `127.0.0.1` only, port `POSTGRES_PORT` (default 55432), superuser
  `POSTGRES_USER` and database `POSTGRES_DB` (default `cartignon`). `POSTGRES_PASSWORD` is required.
  The password is set when the data directory is first initialised; changing it in `.env` later
  does not change the server password.
- Integration tests never use the dev database. Without `TEST_DATABASE_URL`, a Vitest global setup
  (`packages/database/test/global-setup.ts`) starts an ephemeral Postgres in a temp directory on a
  free loopback port with a random password, in a separate Node process, and deletes it afterwards. With `TEST_DATABASE_URL`
  (e.g. from `.env`), that server is used and `pnpm db:start` must be running. Either way each test
  file creates `cartignon_test_<random>`, migrates it, and drops it afterwards.
- CI: Postgres refuses to run as root, so run integration tests as a non-root user or provide
  `TEST_DATABASE_URL` (e.g. a Postgres service container). On Linux/macOS the binaries' postinstall
  (allowed in `pnpm-workspace.yaml`) must run to create their library symlinks.
- Wiping all local dev data is destructive: stop the server, then delete `.data/postgres`.

## Windows notes
- Stop `pnpm dev` / `pnpm db:start` with Ctrl+C (answer `Y` if cmd asks "Terminate batch job") or
  `pnpm db:stop`. If the Node process is killed instead (e.g. Task Manager), `postgres.exe` may keep
  running; `pnpm db:stop` then shuts it down.
- `SIGTERM` cannot be delivered to a process on Windows; use `pnpm db:stop` from scripts.
