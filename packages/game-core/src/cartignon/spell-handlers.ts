import type { Seat } from '../rules.js';
import { activeModifierOf, stackAtk, type Board, type CardIndex } from './board.js';
import type { JsonValue, SpellChoiceRequest } from './choices.js';
// Best-effort mode (R4c-5, RD-161): through S-19 a Primary runs without its condition, so every
// handler's "unreachable after `feasible`" branch does as much as it can (documented per handler).
import type { SpellKernel } from './kernel.js';
import type { CardId } from './zones.js';

/**
 * Spell handler registry (ADR-0007 sections 2-3, R4c-1). One entry per spell `defId` of
 * `data/cards.json`; a drift test keeps the two in sync. A supported entry has a TypeScript
 * handler (`feasible` + `primary`); the Secondary is data (`SpellDef.secondary`) and is run by
 * spells.ts. Spells of later milestones are registered as `notYetSupported`: `createRoundContext`
 * accepts them, but playing one is rejected with `SPELL_NOT_SUPPORTED` and `legalCommands` never
 * offers it.
 *
 * Handlers read the board and act only through the kernel; they never see the RNG.
 */

/** What `feasible` may look at. `board` has the spell in resolution (not in hand, RD-116). */
export interface SpellView {
  readonly cards: CardIndex;
  readonly board: Board;
  readonly caster: Seat;
  readonly opponent: Seat;
  /**
   * The caster's replay-locked cards (`RoundState.turnLocks`, S-09). RD-145 (Proposed): a spell
   * never places a locked card either, so they are not placement candidates.
   */
  readonly locked: readonly CardId[];
}

export interface SpellHandler {
  /**
   * RD-14 / RD-119: the printed condition combined with the structural requirements of the
   * Primary. False -> the Secondary runs instead.
   */
  readonly feasible: (view: SpellView) => boolean;
  /**
   * The Primary (ADR-0007 `run`), through kernel primitives only. Runs only when `feasible` was
   * true. Returns undefined when done, or a `SpellChoiceRequest` to yield a choice (R4c-2); the
   * spell layer then calls `resume` with the answer (automatically for a single legal answer).
   * A handler never yields a choice it cannot answer: with too few options it skips that step
   * (best effort, documented per handler).
   */
  readonly primary: (kernel: SpellKernel) => SpellChoiceRequest | undefined;
  /**
   * Continues the Primary after a choice: `step` and `scratch` are the yielded continuation
   * (JSON data only), `selection` a validated answer. May finish or yield again (chaining).
   */
  readonly resume?: (
    kernel: SpellKernel,
    step: string,
    scratch: JsonValue,
    selection: readonly CardId[],
  ) => SpellChoiceRequest | undefined;
}

/**
 * The milestone a `notYetSupported` spell belongs to. Since R4c-5 every spell of the catalog is
 * supported; the variant stays for catalogs that add spells ahead of their handlers.
 */
export type SpellMilestone = string;

export type SpellRegistryEntry =
  | {
      readonly status: 'supported';
      readonly handler: SpellHandler;
      /** RD-84: the Primary can draw from the graveyard. */
      readonly primaryDrawsFromGraveyard: boolean;
    }
  | {
      readonly status: 'notYetSupported';
      readonly milestone: SpellMilestone;
      readonly primaryDrawsFromGraveyard: boolean;
    };

// ---------------------------------------------------------------------------------------------
// RD-116 counting helpers: "on the field" / "played creatures" = creatures currently on stacks,
// Base included; hand sizes are taken from a board where the spell has already left the hand.

export function creatureCount(board: Board, seat: Seat): number {
  return board.zones.stacks[seat].length;
}

export function fieldCreatureCount(board: Board): number {
  return creatureCount(board, 0) + creatureCount(board, 1);
}

export function handSize(board: Board, seat: Seat): number {
  return board.zones.hands[seat].length;
}

export function leadingCreature(board: Board, seat: Seat): CardId | undefined {
  return board.zones.stacks[seat].at(-1);
}

/** Creatures (by instance id) on `seat`'s stack whose level satisfies `test`, bottom to top. */
function stackCreaturesWhere(
  view: Pick<SpellView, 'cards' | 'board'>,
  seat: Seat,
  test: (level: number) => boolean,
): CardId[] {
  return view.board.zones.stacks[seat].filter((id) => {
    const def = view.cards[id];
    return def?.kind === 'creature' && test(def.level);
  });
}

