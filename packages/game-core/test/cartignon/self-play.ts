import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSeededRng, type Rng, type Seat } from '../../src/index.js';
import {
  activeSeat,
  applyMatchCommand,
  canStillReachCreature,
  createRoundContext,
  isValidSelection,
  legalMatchCommands,
  loadBuiltCatalog,
  MAX_LISTED_SELECTIONS,
  NO_PROGRESS_ROUND_LIMIT,
  roundCardIds,
  startCartignonMatch,
  type CardCatalog,
  type CardId,
  type CartignonMatchState,
  type MatchEndReason,
  type RoundCommand,
  type RoundContext,
} from '../../src/cartignon/index.js';

/**
 * R5b self-play driver (test tooling only). Plays whole matches with the REAL card catalog
 * (`data/cards.json`, generated from docs/cards/*.csv) and seeded bot policies, to measure how
 * matches end (RD-24, RD-81, RD-84, RD-89/RD-90).
 *
 * Two independent seeded PRNGs: one is handed to the engine (deck shuffles etc.), one drives the
 * bot's decisions, so a policy change never perturbs the engine's random stream semantics.
 *
 * `disableNoProgress`: the RD-89 rule cannot be switched off without editing src, but the engine
 * reads `match.roundsWithoutProgress` from the (plain data) state it is given. Resetting that
 * field to 0 before every command keeps the engine counter below `NO_PROGRESS_ROUND_LIMIT`, so
 * `noProgress` never fires; every other rule runs unchanged. The driver keeps its own shadow
 * counter (same formula as `finishRound`) to report how long the stalls would have lasted.
 */

export type PolicyName = 'random' | 'eager';

export interface SelfPlayOptions {
  readonly seed: number;
  readonly policy: PolicyName;
  /** Hard cap on applied commands (true infinite-loop detection). */
  readonly maxSteps?: number;
  /** Hard cap on rounds (only reachable with `disableNoProgress`). */
  readonly maxRounds?: number;
  readonly disableNoProgress?: boolean;
  /** Check the 54-card conservation invariant after every step (slower). */
  readonly checkInvariants?: boolean;
  /**
   * `eager` only: plays allowed per turn before it stops preferring plays (default 30). Without a
   * budget two Grave Draw spells can be swapped through the graveyard forever within one turn
   * (play A -> draw B from the graveyard -> A lands there -> play B -> draw A ...): nothing in the
   * rules bounds plays per turn (RD-13, RD-83); only the turn clock (RD-25) does.
   */
  readonly eagerPlayBudget?: number;
  /** Keep the last N applied commands (with context) in `trace`, for diagnosing a seed. */
  readonly traceTail?: number;
}

export interface TraceEntry {
  readonly step: number;
  readonly roundNumber: number;
  readonly turnNumber: number;
  readonly phase: string;
  readonly seat: Seat;
  readonly command: RoundCommand;
  /** Size of the legal list the command was picked from. */
  readonly legalCount: number;
  readonly spellId?: string;
  readonly hands: readonly [number, number];
  readonly deck: number;
  readonly graveyard: number;
}

export type SelfPlayEnd = MatchEndReason | 'stepCap' | 'roundCap';

export interface SelfPlayResult {
  readonly seed: number;
  readonly policy: PolicyName;
  readonly end: SelfPlayEnd;
  readonly winner: Seat | null;
  readonly tokenCounts: readonly [number, number];
  /** Rounds finished (resolved), replays included. */
  readonly rounds: number;
  readonly steps: number;
  /** How many times the no-progress counter (engine or shadow) reached exactly k after a round. */
  readonly noProgressReached: Readonly<Record<1 | 2 | 3, number>>;
  /** Longest run of consecutive no-progress rounds. */
  readonly maxNoProgressStreak: number;
  /** All RD-76 re-deals. */
  readonly redeals: number;
  /** RD-76 re-deals with no creature in deck + hands that went ahead under RD-84. */
  readonly rd84Redeals: number;
  /** Rounds drawn (p1NoBase / tieBreakDeckOut). */
  readonly drawnRounds: number;
  /** Most commands applied within one turn (choices included). */
  readonly maxTurnSteps: number;
  readonly trace: readonly TraceEntry[];
}

