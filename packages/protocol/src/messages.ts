import { z } from 'zod';
import { actionIdSchema, errorCodeSchema, seatSchema } from './common.js';

/**
 * WebSocket message contracts for match rooms. Lobby/connection metadata travels in the room's
 * synchronized state; game state travels only as per-seat views in `match:view` messages.
 * Clients never send identities, seats or timer values. The only revision a client sends is
 * `expectedRevision`: the revision of the view it acted on (stale actions are rejected).
 */
/** Colyseus room name for 1v1 matches (lobby → active → finished in one room). */
export const MATCH_ROOM = 'match';

/** Options passed to `client.joinById(roomId, options)`. Nothing else is accepted. */
export const matchJoinOptionsSchema = z.strictObject({
  ticket: z.string().min(16).max(128),
});
export type MatchJoinOptions = z.infer<typeof matchJoinOptionsSchema>;

export type RoomPhase = 'lobby' | 'active' | 'finished';

/**
 * Public, synchronized room state (Colyseus schema on the server; plain shape here for clients).
 * Contains no hidden information and no identities — only display data per seat.
 * `players` is keyed by seat as a string: '0' | '1'.
 */
export interface PublicRoomState {
  phase: RoomPhase;
  code: string;
  players: Map<string, PublicSeatState>;
}

export interface PublicSeatState {
  displayName: string;
  ready: boolean;
  connected: boolean;
}

export const ClientMessage = {
  Ready: 'ready',
  Action: 'action',
} as const;

export const ServerMessage = {
  /** Sent once after join: which seat this client occupies. */
  Welcome: 'welcome',
  View: 'match:view',
  ActionResult: 'action:result',
  Error: 'error',
  /** R7: clock change without a new revision (pause on disconnect, resume on rejoin). */
  Clock: 'match:clock',
} as const;

export const welcomeMessageSchema = z.strictObject({
  seat: seatSchema,
});
export type WelcomeMessage = z.infer<typeof welcomeMessageSchema>;

export const readyMessageSchema = z.strictObject({
  ready: z.boolean(),
});
export type ReadyMessage = z.infer<typeof readyMessageSchema>;

/**
 * Envelope for a game action. `payload` is shape-checked by the active rules module; here it is
 * only bounded (the transport caps total message size). `expectedRevision` is the `revision` of
 * the last view the client acted on; a mismatch is rejected with `STALE_REVISION`.
 */
export const actionMessageSchema = z.strictObject({
  actionId: actionIdSchema,
  expectedRevision: z.int().min(0),
  action: z.strictObject({
    type: z.string().min(1).max(64),
    v: z.int().min(1).max(1000),
    payload: z.unknown(),
  }),
});
export type ActionMessage = z.infer<typeof actionMessageSchema>;

/**
 * Sent after the action is committed (accepted / duplicate) or definitively refused (rejected).
 * `duplicate` means this actionId was already committed; it carries the revision it produced.
 */
export const actionResultMessageSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('accepted'),
    actionId: actionIdSchema,
    revision: z.int().min(1),
  }),
  z.strictObject({
    status: z.literal('duplicate'),
    actionId: actionIdSchema,
    revision: z.int().min(1),
  }),
  z.strictObject({
    status: z.literal('rejected'),
    actionId: actionIdSchema,
    code: z.string().max(64),
    message: z.string().max(200),
    /** Rules-specific code (e.g. Cartignon `CHOICE_PENDING`); absent when there is none. */
    reason: z.string().max(64).optional(),
  }),
]);
export type ActionResultMessage = z.infer<typeof actionResultMessageSchema>;

/**
 * R7: the running match clock (RD-25 / RD-33 turn clock, RD-164 choice clock, RD-41 / RD-46
 * pause). Public: both seats receive the same data. Times are milliseconds; `deadline` and
 * `serverTime` are server epoch times (`deadline` null while the clock is paused); a client
 * computes the time left as `deadline - serverTime` adjusted by its own receipt time.
 * - `seat`: whose clock runs; `mode`: `turn` (the turn seat) or `choice` (a seat answering a
 *   choice during the other seat's turn).
 * - `running`: false while paused (the clock's seat is disconnected).
 * - `remainingMs`: time left on the clock at `serverTime`.
 * - `pauseLeftMs`: pause budget left per seat (index = seat).
 * - `consecutiveTimeouts`: RD-43 counter per seat (index = seat).
 */
export const clockViewSchema = z.strictObject({
  seat: seatSchema,
  mode: z.enum(['turn', 'choice']),
  running: z.boolean(),
  remainingMs: z.int().min(0),
  deadline: z.int().min(0).nullable(),
  serverTime: z.int().min(0),
  pauseLeftMs: z.tuple([z.int().min(0), z.int().min(0)]),
  consecutiveTimeouts: z.tuple([z.int().min(0), z.int().min(0)]),
});
export type ClockView = z.infer<typeof clockViewSchema>;

/** R7: why this view was sent: an accepted action, a clock timeout, or a forfeit. */
export const viewCauseSchema = z.enum(['action', 'timeout', 'forfeit']);
export type ViewCause = z.infer<typeof viewCauseSchema>;

const outcomeSchema = z.discriminatedUnion('result', [
  z.strictObject({ result: z.literal('winner'), winner: seatSchema, reason: z.string() }),
  z.strictObject({ result: z.literal('draw'), reason: z.string() }),
]);

/**
 * The authorized view for one seat, produced by game-core projections. `rulesId` selects how
 * `public` / `private` / `events` are interpreted (e.g. `cartignon` -> cartignon.ts schemas).
 * `phase.activeSeat` is the seat that must act now; `phase.turnSeat` the seat whose turn it is
 * (they differ e.g. while the other seat answers a choice). `events` are the events of the step
 * that produced this revision, already redacted for this seat; a join / reconnect view carries
 * `events: []` (the view itself is authoritative, events are never replayed).
 * R7: `clock` is the match clock after this revision (null when no clock runs, e.g. the match is
 * over); `cause` says what produced the revision (a join / reconnect view uses `action`).
 */
export const matchViewMessageSchema = z.strictObject({
  matchId: z.uuid(),
  seat: seatSchema,
  revision: z.int().min(0),
  rulesId: z.string().max(64),
  rulesVersion: z.string(),
  phase: z.strictObject({
    id: z.string(),
    activeSeat: seatSchema.nullable(),
    turnSeat: seatSchema.nullable(),
  }),
  public: z.unknown(),
  private: z.unknown(),
  events: z.array(z.unknown()).max(512),
  outcome: outcomeSchema.nullable(),
  clock: clockViewSchema.nullable(),
  cause: viewCauseSchema,
});
export type MatchViewMessage = z.infer<typeof matchViewMessageSchema>;

/** R7 `match:clock`: the clock changed without a new revision (pause / resume). */
export const clockMessageSchema = z.strictObject({
  matchId: z.uuid(),
  revision: z.int().min(0),
  clock: clockViewSchema.nullable(),
});
export type ClockMessage = z.infer<typeof clockMessageSchema>;

export const serverErrorMessageSchema = z.strictObject({
  code: errorCodeSchema,
  message: z.string().max(200),
});
export type ServerErrorMessage = z.infer<typeof serverErrorMessageSchema>;
