import type {
  CartignonCommand,
  CartignonPrivateView,
  CartignonPublicView,
  MatchViewMessage,
} from '@cartignon/protocol';
import { cardLabel, choiceWithOptions, type CartignonViewParts } from '../../lib/cartignon';
import type { Seat } from '../../lib/synthetic';
import type { ClockReading } from './clock';
import { CARTIGNON_COLORS, type CartignonColor } from './colors';

/**
 * Renderer-neutral table model of a Cartignon match (R8a): everything a table UI shows, derived
 * from the validated view only. No rules are computed here; actions come from `private.legal`
 * entries or a choice selection the server validates again.
 */

export type Side = 'mine' | 'theirs';

type CardSummary = CartignonPublicView['defs'][string];
type PendingChoiceView = NonNullable<CartignonPrivateView['pendingChoiceView']>;
type ModifierKind = CartignonPublicView['liveModifiers'][number]['kind'];

/** A `private.legal` entry with its position in that list (stable key / test id). */
export interface LegalRef {
  index: number;
  command: CartignonCommand;
}

export interface TableCard {
  cardId: string;
  /** Plain text from `cardLabel`, e.g. `c05 orange L3 ATK 4`. */
  label: string;
  /** The card's definition id (`C-A1`, `S-01` …), null if the public card table does not list it. */
  defId: string | null;
  /** The card's public summary; null if the public card table does not list it. */
  summary: CardSummary | null;
  /** Creature color, null for spells and unknown cards. */
  color: CartignonColor | null;
}

export interface StackCard extends TableCard {
  /** 0 = bottom (Base); the last card is the top. */
  position: number;
}

export interface TrapCard extends TableCard {
  spellId: string;
  dormant: boolean;
}

export interface SeatArea {
  seat: Seat;
  side: Side;
  handCount: number;
  atk: number;
  /** Bottom to top: the top card is last. */
  stack: StackCard[];
  /** Armed traps are public (RD-130); the table renders both seats' traps face-up. */
  traps: TrapCard[];
  armedTrapCount: number;
}

/** RD-171 spell hint (`private.spellHints`), passed through; no client rule logic. */
export interface SpellHint {
  /** The effect that would fire if cast now; null = this build cannot play the spell. */
  branch: 'primary' | 'secondary' | null;
  /** `playSpell` with this card is legal right now. */
  castable: boolean;
  /** The server's rejection code when not castable, else null. */
  reason: string | null;
}

export interface HandCard extends TableCard {
  /** The legal commands that play this card (`playCreature` / `nullify` / `playSpell`). */
  commands: LegalRef[];
  /** The server's hint for a spell in hand; null for creatures (or a spell without a hint). */
  spellHint: SpellHint | null;
}

export interface TokenView {
  color: CartignonColor;
  owner: Seat | null;
  side: Side | null;
}

export interface LiveModifierView {
  seat: Seat;
  side: Side;
  cardId: string;
  kind: ModifierKind;
  position: number;
}

export interface TableCenter {
  round: number;
  finalRound: boolean;
  replays: number;
  turn: number;
  phaseKind: CartignonPublicView['round']['phase']['kind'];
  tokens: TokenView[];
  deckCount: number;
  graveyardCount: number;
  /** The shared graveyard, oldest first (RD-170). */
  graveyard: TableCard[];
  liveModifiers: LiveModifierView[];
  /** Set while the round is over (`phase.kind === 'roundOver'`), else null. */
  roundOver: RoundOverView | null;
  /** The previous round's result (`match.lastOutcome`), null before the first one. */
  lastOutcome: RoundOutcomeView | null;
}

/** Why the round ended (RD-169), from this seat's perspective. */
export interface RoundOverView {
  reason: 'opponentAhead' | 'equalStall' | 'p1NoBase';
  /** Whose End Turn ended the round. */
  endedBy: Side;
  /** Whether this seat is P1 of the round. */
  iAmP1: boolean;
  /** [mine, theirs]. */
  atk: [number, number];
}

/** A resolved round (`match.lastOutcome`) from this seat's perspective. */
export type RoundOutcomeView =
  | {
      kind: 'win';
      winner: Side;
      decidedBy: 'opponentAhead' | 'tieBreak';
      /** [mine, theirs]. */
      atk: [number, number];
      tieBreakIterations: number;
    }
  | {
      kind: 'draw';
      reason: 'p1NoBase' | 'tieBreakDeckOut';
      atk: [number, number];
      tieBreakIterations: number;
    };

