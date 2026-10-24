import type { CartignonSeatEvent } from '@cartignon/protocol';
import { colorInfo } from './colors';
import type { RoundOutcomeView, Side } from './tableModel';

/**
 * Why a round was won, lost or drawn (2026-10-24): the shared wording of the event history's
 * round-end details and the end-of-match summary's per-round account. Pure; it only re-words what
 * the events already say (`roundOver`, `roundResolved`, `tieBreakDeckOut`, `tokenChanged`) and
 * states the rules they applied, as recorded in docs/rules-decisions.md:
 * - RD-169 (1): End Turn while the opponent is strictly ahead ends the round; the opponent wins.
 * - RD-169 (2): an End Turn at equal ATK without a play, right after an End Turn at equal ATK,
 *   ends the round with the tie-break (RD-19: both draw until a creature, linked onto the stack,
 *   repeated while tied; RD-42: the deck running out makes the round a draw).
 * - RD-63 / RD-67: P1 without a Base creature ends the round as a draw; a drawn round changes no
 *   tokens (RD-42).
 * - RD-26: the winner takes the token of their Leading card's colour (from the supply, from the
 *   opponent, or keeps it when already held).
 * No rule is computed here: every verdict comes from the events.
 */

type RoundOverReason = Extract<CartignonSeatEvent, { type: 'roundOver' }>['reason'];
type TokenChange = Extract<CartignonSeatEvent, { type: 'tokenChanged' }>['change'];

/** How a round reached its end (`roundOver`), from this seat's perspective. */
export interface RoundEnd {
  reason: RoundOverReason;
  /** Whose End Turn ended the round; null when not seen (a summary after a reload). */
  endedBy: Side | null;
  /** [mine, theirs] when the round ended (before any tie-break). */
  atk: [number, number];
}

/** A token move, from this seat's perspective. */
export interface TokenMove {
  side: Side;
  color: TokenChange['color'];
  kind: TokenChange['kind'];
}

/** Everything known about one resolved round. */
export interface RoundAccount {
  outcome: RoundOutcomeView;
  /** The `roundOver` before the result, null when not seen. */
  end: RoundEnd | null;
  /** Whose tie-break search ran out of deck (`tieBreakDeckOut`), null when none or not seen. */
  deckOutBy: Side | null;
  /** The token move of the round, null for a draw (or when not seen). */
  token: TokenMove | null;
}

export const RULE_BEHIND =
  'Rule: ending your turn while the opponent is strictly ahead ends the round, and the opponent wins it.';
export const RULE_STALL =
  'Rule: an End Turn at equal ATK without playing a card, right after an End Turn at equal ATK, ends the round with a tie-break.';
export const RULE_TIE_BREAK =
  'Tie-break: each player draws from the deck until a creature and links it onto their stack, repeated while ATK is tied; then the higher ATK wins.';
export const DRAW_NO_TOKENS = 'A drawn round changes no tokens.';

