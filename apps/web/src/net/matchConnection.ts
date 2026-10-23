import {
  ClientMessage,
  ServerMessage,
  actionMessageSchema,
  actionResultMessageSchema,
  clockMessageSchema,
  matchViewMessageSchema,
  readyMessageSchema,
  serverErrorMessageSchema,
  welcomeMessageSchema,
  type ActionMessage,
  type MatchJoinOptions,
  type RoomAdmission,
} from '@cartignon/protocol';
import { Client, CloseCode, type Room } from '@colyseus/sdk';
import { ApiError, type ApiClient, type ApiFailure } from '../lib/api';
import {
  appendEventLog,
  parseCartignonView,
  rendererFor,
  type CartignonViewParts,
} from '../lib/cartignon';
import { readRoomState } from '../lib/roomState';
import { randomUuid } from '../lib/secureContext';
import { monotonicNow } from '../match/cartignon/clock';
import { incrementAction, type IncrementAmount } from '../lib/synthetic';
import { rejoinDelayMs, shouldAcceptView } from '../lib/views';
import {
  IDLE_SNAPSHOT,
  type ConnectionStatus,
  type MatchSnapshot,
  type MatchSource,
} from './matchSource';

export { IDLE_SNAPSHOT };
export type { ConnectionStatus, MatchSnapshot };

/** The subset of a Colyseus `Room` this module uses (lets tests supply a fake). */
export interface MatchRoom {
  reconnection: { enabled: boolean };
  readonly state: unknown;
  onStateChange(callback: (state: unknown) => void): unknown;
  onMessage(type: string, callback: (payload: unknown) => void): unknown;
  onError(callback: (code: number, message?: string) => void): unknown;
  onLeave(callback: (code: number, reason?: string) => void): unknown;
  send(type: string, payload: unknown): void;
  leave(consented?: boolean): Promise<number>;
}

export interface GameClient {
  joinById(roomId: string, options: MatchJoinOptions): Promise<MatchRoom>;
}

export type TicketSource = Pick<ApiClient, 'getRoomTicket'>;

export interface MatchConnectionOptions {
  /** Delay used between rejoin attempts; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Local time stamped on received clocks; injectable for tests. Defaults to `monotonicNow`
   * (`performance.now()`): only elapsed local time matters, and it must not jump with the wall
   * clock. Display code must read the same source.
   */
  now?: () => number;
}

/** Adapts the Colyseus SDK client to `GameClient`. */
export function createSdkClient(endpoint: string): GameClient {
  const client = new Client(endpoint);
  return {
    async joinById(roomId, options) {
      const room: Room = await client.joinById(roomId, options);
      return room;
    },
  };
}

const MAX_REJOIN_ATTEMPTS = 5;

