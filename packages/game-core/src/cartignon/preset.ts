import type { Seat } from '../rules.js';
import { createBoard } from './board.js';
import type { CardCatalog } from './cards.js';
import type { Color } from './colors.js';
import {
  createTokenSupply,
  poolAfterCleanup,
  type CartignonMatchState,
  type MatchEvent,
  type TokenMap,
} from './match.js';
import { roundCatalogIssues, startRound, type RoundEvent } from './round.js';
import { createCardInstances, DEALING_RULES, type CardId, type Zones } from './zones.js';

/**
 * ADR-0018: a match started from a chosen deal instead of a shuffled one (the tutorial). Additive
 * and unused by the server: `startCartignonMatch` and the rules module are unchanged. Consumes no
 * randomness, so the caller's RNG (the snapshot's `rngState`) is exactly as seeded.
 *
 * Cards are named by `defId`; each defId is one physical card (the catalog lists every card
 * once), so it may appear at most once across hands, `deckTop` and `graveyard`. Every card not
 * named goes to the deck below `deckTop`, in catalog order. The round starts in P1's Base step
 * with empty stacks (`startRound`), exactly as a dealt round does.
 */
export interface CartignonMatchPreset {
  readonly p1: Seat;
  /** defIds per seat, at most `DEALING_RULES.handSize` each (RD-77: no deal exceeds 9). */
  readonly hands: readonly [readonly string[], readonly string[]];
  /** Top of the deck first; the remaining cards follow in catalog order. */
  readonly deckTop?: readonly string[];
  readonly graveyard?: readonly string[];
  /** Tokens already held (a match in progress); unlisted colors stay in the supply. */
  readonly tokens?: Partial<Readonly<Record<Color, Seat>>>;
  /** 1-based; default 1. */
  readonly roundNumber?: number;
}

export type PresetErrorCode =
  'INVALID_CATALOG' | 'UNKNOWN_CARD' | 'DUPLICATE_CARD' | 'HAND_TOO_LARGE';

export type PresetResult =
  | {
      readonly ok: true;
      readonly state: CartignonMatchState;
      readonly events: readonly MatchEvent[];
    }
  | { readonly ok: false; readonly code: PresetErrorCode; readonly message: string };

function reject(code: PresetErrorCode, message: string): PresetResult {
  return { ok: false, code, message };
}

/**
 * Starts a match on the preset deal. Rejections: `INVALID_CATALOG` (as `startCartignonMatch`),
 * `HAND_TOO_LARGE` (a hand above `DEALING_RULES.handSize`), `UNKNOWN_CARD` (a defId the catalog
 * does not list), `DUPLICATE_CARD` (a defId named twice). A `roundNumber` below 1 or not an
 * integer is a programmer error and throws.
 */
export function startPresetCartignonMatch(
  catalog: CardCatalog,
  preset: CartignonMatchPreset,
): PresetResult {
  const issues = roundCatalogIssues(catalog);
  if (issues.length > 0) {
    return reject('INVALID_CATALOG', issues.map((i) => i.message).join('; '));
  }
  const roundNumber = preset.roundNumber ?? 1;
  if (!Number.isSafeInteger(roundNumber) || roundNumber < 1) {
    throw new RangeError(`roundNumber must be an integer >= 1, got ${roundNumber}`);
  }
  for (const seat of [0, 1] as const) {
    const size = preset.hands[seat].length;
    if (size > DEALING_RULES.handSize) {
      return reject(
        'HAND_TOO_LARGE',
        `seat ${seat} hand has ${size} cards (max ${DEALING_RULES.handSize})`,
      );
    }
  }

  const idByDef = new Map<string, CardId>();
  for (const instance of createCardInstances(catalog)) {
    if (!idByDef.has(instance.defId)) idByDef.set(instance.defId, instance.id);
  }
  // Order: hand 0, hand 1, deck top, graveyard; the first problem found is reported.
  const groups = [preset.hands[0], preset.hands[1], preset.deckTop ?? [], preset.graveyard ?? []];
  const used = new Set<CardId>();
  const resolved: CardId[][] = [];
  for (const defIds of groups) {
    const out: CardId[] = [];
    for (const defId of defIds) {
      const id = idByDef.get(defId);
      if (id === undefined) return reject('UNKNOWN_CARD', `unknown card ${defId}`);
      if (used.has(id)) return reject('DUPLICATE_CARD', `card ${defId} is named more than once`);
      used.add(id);
      out.push(id);
    }
    resolved.push(out);
  }
  const [hand0 = [], hand1 = [], deckTop = [], graveyard = []] = resolved;

  const rest = [...idByDef.values()].filter((id) => !used.has(id));
  const zones: Zones = {
    deck: [...deckTop, ...rest],
    graveyard,
    hands: [hand0, hand1],
    stacks: [[], []],
  };
  const tokens: TokenMap = { ...createTokenSupply(), ...preset.tokens };
  const started = startRound(createBoard(zones), preset.p1);
  const events: RoundEvent[] = [
    started.events[0] as RoundEvent,
    { type: 'cardsDrawn', seat: 0, reason: 'deal', cardIds: hand0 },
    { type: 'cardsDrawn', seat: 1, reason: 'deal', cardIds: hand1 },
    ...started.events.slice(1),
  ];
  return {
    ok: true,
    state: {
      round: started.state,
      roundNumber,
      tokens,
      finalRound: false,
      replays: 0,
      poolAfterCleanup: poolAfterCleanup(zones),
      roundsWithoutProgress: 0,
      lastOutcome: null,
      status: { kind: 'playing' },
    },
    events,
  };
}
