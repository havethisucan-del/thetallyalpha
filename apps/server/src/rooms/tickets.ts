import { randomBytes } from 'node:crypto';
import type { Seat } from '@cartignon/game-core';

export const TICKET_TTL_MS = 60_000;

/** What a ticket proves once redeemed: this identity may occupy `seat` in `roomId`. */
export interface TicketGrant {
  readonly identityId: string;
  readonly roomId: string;
  readonly seat: Seat;
}

interface StoredTicket extends TicketGrant {
  readonly expiresAt: number;
}

export interface IssuedTicket {
  readonly ticket: string;
  readonly expiresAt: Date;
}

const keyOf = (identityId: string, roomId: string) => `${identityId}\u0000${roomId}`;

/**
 * Opaque, single-use, short-lived room tickets, held in memory only (a restart invalidates
 * them, which is fine: clients fetch a new one with their session cookie). At most one ticket
 * per (identity, room) is valid: issuing a new one revokes the previous one, so a player
 * cannot stockpile tickets.
 */
export class TicketStore {
  private readonly tickets = new Map<string, StoredTicket>();
  /** (identity, room) → the one outstanding ticket. */
  private readonly latest = new Map<string, string>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs: number = TICKET_TTL_MS, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  issue(grant: TicketGrant): IssuedTicket {
    if (this.tickets.size > 1_000) this.sweep();
    const key = keyOf(grant.identityId, grant.roomId);
    const previous = this.latest.get(key);
    if (previous !== undefined) this.tickets.delete(previous);
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.ttlMs;
    this.tickets.set(ticket, { ...grant, expiresAt });
    this.latest.set(key, ticket);
    return { ticket, expiresAt: new Date(expiresAt) };
  }

  /** Redeems the ticket exactly once. Synchronous, so two redemptions can never both win. */
  consume(ticket: string): TicketGrant | undefined {
    const stored = this.tickets.get(ticket);
    if (stored === undefined) return undefined;
    this.remove(ticket, stored);
    if (stored.expiresAt <= this.now()) return undefined;
    return { identityId: stored.identityId, roomId: stored.roomId, seat: stored.seat };
  }

  invalidateRoom(roomId: string): void {
    for (const [ticket, stored] of this.tickets) {
      if (stored.roomId === roomId) this.remove(ticket, stored);
    }
  }

  /** Drops tickets of `identityId` (all rooms, or only `roomId`). */
  invalidateIdentity(identityId: string, roomId?: string): void {
    for (const [ticket, stored] of this.tickets) {
      if (stored.identityId === identityId && (roomId === undefined || stored.roomId === roomId)) {
        this.remove(ticket, stored);
      }
    }
  }

  sweep(): void {
    const now = this.now();
    for (const [ticket, stored] of this.tickets) {
      if (stored.expiresAt <= now) this.remove(ticket, stored);
    }
  }

  get size(): number {
    return this.tickets.size;
  }

  private remove(ticket: string, stored: StoredTicket): void {
    this.tickets.delete(ticket);
    const key = keyOf(stored.identityId, stored.roomId);
    if (this.latest.get(key) === ticket) this.latest.delete(key);
  }
}