// ---------------------------------------------------------------------------------------------
// R4c-1 handlers (ADR-0007 mapping table).

/** RD-102: d = opponent's hand - caster's hand. */
function handDifference(view: SpellView): number {
  return handSize(view.board, view.opponent) - handSize(view.board, view.caster);
}

/**
 * S-02 (RD-102): d >= 1 -> draw 2 (d >= 2) or 1 from the graveyard; the opponent draws 1.
 * Best-effort (RD-161): with d <= 0 neither draw clause applies, so only the opponent draws.
 */
const S02: SpellHandler = {
  feasible: (v) => handDifference(v) >= 1,
  primary: (k) => {
    const d = handDifference(k);
    const count = d >= 2 ? 2 : d === 1 ? 1 : 0;
    if (count > 0) k.draw(k.caster, 'graveyard', count);
    k.draw(k.opponent, 'deck', 1);
  },
};

/** S-03's ATK penalty on the caster's Leading creature after the swap (spell data, RD-100). */
export const S03_ATK_PENALTY = 100;

/** S-03 (RD-107): equal creature counts, at least 3 each -> swap stacks; -100 on the caster. */
const S03: SpellHandler = {
  feasible: (v) => {
    const own = creatureCount(v.board, v.caster);
    return own >= 3 && own === creatureCount(v.board, v.opponent);
  },
  primary: (k) => {
    k.swapStacks();
    const leader = leadingCreature(k.board, k.caster);
    if (leader !== undefined) k.attachAtk(leader, -S03_ATK_PENALTY);
  },
};

/**
 * S-04 (RD-132): exactly 3 creatures on the field -> all of them return at once to their owners'
 * hands (RD-104; owner = the seat whose stack it is on, RD-135); nothing activates in between.
 * Only the Primary ends the turn (RD-121).
 */
const S04: SpellHandler = {
  feasible: (v) => fieldCreatureCount(v.board) === 3,
  primary: (k) => {
    // Best-effort (RD-161): every creature on the field returns (any count), the turn ends.
    const { stacks } = k.board.zones;
    const all = [...stacks[k.caster], ...stacks[k.opponent]];
    if (all.length > 0) k.removeFromStacks(all, 'ownerHand');
    k.requestEndTurn();
  },
};

/**
 * S-06 (RD-111, RD-133): the opponent's Leading creature has an active modifier (live per RD-53
 * and not negated by S-12, RD-109,
 * also a one-shot kind that already fired) and the caster has a Leading creature -> a copy
 * activates at once for the caster (kernel `fireCopiedModifier`).
 */
const S06: SpellHandler = {
  feasible: (v) =>
    activeModifierOf(v.cards, v.board, v.opponent) !== null &&
    leadingCreature(v.board, v.caster) !== undefined,
  primary: (k) => {
    const live = activeModifierOf(k.cards, k.board, k.opponent);
    if (live !== null) k.fireCopiedModifier(live.kind, live.cardId);
  },
};

/** S-08 (RD-60): the opponent has >= 4 creatures -> their Leading creature dies (graveyard). */
const S08: SpellHandler = {
  feasible: (v) => creatureCount(v.board, v.opponent) >= 4,
  primary: (k) => {
    const leader = leadingCreature(k.board, k.opponent);
    if (leader !== undefined) k.removeFromStacks([leader], 'graveyard');
  },
};

/** S-14 (RD-113): the opponent's stack has >= 2 cards -> position 1 dies; the rest shift down. */
const S14: SpellHandler = {
  feasible: (v) => creatureCount(v.board, v.opponent) >= 2,
  primary: (k) => {
    const first = k.board.zones.stacks[k.opponent][1];
    if (first !== undefined) k.removeFromStacks([first], 'graveyard');
  },
};

/** S-15's threshold and stack ATK change (spell data, RD-100). */
export const S15_THRESHOLD = 125;
export const S15_STACK_PENALTY = 50;

/**
 * S-15: the opponent's stack ATK exceeds the caster's by >= 125 -> -50 on the opponent's whole
 * stack until round end, independent of the Leading creature (confirmed by the user 2026-10-19).
 */
const S15: SpellHandler = {
  feasible: (v) =>
    stackAtk(v.cards, v.board, v.opponent) - stackAtk(v.cards, v.board, v.caster) >= S15_THRESHOLD,
  primary: (k) => {
    k.addStackAtk(k.opponent, -S15_STACK_PENALTY);
  },
};

