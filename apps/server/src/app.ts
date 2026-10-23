import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { matchMaker, Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { createPool } from '@cartignon/database';
import { MATCH_ROOM, MAX_WS_MESSAGE_BYTES } from '@cartignon/protocol';
import type { Express } from 'express';
import { SessionService, sessionCookieName } from './auth/sessions.js';
import type { Config } from './config.js';
import { configureApi, type ApiLimiters } from './http/api.js';
import { installGate } from './http/gate.js';
import { colyseusLogger, type Logger } from './logger.js';
import { defineMatchRoom } from './rooms/match-room.js';
import { RoomRegistry } from './rooms/registry.js';
import { selectRules } from './rooms/rules.js';
import { TicketStore } from './rooms/tickets.js';
import { clientKey } from './security/client-ip.js';
import { OriginPolicy, restrictMatchmakerCors } from './security/origins.js';
import { RateLimiter, type RateLimit } from './security/rate-limit.js';

export interface RateLimits {
  readonly apiPostPerIp: RateLimit;
  readonly guestPerIp: RateLimit;
  readonly joinPerIp: RateLimit;
  readonly joinPerIdentity: RateLimit;
  readonly createPerIp: RateLimit;
  readonly createPerIdentity: RateLimit;
  readonly ticketPerIdentity: RateLimit;
  readonly matchmakePerIp: RateLimit;
  readonly wsConnectPerIp: RateLimit;
  /** WebSocket messages per client per second (Colyseus closes the connection above it). */
  readonly wsMessagesPerSecond: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  apiPostPerIp: { burst: 60, perMinute: 120 },
  guestPerIp: { burst: 10, perMinute: 10 / 60 }, // 10 per hour
  joinPerIp: { burst: 20, perMinute: 20 },
  joinPerIdentity: { burst: 10, perMinute: 10 },
  createPerIp: { burst: 10, perMinute: 10 },
  createPerIdentity: { burst: 5, perMinute: 10 },
  ticketPerIdentity: { burst: 10, perMinute: 30 },
  matchmakePerIp: { burst: 30, perMinute: 60 },
  wsConnectPerIp: { burst: 30, perMinute: 60 },
  wsMessagesPerSecond: 20,
};

export interface StartOptions {
  readonly config: Config;
  readonly logger: Logger;
  readonly rateLimits?: Partial<RateLimits>;
}

export interface ShutdownOptions {
  /**
   * Keep serving for this long with readiness 503 and new admissions refused (503
   * UNAVAILABLE) before rooms are closed, so a load balancer can drain. Default 0.
   */
  readonly drainMs?: number;
}

export interface GameServer {
  readonly port: number;
  /** http://host:port of the listening server. */
  readonly url: string;
  readonly registry: RoomRegistry;
  /** Idempotent graceful shutdown: readiness off, rooms disposed, sockets and pool closed. */
  shutdown(options?: ShutdownOptions): Promise<void>;
}

const SWEEP_INTERVAL_MS = 60_000;
const SESSION_PURGE_INTERVAL_MS = 60 * 60 * 1000;

/** Starts Express + Colyseus on one HTTP server. Resolves once listening. */
export async function startServer(options: StartOptions): Promise<GameServer> {
  const { config, logger } = options;
  const limits = { ...DEFAULT_RATE_LIMITS, ...options.rateLimits };
  // Built before anything is opened: an invalid card catalog fails the start immediately.
  const rules = selectRules(config.matchRules);

  const pool = createPool(config.databaseUrl);
  pool.on('error', (error: Error) => {
    logger.error({ err: error.message }, 'idle database client error');
  });

  const sessions = new SessionService(pool, config.sessionTtlDays);
  const registry = new RoomRegistry();
  const tickets = new TicketStore();
  const origins = new OriginPolicy(config.allowedOrigins);
  const limiters: ApiLimiters & { matchmake: RateLimiter; wsConnect: RateLimiter } = {
    postPerIp: new RateLimiter(limits.apiPostPerIp),
    guestPerIp: new RateLimiter(limits.guestPerIp),
    joinPerIp: new RateLimiter(limits.joinPerIp),
    joinPerIdentity: new RateLimiter(limits.joinPerIdentity),
    createPerIp: new RateLimiter(limits.createPerIp),
    createPerIdentity: new RateLimiter(limits.createPerIdentity),
    ticketPerIdentity: new RateLimiter(limits.ticketPerIdentity),
    matchmake: new RateLimiter(limits.matchmakePerIp),
    wsConnect: new RateLimiter(limits.wsConnectPerIp),
  };
  const allLimiters: RateLimiter[] = [
    limiters.postPerIp,
    limiters.guestPerIp,
    limiters.joinPerIp,
    limiters.joinPerIdentity,
    limiters.createPerIp,
    limiters.createPerIdentity,
    limiters.ticketPerIdentity,
    limiters.matchmake,
    limiters.wsConnect,
  ];
  const keyOf = (req: Parameters<typeof clientKey>[0]) => clientKey(req, config.trustedProxy);
  let shuttingDown = false;

  // Matchmaking is reachable only for joining an existing room by id with a ticket; rooms
  // are created exclusively by the API (`matchMaker.createRoom`).
  matchMaker.controller.exposedMethods = ['joinById'];
  restrictMatchmakerCors(origins);

  const httpServer: HttpServer = createServer();
  const transport = new WebSocketTransport({
    server: httpServer,
    maxPayload: MAX_WS_MESSAGE_BYTES,
  });
  const gameServer = new Server({
    transport,
    greet: false,
    gracefullyShutdown: false, // signals are handled by main.ts
    logger: colyseusLogger(logger),
    express: (app) => {
      configureApi(app as unknown as Express, {
        pool,
        sessions,
        registry,
        tickets,
        origins,
        limiters,
        cookieName: sessionCookieName(config.cookieSecure),
        cookieSecure: config.cookieSecure,
        trustedProxy: config.trustedProxy,
        maxLiveRooms: config.maxLiveRooms,
        keyOf,
        logger,
        isShuttingDown: () => shuttingDown,
      });
    },
  });

  gameServer.define(
    MATCH_ROOM,
    defineMatchRoom({
      registry,
      tickets,
      logger: logger.child({ component: 'match-room' }),
      idleTimeoutMs: config.roomIdleTimeoutMs,
      finishedTtlMs: config.roomFinishedTtlMs,
      maxLifetimeMs: config.roomMaxLifetimeMs,
      seatClaimTimeoutMs: config.seatClaimTimeoutMs,
      turnTimeoutMs: config.turnTimeoutMs,
      choiceTimeoutMs: config.choiceTimeoutMs,
      pauseBudgetMs: config.pauseBudgetMs,
      now: () => Date.now(),
      monoNow: () => performance.now(),
      maxMessagesPerSecond: limits.wsMessagesPerSecond,
      isAllowedOrigin: (origin) => origins.allows(origin),
      rules,
    }),
  );

  const closed = new Promise<void>((resolve) => {
    httpServer.once('close', () => {
      resolve();
    });
  });

  try {
    await gameServer.listen(config.port, config.host);
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
  installGate(httpServer, {
    origins,
    matchmakeLimiter: limiters.matchmake,
    upgradeLimiter: limiters.wsConnect,
    logger,
    keyOf,
  });

  const sweeper = setInterval(() => {
    tickets.sweep();
    for (const limiter of allLimiters) limiter.sweep();
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  const purgeSessions = () => {
    sessions.purgeExpired().then(
      (removed) => {
        if (removed > 0) logger.info({ removed }, 'expired sessions purged');
      },
      (error: unknown) => {
        logger.warn(
          { err: error instanceof Error ? error.message : 'unknown' },
          'session purge failed',
        );
      },
    );
  };
  purgeSessions();
  const purger = setInterval(purgeSessions, SESSION_PURGE_INTERVAL_MS);
  purger.unref();

  const { port } = httpServer.address() as AddressInfo;
  const url = `http://${config.host}:${port}`;
  logger.info(
    {
      host: config.host,
      port,
      trustedProxy: config.trustedProxy,
      rulesId: rules.current.rulesId,
      rulesVersion: rules.current.rulesVersion,
    },
    'server listening',
  );

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (shutdownOptions: ShutdownOptions = {}): Promise<void> => {
    shutdownPromise ??= (async () => {
      shuttingDown = true;
      logger.info('shutting down');
      clearInterval(sweeper);
      clearInterval(purger);
      if ((shutdownOptions.drainMs ?? 0) > 0) await delay(shutdownOptions.drainMs);
      // Locks and disposes every room (clients get SERVER_SHUTDOWN), then closes the
      // WebSocket server and the HTTP server (no new connections).
      await gameServer.gracefullyShutdown(false);
      if (httpServer.listening) httpServer.close(); // in case Colyseus' shutdown bailed early
      httpServer.closeAllConnections();
      await closed;
      await pool.end();
      logger.info('shutdown complete');
    })();
    return shutdownPromise;
  };

  return { port, url, registry, shutdown };
}
