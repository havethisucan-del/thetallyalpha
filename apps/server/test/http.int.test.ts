import { randomBytes } from 'node:crypto';
import {
  ApiRoute,
  CSRF_HEADER,
  errorBodySchema,
  healthResponseSchema,
  MAX_HTTP_BODY_BYTES,
  sessionResponseSchema,
} from '@cartignon/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionService } from '../src/auth/sessions.js';
import { Agent, EVIL_ORIGIN, startTestServer, WEB_ORIGIN, type TestServer } from './helpers.js';

let t: TestServer;

beforeAll(async () => {
  t = await startTestServer();
});

afterAll(async () => {
  await t.stop();
});

function expectError(res: { status: number; body: unknown }, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = errorBodySchema.parse(res.body);
  expect(body.error.code).toBe(code);
}

describe('health', () => {
  it('/healthz and /readyz report ok', async () => {
    const agent = new Agent(t.url);
    const health = await agent.get(ApiRoute.Health);
    expect(health.status).toBe(200);
    expect(healthResponseSchema.parse(health.body)).toEqual({ status: 'ok' });
    const ready = await agent.get(ApiRoute.Ready);
    expect(ready.status).toBe(200);
    expect(healthResponseSchema.parse(ready.body)).toEqual({ status: 'ok' });
  });
});

describe('guest sessions', () => {
  it('two cookie jars get two independent guest sessions', async () => {
    const a = new Agent(t.url);
    const b = new Agent(t.url);
    const [ra, rb] = await Promise.all([
      a.post(ApiRoute.GuestSession),
      b.post(ApiRoute.GuestSession),
    ]);
    expect(ra.status).toBe(201);
    expect(rb.status).toBe(201);
    const sa = sessionResponseSchema.parse(ra.body);
    const sb = sessionResponseSchema.parse(rb.body);
    expect(sa.player.playerId).not.toBe(sb.player.playerId);
    expect(sa.player.kind).toBe('guest');
    expect(sa.player.displayName).toMatch(/^Guest-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);

    // Same jar again: the existing session is returned, no new identity.
    const again = await a.post(ApiRoute.GuestSession);
    expect(again.status).toBe(200);
    expect(sessionResponseSchema.parse(again.body).player.playerId).toBe(sa.player.playerId);
    expect(again.headers.getSetCookie()).toEqual([]);

    const me = await b.get(ApiRoute.Session);
    expect(me.status).toBe(200);
    expect(sessionResponseSchema.parse(me.body).player.playerId).toBe(sb.player.playerId);
  });

  it('sets a hardened cookie and stores only the token hash', async () => {
    const agent = new Agent(t.url);
    const res = await agent.post(ApiRoute.GuestSession);
    const [setCookie] = res.headers.getSetCookie();
    expect(setCookie).toBeDefined();
    expect(setCookie).toMatch(/^cartignon_session=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain(`Max-Age=${30 * 24 * 3600}`);
    expect(setCookie).not.toContain('Secure');

    const token = (agent.cookie ?? '').split('=')[1] ?? '';
    const rows = await t.db.pool.query<{ token_hash: string }>('SELECT token_hash FROM sessions');
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) {
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.token_hash).not.toContain(token);
    }
  });

  it('invalid, unknown, expired and revoked cookies are 401', async () => {
    const forged = new Agent(t.url);
    forged.cookie = 'cartignon_session=not-a-token';
    expectError(await forged.get(ApiRoute.Session), 401, 'UNAUTHENTICATED');
    forged.cookie = `cartignon_session=${randomBytes(32).toString('base64url')}`;
    expectError(await forged.get(ApiRoute.Session), 401, 'UNAUTHENTICATED');
    expectError(await new Agent(t.url).get(ApiRoute.Session), 401, 'UNAUTHENTICATED');

    const expiring = new Agent(t.url);
    const session = await expiring.guest();
    await t.db.pool.query(
      `UPDATE sessions SET expires_at = now() - interval '1 second' WHERE identity_id = $1`,
      [session.player.playerId],
    );
    expectError(await expiring.get(ApiRoute.Session), 401, 'UNAUTHENTICATED');
    // An expired session is not reused: a new guest identity is issued.
    const renewed = await expiring.post(ApiRoute.GuestSession);
    expect(renewed.status).toBe(201);

    const leaving = new Agent(t.url);
    await leaving.guest();
    const cookie = leaving.cookie;
    const logout = await leaving.post(ApiRoute.Logout);
    expect(logout.status).toBe(204);
    expect(logout.headers.getSetCookie()[0]).toContain('Max-Age=0');
    const replay = new Agent(t.url);
    replay.cookie = cookie;
    expectError(await replay.get(ApiRoute.Session), 401, 'UNAUTHENTICATED');
  });
});