// ---------------------------------------------------------------------------------------------
// R4c-2 handlers: spells with a mid-resolution choice.

/** S-01's look-at count and kept count (spell data, RD-114). */
export const S01_LOOK_COUNT = 2;
export const S01_KEEP_COUNT = 1;

/**
 * S-01 (RD-114, RD-116): a level-3 creature on the field (either side) -> look at the top 2 deck
 * cards (hidden "looking at" area, not the hand); the caster keeps 1 (hidden choice `keepDrawn`),
 * the other goes back into the deck, which is shuffled. Deck with 1 card -> that card is kept
 * automatically (single legal answer); empty deck -> nothing happens (RD-48 / RD-93), no choice.
 */
const S01: SpellHandler = {
  feasible: (v) =>
    stackCreaturesWhere(v, v.caster, (l) => l === 3).length +
      stackCreaturesWhere(v, v.opponent, (l) => l === 3).length >
    0,
  primary: (k) => {
    const looked = k.lookAtDeck(S01_LOOK_COUNT);
    if (looked.length === 0) return undefined; // Zero options: the step is skipped.
    const keep = Math.min(S01_KEEP_COUNT, looked.length);
    return {
      kind: 'keepDrawn',
      options: looked,
      min: keep,
      max: keep,
      step: 'keep',
      scratch: null,
    };
  },
  resume: (k, _step, _scratch, selection) => {
    k.settleLookedAt(selection);
    return undefined;
  },
};

/**
 * The caster's hand creatures a spell may place (hand order, RD-141), optionally filtered by
 * level. RD-145 (Proposed): replay-locked cards (S-09) are never candidates.
 */
function placeableHandCreatures(
  view: SpellView,
  test: (level: number) => boolean = () => true,
): CardId[] {
  return view.board.zones.hands[view.caster].filter((id) => {
    const def = view.cards[id];
    return def?.kind === 'creature' && !view.locked.includes(id) && test(def.level);
  });
}

/** The level of the caster's Leading creature, or undefined without one. */
function leaderLevel(view: SpellView): number | undefined {
  const leader = leadingCreature(view.board, view.caster);
  const def = leader === undefined ? undefined : view.cards[leader];
  return def?.kind === 'creature' ? def.level : undefined;
}

/** S-10 candidates: caster's hand creatures with the level of the caster's Leading creature. */
function kindredCandidates(view: SpellView): CardId[] {
  const level = leaderLevel(view);
  if (level === undefined) return [];
  return placeableHandCreatures(view, (l) => l === level);
}

/**
 * S-10 (RD-117, RD-116): the caster has a Leading creature and a hand creature of the same level
 * (the spell is already out of the hand) -> the caster chooses one (automatic with a single
 * candidate, `handCreature`) and it is placed on the caster's stack as a normal placement: its
 * modifier activates and an armed Link Up is used up (RD-10 / RD-108).
 */
const S10: SpellHandler = {
  feasible: (v) => kindredCandidates(v).length > 0,
  primary: (k) => {
    const options = kindredCandidates(k);
    if (options.length === 0) return undefined; // Unreachable after `feasible`; skip.
    return { kind: 'handCreature', options, min: 1, max: 1, step: 'place', scratch: null };
  },
  resume: (k, _step, _scratch, selection) => {
    for (const cardId of selection) k.placeOnStack(cardId);
    return undefined;
  },
};

/** S-11's target levels (spell data, RD-118). */
export const S11_MAX_LEVEL = 3;

/**
 * S-11 (RD-118, RD-105, RD-121): the opponent has a level 1-3 creature on its stack (Base
 * included) -> the caster chooses one (`enemyCreature`, automatic with a single candidate); it
 * returns to its owner's hand (RD-104 / RD-135), the cards above shift down (a removed Base makes
 * position 1 the new Base), and the caster's turn ends.
 */
const S11: SpellHandler = {
  feasible: (v) => stackCreaturesWhere(v, v.opponent, (l) => l <= S11_MAX_LEVEL).length > 0,
  primary: (k) => {
    const options = stackCreaturesWhere(k, k.opponent, (l) => l <= S11_MAX_LEVEL);
    if (options.length === 0) {
      // Unreachable after `feasible`. Best-effort (RD-161): nothing to return, the turn ends.
      k.requestEndTurn();
      return undefined;
    }
    return { kind: 'enemyCreature', options, min: 1, max: 1, step: 'repel', scratch: null };
  },
  resume: (k, _step, _scratch, selection) => {
    k.removeFromStacks(selection, 'ownerHand');
    k.requestEndTurn();
    return undefined;
  },
};

