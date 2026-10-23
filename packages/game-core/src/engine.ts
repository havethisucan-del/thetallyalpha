import { createRngFromSeedBytes, createRngFromState } from './rng.js';
import type {
  AnyRulesModule,
  ForfeitReason,
  GameAction,
  MatchSetup,
  Outcome,
  PhaseInfo,
  Seat,
  TimeoutPlan,
} from './rules.js';

/**
 * Everything needed to resume a match: persisted as one row per revision boundary.
 * `revision` increases by exactly one per accepted action.
 */
export interface Snapshot<TState = unknown> {
  readonly rulesId: string;
  readonly rulesVersion: string;
  readonly revision: number;
  /** `Rng.getState()` format (32 lowercase hex chars). Server-only, never sent to clients. */
  readonly rngState: string;
  readonly state: TState;
}

export type StepErrorCode =
  /** `expectedRevision` is not the snapshot's revision (the client acted on an old view). */
  | 'STALE_REVISION'
  | 'MATCH_FINISHED'
  | 'RULES_MISMATCH'
  | 'MALFORMED'
  | 'UNSUPPORTED_VERSION'
  | 'NOT_YOUR_TURN'
  | 'ILLEGAL';

/**
 * `events` are the rules' RAW events (server-only, may contain hidden information); send each
 * seat only `eventsFor(rules, events, seat)`. `reason` is a rules-specific code on rejections.
 */
export type StepResult<TState = unknown> =
  | {
      readonly ok: true;
      readonly snapshot: Snapshot<TState>;
      readonly outcome: Outcome | null;
      readonly events: readonly unknown[];
    }
  | {
      readonly ok: false;
      readonly code: StepErrorCode;
      readonly message: string;
      readonly reason?: string;
    };

/**
 * Deep copy via JSON. Deliberate: state is persisted as JSON, so cloning through JSON keeps the
 * in-memory state identical to what a restart would load (no Dates, Maps or undefined).
 */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * `seed` is exactly `RNG_SEED_BYTES` (16) bytes. Production passes CSPRNG output
 * (`randomBytes(16)`); tests may pass `expandTestSeed(n)`.
 */
export function createMatch(rules: AnyRulesModule, setup: MatchSetup, seed: Uint8Array): Snapshot {
  const rng = createRngFromSeedBytes(seed);
  const state: unknown = rules.createInitialState(setup, rng);
  return {
    rulesId: rules.rulesId,
    rulesVersion: rules.rulesVersion,
    revision: 0,
    rngState: rng.getState(),
    state: cloneJson(state),
  };
}

/**
 * ADR-0018: a revision-0 snapshot around a state the caller built (e.g. a Cartignon preset deal,
 * `startPresetCartignonMatch`) instead of `rules.createInitialState`. `state` must be a valid
 * state of `rules`; it is not validated here. The RNG is seeded from `seed` (as `createMatch`)
 * and nothing is drawn from it.
 */
export function createMatchFromState(
  rules: AnyRulesModule,
  state: unknown,
  seed: Uint8Array,
): Snapshot {
  const rng = createRngFromSeedBytes(seed);
  return {
    rulesId: rules.rulesId,
    rulesVersion: rules.rulesVersion,
    revision: 0,
    rngState: rng.getState(),
    state: cloneJson(state),
  };
}

/**
 * Pure transition: validates and applies one action. The input snapshot is never mutated, so a
 * rejected or failed action cannot corrupt authoritative state. Idempotency (duplicate action
 * IDs) is the persistence layer's job; this function only knows about rules.
 * `expectedRevision` is the revision of the view the client acted on; it is checked first.
 */
export function step(
  rules: AnyRulesModule,
  snapshot: Snapshot,
  seat: Seat,
  input: GameAction,
  expectedRevision: number,
): StepResult {
  const rejected = precheck(rules, snapshot, expectedRevision);
  if (rejected !== null) return rejected;
  const parsed = rules.parseAction(input);
  if (!parsed.ok) return parsed;
  const validation = rules.validateAction(snapshot.state, seat, parsed.value);
  if (!validation.ok) return validation;

  const rng = createRngFromState(snapshot.rngState);
  const applied = rules.applyAction(cloneJson(snapshot.state), seat, parsed.value, rng) as {
    readonly state: unknown;
    readonly events: readonly unknown[];
  };
  return committed(rules, snapshot, rng.getState(), applied.state, applied.events);
}

/** R7: which clock expired. `turn`: the turn seat's turn clock; `choice`: a choice clock. */
export type TimeoutMode = 'turn' | 'choice';

/** Upper bound on the plans one `stepTimeout` applies (choice answers plus the final skip). */
export const MAX_TIMEOUT_PLANS = 8;

/** Shared pre-checks of `step`, `stepTimeout` and `forfeitMatch`. */
function precheck(
  rules: AnyRulesModule,
  snapshot: Snapshot,
  expectedRevision: number,
): StepResult | null {
  if (expectedRevision !== snapshot.revision) {
    return {
      ok: false,
      code: 'STALE_REVISION',
      message: `Action was made for revision ${expectedRevision}, current is ${snapshot.revision}`,
    };
  }
  if (snapshot.rulesId !== rules.rulesId || snapshot.rulesVersion !== rules.rulesVersion) {
    return { ok: false, code: 'RULES_MISMATCH', message: 'Snapshot was created by other rules' };
  }
  if (rules.resolveOutcome(snapshot.state) !== null) {
    return { ok: false, code: 'MATCH_FINISHED', message: 'Match is already finished' };
  }
  return null;
}

