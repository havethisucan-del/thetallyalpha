import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { TicketStore } from '../src/rooms/tickets.js';
import { clientIp, normalizeIp, rateKey } from '../src/security/client-ip.js';
import { RateLimiter } from '../src/security/rate-limit.js';

function req(remoteAddress: string, xff?: string): IncomingMessage {
  return {
    socket: { remoteAddress },
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  } as unknown as IncomingMessage;
}

describe('client addresses', () => {
  it('normalises IPv4-mapped IPv6 and zone ids', () => {
    expect(normalizeIp('::ffff:192.0.2.7')).toBe('192.0.2.7');
    expect(normalizeIp('::FFFF:192.0.2.7')).toBe('192.0.2.7');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
  });

  it('keys IPv6 by /64 and IPv4 by address', () => {
    expect(rateKey('192.0.2.7')).toBe('192.0.2.7');
    expect(rateKey('::ffff:192.0.2.7')).toBe('192.0.2.7');
    expect(rateKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(rateKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(rateKey('2001:0db8:0001:0002::')).toBe('2001:db8:1:2::/64');
    expect(rateKey('::1')).toBe('0:0:0:0::/64');
    expect(rateKey('2001:db8:1:3::1')).not.toBe(rateKey('2001:db8:1:2::1'));
  });

  it('ignores X-Forwarded-For unless the peer is a trusted proxy', () => {
    expect(clientIp(req('::ffff:127.0.0.1', '203.0.113.5'), 'none')).toBe('127.0.0.1');
    expect(clientIp(req('198.51.100.1', '203.0.113.5'), 'loopback')).toBe('198.51.100.1');
    expect(clientIp(req('127.0.0.1', '203.0.113.5'), 'loopback')).toBe('203.0.113.5');
    expect(clientIp(req('::1', '1.1.1.1, 203.0.113.5'), 'loopback')).toBe('203.0.113.5');
    expect(clientIp(req('127.0.0.1', 'garbage'), 'loopback')).toBe('127.0.0.1');
    expect(clientIp(req('127.0.0.1'), 'loopback')).toBe('127.0.0.1');
  });
});

describe('rate limiter', () => {
  it('refuses new keys once the key map is full of non-idle buckets', () => {
    let now = 0;
    const limiter = new RateLimiter({ burst: 2, perMinute: 1 }, () => now, 2);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('b')).toBe(true);
    expect(limiter.take('c')).toBe(false); // full: fail closed
    expect(limiter.take('a')).toBe(true); // known keys keep working
    now += 10 * 60_000; // everything refilled → swept on demand
    expect(limiter.take('c')).toBe(true);
    expect(limiter.size).toBeLessThanOrEqual(2);
  });
});

describe('tickets', () => {
  it('a new ticket revokes the previous one; identities can be invalidated', () => {
    const store = new TicketStore();
    const grant = { identityId: 'i1', roomId: 'r1', seat: 0 as const };
    const first = store.issue(grant);
    const second = store.issue(grant);
    expect(store.consume(first.ticket)).toBeUndefined();
    expect(store.consume(second.ticket)).toEqual(grant);
    expect(store.consume(second.ticket)).toBeUndefined();
    const other = store.issue({ ...grant, roomId: 'r2' });
    store.invalidateIdentity('i1');
    expect(store.consume(other.ticket)).toBeUndefined();
  });
});

describe('production config fails closed', () => {
  const base = { DATABASE_URL: 'postgres://user:s3cret@db/app' };

  it('requires explicit https origins and secure cookies, without printing values', () => {
    let error: unknown;
    try {
      loadConfig({ ...base, NODE_ENV: 'production' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).toContain('ALLOWED_ORIGINS');
    expect(message).toContain('COOKIE_SECURE');
    expect(message).not.toContain('s3cret');

    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        ALLOWED_ORIGINS: 'http://game.example',
        COOKIE_SECURE: 'true',
      }),
    ).toThrow(/https/);
  });

  it('accepts a correct production config; dev defaults stay permissive', () => {
    const prod = loadConfig({
      ...base,
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://game.example',
      COOKIE_SECURE: 'true',
      TRUSTED_PROXY: 'loopback',
    });
    expect(prod.cookieSecure).toBe(true);
    expect(prod.trustedProxy).toBe('loopback');
    const dev = loadConfig(base);
    expect(dev.cookieSecure).toBe(false);
    expect(dev.trustedProxy).toBe('none');
    expect(dev.allowedOrigins).toEqual(['http://127.0.0.1:5173', 'http://localhost:5173']);
    expect(dev.seatClaimTimeoutMs).toBe(60_000);
    expect(dev.roomFinishedTtlMs).toBe(60_000);
    expect(dev.roomMaxLifetimeMs).toBe(12 * 60 * 60_000); // RD-167
    expect(dev.turnTimeoutMs).toBe(900_000);
    expect(dev.choiceTimeoutMs).toBe(60_000);
    expect(dev.pauseBudgetMs).toBe(180_000);
    expect(loadConfig({ ...base, TURN_TIMEOUT_SECONDS: '0.3' }).turnTimeoutMs).toBe(300);
    expect(() => loadConfig({ ...base, PAUSE_BUDGET_SECONDS: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, TRUSTED_PROXY: 'everyone' })).toThrow(ConfigError);
  });
});