// ---------------------------------------------------------------------------------------------
// R4c-3 handlers: placement, replacement and control (ADR-0007 section 3).

/** S-05's trigger level on the opponent's side (spell data). */
export const S05_TRIGGER_LEVEL = 5;

/**
 * S-05 (RD-117, RD-108): the opponent has a level-5 creature on its stack and the caster has a
 * (non-locked) hand creature -> the caster chooses one (`handCreature`, automatic with a single
 * candidate) and it is linked onto the caster's stack ignoring the level, as a normal placement
 * (modifier activates, armed Link Up used up). No creature of the caster's on the field -> it
 * becomes the caster's Base (RD-117 / RD-106).
 */
const S05: SpellHandler = {
  feasible: (v) =>
    stackCreaturesWhere(v, v.opponent, (l) => l === S05_TRIGGER_LEVEL).length > 0 &&
    placeableHandCreatures(v).length > 0,
  primary: (k) => {
    const options = placeableHandCreatures(k);
    if (options.length === 0) return undefined; // Unreachable after `feasible`; skip.
    return { kind: 'handCreature', options, min: 1, max: 1, step: 'link', scratch: null };
  },
  resume: (k, _step, _scratch, selection) => {
    for (const cardId of selection) k.placeOnStack(cardId);
    return undefined;
  },
};

/**
 * S-07 (RD-108, RD-127, RD-103): the caster has a Leading creature and a (non-locked) hand
 * creature -> the caster chooses one (`handCreature`); `replaceLeader` atomically puts the old
 * Leading creature into the deck and the chosen one in its place (only the new one activates),
 * the deck is shuffled, and the caster's turn ends (RD-103 / RD-121; the Secondary does not end it).
 */
const S07: SpellHandler = {
  feasible: (v) =>
    leadingCreature(v.board, v.caster) !== undefined && placeableHandCreatures(v).length > 0,
  primary: (k) => {
    const options = placeableHandCreatures(k);
    if (options.length === 0 || leadingCreature(k.board, k.caster) === undefined) {
      // Unreachable after `feasible`. Best-effort (RD-161): no replacement, the turn still ends.
      k.requestEndTurn();
      return undefined;
    }
    return { kind: 'handCreature', options, min: 1, max: 1, step: 'replace', scratch: null };
  },
  resume: (k, _step, _scratch, selection) => {
    const [newCardId] = selection;
    if (newCardId !== undefined) {
      k.replaceLeader(k.caster, newCardId, 'deck');
      k.shuffleDeck();
    }
    k.requestEndTurn();
    return undefined;
  },
};

/** S-09 candidates: the caster's (non-locked) hand creatures below its Leading creature's level. */
function retreatCandidates(view: SpellView): CardId[] {
  const level = leaderLevel(view);
  if (level === undefined) return [];
  return placeableHandCreatures(view, (l) => l < level);
}

/**
 * S-09 (RD-117, RD-127): the caster has a Leading creature and a lower-level hand creature -> the
 * caster chooses one (`handCreature`); `replaceLeader` atomically returns the Leading creature to
 * the caster's hand (its owner, RD-135) and puts the chosen one in its place. The returned creature
 * is replay-locked until the turn ends (`lockReplay`, RD-117); the turn does not end.
 */
const S09: SpellHandler = {
  feasible: (v) => retreatCandidates(v).length > 0,
  primary: (k) => {
    const options = retreatCandidates(k);
    if (options.length === 0) return undefined; // Unreachable after `feasible`; skip.
    return { kind: 'handCreature', options, min: 1, max: 1, step: 'retreat', scratch: null };
  },
  resume: (k, _step, _scratch, selection) => {
    const old = leadingCreature(k.board, k.caster);
    const [newCardId] = selection;
    if (old !== undefined && newCardId !== undefined) {
      k.replaceLeader(k.caster, newCardId, 'ownerHand');
      k.lockReplay(k.caster, old);
    }
    return undefined;
  },
};

/** S-13's target levels (spell data). */
export const S13_MAX_LEVEL = 4;

/**
 * S-13 (RD-106, RD-131, RD-110): the opponent has a level 1-4 creature (Base included) and the
 * caster has at least 1 other hand card -> two chained choices: (1) the enemy creature
 * (`enemyCreature`), whose control and ownership pass to the caster (`takeControl`: top of the
 * caster's stack, or its Base); (2) one card of the caster's hand to discard (`handDiscard`, from
 * the hand as it is after step 1). Each is automatic with a single legal answer.
 */
