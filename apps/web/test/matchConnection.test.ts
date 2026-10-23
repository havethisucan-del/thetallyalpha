import { ServerMessage, type MatchJoinOptions, type RoomAdmission } from '@cartignon/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  MatchConnection,
  type GameClient,
  type MatchRoom,
  type TicketSource,
} from '../src/net/matchConnection';

const matchId = '0b6f6f5e-6a4c-4c1e-9f0a-2d6a4a3c1b2e';
const ABNORMAL_CLOSURE = 1006;
const CONSENTED = 4000;

class FakeRoom implements MatchRoom {
  reconnection = { enabled: true };
  state: unknown;
  sent: [string, unknown][] = [];
  leaveCalls = 0;
  readonly #state: ((state: unknown) => void)[] = [];
  readonly #messages = new Map<string, (payload: unknown) => void>();
  readonly #leave: ((code: number) => void)[] = [];

  constructor(state: unknown) {
    this.state = state;
  }

  onStateChange(callback: (state: unknown) => void) {
    this.#state.push(callback);
  }
  onMessage(type: string, callback: (payload: unknown) => void) {
    this.#messages.set(type, callback);
  }
  onError() {
    /* not exercised */
  }
  onLeave(callback: (code: number) => void) {
    this.#leave.push(callback);
  }
  send(type: string, payload: unknown) {
    this.sent.push([type, payload]);
  }
  leave() {
    this.leaveCalls++;
    return Promise.resolve(CONSENTED);
  }

