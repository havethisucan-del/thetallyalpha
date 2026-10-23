import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { MAX_HTTP_BODY_BYTES } from '@cartignon/protocol';
import type { Logger } from '../logger.js';
import type { OriginPolicy } from '../security/origins.js';
import type { RateLimiter } from '../security/rate-limit.js';
import { writeRawError } from './errors.js';

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;
type UpgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

export interface GateOptions {
  readonly origins: OriginPolicy;
  /** Matchmaking POSTs (seat reservations) per IP. */
  readonly matchmakeLimiter: RateLimiter;
  /** WebSocket connection attempts per IP. */
  readonly upgradeLimiter: RateLimiter;
  readonly logger: Logger;
  /** Rate-limit key of the request's client (see security/client-ip.ts). */
  readonly keyOf: (req: IncomingMessage) => string;
}

function pathOf(req: IncomingMessage): string {
  const url = req.url ?? '/';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  if (socket.destroyed) return;
  socket.on('error', () => {
    socket.destroy();
  });
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Colyseus owns the HTTP server's `request` listener (matchmaking router + Express fallback)
 * and its `upgrade` listener (WebSocket transport). After `listen()` both are wrapped in one
 * gate each, so abuse is refused before Colyseus does any work:
 *  - `/matchmake/*` POSTs: Origin allowlist, body size cap, per-IP rate limit.
 *  - WebSocket upgrades: Origin allowlist, per-IP connection-attempt rate limit.
 */
export function installGate(server: Server, options: GateOptions): void {
  const { origins, matchmakeLimiter, upgradeLimiter, logger, keyOf } = options;

  const requestListeners = server.listeners('request') as RequestListener[];
  server.removeAllListeners('request');
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (pathOf(req).startsWith('/matchmake/') && req.method === 'POST') {
      const origin = req.headers.origin;
      const cors = origins.corsHeaders(origin);
      if (!origins.allows(origin)) {
        logger.warn({ path: '/matchmake' }, 'matchmake from disallowed origin');
        writeRawError(res, 403, 'FORBIDDEN', cors);
        return;
      }
      if (!matchmakeLimiter.take(keyOf(req))) {
        writeRawError(res, 429, 'RATE_LIMITED', cors);
        return;
      }
      const length = Number(req.headers['content-length']);
      if (!Number.isInteger(length) || length > MAX_HTTP_BODY_BYTES) {
        writeRawError(res, 413, 'PAYLOAD_TOO_LARGE', cors);
        return;
      }
    }
    for (const listener of requestListeners) listener.call(server, req, res);
  });

  const upgradeListeners = server.listeners('upgrade') as UpgradeListener[];
  server.removeAllListeners('upgrade');
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!origins.allows(req.headers.origin)) {
      logger.warn('websocket from disallowed origin');
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    if (!upgradeLimiter.take(keyOf(req))) {
      rejectUpgrade(socket, 429, 'Too Many Requests');
      return;
    }
    for (const listener of upgradeListeners) listener.call(server, req, socket, head);
  });
}
