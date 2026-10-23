import {
  createMatch,
  RNG_SEED_BYTES,
  syntheticRules,
  type AnyRulesModule,
  type Seat,
} from '@cartignon/game-core';
import { describe, expect, it } from 'vitest';
import { applyClockWake } from '../src/rooms/clock-step.js';
import { reconcile } from '../src/rooms/turn-clock.js';

const SEED = Uint8Array.from({ length: RNG_SEED_BYTES }, (_, i) => i + 1);

function setup(rules: AnyRulesModule = syntheticRules) {
  const snapshot = createMatch(rules, { options: {} }, SEED);
  const phase = rules.getPhase(snapshot.state);
  const seat = phase.activeSeat as Seat;
  const clock = reconcile(
    undefined,
    { phase, revision: snapshot.revision, connected: [true, true], now: 0 },
    { turnMs: 1000, choiceMs: 100, pauseBudgetMs: 300 },
  );
  return { rules, snapshot, seat, clock };
}

describe('applyClockWake', () => {
  it('applies a turn timeout as one revision with cause timeout', () => {
    const { rules, snapshot, seat, clock } = setup();
    const step = applyClockWake(rules, snapshot, {
      kind: 'timeout',
      seat,
      mode: 'turn',
      counted: true,
      clock,
    });
    expect(step.ok).toBe(true);
    if (!step.ok) return;
    expect(step.cause).toBe('timeout');
    expect(step.clock).toBe(clock);
    expect(step.result.snapshot.revision).toBe(snapshot.revision + 1);
  });

  it('applies a forfeit with cause forfeit and an outcome', () => {
    const { rules, snapshot, seat, clock } = setup();
    const step = applyClockWake(rules, snapshot, {
      kind: 'forfeit',
      seat,
      reason: 'turnTimeouts',
      clock,
    });
    expect(step.ok).toBe(true);
    if (step.ok) {
      expect(step.cause).toBe('forfeit');
      expect(step.result.outcome).not.toBeNull();
    }
  });

  it('a refused step (wrong seat) is a failure, not a throw', () => {
    const { rules, snapshot, seat, clock } = setup();
    const other: Seat = seat === 0 ? 1 : 0;
    const step = applyClockWake(rules, snapshot, {
      kind: 'timeout',
      seat: other,
      mode: 'turn',
      counted: true,
      clock,
    });
    expect(step).toEqual({ ok: false, error: 'NOT_YOUR_TURN' });
  });

  it('a rules module returning an invalid plan or throwing is a failure, not a throw', () => {
    const base = syntheticRules;
    const invalidPlan: AnyRulesModule = {
      ...base,
      timeoutAction: () => ({ kind: 'skip', action: { type: 'nonsense' } }),
    };
    const throwing: AnyRulesModule = {
      ...base,
      forfeit: () => {
        throw new Error('boom');
      },
    };
    const a = setup(invalidPlan);
    const timeout = applyClockWake(a.rules, a.snapshot, {
      kind: 'timeout',
      seat: a.seat,
      mode: 'turn',
      counted: true,
      clock: a.clock,
    });
    expect(timeout.ok).toBe(false);
    const b = setup(throwing);
    expect(
      applyClockWake(b.rules, b.snapshot, {
        kind: 'forfeit',
        seat: b.seat,
        reason: 'turnTimeouts',
        clock: b.clock,
      }),
    ).toEqual({ ok: false, error: 'boom' });
  });
});