  emitState(state: unknown) {
    this.state = state;
    for (const callback of this.#state) callback(state);
  }
  emit(type: string, payload: unknown) {
    this.#messages.get(type)?.(payload);
  }
  close(code: number) {
    for (const callback of this.#leave) callback(code);
  }
}

/** Joins resolve with queued rooms (or wait on a manual deferred); every ticket is recorded. */
class FakeClient implements GameClient {
  readonly joins: { roomId: string; ticket: string }[] = [];
  readonly rooms: FakeRoom[] = [];
  #pending: ((room: FakeRoom) => void) | null = null;
  manual = false;

  joinById(roomId: string, options: MatchJoinOptions): Promise<MatchRoom> {
    this.joins.push({ roomId, ticket: options.ticket });
    const room = new FakeRoom(undecodedState());
    this.rooms.push(room);
    if (!this.manual) return Promise.resolve(room);
    return new Promise((resolve) => {
      this.#pending = () => {
        resolve(room);
      };
    });
  }

  resolvePending() {
    const room = this.rooms.at(-1);
    if (room && this.#pending) this.#pending(room);
  }
}

class FakeTickets implements TicketSource {
  readonly calls: string[] = [];
  #next = 1;
  getRoomTicket(roomId: string): Promise<RoomAdmission> {
    this.calls.push(roomId);
    return Promise.resolve(admission(roomId, `fresh-ticket-${this.#next++}`.padEnd(20, 'x')));
  }
}

function admission(roomId = 'room-1', ticket = 'initial-ticket'.padEnd(20, 'x')): RoomAdmission {
  return { roomId, code: 'ABC234', ticket, ticketExpiresAt: '2026-10-18T12:00:30.000Z' };
}

/** What a reflected Colyseus schema looks like before its first patch: fields unset. */
function undecodedState() {
  return { phase: undefined, code: undefined, players: undefined };
}

function lobbyState(phase = 'lobby') {
  return {
    phase,
    code: 'ABC234',
    players: new Map([['0', { displayName: 'Ana', ready: false, connected: true }]]),
  };
}

function view(revision: number) {
  return {
    matchId,
    seat: 0,
    revision,
    rulesId: 'synthetic',
    rulesVersion: 'synthetic-1',
    phase: { id: 'play', activeSeat: 0, turnSeat: 0 },
    public: { phase: 'play', activeSeat: 0, counter: revision, target: 10, secretCounts: [1, 1] },
    private: { seat: 0, secrets: [3] },
    events: [],
    outcome: null,
    clock: null,
    cause: 'action',
  };
}

function setup() {
  const client = new FakeClient();
  const tickets = new FakeTickets();
  const connection = new MatchConnection(tickets, client, { sleep: () => Promise.resolve() });
  return { client, tickets, connection };
}

describe('MatchConnection', () => {
  it('treats an undecoded initial state as not received (no error)', async () => {
    const { client, connection } = setup();
    expect(await connection.connect(admission())).toBe(true);
    const snapshot = connection.getSnapshot();
    expect(snapshot.status).toBe('connected');
    expect(snapshot.error).toBeNull();
    expect(snapshot.room).toBeNull();
    expect(client.rooms[0]?.reconnection.enabled).toBe(false);
  });

  it('renders a valid state delivered by onStateChange', async () => {
    const { client, connection } = setup();
    await connection.connect(admission());
    client.rooms[0]?.emitState(lobbyState());
    expect(connection.getSnapshot().room).toEqual({
      phase: 'lobby',
      code: 'ABC234',
      seats: [{ displayName: 'Ana', ready: false, connected: true }, null],
    });
    expect(connection.getSnapshot().error).toBeNull();
  });

  it('reports a decoded but invalid state, and clears it on the next valid one', async () => {
    const { client, connection } = setup();
    await connection.connect(admission());
    const room = client.rooms[0];
    room?.emitState({ phase: 'lobby', code: 42, players: new Map() });
    expect(connection.getSnapshot().error).toMatch(/invalid room state/);
    expect(connection.getSnapshot().room).toBeNull();
    room?.emitState(lobbyState());
    expect(connection.getSnapshot().error).toBeNull();
    expect(connection.getSnapshot().room?.phase).toBe('lobby');
  });

  it('clears a lobby-time server error when the match starts', async () => {
    const { client, connection } = setup();
    await connection.connect(admission());
    const room = client.rooms[0];
    room?.emitState(lobbyState());
    room?.emit(ServerMessage.Error, { code: 'CONFLICT', message: 'Match already started.' });
    expect(connection.getSnapshot().error).toBe('Match already started.');
    // Same phase: the error stays.
    room?.emitState(lobbyState());
    expect(connection.getSnapshot().error).toBe('Match already started.');
    room?.emit(ServerMessage.View, view(1));
    expect(connection.getSnapshot().error).toBeNull();

    room?.emit(ServerMessage.Error, { code: 'CONFLICT', message: 'Again.' });
    room?.emitState(lobbyState('active'));
    expect(connection.getSnapshot().error).toBeNull();
  });

  it('drops views with a lower revision', async () => {
    const { client, connection } = setup();
    await connection.connect(admission());
    const room = client.rooms[0];
    room?.emit(ServerMessage.View, view(5));
    room?.emit(ServerMessage.View, view(4));
    expect(connection.getSnapshot().view?.revision).toBe(5);
    room?.emit(ServerMessage.View, view(6));
    expect(connection.getSnapshot().view?.revision).toBe(6);
    room?.emit(ServerMessage.View, { ...view(7), matchId: 'not-a-uuid' });
    expect(connection.getSnapshot().view?.revision).toBe(6);
    expect(connection.getSnapshot().error).toMatch(/invalid match data/);
  });

  it('rejoins after a drop with a fresh ticket each time, never reusing one', async () => {
    const { client, tickets, connection } = setup();
    await connection.connect(admission());
    client.rooms[0]?.emitState(lobbyState());

    client.rooms[0]?.close(ABNORMAL_CLOSURE);
    expect(connection.getSnapshot().status).toBe('reconnecting');
    await vi.waitFor(() => {
      expect(connection.getSnapshot().status).toBe('connected');
    });

    client.rooms[1]?.close(ABNORMAL_CLOSURE);
    await vi.waitFor(() => {
      expect(client.joins).toHaveLength(3);
      expect(connection.getSnapshot().status).toBe('connected');
    });

    expect(tickets.calls).toEqual(['room-1', 'room-1']);
    const used = client.joins.map((join) => join.ticket);
    expect(new Set(used).size).toBe(used.length);
    expect(client.joins.every((join) => join.roomId === 'room-1')).toBe(true);
    // The room state survives the rejoin until the new room sends its own.
    expect(connection.getSnapshot().room?.phase).toBe('lobby');
  });

  it('does not rejoin after a consented close', async () => {
    const { client, tickets, connection } = setup();
    await connection.connect(admission());
    client.rooms[0]?.close(CONSENTED);
    expect(connection.getSnapshot().status).toBe('disconnected');
    await Promise.resolve();
    expect(tickets.calls).toHaveLength(0);
  });

  it('ignores a join that resolves after leave()', async () => {
    const { client, connection } = setup();
    client.manual = true;
    const connected = connection.connect(admission());
    connection.leave();
    client.resolvePending();
    expect(await connected).toBe(false);
    const room = client.rooms[0];
    expect(room?.leaveCalls).toBe(1);
    expect(room?.reconnection.enabled).toBe(true); // never attached
    expect(connection.getSnapshot().status).toBe('disconnected');
  });

  it('stops a rejoin in progress when the player leaves', async () => {
    const client = new FakeClient();
    const tickets = new FakeTickets();
    let wake: () => void = () => undefined;
    const connection = new MatchConnection(tickets, client, {
      sleep: () =>
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
    });
    await connection.connect(admission());
    client.rooms[0]?.close(ABNORMAL_CLOSURE);
    expect(connection.getSnapshot().status).toBe('reconnecting');
    connection.leave();
    wake();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tickets.calls).toHaveLength(0);
    expect(client.joins).toHaveLength(1);
    expect(connection.getSnapshot().status).toBe('disconnected');
  });

  it('only sends while connected', async () => {
    const { client, connection } = setup();
    await connection.connect(admission());
    connection.setReady(true);
    expect(client.rooms[0]?.sent).toEqual([['ready', { ready: true }]]);
    connection.leave();
    expect(connection.sendIncrement(1)).toBeNull();
    expect(client.rooms[0]?.sent).toHaveLength(1);
  });
});