/** A choice this seat must answer, built from `pendingChoiceView` options + min/max (RD-151). */
export interface MyChoice {
  choiceId: number;
  kind: PendingChoiceView['kind'];
  spellId: string;
  options: TableCard[];
  min: number;
  max: number;
}

/**
 * The other seat's pending choice. `optionCount` is absent when the kind hides it (RD-142,
 * `handCreature`); there are never options.
 */
export interface OpponentChoice {
  seat: Seat;
  kind: PendingChoiceView['kind'];
  spellId: string;
  min: number;
  max: number;
  optionCount: number | null;
}

export interface TableModel {
  mySeat: Seat;
  opponentSeat: Seat;
  /** Whose turn it is (`phase.turnSeat`), null when nobody's. */
  onTurn: Side | null;
  /** The seat that must act now (`phase.activeSeat`); differs from the turn seat during a choice. */
  activeSeat: Seat | null;
  /** This seat must act now and the match is not over. */
  myAction: boolean;
  finished: boolean;
  opponent: SeatArea;
  me: SeatArea;
  center: TableCenter;
  hand: HandCard[];
  /** Legal commands without a card: `endTurn`, `mulligan`. */
  globalCommands: LegalRef[];
  /** Card commands whose card is not in the hand (not expected; kept so nothing is dropped). */
  otherCardCommands: LegalRef[];
  myChoice: MyChoice | null;
  opponentChoosing: OpponentChoice | null;
  clock: ClockReading | null;
}

export function otherSeat(seat: Seat): Seat {
  return seat === 0 ? 1 : 0;
}

function sideOf(seat: Seat, mySeat: Seat): Side {
  return seat === mySeat ? 'mine' : 'theirs';
}

/** The table card of an instance id, from the public card table. */
export function tableCard(pub: CartignonPublicView, cardId: string): TableCard {
  const defId = pub.cardDefs[cardId];
  const summary = defId === undefined ? null : (pub.defs[defId] ?? null);
  return {
    cardId,
    label: cardLabel(pub, cardId),
    defId: defId ?? null,
    summary,
    color: summary?.kind === 'creature' ? summary.color : null,
  };
}

function seatArea(pub: CartignonPublicView, seat: Seat, mySeat: Seat): SeatArea {
  const traps = pub.board.armedTraps
    .filter((trap) => trap.seat === seat)
    .map((trap) => ({
      ...tableCard(pub, trap.cardId),
      spellId: trap.spellId,
      dormant: trap.dormant,
    }));
  return {
    seat,
    side: sideOf(seat, mySeat),
    handCount: pub.handCounts[seat],
    atk: pub.atk[seat],
    stack: pub.board.stacks[seat].map((cardId, position) => ({
      ...tableCard(pub, cardId),
      position,
    })),
    traps,
    armedTrapCount: traps.length,
  };
}

function center(pub: CartignonPublicView, mySeat: Seat): TableCenter {
  return {
    round: pub.match.roundNumber,
    finalRound: pub.match.finalRound,
    replays: pub.match.replays,
    turn: pub.round.turnNumber,
    phaseKind: pub.round.phase.kind,
    tokens: CARTIGNON_COLORS.map((color) => {
      const owner = pub.match.tokens[color];
      return { color, owner, side: owner === null ? null : sideOf(owner, mySeat) };
    }),
    deckCount: pub.deckCount,
    graveyardCount: pub.graveyardCount,
    graveyard: pub.graveyard.map((cardId) => tableCard(pub, cardId)),
    liveModifiers: pub.liveModifiers.map((modifier) => ({
      ...modifier,
      side: sideOf(modifier.seat, mySeat),
    })),
    roundOver: roundOverView(pub, mySeat),
    lastOutcome: outcomeView(pub.match.lastOutcome, mySeat),
  };
}

function minePair(atk: readonly [number, number], mySeat: Seat): [number, number] {
  return [atk[mySeat], atk[otherSeat(mySeat)]];
}

