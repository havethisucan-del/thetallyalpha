import type { NarrationLine } from './narration';

/**
 * The table's event history (corner log, 2026-10-23). The narration is rebuilt from the rolling
 * event log on every view, and that log is capped (`EVENT_LOG_LIMIT`), so the table keeps what it
 * has seen in a longer, append-only history (presentation only; nothing here knows the rules).
 */

/** How many lines the history keeps (about a full match of play). */
export const HISTORY_LIMIT = 400;

/**
 * Merges freshly narrated lines (oldest first) into the history (oldest first). A known key keeps
 * its first-seen grouping (`turn`, `startsRound`: the narration of a shortened log may no longer
 * know the turn) but takes the newer text and details (a spell sentence can grow within its step).
 * Returns `history` itself when nothing changed, so it is safe to call on every render.
 */
export function mergeHistory(
  history: readonly NarrationLine[],
  lines: readonly NarrationLine[],
  limit = HISTORY_LIMIT,
): readonly NarrationLine[] {
  const index = new Map(history.map((line, i) => [line.key, i]));
  let next: NarrationLine[] | null = null;
  for (const line of lines) {
    const at = index.get(line.key);
    if (at === undefined) {
      next ??= [...history];
      index.set(line.key, next.length);
      next.push(line);
      continue;
    }
    const known = (next ?? history)[at];
    if (known === undefined || sameContent(known, line)) continue;
    next ??= [...history];
    next[at] = { ...line, ...grouping(known) };
  }
  if (next === null) return history;
  return next.length > limit ? next.slice(-limit) : next;
}

function grouping(line: NarrationLine): Pick<NarrationLine, 'turn' | 'startsRound'> {
  const out: Pick<NarrationLine, 'turn' | 'startsRound'> = {};
  if (line.turn !== undefined) out.turn = line.turn;
  if (line.startsRound) out.startsRound = true;
  return out;
}

function sameContent(a: NarrationLine, b: NarrationLine): boolean {
  const da = a.details ?? [];
  const db = b.details ?? [];
  return a.text === b.text && da.length === db.length && da.every((d, i) => d === db[i]);
}

/** How many history lines came after the line with key `seenKey` (all of them when unknown). */
export function unreadCount(
  history: readonly NarrationLine[],
  seenKey: string | null,
  exceptKey: string | null = null,
): number {
  const seenAt = seenKey === null ? -1 : history.findIndex((line) => line.key === seenKey);
  let count = 0;
  for (let i = seenAt + 1; i < history.length; i += 1) {
    if (history[i]?.key !== exceptKey) count += 1;
  }
  return count;
}

export interface TurnGroup {
  key: string;
  /** e.g. `Turn 2 · You`, `Round result`, `Round start`. */
  label: string;
  /** Newest first. */
  lines: NarrationLine[];
}

export interface RoundGroup {
  key: string;
  /** The round number, or null when the history does not reach its start. */
  round: number | null;
  /** Newest first. */
  turns: TurnGroup[];
}

function turnLabel(turn: NarrationLine['turn']): string {
  if (turn === undefined) return 'Round start';
  if (turn === 'end') return 'Round result';
  return `Turn ${turn.number} · ${turn.side === 'mine' ? 'You' : 'Opponent'}`;
}

/**
 * Groups the history (oldest first) by round and turn, newest first at every level. Rounds are
 * numbered back from `currentRound`: the last round group is the current round. A group the
 * history does not see start gets `round: null` ("Earlier").
 */
export function groupHistory(
  history: readonly NarrationLine[],
  currentRound: number,
): RoundGroup[] {
  const rounds: { startKey: string; lines: NarrationLine[] }[] = [];
  for (const line of history) {
    const last = rounds.at(-1);
    if (last === undefined || line.startsRound) rounds.push({ startKey: line.key, lines: [line] });
    else last.lines.push(line);
  }
  const starts = rounds.filter((r) => r.lines[0]?.startsRound).length;
  let round = currentRound - starts;
  const out: RoundGroup[] = [];
  for (const r of rounds) {
    const opens = r.lines[0]?.startsRound === true;
    if (opens) round += 1;
    const number = opens ? round : round >= 1 ? round : null;
    const turns: TurnGroup[] = [];
    for (const line of r.lines) {
      const label = turnLabel(line.turn);
      const last = turns.at(-1);
      if (last?.label === label) last.lines.push(line);
      else turns.push({ key: line.key, label, lines: [line] });
    }
    for (const turn of turns) turn.lines.reverse();
    out.push({ key: r.startKey, round: number, turns: turns.reverse() });
  }
  return out.reverse();
}