function committed(
  rules: AnyRulesModule,
  snapshot: Snapshot,
  rngState: string,
  state: unknown,
  events: readonly unknown[],
): StepResult {
  const next: unknown = cloneJson(state);
  return {
    ok: true,
    snapshot: {
      rulesId: snapshot.rulesId,
      rulesVersion: snapshot.rulesVersion,
      revision: snapshot.revision + 1,
      rngState,
      state: next,
    },
    outcome: rules.resolveOutcome(next),
    events,
  };
}

/**
 * R7: applies the rules' timeout plans for `seat` whose clock expired, as ONE revision with the
 * concatenated raw events (the server sends them with `cause: 'timeout'`).
 * - `choice`: answers the seat's pending choice once, then stops (RD-164).
 * - `turn`: answers the seat's pending choices (RD-165), then applies the turn skip (RD-33).
 * The loop stops after a skip, at `none`, when `seat` is no longer the acting seat (e.g. a nested
 * choice for the other seat, RD-160), when the turn (`turnKey`) changed, when the match ended, or
 * after `MAX_TIMEOUT_PLANS` plans.
 * Rejections (nothing applied, no revision): `STALE_REVISION`, `RULES_MISMATCH`, `MATCH_FINISHED`
 * as `step`; `NOT_YOUR_TURN` when `seat` is not acting (first plan `none`); `ILLEGAL` with reason
 * `NO_PENDING_CHOICE` in `choice` mode when the seat has no choice to answer. Throws when the
 * rules return a plan their own `validateAction` rejects (broken invariant).
 */
export function stepTimeout(
  rules: AnyRulesModule,
  snapshot: Snapshot,
  seat: Seat,
  mode: TimeoutMode,
  expectedRevision: number,
): StepResult {
  const rejected = precheck(rules, snapshot, expectedRevision);
  if (rejected !== null) return rejected;
  const rng = createRngFromState(snapshot.rngState);
  const startKey: string | null = rules.getPhase(snapshot.state).turnKey;
  let state: unknown = cloneJson(snapshot.state);
  const events: unknown[] = [];
  for (let applied = 0; applied < MAX_TIMEOUT_PLANS; applied++) {
    const plan = rules.timeoutAction(state, seat) as TimeoutPlan<GameAction>;
    if (applied === 0) {
      if (plan.kind === 'none') {
        return { ok: false, code: 'NOT_YOUR_TURN', message: `Seat ${seat} is not acting` };
      }
      if (mode === 'choice' && plan.kind !== 'answer') {
        return {
          ok: false,
          code: 'ILLEGAL',
          message: `Seat ${seat} has no pending choice`,
          reason: 'NO_PENDING_CHOICE',
        };
      }
    }
    if (plan.kind === 'none') break;
    if (mode === 'choice' && plan.kind !== 'answer') break;
    const validation = rules.validateAction(state, seat, plan.action);
    if (!validation.ok) {
      throw new Error(
        `${rules.rulesId}: invalid timeout plan ${plan.kind}/${plan.action.type} (${validation.code})`,
      );
    }
    const result = rules.applyAction(state, seat, plan.action, rng) as {
      readonly state: unknown;
      readonly events: readonly unknown[];
    };
    state = cloneJson(result.state);
    events.push(...result.events);
    if (plan.kind === 'skip' || mode === 'choice') break;
    if (rules.resolveOutcome(state) !== null) break;
    const phase: PhaseInfo = rules.getPhase(state);
    if (phase.activeSeat !== seat || phase.turnKey !== startKey) break;
  }
  return committed(rules, snapshot, rng.getState(), state, events);
}

/**
 * R7: `loser` forfeits the running match (RD-43, RD-41 / RD-46), as one revision. No randomness
 * is consumed. Rejections as `step` (`RULES_MISMATCH`, `MATCH_FINISHED`); the revision is the
 * snapshot's own (the server decides on its current snapshot).
 */
export function forfeitMatch(
  rules: AnyRulesModule,
  snapshot: Snapshot,
  loser: Seat,
  reason: ForfeitReason,
): StepResult {
  const rejected = precheck(rules, snapshot, snapshot.revision);
  if (rejected !== null) return rejected;
  const applied = rules.forfeit(cloneJson(snapshot.state), loser, reason) as {
    readonly state: unknown;
    readonly events: readonly unknown[];
  };
  const result = committed(rules, snapshot, snapshot.rngState, applied.state, applied.events);
  if (result.ok && result.outcome === null) {
    throw new Error(`${rules.rulesId}: forfeit did not end the match`);
  }
  return result;
}

/** The raw events of one step as `seat` may see them (redacted by the rules). */
export function eventsFor(
  rules: AnyRulesModule,
  events: readonly unknown[],
  seat: Seat,
): readonly unknown[] {
  return rules.projectEvents(events, seat);
}

/** The view one seat is authorized to see. Built only from the rules' projections. */
export interface SeatView<TPublic = unknown, TPrivate = unknown> {
  readonly rulesId: string;
  readonly revision: number;
  readonly rulesVersion: string;
  readonly phase: PhaseInfo;
  readonly public: TPublic;
  readonly private: TPrivate;
  readonly outcome: Outcome | null;
}

export function viewFor(rules: AnyRulesModule, snapshot: Snapshot, seat: Seat): SeatView {
  return {
    rulesId: snapshot.rulesId,
    revision: snapshot.revision,
    rulesVersion: snapshot.rulesVersion,
    phase: rules.getPhase(snapshot.state),
    public: rules.projectPublic(snapshot.state),
    private: rules.projectPrivate(snapshot.state, seat),
    outcome: rules.resolveOutcome(snapshot.state),
  };
}
