import { ApiRoute, CSRF_HEADER } from '@cartignon/protocol';
import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError, codeFromStatus, errorCodeFromResponse } from '../src/lib/api';

const uuid = '0b6f6f5e-6a4c-4c1e-9f0a-2d6a4a3c1b2e';
const session = {
  player: { playerId: uuid, displayName: 'Guest-1234', kind: 'guest' },
  expiresAt: '2026-10-19T12:00:00.000Z',
};
const admission = {
  roomId: 'room-1',
  code: 'ABC234',
  ticket: 't'.repeat(32),
  ticketExpiresAt: '2026-10-18T12:00:30.000Z',
};

interface Call {
  input: string;
  init: RequestInit;
}

function fakeFetch(responses: Response[]) {
  const calls: Call[] = [];
  const fetchFn = (input: string, init: RequestInit) => {
    calls.push({ input, init });
    const next = responses.shift();
    return next ? Promise.resolve(next) : Promise.reject(new TypeError('network down'));
  };
  return { calls, fetchFn };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const errorBody = (code: string) => ({ error: { code, message: 'x' } });

function headersOf(call: Call | undefined): Record<string, string> {
  return (call?.init.headers ?? {}) as Record<string, string>;
}

describe('error mapping', () => {
  it('prefers the validated error body over the status', () => {
    expect(errorCodeFromResponse(409, errorBody('ROOM_FULL'))).toBe('ROOM_FULL');
    expect(errorCodeFromResponse(410, errorBody('ROOM_EXPIRED'))).toBe('ROOM_EXPIRED');
  });

  it('falls back to the status for missing or invalid bodies', () => {
    expect(errorCodeFromResponse(404, undefined)).toBe('NOT_FOUND');
    expect(errorCodeFromResponse(429, { error: 'nope' })).toBe('RATE_LIMITED');
    expect(errorCodeFromResponse(401, errorBody('NOT_A_CODE'))).toBe('UNAUTHENTICATED');
    expect(codeFromStatus(503)).toBe('INTERNAL');
    expect(codeFromStatus(418)).toBe('INVALID_RESPONSE');
  });
});

describe('ApiClient', () => {
  it('creates a guest session after a 401 and sends the CSRF header only on POST', async () => {
    const { calls, fetchFn } = fakeFetch([
      json(401, errorBody('UNAUTHENTICATED')),
      json(201, session),
    ]);
    const result = await new ApiClient(fetchFn).ensureSession();
    expect(result.player.displayName).toBe('Guest-1234');
    expect(calls.map((c) => [c.init.method, c.input])).toEqual([
      ['GET', ApiRoute.Session],
      ['POST', ApiRoute.GuestSession],
    ]);
    expect(headersOf(calls[0])[CSRF_HEADER]).toBeUndefined();
    expect(headersOf(calls[1])[CSRF_HEADER]).toBe('1');
    expect(headersOf(calls[1])['content-type']).toBeUndefined();
    expect(calls.every((c) => c.init.credentials === 'same-origin')).toBe(true);
  });

  it('sends a JSON body with content-type when joining', async () => {
    const { calls, fetchFn } = fakeFetch([json(200, admission)]);
    await new ApiClient(fetchFn).joinPrivateRoom('ABC234');
    expect(calls[0]?.input).toBe(ApiRoute.JoinPrivateRoom);
    expect(headersOf(calls[0])['content-type']).toBe('application/json');
    expect(calls[0]?.init.body).toBe(JSON.stringify({ code: 'ABC234' }));
  });

  it('rejects an invalid invite code without calling the server', async () => {
    const { calls, fetchFn } = fakeFetch([]);
    await expect(new ApiClient(fetchFn).joinPrivateRoom('abc')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(calls).toHaveLength(0);
  });

  it('maps HTTP errors to friendly ApiErrors', async () => {
    const { fetchFn } = fakeFetch([json(404, errorBody('NOT_FOUND'))]);
    const error: unknown = await new ApiClient(fetchFn)
      .joinPrivateRoom('ABC234')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect((error as ApiError).message).toMatch(/no room/i);
  });

  it('treats a schema-invalid success response as an error', async () => {
    const { fetchFn } = fakeFetch([json(201, { ...admission, ticket: 'short' })]);
    await expect(new ApiClient(fetchFn).createPrivateRoom()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('reports network failures', async () => {
    const { fetchFn } = fakeFetch([]);
    await expect(new ApiClient(fetchFn).getRoomTicket('room-1')).rejects.toMatchObject({
      code: 'NETWORK',
    });
  });

  it('reads /readyz for both 200 and 503', async () => {
    const { fetchFn } = fakeFetch([
      json(200, { status: 'ok' }),
      json(503, { status: 'unavailable' }),
      json(200, { status: 'weird' }),
    ]);
    const api = new ApiClient(fetchFn);
    expect(await api.checkReady()).toBe('ok');
    expect(await api.checkReady()).toBe('unavailable');
    expect(await api.checkReady()).toBe('unavailable');
    expect(await api.checkReady()).toBe('unavailable');
  });
});
