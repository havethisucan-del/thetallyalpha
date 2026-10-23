import type { Rng } from './rng.js';

/** A player's seat in a 1v1 match. Seats, not identities, are what rules reason about. */
export type Seat = 0 | 1;

export const SEATS: readonly Seat[] = [0, 1];

/**
 * A versioned action as the rules see it. `v` is the action schema version so old clients can
 * be rejected (or migrated) explicitly when an action's shape changes.
 */
export interface GameAction<TType extends string = string, TPayload = unknown> {
  readonly type: TType;
  readonly v: number;
  readonly payload: TPayload;
}

/**
 * Rules-defined phase. `activeSeat` is the seat that must act now (it drives server-side turn
 * clocks); null means nobody acts. `turnSeat` is the seat whose turn it is; it can differ from
 * `activeSeat` when the rules hand a decision to the other seat mid-turn (Cartignon RD-160).
 */
export interface PhaseInfo {
  readonly id: string;
  readonly activeSeat: Seat | null;
  readonly turnSeat: Seat | null;
  /**
   * R7: identifies the current turn (opaque, at most 64 chars); it changes whenever a new turn
   * starts and is null when nobody acts. Server turn clocks use it to detect a turn change.
   */
  readonly turnKey: string | null;
}

/**
 * R7: what the server does when `seat`'s clock expires (`timeoutAction`).
 * - `answer`: answer the seat's pending choice with `action` (a legal answer).
 * - `skip`: end the seat's turn with `action`. It may be an internal action that `parseAction`
 *   never produces (so a client can never submit it); `validateAction` / `applyAction` accept it.
 * - `none`: the seat is not acting; nothing to do.
 */
export type TimeoutPlan<TAction> =
  | { readonly kind: 'answer'; readonly action: TAction }
  | { readonly kind: 'skip'; readonly action: TAction }
  | { readonly kind: 'none' };

/**
 * R7 (RD-43, RD-41/46): `turnTimeouts` = two consecutive turn timeouts by the same seat;
 * `timeoutAfterPause` = the clock expired after the pause budget ran out and nothing was played.
 */
export type ForfeitReason = 'turnTimeouts' | 'timeoutAfterPause';

export type Outcome =
  | { readonly result: 'winner'; readonly winner: Seat; readonly reason: string }
  | { readonly result: 'draw'; readonly reason: string };

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: 'MALFORMED' | 'UNSUPPORTED_VERSION';
      readonly message: string;
    };

/** `reason` is an optional rules-specific code (e.g. Cartignon `CHOICE_PENDING`), max 64 chars. */
export type Validation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'NOT_YOUR_TURN' | 'ILLEGAL';
      readonly message: string;
      readonly reason?: string;
    };

/** What `applyAction` produced: the next state and the raw (unredacted, server-only) events. */
export interface Applied<TState, TEvent> {
  readonly state: TState;
  readonly events: readonly TEvent[];
}

/** Inputs fixed at match creation (e.g. which fixed deck each seat uses). */
export interface MatchSetup {
  readonly options: Readonly<Record<string, unknown>>;
}

/**
 * The contract every rule set implements. Implementations must be deterministic given the same
 * state, action and RNG, and state must be JSON-serializable (it is persisted as a snapshot).
 * `applyAction` may mutate the state it receives; the engine always hands it a private copy.
 * Raw events (`TEvent`) may carry hidden information; only `projectEvents` output may leave the
 * server.
 */
export interface RulesModule<
  TState,
  TAction extends GameAction,
  TPublic,
  TPrivate,
  TEvent = never,
> {
  readonly rulesId: string;
  readonly rulesVersion: string;
  createInitialState(setup: MatchSetup, rng: Rng): TState;
  /** Runtime validation of the action shape; input comes from the network. */
  parseAction(input: GameAction): ParseResult<TAction>;
  validateAction(state: TState, seat: Seat, action: TAction): Validation;
  applyAction(state: TState, seat: Seat, action: TAction, rng: Rng): Applied<TState, TEvent>;
  getPhase(state: TState): PhaseInfo;
  /** Information both seats may see. Must never contain hidden information. */
  projectPublic(state: TState): TPublic;
  /** Information only `seat` may see (its own hidden data). */
  projectPrivate(state: TState, seat: Seat): TPrivate;
  /** The events `seat` may see, redacted for it (JSON-serializable). */
  projectEvents(events: readonly TEvent[], seat: Seat): readonly unknown[];
  /** Non-null once the game is over; the engine refuses further actions after that. */
  resolveOutcome(state: TState): Outcome | null;
  /**
   * R7: the next server action for `seat` when its clock expires. Called repeatedly by
   * `stepTimeout` on the evolving state; must return `none` once the match is over or `seat` is
   * not the acting seat. Every returned action must pass `validateAction` for `seat`.
   */
  timeoutAction(state: TState, seat: Seat): TimeoutPlan<TAction>;
  /**
   * R7: ends a running match: `loser` forfeits, the other seat wins. Only called while
   * `resolveOutcome(state)` is null. May mutate `state` (the engine hands it a private copy).
   */
  forfeit(state: TState, loser: Seat, reason: ForfeitReason): Applied<TState, TEvent>;
}

// Erases the concrete type parameters so infrastructure code can hold any rule set.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRulesModule = RulesModule<any, any, any, any, any>;
