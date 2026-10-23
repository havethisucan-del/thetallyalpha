import { ServerMessage, type ClockView, type RoomAdmission } from '@cartignon/protocol';
import { describe, expect, it } from 'vitest';
import { MatchConnection, type MatchRoom } from '../src/net/matchConnection';

const matchId = '0b6f6f5e-6a4c-4c1e-9f0a-2d6a4a3c1b2e';
const otherMatchId = '1c7a7a6f-7b5d-4d2f-8a1b-3e7b5b4d2c3f';

class FakeRoom implements MatchRoom {
  reconnection = { enabled: true };
  state: unknown = undefined;
  readonly #messages = new Map<string, (payload: unknown) => void>();
  onStateChange() {
    /* not exercised */
  }
  onMessage(type: string, callback: (payload: unknown) => void) {
    this.#messages.set(type, callback);
  }
  onError() {
    /* not exercised */
  }
  onLeave() {
    /* not exercised */
  }
  send() {
    /* not exercised */
  }
  leave() {
    return Promise.resolve(4000);
  }
  emit(type: string, payload: unknown) {
    this.#messages.get(type)?.(payload);
  }
}

function clock(overrides: Partial<ClockView> = {}): ClockView {
  return {
    seat: 0,
    mode: 'turn',
    running: true,
    remainingMs: 900_000,
    deadline: 1_900_000,
    serverTime: 1_000_000,
    pauseLeftMs: [180_000, 180_000],
    consecutiveTimeouts: [0, 0],
    ...overrides,
  };
}

function view(revision: number, viewClock: ClockView | null = clock()) {
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
    clock: viewClock,
    cause: 'action',
  };
}

async function connected() {
  const room = new FakeRoom();
  let now = 100;
  const connection = new MatchConnection(
    { getRoomTicket: () => Promise.reject(new Error()) },
    { joinById: () => Promise.resolve(room) },
    { now: () => now },
  );
  const admission = {
    roomId: 'room-1',
    code: 'ABCDEF',
    ticket: 'ticket-0123456789abcdef',
  } as RoomAdmission;
  await connection.connect(admission);
  return {
    room,
    connection,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe('MatchConnection clock', () => {
  it('starts without a clock', async () => {
    const { connection } = await connected();
    expect(connection.getSnapshot()).toMatchObject({ clock: null, clockReceivedAt: null });
  });

  it('takes the clock from an accepted view and stamps the receipt time', async () => {
    const { room, connection, setNow } = await connected();
    setNow(250);
    room.emit(ServerMessage.View, view(3));
    expect(connection.getSnapshot().clock).toEqual(clock());
    expect(connection.getSnapshot().clockReceivedAt).toBe(250);

    // A stale view changes nothing, the clock included.
    setNow(400);
    room.emit(ServerMessage.View, view(2, clock({ remainingMs: 1 })));
    expect(connection.getSnapshot().clock?.remainingMs).toBe(900_000);
    expect(connection.getSnapshot().clockReceivedAt).toBe(250);
  });

  it('handles a view with clock: null', async () => {
    const { room, connection } = await connected();
    room.emit(ServerMessage.View, view(3));
    room.emit(ServerMessage.View, view(4, null));
    expect(connection.getSnapshot().clock).toBeNull();
    expect(connection.getSnapshot().view?.revision).toBe(4);
  });

  it('applies match:clock for the current match and revision', async () => {
    const { room, connection, setNow } = await connected();
    room.emit(ServerMessage.View, view(3));
    setNow(900);
    const paused = clock({ running: false, deadline: null, remainingMs: 600_000 });
    room.emit(ServerMessage.Clock, { matchId, revision: 3, clock: paused });
    expect(connection.getSnapshot().clock).toEqual(paused);
    expect(connection.getSnapshot().clockReceivedAt).toBe(900);
    expect(connection.getSnapshot().view?.revision).toBe(3);
    expect(connection.getSnapshot().error).toBeNull();

    room.emit(ServerMessage.Clock, { matchId, revision: 3, clock: null });
    expect(connection.getSnapshot().clock).toBeNull();
  });

  it('ignores match:clock for an older revision, another match or before any view', async () => {
    const { room, connection } = await connected();
    room.emit(ServerMessage.Clock, { matchId, revision: 0, clock: clock() });
    expect(connection.getSnapshot().clock).toBeNull();

    room.emit(ServerMessage.View, view(5));
    room.emit(ServerMessage.Clock, { matchId, revision: 4, clock: null });
    room.emit(ServerMessage.Clock, { matchId: otherMatchId, revision: 9, clock: null });
    expect(connection.getSnapshot().clock).toEqual(clock());
  });

  it('reports an invalid match:clock and keeps the last clock', async () => {
    const { room, connection } = await connected();
    room.emit(ServerMessage.View, view(3));
    room.emit(ServerMessage.Clock, { matchId, revision: 3, clock: { ...clock(), extra: 1 } });
    expect(connection.getSnapshot().clock).toEqual(clock());
    expect(connection.getSnapshot().error).toMatch(/invalid clock data/);
    // The next valid view clears it, as for other invalid view data.
    room.emit(ServerMessage.View, view(4));
    expect(connection.getSnapshot().error).toBeNull();
  });
});
