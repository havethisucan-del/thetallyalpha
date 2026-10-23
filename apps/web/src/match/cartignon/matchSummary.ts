import type { CartignonPublicView, MatchViewMessage } from '@cartignon/protocol';
import type { EventLogEntry } from '../../lib/cartignon';
import type { Seat } from '../../lib/synthetic';
import { CARTIGNON_COLORS, colorInfo, type CartignonColor } from './colors';
import { roundOutcomeText } from './labels';
import { otherSeat, outcomeView } from './tableModel';

/**
 * End-of-match summary (Cartignon table): who won, how the match was decided, the final token
 * holdings and the round results, from this seat's perspective. Pure; it only re-words what the
 * view (`outcome`, `public.match`) and the event log (`roundResolved`, `tokenChanged`) already
 * say, no rules are computed here.
 */

type MatchState = CartignonPublicView['match'];
type MatchStatus = MatchState['status'];
type MatchEndReason = Extract<MatchStatus, { kind: 'matchOver' }>['reason'];

/** The event types the summary keeps from the rolling event log. */
const ROUND_EVENT_TYPES = new Set(['roundResolved', 'tokenChanged']);

/**
 * The round result events this table has seen (oldest first), kept beyond the rolling event log's
 * cap (`EVENT_LOG_LIMIT`) and reset when the match changes.
 */
export interface RoundEventHistory {
  matchId: string | null;
  entries: readonly EventLogEntry[];
}

export const EMPTY_ROUND_EVENTS: RoundEventHistory = { matchId: null, entries: [] };

/**
 * Merges the round result events of `eventLog` (oldest first) into `history` by entry key.
 * Returns `history` itself when nothing changed, so it is safe to call on every render.
 */
export function collectRoundEvents(
  history: RoundEventHistory,
  matchId: string | null,
  eventLog: readonly EventLogEntry[],
): RoundEventHistory {
  const base = history.matchId === matchId ? history : { matchId, entries: [] };
  const known = new Set(base.entries.map((entry) => entry.key));
  const added = eventLog.filter(
    (entry) => ROUND_EVENT_TYPES.has(entry.event.type) && !known.has(entry.key),
  );
  if (added.length === 0) return base;
  return { matchId, entries: [...base.entries, ...added] };
}

export type SummaryResult = 'win' | 'loss' | 'draw';

export interface RoundSummary {
  key: string;
  /** The round number, or null when it cannot be told from the data seen. */
  round: number | null;
  result: SummaryResult;
  /** `roundOutcomeText`, e.g. `You won the round on the tie-break (ATK 5 vs 5).` */
  text: string;
  /** The token move of the round, e.g. `You won the Orange token.`; null for a drawn round. */
  token: string | null;
}

export interface MatchSummary {
  result: SummaryResult;
  /** `You won` / `Your opponent won` / `Draw` (the `outcome` test id keeps exactly this text). */
  headline: string;
  /** How the match was decided (`public.match.status.reason`), null when the view does not say. */
  decidedBy: string | null;
  /** Final token holdings by colour. */
  tokens: { mine: CartignonColor[]; theirs: CartignonColor[]; unclaimed: CartignonColor[] };
  /** Rounds resolved in this match (a forfeit ends during an unresolved round). */
  roundsPlayed: number;
  /** Round results seen by this table, oldest first. */
  rounds: RoundSummary[];
  /** False when the round list does not reach back to round 1 (e.g. joined or reloaded late). */
  roundsComplete: boolean;
}

const FORFEIT_REASONS = new Set<MatchEndReason>(['forfeitTimeouts', 'forfeitTimeoutAfterPause']);

function resultFor(winner: Seat | null, mySeat: Seat): SummaryResult {
  if (winner === null) return 'draw';
  return winner === mySeat ? 'win' : 'loss';
}

const HEADLINE: Readonly<Record<SummaryResult, string>> = {
  win: 'You won',
  loss: 'Your opponent won',
  draw: 'Draw',
};

