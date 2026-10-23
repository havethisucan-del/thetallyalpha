import {
  forfeitMatch,
  stepTimeout,
  type AnyRulesModule,
  type Snapshot,
  type StepResult,
} from '@cartignon/game-core';
import type { ViewCause } from '@cartignon/protocol';
import type { TurnClock, WakeResult } from './turn-clock.js';

type Committed = Extract<StepResult, { ok: true }>;

export type ClockStep =
  /** Commit `result` with `cause`, then store `clock`. */
  | {
      readonly ok: true;
      readonly result: Committed;
      readonly cause: ViewCause;
      readonly clock: TurnClock;
    }
  /** Nothing was applied: keep the previous clock and retry later. */
  | { readonly ok: false; readonly error: string };

/**
 * Turns a `timeout` / `forfeit` wake into the engine step it requires (R7). Never throws: a
 * rejected step or a rules module that throws (e.g. an invalid timeout plan) becomes
 * `{ ok: false }`, so the caller keeps its clock unchanged.
 */
export function applyClockWake(
  rules: AnyRulesModule,
  snapshot: Snapshot,
  wake: Extract<WakeResult, { kind: 'timeout' | 'forfeit' }>,
): ClockStep {
  let result: StepResult;
  try {
    result =
      wake.kind === 'timeout'
        ? stepTimeout(rules, snapshot, wake.seat, wake.mode, snapshot.revision)
        : forfeitMatch(rules, snapshot, wake.seat, wake.reason);
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!result.ok) return { ok: false, error: result.code };
  return {
    ok: true,
    result,
    cause: wake.kind === 'timeout' ? 'timeout' : 'forfeit',
    clock: wake.clock,
  };
}
