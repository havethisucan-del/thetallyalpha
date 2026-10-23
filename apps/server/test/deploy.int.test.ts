import { randomUUID } from 'node:crypto';
import {
  ApiRoute,
  ClientMessage,
  errorBodySchema,
  ServerMessage,
  type ActionResultMessage,
  type MatchViewMessage,
} from '@cartignon/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  closeAll,
  connect,
  newPlayer,
  rejection,
  startTestServer,
  waitFor,
  type Connection,
  type TestServer,
} from './helpers.js';

// Deployment-like settings: a reverse proxy on loopback, secure cookies, a small room cap
// and short room timers.
let t: TestServer;
const open: Connection[] = [];
let ipCounter = 0;
/** A distinct client address per agent (we sit behind the trusted loopback "proxy"). */
const nextIp = () => ({ 'x-forwarded-for': `198.51.100.${String(++ipCounter)}` });

beforeAll(async () => {
  t = await startTestServer({
    env: {
      TRUSTED_PROXY: 'loopback',
      COOKIE_SECURE: 'true',
      MAX_LIVE_ROOMS: '3',
      SEAT_CLAIM_TIMEOUT_SECONDS: '1',
      ROOM_FINISHED_TTL_SECONDS: '1',
      ROOM_MAX_LIFETIME_MINUTES: '0.1', // 6 s
      MATCH_RULES: 'synthetic', // plays a short counter match to the end
    },
    rateLimits: { joinPerIp: { burst: 2, perMinute: 0.001 } },
  });
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

function leaveCode(c: Connection): Promise<number> {
  return new Promise((resolve) => {
    c.room.onLeave((code: number) => {
      resolve(code);
    });
  });
}

describe('secure cookie', () => {
  it('uses the __Host- prefixed, Secure cookie and accepts it back', async () => {
    const p = await newPlayer(t.url, nextIp());
    expect(p.agent.cookie).toMatch(/^__Host-cartignon_session=[A-Za-z0-9_-]{43}$/);
    const res = await p.agent.post(ApiRoute.Logout);
    const [cleared] = res.headers.getSetCookie();
    expect(cleared).toMatch(/^__Host-cartignon_session=;/);
    const again = await newPlayer(t.url, nextIp());
    const set = (await again.agent.post(ApiRoute.GuestSession)).headers.getSetCookie();
    expect(set).toEqual([]); // existing session: no new cookie
    expect((await again.agent.get(ApiRoute.Session)).status).toBe(200);
  });

  it('cookie attributes satisfy the __Host- rules', async () => {
    const res = await fetch(`${t.url}${ApiRoute.GuestSession}`, {
      method: 'POST',
      headers: { 'x-cartignon-csrf': '1', ...nextIp() },
    });
    const [cookie] = res.headers.getSetCookie();
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie?.toLowerCase()).not.toContain('domain=');
  });
});

describe('trusted proxy', () => {
  it('keys rate limits by the right-most X-Forwarded-For entry, IPv6 by /64', async () => {
    const join = async (xff: string) => {
      const p = await newPlayer(t.url, { 'x-forwarded-for': xff });
      return (await p.agent.post(ApiRoute.JoinPrivateRoom, { code: 'ZZZZZZ' })).status;
    };
    expect([await join('10.0.0.1'), await join('10.0.0.1'), await join('10.0.0.1')]).toEqual([
      404, 404, 429,
    ]);
    expect(await join('10.0.0.2')).toBe(404);
    // A client-supplied left part cannot pick a fresh bucket.
    expect(await join('203.0.113.9, 10.0.0.1')).toBe(429);
    // IPv4-mapped IPv6 is the same client as plain IPv4.
    expect(await join('::ffff:10.0.0.1')).toBe(429);
    // One /64 is one bucket.
    expect(await join('2001:db8:1:2::1')).toBe(404);
    expect(await join('2001:db8:1:2::abcd')).toBe(404);
    expect(await join('2001:db8:1:2:ffff::9')).toBe(429);
    expect(await join('2001:db8:1:3::1')).toBe(404);
  });
});

describe('room lifecycle timers', () => {
  it('a lobby guest who never connects loses the seat; the next player gets it', async () => {
    const host = await newPlayer(t.url, nextIp());
    const ghost = await newPlayer(t.url, nextIp());
    const next = await newPlayer(t.url, nextIp());
    const created = await host.agent.createRoom();
    const a = await track(connect(t.url, created));
    const ghostTicket = await ghost.agent.joinRoom(created.code ?? '');
    await waitFor(
      () => (a.state()['players'] as Record<string, unknown>)['1'] !== undefined,
      'ghost seat shown',
    );
    await waitFor(
      () => (a.state()['players'] as Record<string, unknown>)['1'] === undefined,
      'ghost seat released',
    );
    expect(t.server.registry.get(created.roomId)?.seats[1]).toBeUndefined();
    expect(String(await rejection(connect(t.url, ghostTicket)))).toContain(
      'invalid or expired ticket',
    );
    const b = await track(connect(t.url, await next.agent.joinRoom(created.code ?? '')));
    await waitFor(() => b.ofType(ServerMessage.Welcome).length === 1);
    expect(b.ofType(ServerMessage.Welcome)).toEqual([{ seat: 1 }]);
  });

  it('a finished match is disposed after ROOM_FINISHED_TTL_SECONDS', async () => {
    const host = await newPlayer(t.url, nextIp());
    const guest = await newPlayer(t.url, nextIp());
    const created = await host.agent.createRoom();
    const seats = [
      await track(connect(t.url, created)),
      await track(connect(t.url, await guest.agent.joinRoom(created.code ?? ''))),
    ];
    for (const c of seats) c.room.send(ClientMessage.Ready, { ready: true });
    const views = (c: Connection) => c.ofType<MatchViewMessage>(ServerMessage.View);
    const latest = (c: Connection) => views(c)[views(c).length - 1];
    await waitFor(() => seats.every((c) => views(c).length === 1), 'match started');

    while (latest(seats[0] as Connection)?.outcome === null) {
      const active = latest(seats[0] as Connection)?.phase.activeSeat ?? 0;
      const conn = seats[active] as Connection;
      const actionId = randomUUID();
      conn.room.send(ClientMessage.Action, {
        actionId,
        expectedRevision: latest(conn)?.revision ?? 0,
        action: { type: 'increment', v: 1, payload: { amount: 3 } },
      });
      await waitFor(
        () =>
          conn
            .ofType<ActionResultMessage>(ServerMessage.ActionResult)
            .some((r) => r.actionId === actionId),
        'action result',
      );
      const revision = latest(conn)?.revision;
      await waitFor(() => seats.every((c) => latest(c)?.revision === revision), 'views');
    }
    const codes = seats.map(leaveCode);
    await waitFor(() => t.server.registry.get(created.roomId) === undefined, 'finished disposal');
    expect(await Promise.all(codes)).toEqual([4000, 4000]);
  });

  it('a room is disposed at ROOM_MAX_LIFETIME_MINUTES even while in use', async () => {
    const host = await newPlayer(t.url, nextIp());
    const created = await host.agent.createRoom();
    const a = await track(connect(t.url, created));
    const left = leaveCode(a);
    await waitFor(() => t.server.registry.get(created.roomId) === undefined, 'lifetime', 10_000);
    expect(await left).toBe(4000);
  }, 20_000);
});

describe('capacity', () => {
  it('room creation is refused with 503 UNAVAILABLE at MAX_LIVE_ROOMS', async () => {
    let refused: { status: number; body: unknown } | undefined;
    for (let i = 0; i < 5 && refused === undefined; i++) {
      const p = await newPlayer(t.url, nextIp());
      const res = await p.agent.post(ApiRoute.CreatePrivateRoom);
      if (res.status !== 201) refused = res;
    }
    expect(refused?.status).toBe(503);
    expect(errorBodySchema.parse(refused?.body).error.code).toBe('UNAVAILABLE');
    expect(t.server.registry.allocatedRoomCount).toBe(3);
  });
});