describe('request hardening', () => {
  it('POST without CSRF header or from a foreign Origin is 403', async () => {
    const agent = new Agent(t.url);
    expectError(
      await agent.post(ApiRoute.GuestSession, undefined, { [CSRF_HEADER]: '' }),
      403,
      'FORBIDDEN',
    );
    expectError(
      await agent.post(ApiRoute.GuestSession, undefined, { origin: EVIL_ORIGIN }),
      403,
      'FORBIDDEN',
    );
    // No Origin at all (non-browser client) is allowed when the CSRF header is present.
    const noOrigin = await agent.post(ApiRoute.GuestSession, undefined, { origin: '' });
    expect(noOrigin.status).toBe(201);
  });

  it('unknown routes, malformed JSON and oversized bodies use the error body', async () => {
    const agent = new Agent(t.url);
    await agent.guest();
    expectError(await agent.get('/api/nope'), 404, 'NOT_FOUND');
    expectError(await agent.get('/'), 404, 'NOT_FOUND');
    expectError(
      await agent.request('POST', ApiRoute.JoinPrivateRoom, { rawBody: '{"code":' }),
      400,
      'BAD_REQUEST',
    );
    expectError(
      await agent.post(ApiRoute.JoinPrivateRoom, { code: 'x'.repeat(MAX_HTTP_BODY_BYTES) }),
      413,
      'PAYLOAD_TOO_LARGE',
    );
    expectError(await agent.post(ApiRoute.JoinPrivateRoom, { code: 'abc' }), 400, 'BAD_REQUEST');
    expectError(await agent.post(ApiRoute.JoinPrivateRoom, { nope: 1 }), 400, 'BAD_REQUEST');
  });

  it('CORS grants only allowlisted origins (API and matchmaking)', async () => {
    const preflight = (origin: string) =>
      fetch(`${t.url}/matchmake/joinById/someroom`, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST' },
      });
    const allowed = await preflight(WEB_ORIGIN);
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(WEB_ORIGIN);
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');
    const denied = await preflight(EVIL_ORIGIN);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();

    const api = await fetch(`${t.url}${ApiRoute.Health}`, { headers: { origin: EVIL_ORIGIN } });
    expect(api.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('matchmaking refuses foreign origins and room creation over HTTP', async () => {
    const evil = await fetch(`${t.url}/matchmake/joinById/someroom`, {
      method: 'POST',
      headers: { origin: EVIL_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: 'x'.repeat(32) }),
    });
    expectError({ status: evil.status, body: await evil.json() }, 403, 'FORBIDDEN');

    const create = await fetch(`${t.url}/matchmake/create/match`, {
      method: 'POST',
      headers: { origin: WEB_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ABCDEF' }),
    });
    expect(create.status).toBeGreaterThanOrEqual(400);
    expect(t.server.registry.liveRoomCount).toBe(0);
  });
});

describe('response headers and session hygiene', () => {
  it('/api responses are no-store and nosniff, errors included', async () => {
    const agent = new Agent(t.url);
    for (const res of [
      await agent.post(ApiRoute.GuestSession),
      await new Agent(t.url).get(ApiRoute.Session),
    ]) {
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('purges long-expired and long-revoked sessions but never identities', async () => {
    const stale = new Agent(t.url);
    const old = await stale.guest();
    const fresh = new Agent(t.url);
    const kept = await fresh.guest();
    await t.db.pool.query(
      `UPDATE sessions SET expires_at = now() - interval '8 days' WHERE identity_id = $1`,
      [old.player.playerId],
    );
    const removed = await new SessionService(t.db.pool, 30).purgeExpired();
    expect(removed).toBeGreaterThanOrEqual(1);
    const left = await t.db.pool.query<{ identity_id: string }>(
      'SELECT identity_id FROM sessions WHERE identity_id = ANY($1::uuid[])',
      [[old.player.playerId, kept.player.playerId]],
    );
    expect(left.rows.map((r) => r.identity_id)).toEqual([kept.player.playerId]);
    const identity = await t.db.pool.query('SELECT 1 FROM identities WHERE id = $1', [
      old.player.playerId,
    ]);
    expect(identity.rowCount).toBe(1);
    expect((await fresh.get(ApiRoute.Session)).status).toBe(200);
  });
});