/** A command the engine rejected although the driver took it from the legal list. */
export class IllegalLegalCommandError extends Error {
  readonly command: RoundCommand;
  readonly code: string;

  constructor(
    where: { readonly seed: number; readonly policy: PolicyName; readonly step: number },
    seat: Seat,
    command: RoundCommand,
    code: string,
    detail: string,
  ) {
    super(
      `seed ${where.seed} policy ${where.policy} step ${where.step}: engine rejected legal ` +
        `command ${JSON.stringify(command)} for seat ${seat}: ${code} ${detail}`,
    );
    this.command = command;
    this.code = code;
  }
}

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

let cached: { readonly catalog: CardCatalog; readonly ctx: RoundContext } | undefined;

/** The real catalog, loaded as catalog.test.ts does (`data/cards.json` -> `loadCatalog`). */
export function realCatalog(): { readonly catalog: CardCatalog; readonly ctx: RoundContext } {
  if (cached !== undefined) return cached;
  const catalog = loadBuiltCatalog(JSON.parse(read('../../data/cards.json')) as unknown);
  cached = { catalog, ctx: createRoundContext(catalog) };
  return cached;
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick from an empty list');
  return items[rng.nextInt(items.length)] as T;
}

/** A uniformly random size, then a uniformly random subset of that size (always valid). */
function randomSelection(
  rng: Rng,
  choice: { readonly options: readonly CardId[]; readonly min: number; readonly max: number },
): CardId[] {
  const top = Math.min(choice.max, choice.options.length);
  const size = choice.min + rng.nextInt(top - choice.min + 1);
  const pool = [...choice.options];
  const out: CardId[] = [];
  while (out.length < size) out.push(pool.splice(rng.nextInt(pool.length), 1)[0] as CardId);
  return out;
}

const PLAY_TYPES: ReadonlySet<RoundCommand['type']> = new Set([
  'playCreature',
  'nullify',
  'playSpell',
]);

function choose(
  policy: PolicyName,
  rng: Rng,
  match: CartignonMatchState,
  legal: readonly RoundCommand[],
  playBudgetLeft: boolean,
): RoundCommand {
  const pending = match.round.pendingChoice;
  if (pending !== undefined) {
    // The listing is a bounded prefix (MAX_LISTED_SELECTIONS); sample beyond it half the time.
    if (legal.length >= MAX_LISTED_SELECTIONS && rng.nextInt(2) === 0) {
      const selection = randomSelection(rng, pending);
      if (!isValidSelection(pending, selection)) throw new Error('driver bug: invalid selection');
      return { type: 'chooseSpellOption', choiceId: pending.choiceId, selection };
    }
    return pick(rng, legal);
  }
  if (policy === 'eager') {
    const plays = legal.filter((c) => PLAY_TYPES.has(c.type));
    if (plays.length > 0 && playBudgetLeft) return pick(rng, plays);
    if (!playBudgetLeft) {
      const rest = legal.filter((c) => !PLAY_TYPES.has(c.type));
      if (rest.length > 0) return pick(rng, rest);
    }
  }
  return pick(rng, legal);
}

function checkConservation(match: CartignonMatchState, total: number): void {
  const ids = roundCardIds(match.round);
  if (ids.length !== total || new Set(ids).size !== total) {
    throw new Error(`card conservation broken: ${ids.length} ids, ${new Set(ids).size} distinct`);
  }
}

