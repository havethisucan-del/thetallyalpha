import { availableParallelism } from 'node:os';
import { parseArgs } from 'node:util';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import {
  BOT_LEVEL_NAMES,
  createBot,
  DEFAULT_PLAYOUT_BUDGET,
  DEFAULT_TIME_BUDGET_MS,
  isBotLevel,
  playBotMatch,
  type BotLevel,
  type BotTuning,
  type SearchBudget,
} from '@cartignon/ai';
import { createSeededRng, type Seat } from '@cartignon/game-core';
import { realCatalog } from './catalog.ts';

/**
 * ADR-0016 tournament harness (Node only; `pnpm ai:tournament`). Plays level pairings over the
 * real catalog and prints win rates and decision times. Games come in pairs with the same engine
 * seed and swapped seats, so neither level profits from a lucky deal or from moving first.
 *
 *   pnpm ai:tournament [--games 400] [--pairs 1-2,2-3,3-4,4-5] [--budget playouts|time]
 *                      [--seed 1] [--workers N] [--tune '{"4":{"mc":{"priorPlayouts":6}}}']
 *
 * `--budget playouts` (default) uses DEFAULT_PLAYOUT_BUDGET (deterministic per seed);
 * `--budget time` uses DEFAULT_TIME_BUDGET_MS (what the browser bot uses; machine-dependent).
 */

type BudgetMode = 'playouts' | 'time';

interface Job {
  readonly a: BotLevel;
  readonly b: BotLevel;
  readonly seed: number;
  readonly game: number;
  readonly budget: BudgetMode;
  /** Per-level overrides (`--tune '{"4":{"mc":{"priorPlayouts":6}}}'`), for tuning runs. */
  readonly tune: Partial<Record<BotLevel, BotTuning & { readonly playouts?: number }>>;
}

interface GameResult {
  readonly a: BotLevel;
  readonly b: BotLevel;
  /** 'a' | 'b' won, or null for a draw / step cap. */
  readonly winner: 'a' | 'b' | null;
  readonly stepCap: boolean;
  readonly steps: number;
  /** Per level: decision times in ms. */
  readonly msA: readonly number[];
  readonly msB: readonly number[];
}

function budgetFor(level: BotLevel, job: Job): SearchBudget | undefined {
  if (level < 4) return undefined;
  return job.budget === 'playouts'
    ? { kind: 'playouts', playouts: job.tune[level]?.playouts ?? DEFAULT_PLAYOUT_BUDGET[level] }
    : { kind: 'time', ms: DEFAULT_TIME_BUDGET_MS[level], now: () => performance.now() };
}

function playGame(job: Job): GameResult {
  const { catalog, ctx } = cachedCatalog();
  // Games 2k and 2k + 1 share the deal; level `a` sits in seat 0 on even games.
  const pair = Math.floor(job.game / 2);
  const aSeat: Seat = job.game % 2 === 0 ? 0 : 1;
  const engineRng = createSeededRng(job.seed * 1_000_003 + job.a * 7919 + job.b * 104_729 + pair);
  const levels: readonly [BotLevel, BotLevel] = aSeat === 0 ? [job.a, job.b] : [job.b, job.a];
  const seats = levels.map((level, seat) => {
    const budget = budgetFor(level, job);
    return {
      bot: createBot(level, ctx, job.tune[level]),
      rng: createSeededRng(job.seed * 31 + job.game * 2 + seat + 17),
      ...(budget === undefined ? {} : { budget }),
    };
  }) as unknown as Parameters<typeof playBotMatch>[3];
  const ms: [number[], number[]] = [[], []];
  const result = playBotMatch(ctx, catalog, engineRng, seats, {
    now: () => performance.now(),
    onDecision: (d) => ms[d.seat].push(d.ms),
  });
  const winner =
    result.winner === null ? null : result.winner === aSeat ? ('a' as const) : ('b' as const);
  return {
    a: job.a,
    b: job.b,
    winner,
    stepCap: result.end === 'stepCap',
    steps: result.steps,
    msA: ms[aSeat],
    msB: ms[aSeat === 0 ? 1 : 0],
  };
}

