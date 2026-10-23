import type { IncomingMessage } from 'node:http';
import { isIP, isIPv4 } from 'node:net';

/**
 * Which socket peers may vouch for the client address via `X-Forwarded-For`.
 * - `none`: never; the socket peer is the client (direct exposure, the default).
 * - `loopback`: a reverse proxy on the same host (127.0.0.0/8, ::1).
 */
export type TrustedProxy = 'none' | 'loopback';

/** `::ffff:a.b.c.d` → `a.b.c.d`; other addresses unchanged (lower-cased, zone id dropped). */
export function normalizeIp(address: string): string {
  const lower = address.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (mapped?.[1] !== undefined && isIPv4(mapped[1])) return mapped[1];
  const zone = lower.indexOf('%');
  return zone === -1 ? lower : lower.slice(0, zone);
}

export function isLoopback(address: string): boolean {
  const ip = normalizeIp(address);
  return ip === '::1' || (isIPv4(ip) && ip.startsWith('127.'));
}

/** Expands an IPv6 address to its 8 hextets (embedded IPv4 tail supported). */
function ipv6Hextets(ip: string): number[] | undefined {
  let address = ip;
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (v4?.[1] !== undefined) {
    const octets = v4[1].split('.').map(Number);
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    address = `${address.slice(0, -v4[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] === '' || halves[0] === undefined ? [] : halves[0].split(':');
  const tail =
    halves.length === 2 && halves[1] !== '' && halves[1] !== undefined ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  const parts = [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
  const hextets = parts.map((p) => Number.parseInt(p, 16));
  return hextets.every((h) => Number.isInteger(h) && h >= 0 && h <= 0xffff) ? hextets : undefined;
}

/**
 * Rate-limit key for an address: IPv4 as is, IPv6 by its /64 prefix (one subscriber usually
 * controls a whole /64, so per-address keys would be trivially evaded).
 */
export function rateKey(address: string): string {
  const ip = normalizeIp(address);
  if (isIP(ip) !== 6) return ip;
  const hextets = ipv6Hextets(ip);
  if (hextets === undefined) return ip;
  return `${hextets
    .slice(0, 4)
    .map((h) => h.toString(16))
    .join(':')}::/64`;
}

/**
 * The client address of a request. `X-Forwarded-For` is honoured only when the socket peer is
 * a trusted proxy, and then only its right-most entry (the address that proxy saw); anything
 * to its left is client-controlled.
 */
export function clientIp(req: IncomingMessage, trust: TrustedProxy): string {
  const peer = normalizeIp(req.socket.remoteAddress ?? 'unknown');
  if (trust === 'none' || !isLoopback(peer)) return peer;
  const header = req.headers['x-forwarded-for'];
  const value = Array.isArray(header) ? header.join(',') : header;
  if (value === undefined) return peer;
  const entries = value
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '');
  const last = entries[entries.length - 1];
  if (last === undefined) return peer;
  const ip = normalizeIp(last);
  return isIP(ip) === 0 ? peer : ip;
}

/** Rate-limit key of a request's client. */
export function clientKey(req: IncomingMessage, trust: TrustedProxy): string {
  return rateKey(clientIp(req, trust));
}
