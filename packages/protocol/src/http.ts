import { z } from 'zod';
import { inviteCodeSchema } from './common.js';

/**
 * HTTP API contracts. Identity comes only from the HttpOnly session cookie; no request body
 * ever carries a player ID.
 */

/** Header every state-changing request must carry (CSRF defence together with Origin checks). */
export const CSRF_HEADER = 'x-cartignon-csrf';

export const playerSchema = z.strictObject({
  playerId: z.uuid(),
  displayName: z.string().min(1).max(32),
  kind: z.enum(['guest']),
});
export type Player = z.infer<typeof playerSchema>;

export const sessionResponseSchema = z.strictObject({
  player: playerSchema,
  expiresAt: z.iso.datetime(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/**
 * HTTP routes. All POSTs require `CSRF_HEADER` and an allowed `Origin`; errors use
 * `errorBodySchema`. Status codes: 400 BAD_REQUEST, 401 UNAUTHENTICATED, 403 FORBIDDEN,
 * 404 NOT_FOUND, 409 CONFLICT / ROOM_FULL, 410 ROOM_EXPIRED, 413 PAYLOAD_TOO_LARGE,
 * 429 RATE_LIMITED, 500 INTERNAL.
 */
export const ApiRoute = {
  /** GET → 200 `HealthResponse` (process alive). */
  Health: '/healthz',
  /** GET → 200/503 `HealthResponse` (database reachable, not shutting down). */
  Ready: '/readyz',
  /** POST (no body) → 201 new guest or 200 existing valid session; sets the session cookie. */
  GuestSession: '/api/session/guest',
  /** GET → 200 `SessionResponse` or 401. */
  Session: '/api/session',
  /** POST → 204; revokes the session and clears the cookie. */
  Logout: '/api/session/logout',
  /** POST (no body) → 201 `RoomAdmission`; creates a private room with a fresh invite code. */
  CreatePrivateRoom: '/api/rooms/private',
  /** POST `JoinPrivateRoomRequest` → 200 `RoomAdmission`; 404 unknown, 409 full, 410 expired. */
  JoinPrivateRoom: '/api/rooms/private/join',
  /** POST `RoomTicketRequest` → 200 `RoomAdmission`; only for a room the player already sits in. */
  RoomTicket: '/api/rooms/ticket',
} as const;

export const joinPrivateRoomRequestSchema = z.strictObject({
  code: inviteCodeSchema,
});
export type JoinPrivateRoomRequest = z.infer<typeof joinPrivateRoomRequestSchema>;

export const roomTicketRequestSchema = z.strictObject({
  roomId: z.string().min(1).max(64),
});
export type RoomTicketRequest = z.infer<typeof roomTicketRequestSchema>;

/**
 * Permission to enter one room. `ticket` is opaque, single-use, short-lived and bound to the
 * session's identity and `roomId`; the client passes it as `MatchJoinOptions.ticket`.
 */
export const roomAdmissionSchema = z.strictObject({
  roomId: z.string().min(1).max(64),
  code: inviteCodeSchema.nullable(),
  ticket: z.string().min(16).max(128),
  ticketExpiresAt: z.iso.datetime(),
});
export type RoomAdmission = z.infer<typeof roomAdmissionSchema>;

export const healthResponseSchema = z.strictObject({
  status: z.enum(['ok', 'unavailable']),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