/** Ticket errors after which another attempt cannot succeed. */
const FATAL_TICKET_ERRORS: ReadonlySet<ApiFailure> = new Set<ApiFailure>([
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'ROOM_FULL',
  'ROOM_EXPIRED',
]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Where the current `error` came from, so it can be cleared when its cause goes away:
 * `state` / `view` (invalid data, cleared by the next valid one), `server` (a server `error`
 * message, transient: cleared on a phase change or the first view), `connection`.
 */
type ErrorKind = 'state' | 'view' | 'server' | 'connection';

/**
 * One match-room connection: presentation state only. Everything shown comes from validated
 * server data; nothing is computed or cached locally. Rejoin always uses a fresh ticket.
 *
 * Exposes `subscribe` / `getSnapshot` for React's `useSyncExternalStore`.
 */
export class MatchConnection implements MatchSource {
  readonly #api: TicketSource;
  readonly #client: GameClient;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #listeners = new Set<() => void>();
  #snapshot: MatchSnapshot = IDLE_SNAPSHOT;
  #errorKind: ErrorKind | null = null;
  #room: MatchRoom | null = null;
  /** Incremented on connect/leave; stale async work compares and bails out. */
  #generation = 0;

  constructor(
    api: TicketSource,
    client: string | GameClient,
    options: MatchConnectionOptions = {},
  ) {
    this.#api = api;
    this.#client = typeof client === 'string' ? createSdkClient(client) : client;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#now = options.now ?? monotonicNow;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = (): MatchSnapshot => this.#snapshot;

  #update(patch: Partial<MatchSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }

  #setError(kind: ErrorKind, message: string, patch: Partial<MatchSnapshot> = {}): void {
    this.#errorKind = kind;
    this.#update({ ...patch, error: message });
  }

  /** Clears the error (all kinds when `kinds` is omitted) and applies `patch`. */
  #clearError(patch: Partial<MatchSnapshot>, kinds?: readonly ErrorKind[]): void {
    const clear =
      this.#errorKind !== null && (kinds === undefined || kinds.includes(this.#errorKind));
    if (clear) this.#errorKind = null;
    this.#update(clear ? { ...patch, error: null } : patch);
  }

  async connect(admission: RoomAdmission): Promise<boolean> {
    const generation = ++this.#generation;
    this.#errorKind = null;
    this.#update({
      ...IDLE_SNAPSHOT,
      status: 'connecting',
      roomId: admission.roomId,
      inviteCode: admission.code,
    });
    try {
      const room = await this.#join(admission);
      if (generation !== this.#generation) {
        void room.leave(true);
        return false;
      }
      this.#clearError({ status: 'connected' });
      this.#attach(room, generation);
      return true;
    } catch {
      if (generation === this.#generation) {
        this.#setError('connection', 'Could not join the room.', { status: 'disconnected' });
      }
      return false;
    }
  }

  /** Leaves on purpose; no rejoin follows. */
  leave(): void {
    this.#generation++;
    const room = this.#room;
    this.#room = null;
    if (room) void room.leave(true);
    this.#update({ status: 'disconnected' });
  }

  setReady(ready: boolean): void {
    const message = readyMessageSchema.parse({ ready });
    this.#send(ClientMessage.Ready, message);
  }

  sendIncrement(amount: IncrementAmount): string | null {
    return this.sendAction(incrementAction(amount));
  }

  /**
   * Sends a rules action for the view on screen; returns its actionId, or null when there is no
   * view or no connection. The server rejects actions made for an older revision (STALE_REVISION).
   */
  sendAction(action: ActionMessage['action']): string | null {
    const view = this.#snapshot.view;
    if (!view) return null;
    const message: ActionMessage = actionMessageSchema.parse({
      actionId: randomUuid(), // crypto.randomUUID is missing over plain-http LAN (ADR-0013)
      expectedRevision: view.revision,
      action,
    });
    return this.#send(ClientMessage.Action, message) ? message.actionId : null;
  }

  #send(type: string, payload: unknown): boolean {
    const room = this.#room;
    if (!room || this.#snapshot.status !== 'connected') return false;
    room.send(type, payload);
    return true;
  }

  #join(admission: RoomAdmission): Promise<MatchRoom> {
    const options: MatchJoinOptions = { ticket: admission.ticket };
    return this.#client.joinById(admission.roomId, options);
  }

  #attach(room: MatchRoom, generation: number): void {
    // Rejoin is ticket-based (below); the SDK's token-based auto-reconnect is turned off so a
    // drop surfaces as onLeave.
    room.reconnection.enabled = false;
    this.#room = room;
    const isCurrent = () => this.#room === room && generation === this.#generation;

    room.onStateChange((state: unknown) => {
      if (isCurrent()) this.#applyState(state);
    });

    room.onMessage(ServerMessage.Welcome, (payload: unknown) => {
      if (!isCurrent()) return;
      const parsed = welcomeMessageSchema.safeParse(payload);
      if (parsed.success) this.#update({ seat: parsed.data.seat });
      else this.#setError('view', 'Received invalid data from the server.');
    });

    room.onMessage(ServerMessage.View, (payload: unknown) => {
      if (!isCurrent()) return;
      const parsed = matchViewMessageSchema.safeParse(payload);
      if (!parsed.success) {
        this.#setError('view', 'Received invalid match data from the server.');
        return;
      }
      const current = this.#snapshot.view;
      if (!shouldAcceptView(current, parsed.data)) return;
      const next = parsed.data;
      let cartignon: CartignonViewParts | null = null;
      if (rendererFor(next.rulesId) === 'cartignon') {
        cartignon = parseCartignonView(next);
        if (!cartignon) {
          this.#setError('view', 'Received invalid match data from the server.');
          return;
        }
      }
      const sameMatch = current !== null && current.matchId === next.matchId;
      const eventLog = cartignon
        ? appendEventLog(sameMatch ? this.#snapshot.eventLog : [], next.revision, cartignon.events)
        : [];
      const patch = {
        view: next,
        seat: next.seat,
        cartignon,
        eventLog,
        clock: next.clock,
        clockReceivedAt: this.#now(),
      };
      // The first view means the match started: lobby-time server errors no longer apply.
      this.#clearError(patch, current === null ? ['view', 'server'] : ['view']);
    });

    room.onMessage(ServerMessage.Clock, (payload: unknown) => {
      if (!isCurrent()) return;
      const parsed = clockMessageSchema.safeParse(payload);
      if (!parsed.success) {
        this.#setError('view', 'Received invalid clock data from the server.');
        return;
      }
      // A clock only applies to the match on screen, at its revision or a newer one.
      const current = this.#snapshot.view;
      const message = parsed.data;
      if (current?.matchId !== message.matchId || message.revision < current.revision) return;
      this.#update({ clock: message.clock, clockReceivedAt: this.#now() });
    });

    room.onMessage(ServerMessage.ActionResult, (payload: unknown) => {
      if (!isCurrent()) return;
      const parsed = actionResultMessageSchema.safeParse(payload);
      if (parsed.success) this.#update({ lastResult: parsed.data });
    });

    room.onMessage(ServerMessage.Error, (payload: unknown) => {
      if (!isCurrent()) return;
      const parsed = serverErrorMessageSchema.safeParse(payload);
      this.#setError(
        'server',
        parsed.success ? parsed.data.message : 'The server reported an error.',
      );
    });

    room.onError(() => {
      if (isCurrent()) this.#setError('connection', 'Connection error.');
    });

    room.onLeave((code: number) => {
      if (!isCurrent()) return;
      this.#room = null;
      const finished = this.#snapshot.room?.phase === 'finished' || !!this.#snapshot.view?.outcome;
      if (finished || code === CloseCode.CONSENTED) {
        this.#update({ status: 'disconnected' });
        return;
      }
      void this.#rejoin(generation);
    });

    // Usually not decoded yet here: the server sends the first state after the join handshake,
    // so this is a no-op and onStateChange delivers it.
    this.#applyState(room.state);
  }

  #applyState(state: unknown): void {
    // Not received yet (no state object, or a schema instance whose fields are still unset).
    if (typeof state !== 'object' || state === null) return;
    if ((state as { phase?: unknown }).phase === undefined) return;

    const snapshot = readRoomState(state);
    if (!snapshot) {
      this.#setError('state', 'Received invalid room state from the server.');
      return;
    }
    const phaseChanged = this.#snapshot.room?.phase !== snapshot.phase;
    this.#clearError({ room: snapshot }, phaseChanged ? ['state', 'server'] : ['state']);
  }

  async #rejoin(generation: number): Promise<void> {
    const roomId = this.#snapshot.roomId;
    if (roomId === null) return;
    this.#clearError({ status: 'reconnecting' });

    for (let attempt = 1; attempt <= MAX_REJOIN_ATTEMPTS; attempt++) {
      await this.#sleep(rejoinDelayMs(attempt));
      if (generation !== this.#generation) return;
      try {
        const admission = await this.#api.getRoomTicket(roomId);
        if (generation !== this.#generation) return;
        const room = await this.#join(admission);
        if (generation !== this.#generation) {
          void room.leave(true);
          return;
        }
        this.#clearError({ status: 'connected' });
        this.#attach(room, generation);
        return;
      } catch (error) {
        if (generation !== this.#generation) return;
        if (error instanceof ApiError && FATAL_TICKET_ERRORS.has(error.code)) {
          this.#setError('connection', error.message, { status: 'disconnected' });
          return;
        }
      }
    }
    this.#setError('connection', 'Lost the connection to the match.', { status: 'disconnected' });
  }
}
