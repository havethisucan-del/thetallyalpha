import type { ForfeitReason, GameAction, ParseResult, RulesModule, Seat } from './rules.js';

/**
 * SYNTHETIC TEST FIXTURE — not gameplay. A minimal rule set that exercises infrastructure:
 * turn order (active seat), per-seat hidden data (secrets drawn from the RNG), deterministic
 * randomness, revisions, idempotency and terminal outcomes.
 *
 * Seats alternate; each `increment` adds 1..3 to a shared counter and draws a hidden secret for
 * the acting seat. The seat that brings the counter to `target` wins.
 * R7: a timeout skip is `increment { amount: 1 }`; a forfeit makes the other seat win.
 */
export interface SyntheticState {
  phase: 'playing' | 'finished';
  activeSeat: Seat;
  counter: number;
  target: number;
  secrets: [number[], number[]];
  winner: Seat | null;
  /** R7: set when the match ended by forfeit; absent = ended by reaching the target. */
  endReason?: SyntheticForfeitReason;
}

export type SyntheticForfeitReason = 'forfeitTimeouts' | 'forfeitTimeoutAfterPause';

const FORFEIT_REASONS: Readonly<Record<ForfeitReason, SyntheticForfeitReason>> = {
  turnTimeouts: 'forfeitTimeouts',
  timeoutAfterPause: 'forfeitTimeoutAfterPause',
};

export type SyntheticAction = GameAction<'increment', { amount: number }>;

export interface SyntheticPublic {
  phase: SyntheticState['phase'];
  activeSeat: Seat;
  counter: number;
  target: number;
  secretCounts: [number, number];
}

export interface SyntheticPrivate {
  seat: Seat;
  secrets: number[];
}

const DEFAULT_TARGET = 10;

function parse(input: GameAction): ParseResult<SyntheticAction> {
  if (input.type !== 'increment') {
    return { ok: false, code: 'MALFORMED', message: 'Unknown action type' };
  }
  if (input.v !== 1) {
    return { ok: false, code: 'UNSUPPORTED_VERSION', message: 'Unsupported action version' };
  }
  const payload = input.payload;
  if (typeof payload !== 'object' || payload === null || Object.keys(payload).length !== 1) {
    return { ok: false, code: 'MALFORMED', message: 'Payload must be { amount }' };
  }
  const amount = (payload as { amount?: unknown }).amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > 3) {
    return { ok: false, code: 'MALFORMED', message: 'amount must be an integer 1..3' };
  }
  return { ok: true, value: { type: 'increment', v: 1, payload: { amount } } };
}

export const syntheticRules: RulesModule<
  SyntheticState,
  SyntheticAction,
  SyntheticPublic,
  SyntheticPrivate
> = {
  rulesId: 'synthetic',
  rulesVersion: '1',

  createInitialState(setup, rng) {
    const target = setup.options['target'];
    return {
      phase: 'playing',
      activeSeat: rng.nextInt(2) as Seat,
      counter: 0,
      target:
        typeof target === 'number' && Number.isInteger(target) && target > 0
          ? target
          : DEFAULT_TARGET,
      secrets: [[], []],
      winner: null,
    };
  },

  parseAction: parse,

  validateAction(state, seat) {
    if (state.activeSeat !== seat) {
      return { ok: false, code: 'NOT_YOUR_TURN', message: 'It is not your turn' };
    }
    return { ok: true };
  },

  applyAction(state, seat, action, rng) {
    state.counter = Math.min(state.target, state.counter + action.payload.amount);
    state.secrets[seat].push(rng.nextInt(1000));
    if (state.counter >= state.target) {
      state.phase = 'finished';
      state.winner = seat;
    } else {
      state.activeSeat = seat === 0 ? 1 : 0;
    }
    return { state, events: [] };
  },

  getPhase(state) {
    const active = state.phase === 'playing' ? state.activeSeat : null;
    // One turn per accepted action; each action draws exactly one secret.
    const turnKey =
      active === null ? null : String(state.secrets[0].length + state.secrets[1].length);
    return { id: state.phase, activeSeat: active, turnSeat: active, turnKey };
  },

  projectPublic(state) {
    return {
      phase: state.phase,
      activeSeat: state.activeSeat,
      counter: state.counter,
      target: state.target,
      secretCounts: [state.secrets[0].length, state.secrets[1].length],
    };
  },

  projectPrivate(state, seat) {
    return { seat, secrets: [...state.secrets[seat]] };
  },

  projectEvents() {
    return [];
  },

  resolveOutcome(state) {
    return state.winner === null
      ? null
      : { result: 'winner', winner: state.winner, reason: state.endReason ?? 'target-reached' };
  },

  timeoutAction(state, seat) {
    if (state.phase !== 'playing' || state.activeSeat !== seat) return { kind: 'none' };
    return { kind: 'skip', action: { type: 'increment', v: 1, payload: { amount: 1 } } };
  },

  forfeit(state, loser, reason) {
    state.phase = 'finished';
    state.winner = loser === 0 ? 1 : 0;
    state.endReason = FORFEIT_REASONS[reason];
    return { state, events: [] };
  },
};
