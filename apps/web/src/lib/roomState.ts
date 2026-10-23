import type { RoomPhase } from '@cartignon/protocol';

/**
 * Plain, immutable snapshot of the synchronized Colyseus room state (`PublicRoomState`).
 * Colyseus mutates its schema objects in place, so React gets a fresh copy on every change.
 */
export interface SeatSnapshot {
  displayName: string;
  ready: boolean;
  connected: boolean;
}

export interface RoomSnapshot {
  phase: RoomPhase;
  code: string;
  seats: [SeatSnapshot | null, SeatSnapshot | null];
}

const PHASES: ReadonlySet<string> = new Set<RoomPhase>(['lobby', 'active', 'finished']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Works for a Colyseus MapSchema and for a plain Map (both expose `get(key)`). */
function readMapEntry(map: unknown, key: string): unknown {
  if (!isRecord(map)) return undefined;
  const get: unknown = map['get'];
  if (typeof get !== 'function') return undefined;
  return (get as (k: string) => unknown).call(map, key);
}

function readSeat(value: unknown): SeatSnapshot | null | 'invalid' {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return 'invalid';
  const { displayName, ready, connected } = value;
  if (typeof displayName !== 'string' || displayName.length > 64) return 'invalid';
  if (typeof ready !== 'boolean' || typeof connected !== 'boolean') return 'invalid';
  return { displayName, ready, connected };
}

/** Returns null when the state does not match the contract; invalid data is never rendered. */
export function readRoomState(state: unknown): RoomSnapshot | null {
  if (!isRecord(state)) return null;
  const { phase, code, players } = state;
  if (typeof phase !== 'string' || !PHASES.has(phase)) return null;
  if (typeof code !== 'string' || code.length > 16) return null;
  const seat0 = readSeat(readMapEntry(players, '0'));
  const seat1 = readSeat(readMapEntry(players, '1'));
  if (seat0 === 'invalid' || seat1 === 'invalid') return null;
  return { phase: phase as RoomPhase, code, seats: [seat0, seat1] };
}
