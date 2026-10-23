import type { Seat } from '@cartignon/game-core';
import { clockViewSchema } from '@cartignon/protocol';
import { describe, expect, it } from 'vitest';
import {
  clockView,
  nextWakeAt,
  onWake,
  reconcile,
  wakeToken,
  type ClockToken,
  type ReconcileInput,
  type TurnClock,
  type WakeResult,
} from '../src/rooms/turn-clock.js';

const CONFIG = { turnMs: 1000, choiceMs: 100, pauseBudgetMs: 300 };
const BOTH: readonly [boolean, boolean] = [true, true];

function phase(turnKey: string | null, turnSeat: Seat | null, activeSeat: Seat | null = turnSeat) {
  return { turnKey, turnSeat, activeSeat };
}

function sync(
  clock: TurnClock | undefined,
  input: Partial<ReconcileInput> & Pick<ReconcileInput, 'now'>,
): TurnClock {
  return reconcile(
    clock,
    {
      phase:
        clock === undefined
          ? phase('1', 0)
          : phase(clock.turnKey, clock.turnSeat, clock.activeSeat),
      revision: clock?.revision ?? 0,
      connected: clock?.connected ?? BOTH,
      ...input,
    },
    CONFIG,
  );
}

function token(clock: TurnClock): ClockToken {
  const t = wakeToken(clock);
  if (t === null) throw new Error('no clock');
  return t;
}

/** Wakes at the scheduled time, like the room's timer. */
function wake(clock: TurnClock): WakeResult {
  const at = nextWakeAt(clock);
  if (at === null) throw new Error('no wake');
  return onWake(clock, token(clock), at);
}