function roundOverView(pub: CartignonPublicView, mySeat: Seat): RoundOverView | null {
  const phase = pub.round.phase;
  if (phase.kind !== 'roundOver') return null;
  return {
    reason: phase.reason,
    endedBy: sideOf(phase.seat, mySeat),
    iAmP1: pub.round.p1 === mySeat,
    atk: minePair(phase.atk, mySeat),
  };
}

/** `match.lastOutcome` (or a `roundResolved` outcome) from `mySeat`'s perspective. */
export function outcomeView(
  outcome: CartignonPublicView['match']['lastOutcome'],
  mySeat: Seat,
): RoundOutcomeView | null {
  if (outcome === null) return null;
  const atk = minePair(outcome.atk, mySeat);
  if (outcome.kind === 'win') {
    return {
      kind: 'win',
      winner: sideOf(outcome.winner, mySeat),
      decidedBy: outcome.decidedBy,
      atk,
      tieBreakIterations: outcome.tieBreakIterations,
    };
  }
  return {
    kind: 'draw',
    reason: outcome.reason,
    atk,
    tieBreakIterations: outcome.tieBreakIterations,
  };
}

function myChoice(parts: CartignonViewParts): MyChoice | null {
  const choice = choiceWithOptions(parts.private);
  const pending = parts.private.pendingChoiceView;
  if (!choice || !pending) return null;
  return {
    choiceId: choice.choiceId,
    kind: pending.kind,
    spellId: pending.spellId,
    options: choice.options.map((cardId) => tableCard(parts.public, cardId)),
    min: choice.min,
    max: choice.max,
  };
}

function opponentChoice(priv: CartignonPrivateView, mySeat: Seat): OpponentChoice | null {
  const pending = priv.pendingChoiceView;
  if (!pending || pending.seat === mySeat || 'options' in pending) return null;
  return {
    seat: pending.seat,
    kind: pending.kind,
    spellId: pending.spellId,
    min: pending.min,
    max: pending.max,
    optionCount: pending.optionCount ?? null,
  };
}

/**
 * Builds the table model. `mySeat` is the receiving seat (`view.seat`). `clock` is the current
 * reading (`readClock` / `useClock`), passed through.
 */
export function buildTableModel(
  view: MatchViewMessage,
  parts: CartignonViewParts,
  clock: ClockReading | null,
  mySeat: Seat,
): TableModel {
  const pub = parts.public;
  const priv = parts.private;
  const opponentSeat = otherSeat(mySeat);
  const finished = view.outcome !== null || pub.match.status.kind === 'matchOver';
  const turnSeat = view.phase.turnSeat;

  const handIds = new Set(priv.hand);
  const hints = new Map<string, SpellHint>(
    priv.spellHints.map(({ cardId, branch, castable, reason }) => [
      cardId,
      { branch, castable, reason },
    ]),
  );
  const byCard = new Map<string, LegalRef[]>();
  const globalCommands: LegalRef[] = [];
  const otherCardCommands: LegalRef[] = [];
  priv.legal.forEach((command, index) => {
    const ref = { index, command };
    if ('cardId' in command) {
      if (!handIds.has(command.cardId)) {
        otherCardCommands.push(ref);
        return;
      }
      const list = byCard.get(command.cardId) ?? [];
      list.push(ref);
      byCard.set(command.cardId, list);
    } else if (command.type !== 'chooseSpellOption') {
      // Choice answers are built from `pendingChoiceView` (RD-151), not from `legal`.
      globalCommands.push(ref);
    }
  });

  return {
    mySeat,
    opponentSeat,
    onTurn: turnSeat === null ? null : sideOf(turnSeat, mySeat),
    activeSeat: view.phase.activeSeat,
    myAction: !finished && view.phase.activeSeat === mySeat,
    finished,
    opponent: seatArea(pub, opponentSeat, mySeat),
    me: seatArea(pub, mySeat, mySeat),
    center: center(pub, mySeat),
    hand: priv.hand.map((cardId) => ({
      ...tableCard(pub, cardId),
      commands: byCard.get(cardId) ?? [],
      spellHint: hints.get(cardId) ?? null,
    })),
    globalCommands,
    otherCardCommands,
    myChoice: myChoice(parts),
    opponentChoosing: opponentChoice(priv, mySeat),
    clock,
  };
}