function vs(atk: readonly [number, number]): string {
  return `${atk[0]} vs ${atk[1]}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function times(count: number): string {
  return count === 1 ? 'once' : count === 2 ? 'twice' : `${count} times`;
}

/** The `roundOver` view with the ender always known (`opponentAhead`: the loser ended the turn). */
export function roundEndOf(account: RoundAccount): RoundEnd | null {
  if (account.end !== null) return account.end;
  const { outcome } = account;
  if (outcome.kind === 'win' && outcome.decidedBy === 'opponentAhead') {
    // RD-169 (1): the winner is the ender's opponent.
    return {
      reason: 'opponentAhead',
      endedBy: outcome.winner === 'mine' ? 'theirs' : 'mine',
      atk: outcome.atk,
    };
  }
  if (outcome.kind === 'draw' && outcome.reason === 'p1NoBase') {
    return { reason: 'p1NoBase', endedBy: null, atk: outcome.atk };
  }
  return null;
}

/**
 * The one-line headline of a round (summary), from this seat's perspective with ATK as
 * `mine vs theirs`, e.g. `Opponent won: you ended your turn behind (41 vs 76)`.
 */
export function roundHeadline(account: RoundAccount): string {
  const { outcome } = account;
  if (outcome.kind === 'win') {
    const who = outcome.winner === 'mine' ? 'You won' : 'Opponent won';
    if (outcome.decidedBy === 'opponentAhead') {
      const ender = outcome.winner === 'mine' ? 'opponent ended their turn' : 'you ended your turn';
      return `${who}: ${ender} behind (${vs(outcome.atk)})`;
    }
    return `${who} on the tie-break (${vs(outcome.atk)})`;
  }
  if (outcome.reason === 'tieBreakDeckOut') return 'Draw: the deck ran out in the tie-break';
  const end = roundEndOf(account);
  const p1 =
    end?.endedBy === 'mine' ? 'you (P1)' : end?.endedBy === 'theirs' ? 'opponent (P1)' : 'P1';
  return `Draw: ${p1} had no Base creature`;
}

/**
 * What ended the round and the rule that applied (from `roundOver` alone): the event history's
 * details of the round-over line, and the start of the summary's round details.
 */
export function roundEndDetails(end: RoundEnd): string[] {
  const [mine, theirs] = end.atk;
  switch (end.reason) {
    case 'opponentAhead': {
      const what =
        end.endedBy === 'mine'
          ? `You ended your turn at ATK ${mine} while your opponent had ${theirs}.`
          : end.endedBy === 'theirs'
            ? `Your opponent ended their turn at ATK ${theirs} while you had ${mine}.`
            : `A player ended their turn while behind (ATK ${vs(end.atk)}).`;
      return [what, RULE_BEHIND];
    }
    case 'equalStall': {
      const who =
        end.endedBy === 'mine'
          ? 'you ended your turn'
          : end.endedBy === 'theirs'
            ? 'your opponent ended their turn'
            : 'a player ended their turn';
      const after =
        end.endedBy === 'mine' ? "your opponent's" : end.endedBy === 'theirs' ? 'your' : 'an';
      return [
        `Equal-ATK stall: ${who} at ATK ${vs(end.atk)} without playing a card, right after ${after} End Turn at equal ATK.`,
        RULE_STALL,
      ];
    }
    case 'p1NoBase': {
      const who =
        end.endedBy === 'mine'
          ? 'You were P1 and'
          : end.endedBy === 'theirs'
            ? 'Your opponent was P1 and'
            : 'P1';
      return [`${who} had no creature to play as the Base, so the round ended as a draw.`];
    }
  }
}

/** The tie-break and final result (from `roundResolved`), after the round-end details. */
export function roundResultDetails(account: RoundAccount): string[] {
  const { outcome } = account;
  if (outcome.kind === 'win') {
    // The round-end details already give both ATK values.
    if (outcome.decidedBy === 'opponentAhead') return [];
    const [mine, theirs] = outcome.atk;
    const winner = outcome.winner === 'mine' ? 'you win' : 'your opponent wins';
    return [
      RULE_TIE_BREAK,
      `Both searched for a creature ${times(outcome.tieBreakIterations)}; final ATK: you ${mine}, opponent ${theirs} — ${winner} the round.`,
    ];
  }
  if (outcome.reason === 'tieBreakDeckOut') {
    const who =
      account.deckOutBy === 'mine'
        ? ' during your search'
        : account.deckOutBy === 'theirs'
          ? " during your opponent's search"
          : '';
    return [
      RULE_TIE_BREAK,
      `The deck ran out in the tie-break${who}, so the round is a draw (ATK ${vs(outcome.atk)}).`,
      DRAW_NO_TOKENS,
    ];
  }
  return [DRAW_NO_TOKENS];
}

/** A token move as a sentence, e.g. `Your opponent took the Red token from you.` */
export function tokenMoveText(move: TokenMove): string {
  const token = `${colorInfo(move.color).label} token`;
  const mine = move.side === 'mine';
  const who = mine ? 'You' : 'Your opponent';
  switch (move.kind) {
    case 'awarded':
      return `${who} won the ${token}.`;
    case 'stolen':
      return `${who} took the ${token} from ${mine ? 'your opponent' : 'you'}.`;
    case 'protected':
      return `${who} kept the ${token}.`;
  }
}

/** Why the token moved as it did (RD-26): the history's detail of the token line. */
export function tokenReasonText(move: TokenMove): string {
  const colour = `the winner takes the token of their Leading card's colour`;
  switch (move.kind) {
    case 'awarded':
      return `${capitalize(colour)}; it was still in the supply.`;
    case 'stolen':
      return `${capitalize(colour)}; the loser held it, so it changed hands.`;
    case 'protected':
      return `${capitalize(colour)}; the winner already held it, so it stays.`;
  }
}

/** The summary's full account of a round: what ended it, the rule, the result and the token. */
export function roundDetails(account: RoundAccount): string[] {
  const end = roundEndOf(account);
  const out = end === null ? [] : roundEndDetails(end);
  if (end === null && account.outcome.kind === 'win' && account.outcome.decidedBy === 'tieBreak') {
    out.push(
      'Equal-ATK stall: two End Turns in a row at equal ATK, the second without playing a card.',
    );
  }
  out.push(...roundResultDetails(account));
  if (account.token !== null) {
    out.push(`${tokenMoveText(account.token)} ${tokenReasonText(account.token)}`);
  }
  return out;
}