describe('turn clock', () => {
  it('starts a turn clock for the turn seat and expires after turnMs', () => {
    const clock = sync(undefined, { now: 10_000 });
    expect(nextWakeAt(clock)).toBe(11_000);
    expect(clockView(clock)).toEqual({
      seat: 0,
      mode: 'turn',
      running: true,
      remainingMs: 1000,
      deadline: 11_000,
      serverTime: 10_000,
      pauseLeftMs: [300, 300],
      consecutiveTimeouts: [0, 0],
    });
    expect(onWake(clock, token(clock), 10_500)).toMatchObject({ kind: 'early' });
    const result = wake(clock);
    expect(result).toMatchObject({ kind: 'timeout', seat: 0, mode: 'turn' });
    if (result.kind === 'timeout') expect(result.clock.consecutiveTimeouts).toEqual([1, 0]);
  });

  it('keeps the remaining time within a turn and resets it on a new turn', () => {
    let clock = sync(undefined, { now: 0 });
    clock = sync(clock, { now: 400, revision: 1, actor: 0 });
    expect(clockView(clock)?.remainingMs).toBe(600);
    clock = sync(clock, { now: 500, revision: 2, actor: 0, phase: phase('2', 1) });
    expect(clockView(clock)).toMatchObject({ seat: 1, remainingMs: 1000, deadline: 1500 });
  });

  it('has no clock when nobody acts', () => {
    const clock = sync(undefined, { now: 0, phase: phase(null, null) });
    expect(clockView(clock)).toBeNull();
    expect(nextWakeAt(clock)).toBeNull();
    expect(wakeToken(clock)).toBeNull();
  });

  it('ignores stale tokens', () => {
    const clock = sync(undefined, { now: 0 });
    const old = token(clock);
    const next = sync(clock, { now: 10, revision: 1, phase: phase('2', 1) });
    expect(onWake(next, old, 5000)).toEqual({ kind: 'stale' });
    expect(onWake(next, { ...token(next), revision: 0 }, 5000)).toEqual({ kind: 'stale' });
  });

  describe('pause (RD-41 / RD-46 / RD-166)', () => {
    it('stops the clock while the clock seat is disconnected and drains its budget', () => {
      let clock = sync(undefined, { now: 0 });
      clock = sync(clock, { now: 200, connected: [false, true] });
      expect(clockView(clock)).toMatchObject({ running: false, remainingMs: 800, deadline: null });
      expect(nextWakeAt(clock)).toBe(500); // budget end
      clock = sync(clock, { now: 300, connected: [true, true] });
      expect(clockView(clock)).toMatchObject({
        running: true,
        remainingMs: 800,
        deadline: 1100,
        pauseLeftMs: [200, 300],
      });
    });

    it('does not drain while the other seat is disconnected or on the opponent turn', () => {
      let clock = sync(undefined, { now: 0 });
      clock = sync(clock, { now: 0, connected: [true, false] });
      clock = sync(clock, { now: 500, connected: [true, true] });
      expect(clockView(clock)).toMatchObject({ remainingMs: 500, pauseLeftMs: [300, 300] });
    });

    it('resumes when the budget runs out, then forfeits if nothing was played', () => {
      let clock = sync(undefined, { now: 0 });
      clock = sync(clock, { now: 100, connected: [false, true] });
      const resumed = wake(clock);
      expect(resumed.kind).toBe('resumed');
      if (resumed.kind !== 'resumed') return;
      clock = resumed.clock;
      expect(clockView(clock)).toMatchObject({
        running: true,
        remainingMs: 900,
        deadline: 1300,
        pauseLeftMs: [0, 300],
      });
      expect(wake(clock)).toMatchObject({
        kind: 'forfeit',
        seat: 0,
        reason: 'timeoutAfterPause',
      });
    });

    it('after the pause, a seat that played this turn gets an ordinary timeout', () => {
      let clock = sync(undefined, { now: 0 });
      clock = sync(clock, { now: 50, revision: 1, actor: 0 }); // played, still its turn
      clock = sync(clock, { now: 100, connected: [false, true] });
      clock = sync(clock, { now: 2000, connected: [true, true] }); // budget gone, time gone
      expect(clockView(clock)).toMatchObject({ remainingMs: 0, pauseLeftMs: [0, 300] });
      expect(onWake(clock, token(clock), 2000)).toMatchObject({ kind: 'timeout', seat: 0 });
    });

    it('a seat without budget that disconnects later in the match is not paused', () => {
      let clock = sync(undefined, { now: 0 });
      clock = sync(clock, { now: 0, connected: [false, true] });
      clock = sync(clock, { now: 300, connected: [true, true] }); // budget used up exactly
      clock = sync(clock, { now: 300, revision: 1, actor: 0, phase: phase('2', 1) });
      clock = sync(clock, { now: 300, revision: 2, actor: 1, phase: phase('3', 0) });
      clock = sync(clock, { now: 300, connected: [false, true] });
      expect(clockView(clock)).toMatchObject({ running: true, deadline: 1300 });
      expect(wake(clock)).toMatchObject({ kind: 'forfeit', reason: 'timeoutAfterPause' });
    });
  });

  describe('consecutive timeouts (RD-43)', () => {
    it('the second consecutive turn timeout forfeits', () => {
      let clock = sync(undefined, { now: 0 });
      const first = wake(clock);
      expect(first.kind).toBe('timeout');
      if (first.kind !== 'timeout') return;
      clock = sync(first.clock, { now: 1000, revision: 1, phase: phase('2', 1) });
      clock = sync(clock, { now: 1100, revision: 2, actor: 1, phase: phase('3', 0) });
      expect(wake(clock)).toMatchObject({ kind: 'forfeit', seat: 0, reason: 'turnTimeouts' });
    });

    it('resets when the seat ends its own turn by an accepted action', () => {
      let clock = sync(undefined, { now: 0 });
      const first = wake(clock);
      if (first.kind !== 'timeout') throw new Error('expected timeout');
      clock = sync(first.clock, { now: 1000, revision: 1, phase: phase('2', 1) });
      clock = sync(clock, { now: 1100, revision: 2, actor: 1, phase: phase('3', 0) });
      expect(clockView(clock)?.consecutiveTimeouts).toEqual([1, 0]);
      clock = sync(clock, { now: 1200, revision: 3, actor: 0, phase: phase('4', 1) });
      expect(clockView(clock)?.consecutiveTimeouts).toEqual([0, 0]);
    });

    it('an action that does not end the turn keeps the counter', () => {
      let clock = sync(undefined, { now: 0 });
      const first = wake(clock);
      if (first.kind !== 'timeout') throw new Error('expected timeout');
      clock = sync(first.clock, { now: 1000, revision: 1, phase: phase('2', 1) });
      clock = sync(clock, { now: 1000, revision: 2, actor: 1, phase: phase('3', 0) });
      clock = sync(clock, { now: 1100, revision: 3, actor: 0, phase: phase('3', 0) });
      expect(clockView(clock)?.consecutiveTimeouts).toEqual([1, 0]);
      expect(wake(clock)).toMatchObject({ kind: 'forfeit', reason: 'turnTimeouts' });
    });
  });

  describe('choice clock (RD-164)', () => {
    it('suspends the turn clock while the other seat chooses', () => {
      let clock = sync(undefined, { now: 0 });
      clock = sync(clock, { now: 400, revision: 1, actor: 0, phase: phase('1', 0, 1) });
      expect(clockView(clock)).toMatchObject({
        seat: 1,
        mode: 'choice',
        remainingMs: 100,
        deadline: 500,
      });
      clock = sync(clock, { now: 450, revision: 2, actor: 1, phase: phase('1', 0) });
      expect(clockView(clock)).toMatchObject({ seat: 0, mode: 'turn', remainingMs: 600 });
    });

    it('gives every new prompt a fresh choice clock, but not a reconnect', () => {
      let clock = sync(undefined, { now: 0 });
      clock = sync(clock, { now: 0, revision: 1, actor: 0, phase: phase('1', 0, 1) });
      clock = sync(clock, { now: 60, connected: [true, true] });
      expect(clockView(clock)?.remainingMs).toBe(40);
      clock = sync(clock, { now: 60, revision: 2, actor: 1, phase: phase('1', 0, 1) });
      expect(clockView(clock)?.remainingMs).toBe(100);
    });

    it('choice expiry is a timeout that does not count', () => {
      let clock = sync(undefined, { now: 0 });
      clock = sync(clock, { now: 0, revision: 1, actor: 0, phase: phase('1', 0, 1) });
      const result = wake(clock);
      expect(result).toMatchObject({ kind: 'timeout', seat: 1, mode: 'choice' });
      if (result.kind === 'timeout') expect(result.clock.consecutiveTimeouts).toEqual([0, 0]);
    });

    it('a disconnected chooser pauses on its own budget, never the forfeit rule', () => {
      let clock = sync(undefined, { now: 0 });
      clock = sync(clock, { now: 0, revision: 1, actor: 0, phase: phase('1', 0, 1) });
      clock = sync(clock, { now: 0, connected: [true, false] });
      expect(clockView(clock)).toMatchObject({ running: false, pauseLeftMs: [300, 300] });
      const resumed = wake(clock);
      if (resumed.kind !== 'resumed') throw new Error('expected resume');
      expect(wake(resumed.clock)).toMatchObject({ kind: 'timeout', seat: 1, mode: 'choice' });
    });
  });

  it('is JSON-serializable', () => {
    let clock = sync(undefined, { now: 0 });
    clock = sync(clock, { now: 100, connected: [false, true] });
    expect(JSON.parse(JSON.stringify(clock))).toEqual(clock);
  });

  it('ignores a token armed for another seat or mode at the same revision', () => {
    const clock = sync(undefined, { now: 0 });
    expect(onWake(clock, { ...token(clock), mode: 'choice' }, 5000)).toEqual({ kind: 'stale' });
    expect(onWake(clock, { ...token(clock), seat: 1 }, 5000)).toEqual({ kind: 'stale' });
    expect(onWake(clock, { ...token(clock), turnKey: '9' }, 5000)).toEqual({ kind: 'stale' });
  });

  it('views always satisfy the protocol clock schema', () => {
    let clock = sync(undefined, { now: 1_700_000_000_000 });
    expect(clockViewSchema.safeParse(clockView(clock)).success).toBe(true);
    clock = sync(clock, { now: 1_700_000_000_123, connected: [false, true] });
    expect(clockViewSchema.safeParse(clockView(clock)).success).toBe(true);
    clock = sync(clock, {
      now: 1_700_000_000_200,
      revision: 1,
      actor: 1,
      phase: phase('1', 0, 1),
    });
    expect(clockViewSchema.safeParse(clockView(clock)).success).toBe(true);
  });

  describe('pause budget accounting', () => {
    it('is cumulative per match, not refreshed per disconnect', () => {
      let clock = sync(undefined, { now: 0 });
      clock = sync(clock, { now: 0, connected: [false, true] });
      clock = sync(clock, { now: 200, connected: [true, true] });
      clock = sync(clock, { now: 200, revision: 1, actor: 0, phase: phase('2', 1) });
      clock = sync(clock, { now: 200, revision: 2, actor: 1, phase: phase('3', 0) });
      clock = sync(clock, { now: 200, connected: [false, true] });
      expect(clockView(clock)).toMatchObject({ running: false, pauseLeftMs: [100, 300] });
      expect(nextWakeAt(clock)).toBe(300); // only the remaining 100 ms of budget
    });

    it('a wake while still paused with budget left is early and stays paused', () => {
      let clock = sync(undefined, { now: 0 });
      clock = sync(clock, { now: 0, connected: [false, true] });
      const early = onWake(clock, token(clock), 100);
      expect(early.kind).toBe('early');
      if (early.kind !== 'early') return;
      expect(clockView(early.clock)).toMatchObject({
        running: false,
        remainingMs: 1000,
        pauseLeftMs: [200, 300],
      });
      expect(nextWakeAt(early.clock)).toBe(300);
    });

    it('a reconnect after the budget ran out still forfeits if nothing was played', () => {
      let clock = sync(undefined, { now: 0 });
      clock = sync(clock, { now: 0, connected: [false, true] });
      clock = sync(clock, { now: 400, connected: [true, true] }); // budget gone at 300
      expect(clockView(clock)).toMatchObject({ running: true, remainingMs: 900 });
      expect(wake(clock)).toMatchObject({ kind: 'forfeit', seat: 0, reason: 'timeoutAfterPause' });
    });

    it('the after-pause rule applies to one turn only', () => {
      let clock = sync(undefined, { now: 0 });
      clock = sync(clock, { now: 0, connected: [false, true] });
      clock = sync(clock, { now: 400, connected: [true, true] });
      clock = sync(clock, { now: 500, revision: 1, actor: 0, phase: phase('2', 1) });
      clock = sync(clock, { now: 600, revision: 2, actor: 1, phase: phase('3', 0) });
      expect(wake(clock)).toMatchObject({ kind: 'timeout', seat: 0, mode: 'turn' });
    });
  });

  it("RD-165: the turn seat's own choice runs on its turn clock and counts", () => {
    let clock = sync(undefined, { now: 0 });
    clock = sync(clock, { now: 300, revision: 1, actor: 0, phase: phase('1', 0, 0) });
    expect(clockView(clock)).toMatchObject({ seat: 0, mode: 'turn', remainingMs: 700 });
    const result = wake(clock);
    expect(result).toMatchObject({ kind: 'timeout', seat: 0, mode: 'turn' });
    if (result.kind === 'timeout') expect(result.clock.consecutiveTimeouts).toEqual([1, 0]);
  });

  describe('RD-43 counter reset when a turn ends without its own timeout', () => {
    /** Seat 0 timed out on turn 1 (count 1); seat 1 played turn 2; seat 0 is on turn 3. */
    function afterOneTimeout(): TurnClock {
      const first = wake(sync(undefined, { now: 0 }));
      if (first.kind !== 'timeout') throw new Error('expected timeout');
      let clock = sync(first.clock, { now: 1000, revision: 1, phase: phase('2', 1) });
      clock = sync(clock, { now: 1100, revision: 2, actor: 1, phase: phase('3', 0) });
      expect(clock.consecutiveTimeouts).toEqual([1, 0]);
      // Seat 0 plays a spell that hands a nested choice to seat 1 (S-19 -> S-11).
      return sync(clock, { now: 1200, revision: 3, actor: 0, phase: phase('3', 0, 1) });
    }

    it('the other seat answering a nested choice that ends the turn resets the count', () => {
      let clock = afterOneTimeout();
      clock = sync(clock, { now: 1250, revision: 4, actor: 1, phase: phase('4', 1) });
      expect(clock.consecutiveTimeouts).toEqual([0, 0]);
      clock = sync(clock, { now: 1300, revision: 5, actor: 1, phase: phase('5', 0) });
      expect(wake(clock)).toMatchObject({ kind: 'timeout', seat: 0, mode: 'turn' });
    });

    it('a choice clock expiry that ends the turn resets the count', () => {
      let clock = afterOneTimeout();
      const expired = wake(clock);
      expect(expired).toMatchObject({ kind: 'timeout', seat: 1, mode: 'choice', counted: false });
      if (expired.kind !== 'timeout') return;
      clock = sync(expired.clock, { now: 1300, revision: 4, phase: phase('4', 1) });
      expect(clock.consecutiveTimeouts).toEqual([0, 0]);
      clock = sync(clock, { now: 1300, revision: 5, actor: 1, phase: phase('5', 0) });
      expect(wake(clock)).toMatchObject({ kind: 'timeout', seat: 0, mode: 'turn' });
    });

    it('a turn ended by its own timeout keeps the count', () => {
      const first = wake(sync(undefined, { now: 0 }));
      if (first.kind !== 'timeout') throw new Error('expected timeout');
      const clock = sync(first.clock, { now: 1000, revision: 1, phase: phase('2', 1) });
      expect(clock.consecutiveTimeouts).toEqual([1, 0]);
    });
  });

  describe('RD-165 owed skip (the timeout answer hands a choice to the other seat)', () => {
    /** Seat 0 timed out on turn 1 during its own choice; the answer prompted seat 1. */
    function afterAnsweringTimeout(connected: readonly [boolean, boolean] = BOTH): TurnClock {
      let clock = sync(undefined, { now: 0, connected });
      clock = sync(clock, { now: 100, revision: 1, actor: 0, phase: phase('1', 0, 0) });
      const first = onWake(clock, token(clock), 5000);
      if (first.kind !== 'timeout' || !first.counted) throw new Error('expected counted timeout');
      clock = sync(first.clock, { now: 5000, revision: 2, phase: phase('1', 0, 1) });
      expect(clockView(clock)).toMatchObject({ seat: 1, mode: 'choice', remainingMs: 100 });
      expect(clock.consecutiveTimeouts).toEqual([1, 0]);
      return clock;
    }

    it('completes the skip at once, without counting again, after the other seat answers', () => {
      let clock = afterAnsweringTimeout();
      clock = sync(clock, { now: 5050, revision: 3, actor: 1, phase: phase('1', 0) });
      expect(clockView(clock)).toMatchObject({ seat: 0, mode: 'turn', running: true });
      expect(clockView(clock)?.remainingMs).toBe(0);
      expect(nextWakeAt(clock)).toBe(5050);
      const owed = wake(clock);
      expect(owed).toMatchObject({ kind: 'timeout', seat: 0, mode: 'turn', counted: false });
      if (owed.kind !== 'timeout') return;
      expect(owed.clock.consecutiveTimeouts).toEqual([1, 0]);
      // The skip ends the turn by timeout: the count survives the turn change.
      clock = sync(owed.clock, { now: 5050, revision: 4, phase: phase('2', 1) });
      expect(clock.consecutiveTimeouts).toEqual([1, 0]);
    });

    it('also after the choice clock expires', () => {
      let clock = afterAnsweringTimeout();
      const expired = wake(clock);
      if (expired.kind !== 'timeout') throw new Error('expected choice timeout');
      clock = sync(expired.clock, { now: 5100, revision: 3, phase: phase('1', 0) });
      expect(wake(clock)).toMatchObject({ kind: 'timeout', seat: 0, mode: 'turn', counted: false });
    });

    it('is not held back by a pause', () => {
      let clock = afterAnsweringTimeout();
      clock = sync(clock, { now: 5050, revision: 3, actor: 1, phase: phase('1', 0) });
      clock = sync(clock, { now: 5060, connected: [false, true] });
      expect(clockView(clock)).toMatchObject({ running: true, pauseLeftMs: [300, 300] });
      expect(nextWakeAt(clock)).toBe(5060);
      expect(wake(clock)).toMatchObject({ kind: 'timeout', counted: false });
    });

    it('chained hand-offs: the whole turn counts one timeout and is eventually skipped', () => {
      let clock = afterAnsweringTimeout(); // revision 2: seat 1 chooses
      let revision = 2;
      for (let handOff = 0; handOff < 3; handOff++) {
        // Seat 1 answers, giving seat 0 a new choice on the same turn: the skip runs uncounted.
        revision += 1;
        clock = sync(clock, { now: 5050, revision, actor: 1, phase: phase('1', 0) });
        const owed = wake(clock);
        expect(owed).toMatchObject({ kind: 'timeout', seat: 0, mode: 'turn', counted: false });
        if (owed.kind !== 'timeout') return;
        expect(owed.clock.consecutiveTimeouts).toEqual([1, 0]);
        // ...and that answer hands a choice to seat 1 again.
        revision += 1;
        clock = sync(owed.clock, { now: 5050, revision, phase: phase('1', 0, 1) });
      }
      revision += 1;
      clock = sync(clock, { now: 5050, revision, actor: 1, phase: phase('1', 0) });
      const last = wake(clock);
      expect(last).toMatchObject({ kind: 'timeout', counted: false });
      if (last.kind !== 'timeout') return;
      // This time the skip ends the turn: still one timeout for seat 0.
      clock = sync(last.clock, { now: 5050, revision: revision + 1, phase: phase('2', 1) });
      expect(clock.consecutiveTimeouts).toEqual([1, 0]);
    });

    it('no progress: an uncounted skip that leaves the turn seat acting is stuck, not counted', () => {
      let clock = afterAnsweringTimeout();
      clock = sync(clock, { now: 5050, revision: 3, actor: 1, phase: phase('1', 0) });
      const owed = wake(clock);
      if (owed.kind !== 'timeout') throw new Error('expected owed skip');
      // The skip changed nothing visible: same turn, seat 0 still acting, no hand-off.
      clock = sync(owed.clock, { now: 5050, revision: 4, phase: phase('1', 0) });
      const stuck = wake(clock);
      expect(stuck).toMatchObject({ kind: 'stuck', seat: 0 });
      if (stuck.kind !== 'stuck') return;
      expect(stuck.clock.consecutiveTimeouts).toEqual([1, 0]);
      // After the room's back-off the same token runs the skip again, still uncounted.
      expect(onWake(stuck.clock, token(clock), 10_050)).toMatchObject({
        kind: 'timeout',
        counted: false,
      });
    });
  });

  it('accounts on the monotonic `now`; the view uses wall time', () => {
    const wall = 1_700_000_000_000;
    let clock = sync(undefined, { now: 50, wallNow: wall });
    expect(clockView(clock)).toMatchObject({ serverTime: wall, deadline: wall + 1000 });
    // The wall clock jumps an hour; only 400 monotonic ms passed.
    clock = sync(clock, { now: 450, wallNow: wall + 3_600_000 });
    expect(clockView(clock)).toMatchObject({
      remainingMs: 600,
      serverTime: wall + 3_600_000,
      deadline: wall + 3_600_600,
    });
    expect(nextWakeAt(clock)).toBe(1050);
    const early = onWake(clock, token(clock), 500, wall + 3_600_050);
    if (early.kind !== 'early') throw new Error('expected early');
    expect(clockView(early.clock)).toMatchObject({
      remainingMs: 550,
      serverTime: wall + 3_600_050,
    });
  });
});
