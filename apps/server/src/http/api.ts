import { matchMaker } from '@colyseus/core';
import { checkDatabase } from '@cartignon/database';
import type { Seat } from '@cartignon/game-core';
import {
  ApiRoute,
  CSRF_HEADER,
  joinPrivateRoomRequestSchema,
  MATCH_ROOM,
  MAX_HTTP_BODY_BYTES,
  roomTicketRequestSchema,
  type HealthResponse,
  type RoomAdmission,
  type SessionResponse,
} from '@cartignon/protocol';
import { parseCookie, stringifySetCookie } from 'cookie';
import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import type { z } from 'zod';
import type { Pool, Session, SessionService } from '../auth/sessions.js';
import type { Logger } from '../logger.js';
import type { RoomRecord, RoomRegistry, SeatHolder } from '../rooms/registry.js';
import type { TicketStore } from '../rooms/tickets.js';
import type { TrustedProxy } from '../security/client-ip.js';
import type { OriginPolicy } from '../security/origins.js';
import type { RateLimiter } from '../security/rate-limit.js';
import { DEFAULT_MESSAGES, errorBody, HttpError } from './errors.js';

export interface ApiLimiters {
  /** Every `/api` POST, per IP. */
  readonly postPerIp: RateLimiter;
  /** New guest identities, per IP. */
  readonly guestPerIp: RateLimiter;
  /** `JoinPrivateRoom`, per IP and per identity (invite-code enumeration). */
  readonly joinPerIp: RateLimiter;
  readonly joinPerIdentity: RateLimiter;
  /** `CreatePrivateRoom`, per IP and per identity. */
  readonly createPerIp: RateLimiter;
  readonly createPerIdentity: RateLimiter;
  /** `RoomTicket`, per identity. */
  readonly ticketPerIdentity: RateLimiter;
}

export interface ApiDeps {
  readonly pool: Pool;
  readonly sessions: SessionService;
  readonly registry: RoomRegistry;
  readonly tickets: TicketStore;
  readonly origins: OriginPolicy;
  readonly limiters: ApiLimiters;
  readonly cookieName: string;
  readonly cookieSecure: boolean;
  readonly trustedProxy: TrustedProxy;
  readonly maxLiveRooms: number;
  /** Rate-limit key of the request's client (see security/client-ip.ts). */
  readonly keyOf: (req: Request) => string;
  readonly logger: Logger;
  readonly isShuttingDown: () => boolean;
}

function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new HttpError(400, 'BAD_REQUEST', 'Invalid request body');
  return parsed.data;
}

function sessionResponse(session: Session): SessionResponse {
  return {
    player: {
      playerId: session.identity.id,
      displayName: session.identity.displayName,
      kind: session.identity.kind,
    },
    expiresAt: session.expiresAt.toISOString(),
  };
}

const rateLimited = () => new HttpError(429, 'RATE_LIMITED', DEFAULT_MESSAGES.RATE_LIMITED);

