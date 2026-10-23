import { randomBytes } from 'node:crypto';
import { connect as connectTcp, type Socket } from 'node:net';
import { Client, type Room } from '@colyseus/sdk';
import { createTestDatabase, type TestDatabase } from '@cartignon/database/testing';
import {
  ApiRoute,
  CSRF_HEADER,
  roomAdmissionSchema,
  sessionResponseSchema,
  type RoomAdmission,
  type SessionResponse,
} from '@cartignon/protocol';
import { inject } from 'vitest';
import { startServer, type GameServer, type RateLimits } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}

export const WEB_ORIGIN = 'http://127.0.0.1:5173';
export const EVIL_ORIGIN = 'http://evil.example';

/** Generous limits so ordinary tests never trip them (one IP drives every request). */
export const RELAXED_LIMITS: RateLimits = {
  apiPostPerIp: { burst: 10_000, perMinute: 10_000 },
  guestPerIp: { burst: 10_000, perMinute: 10_000 },
  joinPerIp: { burst: 10_000, perMinute: 10_000 },
  joinPerIdentity: { burst: 10_000, perMinute: 10_000 },
  createPerIp: { burst: 10_000, perMinute: 10_000 },
  createPerIdentity: { burst: 10_000, perMinute: 10_000 },
  ticketPerIdentity: { burst: 10_000, perMinute: 10_000 },
  matchmakePerIp: { burst: 10_000, perMinute: 10_000 },
  wsConnectPerIp: { burst: 10_000, perMinute: 10_000 },
  wsMessagesPerSecond: 1_000,
};

export interface TestServer {
  readonly server: GameServer;
  readonly db: TestDatabase;
  readonly url: string;
  /** Every log line the server wrote (debug level), as raw JSON text. */
  readonly logs: string[];
  stop(): Promise<void>;
}

export async function startTestServer(
  options: { rateLimits?: Partial<RateLimits>; env?: Record<string, string> } = {},
): Promise<TestServer> {
  const db = await createTestDatabase(inject('testDatabaseUrl'));
  const logs: string[] = [];
  const echo = process.env['TEST_LOG'] === '1';
  try {
    const config = loadConfig({
      DATABASE_URL: db.url,
      PORT: '0',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'debug',
      ...options.env,
    });
    const sink = {
      write(line: string) {
        logs.push(line);
        if (echo) process.stdout.write(line);
      },
    };
    const server = await startServer({
      config,
      logger: createLogger(config.logLevel, sink),
      rateLimits: { ...RELAXED_LIMITS, ...options.rateLimits },
    });
    return {
      server,
      db,
      url: server.url,
      logs,
      stop: async () => {
        try {
          await server.shutdown();
        } finally {
          await db.drop();
        }
      },
    };
  } catch (error) {
    await db.drop();
    throw error;
  }
}

export interface HttpResult<T = unknown> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
}

/** A browser-like HTTP client with its own cookie jar. */
export class Agent {
  readonly baseUrl: string;
  /** Sent with every request (e.g. a per-agent X-Forwarded-For). */
  readonly defaultHeaders: Record<string, string>;
  cookie: string | undefined;

  constructor(baseUrl: string, defaultHeaders: Record<string, string> = {}) {
    this.baseUrl = baseUrl;
    this.defaultHeaders = defaultHeaders;
  }

  async request(
    method: string,
    path: string,
    options: { body?: unknown; rawBody?: string; headers?: Record<string, string> } = {},
  ): Promise<HttpResult> {
    const headers: Record<string, string> = {
      origin: WEB_ORIGIN,
      ...(method === 'POST' ? { [CSRF_HEADER]: '1' } : {}),
      ...(this.cookie !== undefined ? { cookie: this.cookie } : {}),
      ...(options.body !== undefined || options.rawBody !== undefined
        ? { 'content-type': 'application/json' }
        : {}),
      ...this.defaultHeaders,
      ...options.headers,
    };
    for (const [key, value] of Object.entries(headers)) {
      if (value === '') Reflect.deleteProperty(headers, key); // '' means "omit this header"
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(options.rawBody !== undefined
        ? { body: options.rawBody }
        : options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
    });
    for (const setCookie of response.headers.getSetCookie()) {
      const pair = setCookie.split(';')[0] ?? '';
      const match = /^((?:__Host-)?cartignon_session)=(.*)$/.exec(pair);
      if (match !== null) this.cookie = match[2] === '' ? undefined : pair;
    }
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      // keep text
    }
    return { status: response.status, body, headers: response.headers };
  }

  get(path: string, headers?: Record<string, string>): Promise<HttpResult> {
    return this.request('GET', path, { ...(headers ? { headers } : {}) });
  }

  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResult> {
    return this.request('POST', path, {
      ...(body !== undefined ? { body } : {}),
      ...(headers ? { headers } : {}),
    });
  }

  async guest(): Promise<SessionResponse> {
    const res = await this.post(ApiRoute.GuestSession);
    if (res.status !== 201 && res.status !== 200) throw new Error(`guest: ${res.status}`);
    return sessionResponseSchema.parse(res.body);
  }

  async createRoom(): Promise<RoomAdmission> {
    const res = await this.post(ApiRoute.CreatePrivateRoom);
    if (res.status !== 201) throw new Error(`create: ${res.status} ${JSON.stringify(res.body)}`);
    return roomAdmissionSchema.parse(res.body);
  }

  async joinRoom(code: string): Promise<RoomAdmission> {
    const res = await this.post(ApiRoute.JoinPrivateRoom, { code });
    if (res.status !== 200) throw new Error(`join: ${res.status} ${JSON.stringify(res.body)}`);
    return roomAdmissionSchema.parse(res.body);
  }

  async ticket(roomId: string): Promise<RoomAdmission> {
    const res = await this.post(ApiRoute.RoomTicket, { roomId });
    if (res.status !== 200) throw new Error(`ticket: ${res.status} ${JSON.stringify(res.body)}`);
    return roomAdmissionSchema.parse(res.body);
  }
}