/** How the match ended, in plain words, from `mySeat`'s perspective. */
export function matchEndText(reason: MatchEndReason, winner: Seat | null, mySeat: Seat): string {
  const loser = winner === null ? null : otherSeat(winner) === mySeat ? 'You' : 'Your opponent';
  switch (reason) {
    case 'allTokensHeld':
      return 'All tokens were claimed; the side holding more tokens wins.';
    case 'finalRoundPlayed':
      return 'The final round was played; the side holding more tokens wins.';
    case 'replaysExhausted':
      return 'The tokens were still tied after the final round replays.';
    case 'replayImpossible':
      return 'The final round could not be replayed: no creature was left to play.';
    case 'noCreaturesLeft':
      return 'No creature was left to win another round; decided on tokens.';
    case 'noProgress':
      return 'Several rounds passed without progress; decided on tokens.';
    case 'forfeitTimeouts':
      return `${loser ?? 'A player'} forfeited after two turn timeouts in a row.`;
    case 'forfeitTimeoutAfterPause':
      return `${loser ?? 'A player'} forfeited: the clock ran out after the pause time was used up.`;
  }
}

function tokenText(
  change: Extract<EventLogEntry['event'], { type: 'tokenChanged' }>['change'],
  mySeat: Seat,
): string {
  const token = `${colorInfo(change.color).label} token`;
  const mine = change.seat === mySeat;
  const who = mine ? 'You' : 'Your opponent';
  switch (change.kind) {
    case 'awarded':
      return `${who} won the ${token}.`;
    case 'stolen':
      return `${who} took the ${token} from ${mine ? 'your opponent' : 'you'}.`;
    case 'protected':
      return `${who} kept the ${token}.`;
  }
}

function roundSummaries(entries: readonly EventLogEntry[], mySeat: Seat): RoundSummary[] {
  const rounds: RoundSummary[] = [];
  /** The step (revision) of the last `roundResolved`. */
  let lastRevision: number | null = null;
  for (const entry of entries) {
    const event = entry.event;
    if (event.type === 'roundResolved') {
      const view = outcomeView(event.outcome, mySeat);
      if (view === null) continue;
      const result: SummaryResult =
        view.kind === 'draw' ? 'draw' : view.winner === 'mine' ? 'win' : 'loss';
      rounds.push({
        key: entry.key,
        round: null,
        result,
        text: roundOutcomeText(view),
        token: null,
      });
      lastRevision = entry.revision;
    } else if (event.type === 'tokenChanged') {
      // The token move follows its round's `roundResolved` in the same step.
      const last = rounds.at(-1);
      if (last !== undefined && lastRevision === entry.revision && last.token === null) {
        last.token = tokenText(event.change, mySeat);
      }
    }
  }
  return rounds;
}

/**
 * Builds the summary of a finished match. `outcome` is the view's `outcome` (null while the match
 * runs: no summary), `match` is `public.match`, `rounds` the collected round events.
 */
export function buildMatchSummary(
  outcome: MatchViewMessage['outcome'],
  match: MatchState,
  mySeat: Seat,
  rounds: readonly EventLogEntry[],
): MatchSummary | null {
  if (outcome === null) return null;
  const winner = outcome.result === 'draw' ? null : outcome.winner;
  const result = resultFor(winner, mySeat);
  const status = match.status;
  const over = status.kind === 'matchOver' ? status : null;
  const forfeit = over !== null && FORFEIT_REASONS.has(over.reason);

  const tokens: MatchSummary['tokens'] = { mine: [], theirs: [], unclaimed: [] };
  for (const color of CARTIGNON_COLORS) {
    const owner = match.tokens[color];
    if (owner === null) tokens.unclaimed.push(color);
    else if (owner === mySeat) tokens.mine.push(color);
    else tokens.theirs.push(color);
  }

  // `roundNumber` counts the round in play; the match ends after resolving it, except on a
  // forfeit, which ends during an unresolved round.
  const roundsPlayed = Math.max(0, forfeit ? match.roundNumber - 1 : match.roundNumber);
  const list = roundSummaries(rounds, mySeat);
  // The collected results run up to the match end; number them back from the last one.
  const first = roundsPlayed - list.length + 1;
  const numbered = list.map((round, index) => {
    const number = first + index;
    return { ...round, round: number >= 1 && number <= roundsPlayed ? number : null };
  });

  return {
    result,
    headline: HEADLINE[result],
    decidedBy: over === null ? null : matchEndText(over.reason, over.winner, mySeat),
    tokens,
    roundsPlayed,
    rounds: numbered,
    roundsComplete: first <= 1,
  };
}
