import { randomInt } from 'node:crypto';
import type { Seat } from '@cartignon/game-core';
import { INVITE_CODE_ALPHABET, INVITE_CODE_LENGTH, type RoomPhase } from '@cartignon/protocol';

export interface SeatHolder {
  readonly identityId: string;
  readonly displayName: string;
}

/** What the registry needs from a live room (implemented by the match room). */
export interface RoomHandle {
  /** A seat was assigned over HTTP; show it in the public state (not yet connected). */
  seatAssigned(seat: Seat, holder: SeatHolder): void;
  /** Whether the seat currently has a live WebSocket connection. */
  isSeatLive(seat: Seat): boolean;
}

export interface RoomRecord {
  readonly roomId: string;
  readonly code: string;
  readonly seats: [SeatHolder | undefined, SeatHolder | undefined];
  /** Per seat: when an in-flight matchmaking reservation lapses (0 = none). */
  readonly reservations: [number, number];
  phase: RoomPhase;
  readonly handle: RoomHandle;
}

export type Admission =
  | { readonly ok: true; readonly seat: Seat; readonly record: RoomRecord }
  | { readonly ok: false; readonly reason: 'ROOM_FULL' | 'ROOM_EXPIRED' };

/** How long disposed room ids are remembered so late requests get 410 instead of 404. */
const EXPIRED_MEMORY_MS = 60 * 60 * 1000;
const EXPIRED_MEMORY_MAX = 10_000;

/**
 * In-process source of truth for private rooms: invite codes, seat ownership (seat →
 * identity), in-flight reservations and lifecycle. Every mutation is synchronous — there is
 * never an `await` between a check and the write that depends on it — so concurrent requests
 * cannot seat a third identity or one identity twice. Single instance only (like the Colyseus
 * LocalDriver).
 */
export class RoomRegistry {
  private readonly byId = new Map<string, RoomRecord>();
  private readonly byCode = new Map<string, RoomRecord>();
  /** Codes handed out for rooms still being created → their creator (seat 0). */
  private readonly pending = new Map<string, SeatHolder>();
  private readonly expired = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Reserves a fresh invite code for a room about to be created by `owner`. */
  reserveCode(owner: SeatHolder): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      let code = '';
      for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
        code += INVITE_CODE_ALPHABET[randomInt(INVITE_CODE_ALPHABET.length)] ?? '';
      }
      if (!this.byCode.has(code) && !this.pending.has(code)) {
        this.pending.set(code, owner);
        return code;
      }
    }
    throw new Error('could not allocate a unique invite code');
  }

  /** Undoes `reserveCode`, and unregisters the room if creation failed after `bind`. */
  abandonCode(code: string): void {
    this.pending.delete(code);
    const record = this.byCode.get(code);
    if (record !== undefined) {
      this.byId.delete(record.roomId);
      this.byCode.delete(code);
    }
  }

  /** Called by the room's onCreate: binds the reserved code to the live room. */
  bind(code: string, roomId: string, handle: RoomHandle): RoomRecord {
    const owner = this.pending.get(code);
    if (owner === undefined) throw new Error('room created without a reserved invite code');
    this.pending.delete(code);
    const record: RoomRecord = {
      roomId,
      code,
      seats: [owner, undefined],
      reservations: [0, 0],
      phase: 'lobby',
      handle,
    };
    this.byId.set(roomId, record);
    this.byCode.set(code, record);
    return record;
  }

  get(roomId: string): RoomRecord | undefined {
    return this.byId.get(roomId);
  }

  findByCode(code: string): RoomRecord | undefined {
    return this.byCode.get(code);
  }

  seatOf(record: RoomRecord, identityId: string): Seat | undefined {
    if (record.seats[0]?.identityId === identityId) return 0;
    if (record.seats[1]?.identityId === identityId) return 1;
    return undefined;
  }

  /**
   * Seats `holder` (synchronously): an identity that already holds a seat gets it back;
   * otherwise the first free seat while the room is still in the lobby.
   */
  admit(record: RoomRecord, holder: SeatHolder): Admission {
    const existing = this.seatOf(record, holder.identityId);
    if (existing !== undefined) return { ok: true, seat: existing, record };
    if (record.phase !== 'lobby' || !this.byId.has(record.roomId)) {
      return { ok: false, reason: 'ROOM_EXPIRED' };
    }
    const free: Seat | undefined =
      record.seats[0] === undefined ? 0 : record.seats[1] === undefined ? 1 : undefined;
    if (free === undefined) return { ok: false, reason: 'ROOM_FULL' };
    record.seats[free] = holder;
    record.handle.seatAssigned(free, holder);
    return { ok: true, seat: free, record };
  }

  /** Frees a lobby seat (ghost seat or voluntary leave). Returns the former holder. */
  releaseSeat(roomId: string, seat: Seat): SeatHolder | undefined {
    const record = this.byId.get(roomId);
    if (record?.phase !== 'lobby') return undefined;
    const holder = record.seats[seat];
    record.seats[seat] = undefined;
    record.reservations[seat] = 0;
    return holder;
  }

  /**
   * Starts a matchmaking reservation for `seat` unless one is already in flight. With at
   * most one live connection or one reservation per seat, a player can never fill the
   * room's Colyseus capacity and lock the other seat out.
   */
  beginReservation(record: RoomRecord, seat: Seat, ttlMs: number): boolean {
    if (record.reservations[seat] > this.now()) return false;
    record.reservations[seat] = this.now() + ttlMs;
    return true;
  }

  endReservation(roomId: string, seat: Seat): void {
    const record = this.byId.get(roomId);
    if (record !== undefined) record.reservations[seat] = 0;
  }

  hasReservationInFlight(roomId: string): boolean {
    const record = this.byId.get(roomId);
    const now = this.now();
    return record !== undefined && record.reservations.some((until) => until > now);
  }

  setPhase(roomId: string, phase: RoomPhase): void {
    const record = this.byId.get(roomId);
    if (record !== undefined) record.phase = phase;
  }

  /** Called when the room is disposed: frees the code and remembers the id as expired. */
  remove(roomId: string): void {
    const record = this.byId.get(roomId);
    if (record === undefined) return;
    this.byId.delete(roomId);
    if (this.byCode.get(record.code) === record) this.byCode.delete(record.code);
    this.rememberExpired(roomId);
  }

  isExpired(roomId: string): boolean {
    const at = this.expired.get(roomId);
    return at !== undefined && this.now() - at < EXPIRED_MEMORY_MS;
  }

  get liveRoomCount(): number {
    return this.byId.size;
  }

  /** Live rooms plus rooms being created (what a global room cap must count). */
  get allocatedRoomCount(): number {
    return this.byId.size + this.pending.size;
  }

  private rememberExpired(roomId: string): void {
    const now = this.now();
    if (this.expired.size >= EXPIRED_MEMORY_MAX) {
      for (const [id, at] of this.expired) {
        if (now - at >= EXPIRED_MEMORY_MS || this.expired.size >= EXPIRED_MEMORY_MAX) {
          this.expired.delete(id);
        } else break;
      }
    }
    this.expired.set(roomId, now);
  }
}
