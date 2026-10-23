import { describe, expect, it } from 'vitest';
import { createSeededRng, type Rng, type Seat } from '../../src/index.js';
import {
  activeSeat,
  applyMatchCommand,
  determinize,
  legalMatchCommands,
  observeForSeat,
  roundCardIds,
  startCartignonMatch,
  UndeterminizableObservationError,
  type CardId,
  type CartignonMatchState,
} from '../../src/cartignon/index.js';
import { realCatalog } from './self-play.js';

/**
 * ADR-0016 AI-M1: `observeForSeat` leaks no hidden card and is canonical; `determinize` gives a
 * complete, consistent match. States come from real seeded self-play (random policy with a play
 * cap per turn, so Grave Draw loops cannot stall it).
 */

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
 * Re-deals the cards hidden from `viewer` (`unknown`: opponent hand, deck, opponent's looked-at
 * cards, minus publicly located ones) over their slots in a random order; publicly located cards
 * keep their slot. The result may be inconsistent with the opponent's pending choice; only the
 * observation is compared.
 */
function permuteHidden(match: CartignonMatchState, viewer: Seat, rng: Rng): CartignonMatchState {
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

/** Visits every state of a seeded match (random legal commands, at most 8 plays per turn). */
function visitMatch(seed: number, visit: (match: CartignonMatchState) => void): void {
  const { catalog, ctx } = realCatalog();
  const engineRng = createSeededRng(seed);
  const botRng = createSeededRng(seed + 1_000_003);
  const started = startCartignonMatch(catalog, engineRng);
  if (!started.ok) throw new Error(started.message);
  let match = started.state;
  let turnKey = '';
  let plays = 0;
  for (let step = 0; step < 5_000 && match.status.kind === 'playing'; step++) {
    visit(match);
    const seat = activeSeat(match.round);
    if (seat === null) throw new Error('no active seat');
    const key = `${match.roundNumber}:${match.round.turnNumber}`;
    if (key !== turnKey) {
      turnKey = key;
      plays = 0;
    }
    const legal = legalMatchCommands(ctx, match, seat);
    const calm = legal.filter((c) => c.type === 'endTurn' || c.type === 'chooseSpellOption');
    const options = plays >= 8 && calm.length > 0 ? calm : legal;
    const command = options[botRng.nextInt(options.length)];
    if (command === undefined) throw new Error('no legal command');
    if (command.type !== 'endTurn' && command.type !== 'chooseSpellOption') plays++;
    const result = applyMatchCommand(ctx, match, seat, command, engineRng);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    match = result.state;
  }
  visit(match);
}

const SEEDS = 25;
/** The full self-play sweeps take about 2 s on an idle machine; allow for a loaded one. */
const SWEEP_TIMEOUT_MS = 30_000;

describe('observeForSeat (ADR-0016 AI-M1)', () => {
  it(
    'never contains a card id hidden from the seat, in any self-play state',
    () => {
      let checked = 0;
      for (let seed = 1; seed <= SEEDS; seed++) {
        visitMatch(seed, (match) => {
          for (const seat of [0, 1] as const) {
            const obs = observeForSeat(match, seat);
            const json = JSON.stringify(obs.match) + JSON.stringify(obs.opponentChoice);
            for (const id of obs.unknown) expect(json.includes(`"${id}"`), id).toBe(false);
            checked++;
          }
        });
      }
      expect(checked).toBeGreaterThan(1_000);
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    'is invariant under permutations of the hidden cards at every step',
    () => {
      const rng = createSeededRng(4242);
      let checked = 0;
      for (let seed = 1; seed <= SEEDS; seed++) {
        visitMatch(seed, (match) => {
          for (const seat of [0, 1] as const) {
            const obs = observeForSeat(match, seat);
            for (let k = 0; k < 2; k++) {
              expect(observeForSeat(permuteHidden(match, seat, rng), seat)).toEqual(obs);
            }
            checked++;
          }
        });
      }
      expect(checked).toBeGreaterThan(1_000);
    },
    SWEEP_TIMEOUT_MS,
  );

  it('keeps the own hand, sizes and the unknown pool consistent', () => {
    visitMatch(3, (match) => {
      for (const seat of [0, 1] as const) {
        const opp: Seat = seat === 0 ? 1 : 0;
        const obs = observeForSeat(match, seat);
        const zones = match.round.board.zones;
        expect(obs.match.round.board.zones.hands[seat]).toEqual(zones.hands[seat]);
        expect(obs.match.round.board.zones.hands[opp]).toEqual([]);
        expect(obs.match.round.board.zones.deck).toEqual([]);
        expect(obs.hidden.opponentHand).toBe(zones.hands[opp].length);
        expect(obs.hidden.deck).toBe(zones.deck.length);
        expect(obs.unknown.length + obs.known.opponentHand.length + obs.known.deck.length).toBe(
          obs.hidden.opponentHand + obs.hidden.deck + obs.hidden.opponentLookingAt,
        );
      }
    });
  });
});

describe('determinize (ADR-0016 AI-M1)', () => {
  it('samples a complete match with the same observation at every determinizable step', () => {
    const rng = createSeededRng(99);
    const { catalog, ctx } = realCatalog();
    let sampled = 0;
    for (let seed = 1; seed <= 10; seed++) {
      visitMatch(seed, (match) => {
        const seat = activeSeat(match.round) ?? 0;
        const obs = observeForSeat(match, seat);
        const full = determinize(obs, rng);
        expect(observeForSeat(full, seat)).toEqual(obs);
        const ids = roundCardIds(full.round);
        expect(new Set(ids).size).toBe(catalog.length);
        expect(ids.length).toBe(catalog.length);
        // The acting seat's legal commands do not depend on the sample.
        expect(legalMatchCommands(ctx, full, seat)).toEqual(legalMatchCommands(ctx, match, seat));
        sampled++;
      });
    }
    expect(sampled).toBeGreaterThan(500);
  });

  it("refuses an observation taken during the opponent's pending choice", () => {
    let refused = 0;
    for (let seed = 1; seed <= SEEDS && refused === 0; seed++) {
      visitMatch(seed, (match) => {
        const pending = match.round.pendingChoice;
        if (pending === undefined) return;
        const viewer: Seat = pending.seat === 0 ? 1 : 0;
        const obs = observeForSeat(match, viewer);
        expect(obs.opponentChoice).not.toBeNull();
        expect(obs.match.round.pendingChoice).toBeUndefined();
        expect(() => determinize(obs, createSeededRng(1))).toThrow(
          UndeterminizableObservationError,
        );
        refused++;
      });
    }
    expect(refused).toBeGreaterThan(0);
  });
});