let catalogCache: ReturnType<typeof realCatalog> | undefined;
function cachedCatalog(): ReturnType<typeof realCatalog> {
  catalogCache ??= realCatalog();
  return catalogCache;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      games: { type: 'string', default: '400' },
      pairs: { type: 'string', default: '1-2,2-3,3-4,4-5' },
      budget: { type: 'string', default: 'playouts' },
      seed: { type: 'string', default: '1' },
      workers: { type: 'string', default: String(Math.max(1, availableParallelism() - 1)) },
      tune: { type: 'string', default: '{}' },
    },
  });
  const games = Number.parseInt(values.games, 10);
  const seed = Number.parseInt(values.seed, 10);
  const workers = Math.max(1, Number.parseInt(values.workers, 10));
  const budget = values.budget;
  if (budget !== 'playouts' && budget !== 'time') throw new Error('--budget playouts|time');
  if (!Number.isInteger(games) || games < 2 || games % 2 !== 0) {
    throw new Error('--games must be an even integer >= 2');
  }
  const pairs = values.pairs.split(',').map((p) => {
    const [a, b] = p.split('-').map(Number);
    if (!isBotLevel(a) || !isBotLevel(b)) throw new Error(`bad pairing ${p}`);
    return [a, b] as const;
  });
  const tune = JSON.parse(values.tune) as Job['tune'];
  const jobs: Job[] = pairs.flatMap(([a, b]) =>
    Array.from({ length: games }, (_, game) => ({ a, b, seed, game, budget, tune })),
  );
  console.log(
    `ADR-0016 tournament: ${games} games per pairing, budget=${budget}, seed=${seed}, ` +
      `workers=${workers}, tune=${values.tune}`,
  );
  const started = performance.now();
  const results = await runJobs(jobs, workers);
  const wall = (performance.now() - started) / 1000;

  const msByLevel = new Map<BotLevel, number[]>();
  console.log('\n| Pairing | A wins | B wins | Draws | A win rate (decisive) | Step caps |');
  console.log('|---|---|---|---|---|---|');
  for (const [a, b] of pairs) {
    const rs = results.filter((r) => r.a === a && r.b === b);
    const wa = rs.filter((r) => r.winner === 'a').length;
    const wb = rs.filter((r) => r.winner === 'b').length;
    const draws = rs.length - wa - wb;
    const caps = rs.filter((r) => r.stepCap).length;
    const rate = wa + wb === 0 ? 0 : (100 * wa) / (wa + wb);
    console.log(
      `| L${a} ${BOT_LEVEL_NAMES[a]} vs L${b} ${BOT_LEVEL_NAMES[b]} | ${wa} | ${wb} | ${draws} | ` +
        `${fmt(rate)} % | ${caps} |`,
    );
    for (const r of rs) {
      msByLevel.set(a, [...(msByLevel.get(a) ?? []), ...r.msA]);
      msByLevel.set(b, [...(msByLevel.get(b) ?? []), ...r.msB]);
    }
  }
  console.log('\n| Level | Decisions | Mean ms | p50 ms | p95 ms | Max ms |');
  console.log('|---|---|---|---|---|---|');
  for (const level of [...msByLevel.keys()].sort()) {
    const ms = [...(msByLevel.get(level) ?? [])].sort((x, y) => x - y);
    const mean = ms.reduce((s, x) => s + x, 0) / Math.max(1, ms.length);
    console.log(
      `| L${level} | ${ms.length} | ${fmt(mean)} | ${fmt(quantile(ms, 0.5))} | ` +
        `${fmt(quantile(ms, 0.95))} | ${fmt(ms.at(-1) ?? 0)} |`,
    );
  }
  console.log(`\nWall time: ${fmt(wall)} s`);
}

async function runJobs(jobs: readonly Job[], workers: number): Promise<GameResult[]> {
  if (workers <= 1) return jobs.map(playGame);
  const results: GameResult[] = [];
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(workers, jobs.length) },
      () =>
        new Promise<void>((resolve, reject) => {
          const worker = new Worker(new URL(import.meta.url), { workerData: { worker: true } });
          const feed = (): void => {
            const job = jobs[next++];
            if (job === undefined) {
              void worker.terminate().then(() => {
                resolve();
              });
              return;
            }
            worker.postMessage(job);
          };
          worker.on('message', (r: GameResult) => {
            results.push(r);
            done++;
            if (done % 50 === 0) console.error(`  ${done}/${jobs.length} games`);
            feed();
          });
          worker.on('error', reject);
          feed();
        }),
    ),
  );
  return results;
}

const data = workerData as { worker?: boolean } | null;
if (!isMainThread && data?.worker === true) {
  parentPort?.on('message', (job: Job) => {
    parentPort?.postMessage(playGame(job));
  });
} else {
  await main();
}
