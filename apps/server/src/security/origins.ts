import { matchMaker } from '@colyseus/core';
import { CSRF_HEADER } from '@cartignon/protocol';

/** Exact-match origin allowlist (scheme://host:port as browsers send it). */
export class OriginPolicy {
  private readonly origins: ReadonlySet<string>;

  constructor(origins: Iterable<string>) {
    this.origins = new Set(origins);
  }

  isListed(origin: string): boolean {
    return this.origins.has(origin);
  }

  /** A missing Origin is allowed (non-browser client, no ambient-credential risk). */
  allows(origin: string | null | undefined): boolean {
    return origin === undefined || origin === null || this.origins.has(origin);
  }

  /** CORS response headers for `origin`: only allowlisted origins get any grant. */
  corsHeaders(origin: string | null | undefined): Record<string, string> {
    return origin !== undefined && origin !== null && this.origins.has(origin)
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' }
      : {};
  }
}

interface CorsController {
  DEFAULT_CORS_HEADERS: Record<string, string>;
  getCorsHeaders(headers: Headers): Record<string, string>;
}

/**
 * Colyseus 0.18 answers every OPTIONS request and stamps CORS headers on every HTTP response
 * from `matchMaker.controller` (defaults: `Access-Control-Allow-Origin` = request Origin or
 * `*`, with credentials). Replace both so only allowlisted origins get a grant, for the
 * `/matchmake/*` routes and the Express API alike.
 */
export function restrictMatchmakerCors(policy: OriginPolicy): void {
  const controller = matchMaker.controller as unknown as CorsController;
  controller.DEFAULT_CORS_HEADERS = {
    'Access-Control-Allow-Headers': `Content-Type, Accept, ${CSRF_HEADER}`,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
  controller.getCorsHeaders = (headers: Headers) => policy.corsHeaders(headers.get('origin'));
}