export async function newPlayer(
  baseUrl: string,
  headers: Record<string, string> = {},
): Promise<{ agent: Agent; me: SessionResponse }> {
  const agent = new Agent(baseUrl, headers);
  const me = await agent.guest();
  return { agent, me };
}

export interface Received {
  readonly type: string;
  readonly message: unknown;
}

/** A connected SDK room plus a transcript of everything the server sent it. */
export interface Connection {
  readonly room: Room;
  readonly received: Received[];
  ofType<T = unknown>(type: string): T[];
  /** Plain JSON of the synchronized state. */
  state(): Record<string, unknown>;
}

export function sdkClient(baseUrl: string, origin: string = WEB_ORIGIN): Client {
  return new Client(baseUrl, { headers: { Origin: origin } });
}

export async function connect(
  baseUrl: string,
  admission: Pick<RoomAdmission, 'roomId' | 'ticket'>,
  options: Record<string, unknown> = { ticket: admission.ticket },
): Promise<Connection> {
  const room = await sdkClient(baseUrl).joinById(admission.roomId, options);
  const received: Received[] = [];
  room.onMessage('*', (type: string | number, message: unknown) => {
    received.push({ type: String(type), message });
  });
  return {
    room,
    received,
    ofType: <T>(type: string) => received.filter((r) => r.type === type).map((r) => r.message as T),
    state: () => (room.state as { toJSON(): Record<string, unknown> }).toJSON(),
  };
}

/** Leaves every still-open connection (SDK `leave()` never settles on a closed room). */
export async function closeAll(connections: Connection[]): Promise<void> {
  await Promise.all(
    connections
      .splice(0)
      .filter((c) => c.room.connection.isOpen)
      .map((c) => c.room.leave().catch(() => undefined)),
  );
}

export async function waitFor(
  predicate: () => boolean,
  what = 'condition',
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Resolves when the promise rejects; fails if it resolves (returning the error). */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    const value = await promise;
    if (typeof (value as { leave?: unknown }).leave === 'function') {
      await (value as Room).leave();
    }
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

/** Seat reservation via raw HTTP matchmaking (no WebSocket afterwards). */
export async function matchmake(
  baseUrl: string,
  roomId: string,
  ticket: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/matchmake/joinById/${roomId}`, {
    method: 'POST',
    headers: { origin: WEB_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ ticket }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/**
 * Joins a seat over a raw TCP socket, completes the WebSocket upgrade and then goes silent
 * (never reads, never answers pings): a half-open client the server still considers live
 * until its heartbeat gives up.
 */
export async function halfOpenJoin(
  baseUrl: string,
  roomId: string,
  ticket: string,
): Promise<Socket> {
  const reservation = await matchmake(baseUrl, roomId, ticket);
  if (reservation.status !== 200) throw new Error(`matchmake: ${reservation.status}`);
  const { sessionId, processId } = reservation.body as { sessionId: string; processId: string };
  const url = new URL(baseUrl);
  const socket = connectTcp(Number(url.port), url.hostname);
  socket.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => {
      socket.write(
        `GET /${processId}/${roomId}?sessionId=${sessionId} HTTP/1.1\r\n` +
          `Host: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n` +
          `Sec-WebSocket-Version: 13\r\nOrigin: ${WEB_ORIGIN}\r\n\r\n`,
      );
    });
    socket.once('data', (chunk: Buffer) => {
      socket.pause(); // from now on: silent
      if (chunk.toString('latin1').startsWith('HTTP/1.1 101')) resolve();
      else reject(new Error('upgrade refused'));
    });
    socket.once('error', reject);
  });
  return socket;
}
