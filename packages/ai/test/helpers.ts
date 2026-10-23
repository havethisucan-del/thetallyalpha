import { createRequire } from 'node:module';
import {
  activeSeat,
  applyMatchCommand,
  createRoundContext,
  createSeededRng,
  loadBuiltCatalog,
  observeForSeat,
  startCartignonMatch,
  type CardCatalog,
  type CardId,
  type CartignonMatchState,
  type RoundContext,
  type Rng,
  type Seat,
} from '@cartignon/game-core';
import { createBot } from '../src/index.js';

let cached: { readonly catalog: CardCatalog; readonly ctx: RoundContext } | undefined;

/** The real card catalog (`@cartignon/game-core/cards.json`). */
export function realCatalog(): { readonly catalog: CardCatalog; readonly ctx: RoundContext } {
  if (cached !== undefined) return cached;
  const require = createRequire(import.meta.url);
  const catalog = loadBuiltCatalog(require('@cartignon/game-core/cards.json') as unknown);
  cached = { catalog, ctx: createRoundContext(catalog) };
  return cached;
}

/** Every non-final state of a seeded L1-vs-L1 match (cheap, varied, real rules). */
export function sampleStates(seed: number, maxSteps = 2_000): CartignonMatchState[] {
  const { catalog, ctx } = realCatalog();
  const engineRng = createSeededRng(seed);
  const botRngs = [createSeededRng(seed + 101), createSeededRng(seed + 202)] as const;
  const bots = [createBot(1, ctx), createBot(1, ctx)] as const;
  const started = startCartignonMatch(catalog, engineRng);
  if (!started.ok) throw new Error(started.message);
  let match = started.state;
  const states: CartignonMatchState[] = [];
  for (let step = 0; step < maxSteps && match.status.kind === 'playing'; step++) {
    states.push(match);
    const seat = activeSeat(match.round);
    if (seat === null) throw new Error('no active seat');
    const command = bots[seat].chooseCommand(observeForSeat(match, seat), botRngs[seat]);
    const result = applyMatchCommand(ctx, match, seat, command, engineRng);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    match = result.state;
  }
  return states;
}

function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

/**
 * The same match with the cards hidden from `viewer` (opponent hand, deck, opponent's looked-at
 * cards, minus publicly located ones) re-dealt over their slots in a random order.
 */
export function permuteHidden(
  match: CartignonMatchState,
  viewer: Seat,
  rng: Rng,
): CartignonMatchState {
  const opp: Seat = viewer === 0 ? 1 : 0;
  const board = match.round.board;
  const zones = board.zones;
  const hidden = new Set(observeForSeat(match, viewer).unknown);
  const looking = board.lookingAt?.seat === opp ? board.lookingAt.cardIds : [];
  const slots = [...zones.hands[opp], ...zones.deck, ...looking];
  const refill = shuffled(
    slots.filter((id) => hidden.has(id)),
    rng,
  );
  const pool = slots.map((id) => (hidden.has(id) ? (refill.shift() as CardId) : id));
  const hand = pool.splice(0, zones.hands[opp].length);
  const deck = pool.splice(0, zones.deck.length);
  const hands: readonly [readonly CardId[], readonly CardId[]] =
    opp === 0 ? [hand, zones.hands[1]] : [zones.hands[0], hand];
  return {
    ...match,
    round: {
      ...match.round,
      board: {
        ...board,
        zones: { ...zones, hands, deck },
        ...(looking.length > 0 ? { lookingAt: { seat: opp, cardIds: pool } } : {}),
      },
    },
  };
}
