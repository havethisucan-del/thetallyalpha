import { ApiRoute, ClientMessage, errorBodySchema } from '@cartignon/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  closeAll,
  connect,
  newPlayer,
  rejection,
  startTestServer,
  waitFor,
  WEB_ORIGIN,
  type Connection,
  type TestServer,
} from './helpers.js';

// Tight limits and a short idle timeout, isolated in their own server.
const IDLE_MINUTES = 0.01; // 600 ms
const WS_CONNECT_BURST = 6;
const MATCHMAKE_BURST = 6;

let t: TestServer;
const open: Connection[] = [];

beforeAll(async () => {
  t = await startTestServer({
    env: { ROOM_IDLE_TIMEOUT_MINUTES: String(IDLE_MINUTES) },
    rateLimits: {
      joinPerIdentity: { burst: 3, perMinute: 0.001 },
      joinPerIp: { burst: 8, perMinute: 0.001 },
      wsConnectPerIp: { burst: WS_CONNECT_BURST, perMinute: 0.001 },
      matchmakePerIp: { burst: MATCHMAKE_BURST, perMinute: 0.001 },
      wsMessagesPerSecond: 5,
    },
  });
});

afterEach(async () => {
  await closeAll(open);
});

afterAll(async () => {
  await t.stop();
});

function errorCode(body: unknown): string {
  return errorBodySchema.parse(body).error.code;
}

describe('rate limits', () => {
  it('JoinPrivateRoom is limited per identity and per IP (429)', async () => {
    const a = await newPlayer(t.url);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await a.agent.post(ApiRoute.JoinPrivateRoom, { code: 'ZZZZZZ' });
      statuses.push(res.status);
      if (res.status === 429) expect(errorCode(res.body)).toBe('RATE_LIMITED');
    }
    expect(statuses).toEqual([404, 404, 404, 429, 429]);

    // Fresh identities from the same IP run into the per-IP bucket (8 total, 5 used above).
    // A spoofed X-Forwarded-For changes nothing: no proxy is trusted by default.
    const others = await Promise.all(
      [1, 2, 3, 4].map((i) => newPlayer(t.url, { 'x-forwarded-for': `10.9.0.${i}` })),
    );
    const more = [];
    for (const o of others) {
      more.push((await o.agent.post(ApiRoute.JoinPrivateRoom, { code: 'ZZZZZZ' })).status);
    }
    expect(more).toEqual([404, 404, 404, 429]);
  });

  it('a client flooding messages is disconnected', async () => {
    const p = await newPlayer(t.url);
    const created = await p.agent.createRoom();
    const c = await connect(t.url, created);
    open.push(c);
    const left = new Promise<number>((resolve) => {
      c.room.onLeave((code: number) => {
        resolve(code);
      });
    });
    for (let i = 0; i < 40; i++) c.room.send(ClientMessage.Ready, { ready: i % 2 === 0 });
    expect(await left).toBe(4002); // Colyseus CloseCode.WITH_ERROR
  });
});

describe('inactivity cleanup', () => {
  it('a room nobody is connected to is disposed; its code and tickets die with it', async () => {
    const p = await newPlayer(t.url);
    const created = await p.agent.createRoom();
    await waitFor(() => t.server.registry.get(created.roomId) === undefined, 'idle disposal');

    // A ticket issued before the disposal can no longer be redeemed (the room is gone, and
    // disposal also invalidated the room's tickets).
    const late = await rejection(connect(t.url, created));
    expect(String(late)).toMatch(/not found|invalid or expired ticket/);

    // The code is freed (a join would be 404; the join bucket is spent by the test above).
    expect(t.server.registry.findByCode(created.code ?? '')).toBeUndefined();
    const ticket = await p.agent.post(ApiRoute.RoomTicket, { roomId: created.roomId });
    expect(ticket.status).toBe(410);
    expect(errorCode(ticket.body)).toBe('ROOM_EXPIRED');
  });

  it('a connected room is kept; the idle clock starts when the last client leaves', async () => {
    const p = await newPlayer(t.url);
    const created = await p.agent.createRoom();
    const c = await connect(t.url, created);
    await new Promise((resolve) => setTimeout(resolve, IDLE_MINUTES * 60_000 * 2));
    expect(t.server.registry.get(created.roomId)).toBeDefined();
    await c.room.leave();
    await waitFor(() => t.server.registry.get(created.roomId) === undefined, 'idle disposal');
  });
});

describe('connection limits', () => {
  it('WebSocket connection attempts are limited per IP', async () => {
    // Earlier tests in this file connected twice.
    const outcomes = await Promise.all(
      Array.from(
        { length: 8 },
        () =>
          new Promise<'open' | 'refused'>((resolve) => {
            const ws = new WebSocket(t.url.replace('http', 'ws'), {
              headers: { origin: WEB_ORIGIN },
            });
            ws.onopen = () => {
              resolve('open');
              ws.close();
            };
            ws.onerror = () => {
              resolve('refused');
            };
          }),
      ),
    );
    expect(outcomes.filter((o) => o === 'open')).toHaveLength(WS_CONNECT_BURST - 2);
    expect(outcomes.filter((o) => o === 'refused')).toHaveLength(8 - (WS_CONNECT_BURST - 2));
  });

  it('matchmaking requests are limited per IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${t.url}/matchmake/joinById/doesnotexist`, {
        method: 'POST',
        headers: { origin: WEB_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ ticket: 'x'.repeat(32) }),
      });
      statuses.push(res.status);
    }
    // Three matchmaking requests were spent above (two SDK joins, one late-ticket attempt).
    expect(statuses.filter((s) => s === 429)).toHaveLength(6 - (MATCHMAKE_BURST - 3));
    expect(statuses.slice(0, MATCHMAKE_BURST - 3).every((s) => s !== 429)).toBe(true);
  });
});