/** Configures the Express app Colyseus mounts behind its matchmaking router. */
export function configureApi(app: Express, deps: ApiDeps): void {
  const { sessions, registry, tickets, origins, limiters, logger, keyOf } = deps;

  const sessionToken = (req: Request): string | undefined => {
    const header = req.headers.cookie;
    return header === undefined ? undefined : parseCookie(header)[deps.cookieName];
  };

  const setSessionCookie = (res: Response, token: string, maxAge: number): void => {
    res.append(
      'Set-Cookie',
      stringifySetCookie({
        name: deps.cookieName,
        value: token,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: deps.cookieSecure,
        maxAge,
        ...(maxAge === 0 ? { expires: new Date(0) } : {}),
      }),
    );
  };

  const requireSession = async (req: Request): Promise<Session> => {
    const session = await sessions.find(sessionToken(req));
    if (session === undefined) throw new HttpError(401, 'UNAUTHENTICATED', 'Not signed in');
    return session;
  };

  const refuseWhileShuttingDown = (): void => {
    if (deps.isShuttingDown()) {
      throw new HttpError(503, 'UNAVAILABLE', 'Server is shutting down, try again shortly');
    }
  };

  const admission = (record: RoomRecord, identityId: string, seat: Seat): RoomAdmission => {
    const issued = tickets.issue({ identityId, roomId: record.roomId, seat });
    return {
      roomId: record.roomId,
      code: record.code,
      ticket: issued.ticket,
      ticketExpiresAt: issued.expiresAt.toISOString(),
    };
  };

  const holderOf = (session: Session): SeatHolder => ({
    identityId: session.identity.id,
    displayName: session.identity.displayName,
  });

  app.disable('x-powered-by');
  // Kept consistent with clientIp(): only a loopback peer may vouch via X-Forwarded-For.
  app.set('trust proxy', deps.trustedProxy === 'loopback' ? 'loopback' : false);

  // Access log without query strings, headers or bodies.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const quiet = req.path === ApiRoute.Health || req.path === ApiRoute.Ready;
      const fields = { method: req.method, path: req.path, status: res.statusCode, ms };
      if (quiet) logger.debug(fields, 'request');
      else logger.info(fields, 'request');
    });
    next();
  });

  // API responses carry session data: never cache, never sniff.
  app.use('/api', (_req: Request, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.get(ApiRoute.Health, (_req, res) => {
    res.json({ status: 'ok' } satisfies HealthResponse);
  });

  app.get(ApiRoute.Ready, async (_req, res) => {
    const ok = !deps.isShuttingDown() && (await checkDatabase(deps.pool));
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'unavailable' } satisfies HealthResponse);
  });

  // Every POST: rate limit, CSRF header, Origin allowlist, body size — before parsing.
  const guardPost: RequestHandler = (req, _res, next) => {
    if (req.method !== 'POST') {
      next();
      return;
    }
    if (!limiters.postPerIp.take(keyOf(req))) throw rateLimited();
    const csrf = req.get(CSRF_HEADER);
    if (csrf === undefined || csrf.trim() === '' || !origins.allows(req.get('origin'))) {
      throw new HttpError(403, 'FORBIDDEN', 'Request not allowed');
    }
    const length = Number(req.get('content-length') ?? '0');
    if (!Number.isFinite(length) || length > MAX_HTTP_BODY_BYTES) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', DEFAULT_MESSAGES.PAYLOAD_TOO_LARGE);
    }
    next();
  };
  app.use(guardPost);
  app.use(express.json({ limit: MAX_HTTP_BODY_BYTES, type: 'application/json' }));

  app.post(ApiRoute.GuestSession, async (req, res) => {
    const existing = await sessions.find(sessionToken(req));
    if (existing !== undefined) {
      res.status(200).json(sessionResponse(existing));
      return;
    }
    if (!limiters.guestPerIp.take(keyOf(req))) throw rateLimited();
    const created = await sessions.createGuest();
    setSessionCookie(res, created.token, sessions.ttlSeconds);
    logger.info({ playerId: created.identity.id }, 'guest session created');
    res.status(201).json(sessionResponse(created));
  });

  app.get(ApiRoute.Session, async (req, res) => {
    res.status(200).json(sessionResponse(await requireSession(req)));
  });

  app.post(ApiRoute.Logout, async (req, res) => {
    const identityId = await sessions.revoke(sessionToken(req));
    if (identityId !== undefined) tickets.invalidateIdentity(identityId);
    setSessionCookie(res, '', 0);
    res.status(204).end();
  });

  app.post(ApiRoute.CreatePrivateRoom, async (req, res) => {
    refuseWhileShuttingDown();
    if (!limiters.createPerIp.take(keyOf(req))) throw rateLimited();
    const session = await requireSession(req);
    if (!limiters.createPerIdentity.take(session.identity.id)) throw rateLimited();
    if (registry.allocatedRoomCount >= deps.maxLiveRooms) {
      logger.warn({ rooms: registry.allocatedRoomCount }, 'live room cap reached');
      throw new HttpError(503, 'UNAVAILABLE', 'Too many open rooms, try again later');
    }
    const code = registry.reserveCode(holderOf(session));
    try {
      await matchMaker.createRoom(MATCH_ROOM, { code });
    } catch (error) {
      registry.abandonCode(code); // also unregisters a room that bound before failing
      throw error;
    }
    const record = registry.findByCode(code);
    if (record === undefined) throw new Error('created room is not registered');
    logger.info({ roomId: record.roomId, playerId: session.identity.id }, 'private room created');
    res.status(201).json(admission(record, session.identity.id, 0));
  });

  app.post(ApiRoute.JoinPrivateRoom, async (req, res) => {
    refuseWhileShuttingDown();
    if (!limiters.joinPerIp.take(keyOf(req))) throw rateLimited();
    const session = await requireSession(req);
    if (!limiters.joinPerIdentity.take(session.identity.id)) throw rateLimited();
    const { code } = parseBody(joinPrivateRoomRequestSchema, req.body);
    // From here to the ticket there is no await: seat assignment is atomic.
    const record = registry.findByCode(code);
    if (record === undefined) throw new HttpError(404, 'NOT_FOUND', 'No room with that code');
    const result = registry.admit(record, holderOf(session));
    if (!result.ok) {
      throw result.reason === 'ROOM_FULL'
        ? new HttpError(409, 'ROOM_FULL', DEFAULT_MESSAGES.ROOM_FULL)
        : new HttpError(410, 'ROOM_EXPIRED', DEFAULT_MESSAGES.ROOM_EXPIRED);
    }
    res.status(200).json(admission(record, session.identity.id, result.seat));
  });

  app.post(ApiRoute.RoomTicket, async (req, res) => {
    refuseWhileShuttingDown();
    const session = await requireSession(req);
    if (!limiters.ticketPerIdentity.take(session.identity.id)) throw rateLimited();
    const { roomId } = parseBody(roomTicketRequestSchema, req.body);
    const record = registry.get(roomId);
    if (record === undefined) {
      throw registry.isExpired(roomId)
        ? new HttpError(410, 'ROOM_EXPIRED', DEFAULT_MESSAGES.ROOM_EXPIRED)
        : new HttpError(404, 'NOT_FOUND', 'Room not found');
    }
    const seat = registry.seatOf(record, session.identity.id);
    if (seat === undefined) throw new HttpError(403, 'FORBIDDEN', 'You have no seat in this room');
    res.status(200).json(admission(record, session.identity.id, seat));
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json(errorBody('NOT_FOUND', DEFAULT_MESSAGES.NOT_FOUND));
  });

  const onError: ErrorRequestHandler = (error: unknown, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof HttpError) {
      res.status(error.status).json(errorBody(error.code, error.message));
      return;
    }
    // body-parser errors carry a `type` and an HTTP status.
    const type = (error as { type?: unknown } | null)?.type;
    if (type === 'entity.too.large') {
      res.status(413).json(errorBody('PAYLOAD_TOO_LARGE', DEFAULT_MESSAGES.PAYLOAD_TOO_LARGE));
      return;
    }
    if (type === 'entity.parse.failed' || type === 'encoding.unsupported') {
      res.status(400).json(errorBody('BAD_REQUEST', 'Malformed request body'));
      return;
    }
    logger.error(
      {
        method: req.method,
        path: req.path,
        err: error instanceof Error ? error.message : 'unknown',
      },
      'unhandled request error',
    );
    res.status(500).json(errorBody('INTERNAL', DEFAULT_MESSAGES.INTERNAL));
  };
  app.use(onError);
}
