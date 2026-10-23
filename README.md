# The Tally

A two-player, turn-based card game in the browser. Play minion and spell cards, fight for the
round, and win tokens on the tally. Play solo against a bot (five levels, L1 to L5), or online
against a friend on a locally running server.

## Play in the browser

**<https://havethisucan-del.github.io/thetallyalpha/>**

The link runs the solo mode: the whole game and the bot run in your browser, nothing to install
and no server. Press **Play**, pick a bot level and press **Play vs ...**.

The first time you press Play, a short interactive tutorial starts instead: a scripted round,
dropped into a battle already in progress, that explains the card face, the flow of a turn,
combat and the goal of the round. You can skip it, and the Play screen has **Replay tutorial** to
run it again. Light and dark themes follow your system; the toggle on the page overrides it.

Online play (two players, private rooms) needs the game server, so it is not available from the
link; run the game locally (below).

## Run locally

Prerequisites: Node 24 LTS (see `.nvmrc`) and pnpm 12.14.0 (the `packageManager` field in
`package.json`; `npm i -g pnpm@12.14.0`). No Docker, no separate database install:
PostgreSQL runs from an npm package.

```sh
pnpm install
pnpm dev        # local Postgres + migrations + server + web; open http://127.0.0.1:5173
```

`pnpm dev` needs a `.env` (copy `.env.example` and set a local password). To play both seats
online on one machine, use two different browsers (or one normal and one private window).
Details, configuration and LAN play: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

Without a terminal: install Node.js LTS, then double-click `Start The Tally.bat` (Windows) or
`Start The Tally.command` (macOS; the first time right-click and choose Open). The launcher
creates `.env`, installs dependencies, starts the game and opens the browser.

## Tests

```sh
pnpm check              # typecheck + lint + format check + unit tests
pnpm test:integration   # integration tests (start their own throwaway Postgres)
pnpm test:e2e           # Playwright: two-browser online match against a local server
pnpm test:e2e:static    # Playwright: the static solo build served under a sub-path, as on Pages
```

## Layout

```
packages/game-core   rules, pure engine, card catalog, projections, seeded RNG
packages/protocol    zod contracts for HTTP and WebSocket messages
packages/ai          the solo bots (levels L1 to L5)
packages/database    Drizzle schema, SQL migrations, embedded dev Postgres
apps/server          Express + Colyseus game server (online play)
apps/web             React + Vite client; solo mode, tutorial and online play
tests/               end-to-end tests (online and static)
docs/cards/          card data (CSV) that generates the built card catalog
```

## Licence

- **Code:** no licence is granted for the code at this time; all rights reserved.
- **Card art:** the underlying figure illustrations are public domain; the card and visual design
  built on them is all rights reserved and not covered by any open licence; see
  [apps/web/ART-NOTICE.md](apps/web/ART-NOTICE.md).
- **Fonts and other third-party material:** under their own licences; see
  [apps/web/THIRD-PARTY-NOTICES.md](apps/web/THIRD-PARTY-NOTICES.md).
