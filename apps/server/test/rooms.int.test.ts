import {
  ApiRoute,
  errorBodySchema,
  INVITE_CODE_LENGTH,
  roomAdmissionSchema,
  ServerMessage,
  type WelcomeMessage,
} from '@cartignon/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  closeAll,
  connect,
  halfOpenJoin,
  matchmake,
  newPlayer,
  rejection,
  sdkClient,
  startTestServer,
  waitFor,
  EVIL_ORIGIN,
  type Connection,
  type TestServer,
} from './helpers.js';

let t: TestServer;
const open: Connection[] = [];

beforeAll(async () => {
  t = await startTestServer();
});

afterEach(async () => {
  await closeAll(open);
});

afterAll(async () => {
  await t.stop();
});

async function track(promise: Promise<Connection>): Promise<Connection> {
  const connection = await promise;
  open.push(connection);
  return connection;
}

function errorCode(body: unknown): string {
  return errorBodySchema.parse(body).error.code;
}

describe('private rooms', () => {
  it('create + join by code: both clients see each other in the synchronized state', async () => {
    const host = await newPlayer(t.url);
    const guest = await newPlayer(t.url);
    const created = await host.agent.createRoom();
    expect(created.code).toHaveLength(INVITE_CODE_LENGTH);
    const joined = await guest.agent.joinRoom(created.code ?? '');
    expect(joined.roomId).toBe(created.roomId);
    expect(joined.ticket).not.toBe(created.ticket);

    const a = await track(connect(t.url, created));
    const b = await track(connect(t.url, joined));
    await waitFor(() => a.ofType('welcome').length === 1 && b.ofType('welcome').length === 1);
    expect(a.ofType<WelcomeMessage>(ServerMessage.Welcome)).toEqual([{ seat: 0 }]);
    expect(b.ofType<WelcomeMessage>(ServerMessage.Welcome)).toEqual([{ seat: 1 }]);

    const expected = {
      phase: 'lobby',
      code: created.code,
      players: {
        '0': { displayName: host.me.player.displayName, ready: false, connected: true },
        '1': { displayName: guest.me.player.displayName, ready: false, connected: true },
      },
    };
    await waitFor(
      () =>
        JSON.stringify(a.state()) === JSON.stringify(expected) &&
        JSON.stringify(b.state()) === JSON.stringify(expected),
      'synchronized lobby state',
    );
    // No identities in the public state.
    const stateText = JSON.stringify([a.state(), b.state()]);
    expect(stateText).not.toContain(host.me.player.playerId);
    expect(stateText).not.toContain(guest.me.player.playerId);

    // Joining again by code returns the same seat (rejoin), not a new one.
    const again = await guest.agent.joinRoom(created.code ?? '');
    expect(again.roomId).toBe(created.roomId);
    const hostAgain = await host.agent.joinRoom(created.code ?? '');
    expect(hostAgain.roomId).toBe(created.roomId);
  });

  it('a third identity gets 409 ROOM_FULL and cannot connect with forged or reused tickets', async () => {
    const host = await newPlayer(t.url);
    const guest = await newPlayer(t.url);
    const intruder = await newPlayer(t.url);
    const created = await host.agent.createRoom();
    const joined = await guest.agent.joinRoom(created.code ?? '');
    const a = await track(connect(t.url, created));

    const full = await intruder.agent.post(ApiRoute.JoinPrivateRoom, { code: created.code });
    expect(full.status).toBe(409);
    expect(errorCode(full.body)).toBe('ROOM_FULL');
    const ticket = await intruder.agent.post(ApiRoute.RoomTicket, { roomId: created.roomId });
    expect(ticket.status).toBe(403);
    expect(errorCode(ticket.body)).toBe('FORBIDDEN');

    // Seat 1 is still free here, so each refusal below comes from ticket checks, not capacity.
    const forged = await rejection(
      connect(t.url, { roomId: created.roomId, ticket: 'f'.repeat(43) }),
    );
    expect(String(forged)).toContain('invalid or expired ticket');
    const other = await intruder.agent.createRoom();
    const wrongRoom = await rejection(
      connect(t.url, { roomId: created.roomId, ticket: other.ticket }),
    );
    expect(String(wrongRoom)).toContain('not valid for this room');

    const b = await track(connect(t.url, joined));
    await b.room.leave(); // consented leave in the lobby gives seat 1 back
    await waitFor(() => {
      const players = a.state()['players'] as Record<string, unknown>;
      return players['1'] === undefined;
    }, 'guest seat released');
    const reused = await rejection(connect(t.url, joined));
    expect(String(reused)).toContain('invalid or expired ticket');

    const back = await track(connect(t.url, await guest.agent.joinRoom(created.code ?? '')));
    expect(back.room.connection.isOpen).toBe(true);
    // The room survived all of that.
    await waitFor(() => {
      const players = a.state()['players'] as Record<string, { connected: boolean }>;
      return players['0']?.connected === true && players['1']?.connected === true;
    });
    expect(a.room.connection.isOpen).toBe(true);
  });

  it('concurrent joins by many identities seat exactly one guest', async () => {
    const host = await newPlayer(t.url);
    const created = await host.agent.createRoom();
    const players = await Promise.all(Array.from({ length: 12 }, () => newPlayer(t.url)));
    const results = await Promise.all(
      players.map((p) => p.agent.post(ApiRoute.JoinPrivateRoom, { code: created.code })),
    );
    const seated = results.filter((r) => r.status === 200);
    const full = results.filter((r) => r.status === 409);
    expect(seated).toHaveLength(1);
    expect(full).toHaveLength(11);
    for (const r of full) expect(errorCode(r.body)).toBe('ROOM_FULL');
    expect(roomAdmissionSchema.parse(seated[0]?.body).roomId).toBe(created.roomId);
    const record = t.server.registry.get(created.roomId);
    expect(record?.seats.filter((s) => s !== undefined)).toHaveLength(2);
  });

  it('one identity joining concurrently many times holds a single seat', async () => {
    const host = await newPlayer(t.url);
    const guest = await newPlayer(t.url);
    const created = await host.agent.createRoom();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => guest.agent.joinRoom(created.code ?? '')),
    );
    expect(new Set(results.map((r) => r.roomId))).toEqual(new Set([created.roomId]));
    const record = t.server.registry.get(created.roomId);
    expect(record?.seats[1]?.identityId).toBe(guest.me.player.playerId);
    expect(record?.seats[0]?.identityId).toBe(host.me.player.playerId);
  });

  it('a second live connection for the same seat is rejected; the first keeps it', async () => {
    const host = await newPlayer(t.url);
    const created = await host.agent.createRoom();
    const first = await track(connect(t.url, created));
    const second = await host.agent.ticket(created.roomId);
    const duplicate = await rejection(connect(t.url, second));
    expect(String(duplicate)).toContain('seat already has a live connection');
    expect(first.room.connection.isOpen).toBe(true);
    await waitFor(() => first.ofType('welcome').length === 1);
  });

  it('unknown codes are 404, bad codes 400, unknown rooms 404, auth required', async () => {
    const p = await newPlayer(t.url);
    const unknown = await p.agent.post(ApiRoute.JoinPrivateRoom, { code: 'ZZZZZZ' });
    expect(unknown.status).toBe(404);
    expect(errorCode(unknown.body)).toBe('NOT_FOUND');
    const lower = await p.agent.post(ApiRoute.JoinPrivateRoom, { code: 'abcdef' });
    expect(lower.status).toBe(400);
    const noRoom = await p.agent.post(ApiRoute.RoomTicket, { roomId: 'doesnotexist' });
    expect(noRoom.status).toBe(404);

    const anon = await fetch(`${t.url}${ApiRoute.CreatePrivateRoom}`, {
      method: 'POST',
      headers: { 'x-cartignon-csrf': '1' },
    });
    expect(anon.status).toBe(401);
  });

  it('invalid join options and foreign origins are rejected; room survives', async () => {
    const host = await newPlayer(t.url);
    const created = await host.agent.createRoom();
    expect(String(await rejection(connect(t.url, created, {})))).toContain('invalid join options');
    const extra = await rejection(connect(t.url, created, { ticket: created.ticket, seat: 1 }));
    expect(String(extra)).toContain('invalid join options');
    // The strict-option failure above did not consume the ticket.
    const evil = sdkClient(t.url, EVIL_ORIGIN);
    await rejection(evil.joinById(created.roomId, { ticket: created.ticket }));
    const ok = await track(connect(t.url, created));
    await waitFor(() => ok.ofType('welcome').length === 1);
  });

  it('logs never contain tickets, session tokens or the database password', async () => {
    const host = await newPlayer(t.url);
    const created = await host.agent.createRoom();
    const c = await track(connect(t.url, created));
    await waitFor(() => c.ofType('welcome').length === 1);
    const token = (host.agent.cookie ?? '').split('=')[1] ?? '';
    expect(token.length).toBe(43);
    const text = t.logs.join('');
    expect(t.logs.length).toBeGreaterThan(0);
    expect(text).not.toContain(token);
    expect(text).not.toContain(created.ticket);
    const password = new URL(t.db.url).password;
    if (password !== '') expect(text).not.toContain(password);
    expect(text.toLowerCase()).not.toContain('cartignon_session=');
  });

  it('a reservation flood by one seat cannot lock the other seat out (H2)', async () => {
    const host = await newPlayer(t.url);
    const guest = await newPlayer(t.url);
    const created = await host.agent.createRoom();
    const joined = await guest.agent.joinRoom(created.code ?? '');
    // The host never opens a socket, only reserves seats over and over.
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const ticket = await host.agent.ticket(created.roomId);
      statuses.push((await matchmake(t.url, created.roomId, ticket.ticket)).status);
    }
    expect(statuses[0]).toBe(200);
    expect(statuses.slice(1).every((s) => s !== 200)).toBe(true); // one reservation per seat
    const b = await track(connect(t.url, joined));
    await waitFor(() => b.ofType('welcome').length === 1, 'guest joined despite the flood');
  });

  it('a new ticket revokes the previous one for the same identity and room', async () => {
    const host = await newPlayer(t.url);
    const created = await host.agent.createRoom();
    const fresh = await host.agent.ticket(created.roomId);
    expect(String(await rejection(connect(t.url, created)))).toContain('invalid or expired ticket');
    const c = await track(connect(t.url, fresh));
    await waitFor(() => c.ofType('welcome').length === 1);
  });

  it('logout drops the identity’s outstanding tickets', async () => {
    const host = await newPlayer(t.url);
    const created = await host.agent.createRoom();
    expect((await host.agent.post(ApiRoute.Logout)).status).toBe(204);
    expect(String(await rejection(connect(t.url, created)))).toContain('invalid or expired ticket');
  });

  it('a guest leaving the lobby on purpose frees the seat for someone else', async () => {
    const host = await newPlayer(t.url);
    const guest = await newPlayer(t.url);
    const third = await newPlayer(t.url);
    const created = await host.agent.createRoom();
    const a = await track(connect(t.url, created));
    const b = await connect(t.url, await guest.agent.joinRoom(created.code ?? ''));
    await waitFor(() => Object.keys(a.state()['players'] as object).length === 2, 'guest shown');
    await b.room.leave();
    await waitFor(
      () => (a.state()['players'] as Record<string, unknown>)['1'] === undefined,
      'seat released in public state',
    );
    expect(t.server.registry.get(created.roomId)?.seats[1]).toBeUndefined();
    const c = await track(connect(t.url, await third.agent.joinRoom(created.code ?? '')));
    await waitFor(() => c.ofType('welcome').length === 1);
    expect(c.ofType('welcome')).toEqual([{ seat: 1 }]);
  });

  it('rejoin while a half-open old socket still holds the seat succeeds after the heartbeat', async () => {
    const host = await newPlayer(t.url);
    const guest = await newPlayer(t.url);
    const created = await host.agent.createRoom();
    const a = await track(connect(t.url, created));
    const joined = await guest.agent.joinRoom(created.code ?? '');
    const stale = await halfOpenJoin(t.url, created.roomId, joined.ticket);
    try {
      await waitFor(() => {
        const players = a.state()['players'] as Record<string, { connected: boolean }>;
        return players['1']?.connected === true;
      }, 'half-open seat shown as connected');

      const first = await rejection(connect(t.url, await guest.agent.ticket(created.roomId)));
      expect(String(first)).toContain('seat already has a live connection');

      // Retry like a client would; the transport heartbeat (3 s x 2) reaps the dead socket.
      let back: Connection | undefined;
      const deadline = Date.now() + 20_000;
      while (back === undefined && Date.now() < deadline) {
        try {
          back = await connect(t.url, await guest.agent.ticket(created.roomId));
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      expect(back).toBeDefined();
      if (back !== undefined) {
        open.push(back);
        const rejoined = back;
        await waitFor(() => rejoined.ofType('welcome').length === 1, 'rejoined');
        expect(rejoined.ofType('welcome')).toEqual([{ seat: 1 }]);
      }
    } finally {
      stale.destroy();
    }
  }, 40_000);
});
