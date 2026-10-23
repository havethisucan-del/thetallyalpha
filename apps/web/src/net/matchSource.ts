import type {
  ActionMessage,
  ActionResultMessage,
  ClockView,
  MatchViewMessage,
} from '@cartignon/protocol';
import type { CartignonViewParts, EventLogEntry } from '../lib/cartignon';
import type { RoomSnapshot } from '../lib/roomState';
import type { IncrementAmount, Seat } from '../lib/synthetic';

/**
 * ADR-0017: what the match screens read and send, independent of where the match runs. Implemented
 * by `MatchConnection` (online, Colyseus) and `LocalMatch` (solo vs bot, in the browser). This
 * module has no runtime dependencies on the online code, so the static build can use it.
 */

export type ConnectionStatus =
  'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface MatchSnapshot {
  status: ConnectionStatus;
  roomId: string | null;
  inviteCode: string | null;
  seat: Seat | null;
  room: RoomSnapshot | null;
  view: MatchViewMessage | null;
  /** Strictly parsed parts of `view` when its `rulesId` is `cartignon`, else null. */
  cartignon: CartignonViewParts | null;
  /** Rolling client-side log of the Cartignon events received (newest last). */
  eventLog: readonly EventLogEntry[];
  lastResult: ActionResultMessage | null;
  error: string | null;
  /**
   * Latest match clock: from the accepted `match:view`, or from a newer `match:clock` (pause /
   * resume without a new revision). Null when no clock runs.
   */
  clock: ClockView | null;
  /** Local `now()` (see `MatchConnectionOptions.now`) when `clock` was received; null with no view. */
  clockReceivedAt: number | null;
}

export const IDLE_SNAPSHOT: MatchSnapshot = {
  status: 'idle',
  roomId: null,
  inviteCode: null,
  seat: null,
  room: null,
  view: null,
  cartignon: null,
  eventLog: [],
  lastResult: null,
  error: null,
  clock: null,
  clockReceivedAt: null,
};

/** A producer of `MatchSnapshot`s, shaped for React's `useSyncExternalStore`. */
export interface MatchSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): MatchSnapshot;
  /** Sends a rules action for the view on screen; returns its actionId, or null if not sent. */
  sendAction(action: ActionMessage['action']): string | null;
  sendIncrement(amount: IncrementAmount): string | null;
  setReady(ready: boolean): void;
  /** Leaves on purpose; nothing happens on this source afterwards. */
  leave(): void;
}