export function playMatch(options: SelfPlayOptions): SelfPlayResult {
  const { seed, policy } = options;
  const maxSteps = options.maxSteps ?? 50_000;
  const maxRounds = options.maxRounds ?? Number.POSITIVE_INFINITY;
  const { catalog, ctx } = realCatalog();
  // Distinct, deterministic streams for the engine and the bot.
  const engineRng = createSeededRng(seed);
  const botRng = createSeededRng((seed ^ 0x9e3779b9) >>> 0);

  const started = startCartignonMatch(catalog, engineRng);
  if (!started.ok) throw new Error(`match did not start: ${started.code} ${started.message}`);
  let match = started.state;
  const total = catalog.length;

  let steps = 0;
  let rounds = 0;
  let shadowStreak = 0;
  let maxStreak = 0;
  let redeals = 0;
  let rd84Redeals = 0;
  let drawnRounds = 0;
  const reached: Record<1 | 2 | 3, number> = { 1: 0, 2: 0, 3: 0 };
  const traceTail = options.traceTail ?? 0;
  const trace: TraceEntry[] = [];
  const eagerPlayBudget = options.eagerPlayBudget ?? 30;
  let currentTurn = '';
  let turnSteps = 0;
  let turnPlays = 0;
  let maxTurnSteps = 0;

  while (match.status.kind === 'playing') {
    if (steps >= maxSteps) return finish('stepCap');
    if (rounds >= maxRounds) return finish('roundCap');
    const seat = activeSeat(match.round);
    if (seat === null) throw new Error(`seed ${seed}: playing match with no active seat`);
    const legal = legalMatchCommands(ctx, match, seat);
    if (legal.length === 0) throw new Error(`seed ${seed} step ${steps}: no legal command`);
    const turnKey = `${match.roundNumber}:${match.round.turnNumber}:${match.round.phase.kind}`;
    if (turnKey !== currentTurn) {
      currentTurn = turnKey;
      turnSteps = 0;
      turnPlays = 0;
    }
    const command = choose(policy, botRng, match, legal, turnPlays < eagerPlayBudget);
    turnSteps++;
    if (PLAY_TYPES.has(command.type)) turnPlays++;
    maxTurnSteps = Math.max(maxTurnSteps, turnSteps);
    const input: CartignonMatchState = options.disableNoProgress
      ? { ...match, roundsWithoutProgress: 0 }
      : match;
    const poolBefore = match.poolAfterCleanup;
    if (traceTail > 0) {
      const z = match.round.board.zones;
      const cardId = 'cardId' in command ? command.cardId : undefined;
      const def = cardId === undefined ? undefined : ctx.cards[cardId];
      trace.push({
        step: steps + 1,
        roundNumber: match.roundNumber,
        turnNumber: match.round.turnNumber,
        phase: match.round.phase.kind,
        seat,
        command,
        legalCount: legal.length,
        ...(def?.kind === 'spell' ? { spellId: def.defId } : {}),
        hands: [z.hands[0].length, z.hands[1].length],
        deck: z.deck.length,
        graveyard: z.graveyard.length,
      });
      if (trace.length > traceTail) trace.shift();
    }
    const result = applyMatchCommand(ctx, input, seat, command, engineRng);
    steps++;
    if (!result.ok) {
      throw new IllegalLegalCommandError(
        { seed, policy, step: steps },
        seat,
        command,
        result.code,
        result.message,
      );
    }
    match = result.state;
    for (const event of result.events) {
      if (event.type === 'roundResolved') {
        rounds++;
        if (event.outcome.kind === 'draw') drawnRounds++;
      }
      if (event.type === 'handsRedealt') {
        redeals++;
        // RD-84: the re-deal happened although deck + hands held no creature.
        const z = match.round.board.zones;
        const pool = [...z.deck, ...z.hands[0], ...z.hands[1]];
        if (!pool.some((id) => ctx.cards[id]?.kind === 'creature')) {
          if (!canStillReachCreature(ctx, z)) {
            throw new Error(`seed ${seed}: RD-84 re-deal without a graveyard-draw spell`);
          }
          rd84Redeals++;
        }
      }
    }
    if (result.events.some((e) => e.type === 'roundResolved')) {
      shadowStreak = match.poolAfterCleanup < poolBefore ? 0 : shadowStreak + 1;
      if (!options.disableNoProgress && shadowStreak !== match.roundsWithoutProgress) {
        throw new Error(`seed ${seed}: shadow no-progress counter diverged from the engine`);
      }
      maxStreak = Math.max(maxStreak, shadowStreak);
      if (shadowStreak >= 1 && shadowStreak <= 3) reached[shadowStreak as 1 | 2 | 3]++;
    }
    if (options.checkInvariants === true) checkConservation(match, total);
  }
  const status = match.status;
  return finish(status.reason, status.winner, status.tokenCounts);

  function finish(
    end: SelfPlayEnd,
    winner: Seat | null = null,
    tokenCounts: readonly [number, number] = [0, 0],
  ): SelfPlayResult {
    return {
      seed,
      policy,
      end,
      winner,
      tokenCounts,
      rounds,
      steps,
      noProgressReached: reached,
      maxNoProgressStreak: maxStreak,
      redeals,
      rd84Redeals,
      drawnRounds,
      maxTurnSteps,
      trace,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Statistics

export interface SelfPlayStats {
  readonly matches: number;
  readonly ends: Readonly<Record<string, number>>;
  readonly roundsPct: Readonly<Record<'p50' | 'p90' | 'p99' | 'max', number>>;
  readonly stepsPct: Readonly<Record<'p50' | 'p90' | 'p99' | 'max', number>>;
  /** Matches in which the no-progress counter reached at least k. */
  readonly matchesReaching: Readonly<Record<1 | 2 | 3, number>>;
  /** Total times the counter reached exactly k (across all matches). */
  readonly timesReached: Readonly<Record<1 | 2 | 3, number>>;
  readonly maxStreak: number;
  readonly redeals: number;
  readonly matchesWithRedeal: number;
  readonly rd84Redeals: number;
  readonly matchesWithRd84Redeal: number;
  readonly drawnRounds: number;
  /** Per-match longest turn (commands), as percentiles over matches. */
  readonly maxTurnStepsPct: Readonly<Record<'p50' | 'p90' | 'p99' | 'max', number>>;
}

function percentiles(values: readonly number[]): Record<'p50' | 'p90' | 'p99' | 'max', number> {
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  return { p50: at(0.5), p90: at(0.9), p99: at(0.99), max: s.at(-1) ?? 0 };
}

export function summarize(results: readonly SelfPlayResult[]): SelfPlayStats {
  const ends: Record<string, number> = {};
  for (const r of results) ends[r.end] = (ends[r.end] ?? 0) + 1;
  const count = (f: (r: SelfPlayResult) => boolean): number => results.filter(f).length;
  const sum = (f: (r: SelfPlayResult) => number): number =>
    results.reduce((acc, r) => acc + f(r), 0);
  return {
    matches: results.length,
    ends,
    roundsPct: percentiles(results.map((r) => r.rounds)),
    stepsPct: percentiles(results.map((r) => r.steps)),
    matchesReaching: {
      1: count((r) => r.maxNoProgressStreak >= 1),
      2: count((r) => r.maxNoProgressStreak >= 2),
      3: count((r) => r.maxNoProgressStreak >= NO_PROGRESS_ROUND_LIMIT),
    },
    timesReached: {
      1: sum((r) => r.noProgressReached[1]),
      2: sum((r) => r.noProgressReached[2]),
      3: sum((r) => r.noProgressReached[3]),
    },
    maxStreak: Math.max(0, ...results.map((r) => r.maxNoProgressStreak)),
    redeals: sum((r) => r.redeals),
    matchesWithRedeal: count((r) => r.redeals > 0),
    rd84Redeals: sum((r) => r.rd84Redeals),
    matchesWithRd84Redeal: count((r) => r.rd84Redeals > 0),
    drawnRounds: sum((r) => r.drawnRounds),
    maxTurnStepsPct: percentiles(results.map((r) => r.maxTurnSteps)),
  };
}