const S13: SpellHandler = {
  feasible: (v) =>
    stackCreaturesWhere(v, v.opponent, (l) => l <= S13_MAX_LEVEL).length > 0 &&
    handSize(v.board, v.caster) >= 1,
  primary: (k) => {
    const options = stackCreaturesWhere(k, k.opponent, (l) => l <= S13_MAX_LEVEL);
    // Unreachable after `feasible`. Best-effort (RD-161): no target, the discard still happens.
    if (options.length === 0) return discardStep(k);
    return { kind: 'enemyCreature', options, min: 1, max: 1, step: 'take', scratch: null };
  },
  resume: (k, step, _scratch, selection) => {
    if (step === 'take') {
      for (const cardId of selection) k.takeControl(cardId);
      return discardStep(k);
    }
    k.discard(k.caster, selection);
    return undefined;
  },
};

/** S-13's discard step; skipped with an empty hand (unreachable after `feasible`; RD-161). */
function discardStep(k: SpellKernel): SpellChoiceRequest | undefined {
  const hand = [...k.board.zones.hands[k.caster]];
  if (hand.length === 0) return undefined;
  return { kind: 'handDiscard', options: hand, min: 1, max: 1, step: 'discard', scratch: null };
}

/** S-17's minimum hand surplus (spell data, RD-110: "more than one"). */
export const S17_MIN_SURPLUS = 2;

/** RD-110: the caster's hand surplus over the opponent's (spell already out of the hand). */
function handSurplus(view: Pick<SpellView, 'board' | 'caster' | 'opponent'>): number {
  return handSize(view.board, view.caster) - handSize(view.board, view.opponent);
}

/**
 * S-17 (RD-110, RD-106, RD-131): the caster has at least 2 more hand cards than the opponent and
 * the opponent has a creature -> two chained choices: (1) exactly `surplus` cards of the caster's
 * hand (`handToDeck`, hidden) go into the deck, which is shuffled, so the hands become equal;
 * (2) any enemy creature (`enemyCreature`), whose control and ownership pass to the caster.
 */
const S17: SpellHandler = {
  feasible: (v) => handSurplus(v) >= S17_MIN_SURPLUS && creatureCount(v.board, v.opponent) >= 1,
  primary: (k) => {
    const surplus = handSurplus(k);
    // Unreachable after `feasible`. Best-effort (RD-161): no surplus, nothing goes into the deck
    // (no shuffle); the takeover still happens.
    if (surplus < 1) return takeoverStep(k);
    const options = [...k.board.zones.hands[k.caster]];
    return {
      kind: 'handToDeck',
      options,
      min: surplus,
      max: surplus,
      step: 'return',
      scratch: null,
    };
  },
  resume: (k, step, _scratch, selection) => {
    if (step === 'return') {
      k.returnHandCards(k.caster, selection);
      k.shuffleDeck();
      return takeoverStep(k);
    }
    for (const cardId of selection) k.takeControl(cardId);
    return undefined;
  },
};

/** S-17's takeover step; skipped without an enemy creature (unreachable after `feasible`). */
function takeoverStep(k: SpellKernel): SpellChoiceRequest | undefined {
  const options = [...k.board.zones.stacks[k.opponent]];
  if (options.length === 0) return undefined;
  return { kind: 'enemyCreature', options, min: 1, max: 1, step: 'take', scratch: null };
}

/** S-18's scratch between its two choices: the chosen enemy creature (null: none, RD-161). */
function enemyFromScratch(scratch: JsonValue): CardId | null {
  if (typeof scratch === 'object' && scratch !== null && !Array.isArray(scratch)) {
    const enemy = (scratch as { readonly [key: string]: JsonValue })['enemy'];
    if (typeof enemy === 'string' || enemy === null) return enemy;
  }
  throw new Error('corrupt S-18 continuation');
}

/**
 * S-18's second step: the caster's own creature (`ownCreature`), then both return as one removal
 * and the turn ends. Best-effort (RD-161): a missing side returns nothing; the turn still ends.
 */
function withdrawStep(k: SpellKernel, enemy: CardId | null): SpellChoiceRequest | undefined {
  const options = [...k.board.zones.stacks[k.caster]];
  if (options.length === 0) {
    withdraw(k, [], enemy);
    return undefined;
  }
  return { kind: 'ownCreature', options, min: 1, max: 1, step: 'own', scratch: { enemy } };
}

