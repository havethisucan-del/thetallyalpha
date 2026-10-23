import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { createPool } from '@cartignon/database';
import { INVITE_CODE_ALPHABET, type Player } from '@cartignon/protocol';

/** `pg.Pool`, named through the database package (the server has no direct `pg` dependency). */
export type Pool = ReturnType<typeof createPool>;

export const SESSION_COOKIE = 'cartignon_session';
/** `__Host-` prefix: browsers only accept it with Secure, Path=/ and no Domain. */
export const SECURE_SESSION_COOKIE = '__Host-cartignon_session';

export function sessionCookieName(secure: boolean): string {
  return secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
}

/** Expired or revoked sessions are deleted this long after they stopped being valid. */
export const SESSION_PURGE_GRACE_DAYS = 7;

/** 32 random bytes, base64url without padding. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Account kinds. Only guests exist today; an upgrade flow would add a kind here (and in the
 * `identity_kind` enum) while the identity id stays the same.
 */
export type IdentityKind = Player['kind'];

export interface Identity {
  readonly id: string;
  readonly kind: IdentityKind;
  readonly displayName: string;
}

export interface Session {
  readonly identity: Identity;
  readonly expiresAt: Date;
}

export interface NewSession extends Session {
  /** Raw token for the cookie. Never stored or logged; only its SHA-256 is persisted. */
  readonly token: string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateGuestName(): string {
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += INVITE_CODE_ALPHABET[randomInt(INVITE_CODE_ALPHABET.length)] ?? '';
  }
  return `Guest-${suffix}`;
}

function toKind(value: string): IdentityKind {
  if (value === 'guest') return value;
  throw new Error('unknown identity kind');
}

interface SessionRow {
  identity_id: string;
  kind: string;
  display_name: string;
  expires_at: Date;
}

/** Guest identities and opaque sessions in PostgreSQL. Identity derives only from the token. */
export class SessionService {
  private readonly pool: Pool;
  private readonly ttlMs: number;

  constructor(pool: Pool, ttlDays: number) {
    this.pool = pool;
    this.ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  }

  get ttlSeconds(): number {
    return Math.floor(this.ttlMs / 1000);
  }

  /** Valid = exists, not revoked, not expired. Malformed tokens never reach the database. */
  async find(token: string | undefined): Promise<Session | undefined> {
    if (token === undefined || !TOKEN_PATTERN.test(token)) return undefined;
    const result = await this.pool.query<SessionRow>(
      `SELECT i.id AS identity_id, i.kind, i.display_name, s.expires_at
         FROM sessions s
         JOIN identities i ON i.id = s.identity_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [hashToken(token)],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      identity: { id: row.identity_id, kind: toKind(row.kind), displayName: row.display_name },
      expiresAt: row.expires_at,
    };
  }

  /** Creates a guest identity and its first session in one statement (atomic). */
  async createGuest(): Promise<NewSession> {
    const token = randomBytes(32).toString('base64url');
    const displayName = generateGuestName();
    const expiresAt = new Date(Date.now() + this.ttlMs);
    const result = await this.pool.query<SessionRow>(
      `WITH identity AS (
         INSERT INTO identities (kind, display_name) VALUES ('guest', $1)
         RETURNING id, kind, display_name
       ), session AS (
         INSERT INTO sessions (identity_id, token_hash, expires_at)
         SELECT id, $2, $3 FROM identity
         RETURNING expires_at
       )
       SELECT identity.id AS identity_id, identity.kind, identity.display_name, session.expires_at
         FROM identity, session`,
      [displayName, hashToken(token), expiresAt],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('guest session insert returned no row');
    return {
      token,
      identity: { id: row.identity_id, kind: toKind(row.kind), displayName: row.display_name },
      expiresAt: row.expires_at,
    };
  }

  /** Revokes the session; returns the identity it belonged to (if it was valid). */
  async revoke(token: string | undefined): Promise<string | undefined> {
    if (token === undefined || !TOKEN_PATTERN.test(token)) return undefined;
    const result = await this.pool.query<{ identity_id: string }>(
      `UPDATE sessions SET revoked_at = now()
        WHERE token_hash = $1 AND revoked_at IS NULL
        RETURNING identity_id`,
      [hashToken(token)],
    );
    return result.rows[0]?.identity_id;
  }

  /**
   * Deletes sessions that expired or were revoked more than `graceDays` ago. Identities are
   * never deleted (they will own match history). Returns the number of rows removed.
   */
  async purgeExpired(graceDays: number = SESSION_PURGE_GRACE_DAYS): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM sessions
        WHERE expires_at < now() - make_interval(days => $1)
           OR revoked_at < now() - make_interval(days => $1)`,
      [graceDays],
    );
    return result.rowCount ?? 0;
  }
}
