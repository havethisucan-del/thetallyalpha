import { describe, expect, it } from 'vitest';
import {
  MAX_TIMEOUT_PLANS,
  createMatch,
  expandTestSeed,
  forfeitMatch,
  step,
  stepTimeout,
  syntheticRules,
  type AnyRulesModule,
  type Seat,
  type Snapshot,
  type SyntheticState,
} from '../src/index.js';

// R7: engine timeout / forfeit paths with the synthetic rules.

const increment = (amount: number) => ({ type: 'increment', v: 1, payload: { amount } });
const active = (s: Snapshot): Seat => (s.state as SyntheticState).activeSeat;
const other = (seat: Seat): Seat => (seat === 0 ? 1 : 0);

describe('stepTimeout / forfeitMatch with synthetic rules', () => {
  const s0 = createMatch(syntheticRules, { options: { target: 4 } }, expandTestSeed(3));

  it('turnKey advances with every accepted action and is null once finished', () => {
    expect(syntheticRules.getPhase(s0.state as SyntheticState).turnKey).toBe('0');
    const r = stepTimeout(syntheticRules, s0, active(s0), 'turn', 0);
    if (!r.ok) throw new Error(r.code);
    expect(syntheticRules.getPhase(r.snapshot.state as SyntheticState).turnKey).toBe('1');
  });

  it('a timeout skip is exactly `increment 1` (parity with step), in one revision', () => {
    let a = s0;
    let b = s0;
    while (syntheticRules.resolveOutcome(a.state as SyntheticState) === null) {
      const seat = active(a);
      const viaTimeout = stepTimeout(syntheticRules, a, seat, 'turn', a.revision);
      const viaStep = step(syntheticRules, b, seat, increment(1), b.revision);
      if (!viaTimeout.ok || !viaStep.ok) throw new Error('unexpected rejection');
      expect(viaTimeout).toEqual(viaStep);
      a = viaTimeout.snapshot;
      b = viaStep.snapshot;
    }
    expect(a.revision).toBe(4);
    expect(stepTimeout(syntheticRules, a, 0, 'turn', a.revision)).toMatchObject({
      ok: false,
      code: 'MATCH_FINISHED',
    });
  });

  it('rejects stale revisions, non-acting seats and choice mode without a choice', () => {
    const seat = active(s0);
    expect(stepTimeout(syntheticRules, s0, seat, 'turn', 1)).toMatchObject({
      ok: false,
      code: 'STALE_REVISION',
    });
    expect(stepTimeout(syntheticRules, s0, other(seat), 'turn', 0)).toMatchObject({
      ok: false,
      code: 'NOT_YOUR_TURN',
    });
    expect(stepTimeout(syntheticRules, s0, seat, 'choice', 0)).toMatchObject({
      ok: false,
      code: 'ILLEGAL',
      reason: 'NO_PENDING_CHOICE',
    });
    expect(
      stepTimeout(syntheticRules, { ...s0, rulesVersion: 'x' }, seat, 'turn', 0),
    ).toMatchObject({ ok: false, code: 'RULES_MISMATCH' });
  });

  it('throws when the rules return a plan their own validation rejects', () => {
    const broken: AnyRulesModule = {
      ...syntheticRules,
      timeoutAction: () => ({ kind: 'skip', action: increment(1) }),
    };
    expect(() => stepTimeout(broken, s0, other(active(s0)), 'turn', 0)).toThrow(
      /invalid timeout plan/,
    );
  });

  it(`stops after ${MAX_TIMEOUT_PLANS} answers in one revision`, () => {
    let calls = 0;
    const answering: AnyRulesModule = {
      ...syntheticRules,
      timeoutAction: () => {
        calls++;
        return { kind: 'answer', action: increment(1) };
      },
      validateAction: () => ({ ok: true }),
      applyAction: (state: SyntheticState) => ({ state, events: [calls] }),
    };
    const r = stepTimeout(answering, s0, active(s0), 'turn', 0);
    if (!r.ok) throw new Error(r.code);
    expect(r.snapshot.revision).toBe(1);
    expect(r.events).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('forfeit: the other seat wins in one revision; later steps get MATCH_FINISHED', () => {
    const before = JSON.stringify(s0);
    const r = forfeitMatch(syntheticRules, s0, 0, 'turnTimeouts');
    if (!r.ok) throw new Error(r.code);
    expect(JSON.stringify(s0)).toBe(before);
    expect(r.snapshot.revision).toBe(1);
    expect(r.snapshot.rngState).toBe(s0.rngState);
    expect(r.outcome).toEqual({ result: 'winner', winner: 1, reason: 'forfeitTimeouts' });
    expect(syntheticRules.getPhase(r.snapshot.state as SyntheticState)).toEqual({
      id: 'finished',
      activeSeat: null,
      turnSeat: null,
      turnKey: null,
    });
    expect(step(syntheticRules, r.snapshot, 1, increment(1), 1)).toMatchObject({
      ok: false,
      code: 'MATCH_FINISHED',
    });
    expect(forfeitMatch(syntheticRules, r.snapshot, 1, 'timeoutAfterPause')).toMatchObject({
      ok: false,
      code: 'MATCH_FINISHED',
    });
    const pause = forfeitMatch(syntheticRules, s0, 1, 'timeoutAfterPause');
    expect(pause).toMatchObject({
      ok: true,
      outcome: { result: 'winner', winner: 0, reason: 'forfeitTimeoutAfterPause' },
    });
  });

  it('forfeit throws when the rules do not end the match', () => {
    const broken: AnyRulesModule = {
      ...syntheticRules,
      forfeit: (state: SyntheticState) => ({ state, events: [] }),
    };
    expect(() => forfeitMatch(broken, s0, 0, 'turnTimeouts')).toThrow(/did not end the match/);
  });
});