function withdraw(k: SpellKernel, own: readonly CardId[], enemy: CardId | null): void {
  const returned = enemy === null ? [...own] : [...own, enemy];
  if (returned.length > 0) k.removeFromStacks(returned, 'ownerHand');
  k.requestEndTurn();
}

/**
 * S-18 (RD-119, RD-121, RD-104 / RD-135): the opponent has at least 2 more creatures than the
 * caster and the caster has at least 1 -> two chained choices: (1) an enemy creature
 * (`enemyCreature`), (2) one of the caster's own (`ownCreature`, automatic with one). Both then
 * return to their owners' hands as ONE removal (RD-147, Proposed: nothing activates in between;
 * order: the caster's first, as RD-132), and the caster's turn ends.
 */
const S18: SpellHandler = {
  feasible: (v) =>
    creatureCount(v.board, v.caster) >= 1 &&
    creatureCount(v.board, v.opponent) >= creatureCount(v.board, v.caster) + 2,
  primary: (k) => {
    const options = [...k.board.zones.stacks[k.opponent]];
    // Unreachable after `feasible`. Best-effort (RD-161): no enemy creature, own step only.
    if (options.length === 0) return withdrawStep(k, null);
    return { kind: 'enemyCreature', options, min: 1, max: 1, step: 'enemy', scratch: null };
  },
  resume: (k, step, scratch, selection) => {
    if (step === 'enemy') return withdrawStep(k, selection[0] ?? null);
    withdraw(k, selection, enemyFromScratch(scratch));
    return undefined;
  },
};

// ---------------------------------------------------------------------------------------------
// R4c-4 handlers: armed traps (RD-101, traps.ts).

/**
 * S-12 Null Snare and S-16 Recoil Snare (RD-101, RD-128..RD-130): always playable; the Primary
 * arms the trap on the caster's side instead of resolving. Trigger, outcome and lapse (with the
 * data Secondary) are handled by traps.ts on the opponent's placements and at turn / round end.
 */
const TRAP: SpellHandler = {
  feasible: () => true,
  primary: (k) => {
    k.armTrap(k.caster);
  },
};

// ---------------------------------------------------------------------------------------------
// R4c-5 handler: S-19 Gambit Prism (RD-112, RD-119, RD-120, RD-121, RD-157..RD-161).

/**
 * S-19 Gambit Prism: always playable; draws 1 random card from the graveyard (kernel
 * `drawRandomFromGraveyard`: round RNG, revealed, in no zone). The S-19 card itself is in
 * resolution, so it can never draw itself (RD-158). Empty graveyard: nothing happens.
 * - Creature (RD-108, RD-120): placed on the caster's stack ignoring level and colour, as a normal
 *   placement (modifier activates, an armed Link Up is used up, the opponent's traps may trigger,
 *   RD-152); with no creature of the caster's on the field it becomes the Base.
 * - Spell (RD-112): the opponent plays it at once as its caster, in best-effort mode
 *   (`playForOpponent`; spells.ts runs it as a nested frame).
 */
const S19: SpellHandler = {
  feasible: () => true,
  primary: (k) => {
    const drawn = k.drawRandomFromGraveyard();
    if (drawn === undefined) return undefined;
    if (k.cards[drawn]?.kind === 'creature') k.placeOnStack(drawn);
    else k.playForOpponent(drawn);
    return undefined;
  },
};

const supported = (handler: SpellHandler, primaryDrawsFromGraveyard = false): SpellRegistryEntry =>
  Object.freeze({ status: 'supported', handler, primaryDrawsFromGraveyard });

/** Exactly one entry per spell of `data/cards.json` (drift test). */
export const SPELL_REGISTRY: Readonly<Record<string, SpellRegistryEntry>> = Object.freeze({
  'S-01': supported(S01),
  'S-02': supported(S02, true),
  'S-03': supported(S03),
  'S-04': supported(S04),
  'S-05': supported(S05),
  'S-06': supported(S06),
  'S-07': supported(S07),
  'S-08': supported(S08),
  'S-09': supported(S09),
  'S-10': supported(S10),
  'S-11': supported(S11),
  'S-12': supported(TRAP),
  'S-13': supported(S13),
  'S-14': supported(S14),
  'S-15': supported(S15),
  'S-16': supported(TRAP),
  'S-17': supported(S17),
  'S-18': supported(S18),
  'S-19': supported(S19, true),
});
