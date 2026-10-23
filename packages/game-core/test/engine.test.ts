import { describe, expect, it } from 'vitest';
import {
  cloneJson,
  createMatch,
  expandTestSeed,
  eventsFor,
  step,
  syntheticRules,
  viewFor,
  type Seat,
  type Snapshot,
  type SyntheticState,
} from '../src/index.js';

const increment = (amount: number) => ({ type: 'increment', v: 1, payload: { amount } });

function activeSeat(snapshot: Snapshot): Seat {
  return (snapshot.state as SyntheticState).activeSeat;
}

function mustStep(snapshot: Snapshot, seat: Seat, amount: number): Snapshot {
  const result = step(syntheticRules, snapshot, seat, increment(amount), snapshot.revision);
  if (!result.ok) throw new Error(`unexpected rejection: ${result.code}`);
  return result.snapshot;
}

// RNG unit tests live in rng.test.ts.
describe('engine with synthetic rules', () => {
  it('persists RNG state in the snapshot and rejects a malformed one', () => {
    const s0 = createMatch(syntheticRules, { options: {} }, expandTestSeed(7));
    expect(s0.rngState).toMatch(/^[0-9a-f]{32}$/);
    expect(() => createMatch(syntheticRules, { options: {} }, new Uint8Array(4))).toThrow(
      RangeError,
    );
    const broken = { ...s0, rngState: '0'.repeat(32) };
    expect(() => step(syntheticRules, broken, activeSeat(s0), increment(1), 0)).toThrow(RangeError);
  });

  it('creates revision 0 with rules identity', () => {
    const s = createMatch(syntheticRules, { options: {} }, expandTestSeed(7));
    expect(s).toMatchObject({ rulesId: 'synthetic', rulesVersion: '1', revision: 0 });
  });

  it('increments revision by exactly one per accepted action and never mutates input', () => {
    const s0 = createMatch(syntheticRules, { options: {} }, expandTestSeed(7));
    const before = cloneJson(s0);
    const s1 = mustStep(s0, activeSeat(s0), 2);
    expect(s0).toEqual(before);
    expect(s1.revision).toBe(1);
    expect((s1.state as SyntheticState).counter).toBe(2);
  });

  it('is deterministic: same seed and actions give identical snapshots', () => {
    const run = () => {
      let s = createMatch(syntheticRules, { options: {} }, expandTestSeed(99));
      for (const amount of [1, 2, 3]) s = mustStep(s, activeSeat(s), amount);
      return s;
    };
    expect(run()).toEqual(run());
  });

  it('rejects out-of-turn, malformed and unsupported-version actions without changing state', () => {
    const s0 = createMatch(syntheticRules, { options: {} }, expandTestSeed(7));
    const other: Seat = activeSeat(s0) === 0 ? 1 : 0;
    expect(step(syntheticRules, s0, other, increment(1), 0)).toMatchObject({
      ok: false,
      code: 'NOT_YOUR_TURN',
    });
    for (const bad of [
      increment(4),
      increment(0),
      { type: 'increment', v: 1, payload: { amount: 1, extra: true } },
      { type: 'increment', v: 1, payload: null },
      { type: 'teleport', v: 1, payload: {} },
    ]) {
      expect(step(syntheticRules, s0, activeSeat(s0), bad, 0)).toMatchObject({
        ok: false,
        code: 'MALFORMED',
      });
    }
    expect(
      step(
        syntheticRules,
        s0,
        activeSeat(s0),
        { type: 'increment', v: 2, payload: { amount: 1 } },
        0,
      ),
    ).toMatchObject({ ok: false, code: 'UNSUPPORTED_VERSION' });
  });

  it('reports an outcome once and refuses actions after it', () => {
    let s = createMatch(syntheticRules, { options: { target: 3 } }, expandTestSeed(7));
    const winner = activeSeat(s);
    const result = step(syntheticRules, s, winner, increment(3), s.revision);
    expect(result).toMatchObject({ ok: true, outcome: { result: 'winner', winner } });
    if (!result.ok) return;
    s = result.snapshot;
    expect(step(syntheticRules, s, activeSeat(s), increment(1), s.revision)).toMatchObject({
      ok: false,
      code: 'MATCH_FINISHED',
    });
  });

  it('rejects a stale expectedRevision first, without changing state', () => {
    const s0 = createMatch(syntheticRules, { options: {} }, expandTestSeed(7));
    const s1 = mustStep(s0, activeSeat(s0), 1);
    const before = cloneJson(s1);
    for (const expected of [0, 2, -1]) {
      expect(step(syntheticRules, s1, activeSeat(s1), increment(1), expected)).toMatchObject({
        ok: false,
        code: 'STALE_REVISION',
      });
    }
    // Staleness is checked before everything else (even a malformed action).
    expect(step(syntheticRules, s1, activeSeat(s1), increment(9), 0)).toMatchObject({
      code: 'STALE_REVISION',
    });
    expect(s1).toEqual(before);
  });

  it('synthetic rules emit no events; phase carries turnSeat', () => {
    const s0 = createMatch(syntheticRules, { options: {} }, expandTestSeed(7));
    const result = step(syntheticRules, s0, activeSeat(s0), increment(1), 0);
    expect(result).toMatchObject({ ok: true, events: [] });
    expect(eventsFor(syntheticRules, [], 0)).toEqual([]);
    const view = viewFor(syntheticRules, s0, 0);
    expect(view.rulesId).toBe('synthetic');
    expect(view.phase.turnSeat).toBe(view.phase.activeSeat);
  });

  it('rejects snapshots from a different rules version', () => {
    const s0 = createMatch(syntheticRules, { options: {} }, expandTestSeed(7));
    const foreign = { ...s0, rulesVersion: '0' };
    expect(step(syntheticRules, foreign, activeSeat(s0), increment(1), 0)).toMatchObject({
      ok: false,
      code: 'RULES_MISMATCH',
    });
  });
});

describe('projections (hidden information)', () => {
  it("a seat's view contains its own secrets and never the opponent's", () => {
    let s = createMatch(syntheticRules, { options: { target: 50 } }, expandTestSeed(3));
    for (let i = 0; i < 4; i++) s = mustStep(s, activeSeat(s), 1);
    const state = s.state as SyntheticState;
    for (const seat of [0, 1] as const) {
      const view = viewFor(syntheticRules, s, seat);
      const opponent = seat === 0 ? 1 : 0;
      expect(view.private).toEqual({ seat, secrets: state.secrets[seat] });
      const serialized = JSON.stringify(view);
      // The opponent's secret values must not appear anywhere in this seat's view.
      for (const secret of state.secrets[opponent]) {
        if (!state.secrets[seat].includes(secret)) {
          expect(serialized).not.toMatch(new RegExp(`\\b${secret}\\b`));
        }
      }
      expect(view.public).toMatchObject({ secretCounts: [2, 2] });
    }
  });
});
