import { randomUUID } from 'node:crypto';
import type { Seat } from '@cartignon/game-core';
import {
  actionResultMessageSchema,
  cartignonPrivateViewSchema,
  cartignonPublicViewSchema,
  cartignonSeatEventsSchema,
  clockMessageSchema,
  ClientMessage,
  matchViewMessageSchema,
  ServerMessage,
  type ActionResultMessage,
  type ClockMessage,
  type ClockView,
  type MatchViewMessage,
} from '@cartignon/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  closeAll,
  connect,
  newPlayer,
  startTestServer,
  waitFor,
  type Agent,
  type Connection,
  type TestServer,
} from './helpers.js';

/**
 * R7 match clock end to end (docs/tasks/r7-cartignon-timers.md): real timers, tiny env timeouts.
 * Rules: RD-25 / RD-33 turn timeout skips; RD-43 two consecutive timeouts of one seat forfeit;
 * RD-41 / RD-46 / RD-166 pause on disconnect with a per-match budget; RD-164 choice clock.
 *
 * Timing: every wait is a wait-for-message with a timeout of several clock periods; elapsed time
 * is measured with the server's own `clock.serverTime` (not the test process clock). Fixed delays
 * are only used to assert that something does NOT happen.
 */

const other = (seat: Seat): Seat => (seat === 0 ? 1 : 0);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const views = (c: Connection): MatchViewMessage[] =>
  c.ofType<MatchViewMessage>(ServerMessage.View).map((v) => matchViewMessageSchema.parse(v));

const clockMessages = (c: Connection): ClockMessage[] =>
  c.ofType<ClockMessage>(ServerMessage.Clock).map((m) => clockMessageSchema.parse(m));

const results = (c: Connection): ActionResultMessage[] =>
  c
    .ofType<ActionResultMessage>(ServerMessage.ActionResult)
    .map((r) => actionResultMessageSchema.parse(r));

function latest(c: Connection): MatchViewMessage {
  const all = views(c);
  const last = all[all.length - 1];
  if (last === undefined) throw new Error('no view yet');
  return last;
}

function clockOf(view: MatchViewMessage): ClockView {
  if (view.clock === null) throw new Error(`no clock at revision ${String(view.revision)}`);
  return view.clock;
}

async function waitView(
  c: Connection,
  predicate: (view: MatchViewMessage) => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<MatchViewMessage> {
  let found: MatchViewMessage | undefined;
  await waitFor(
    () => {
      found = views(c).find(predicate);
      return found !== undefined;
    },
    what,
    timeoutMs,
  );
  if (found === undefined) throw new Error('unreachable');
  return found;
}

async function waitClock(
  c: Connection,
  predicate: (message: ClockMessage) => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<ClockMessage> {
  let found: ClockMessage | undefined;
  await waitFor(
    () => {
      found = clockMessages(c).find(predicate);
      return found !== undefined;
    },
    what,
    timeoutMs,
  );
  if (found === undefined) throw new Error('unreachable');
  return found;
}

async function act(
  c: Connection,
  action: unknown,
  expectedRevision: number,
): Promise<ActionResultMessage> {
  const actionId = randomUUID();
  c.room.send(ClientMessage.Action, { actionId, expectedRevision, action });
  let found: ActionResultMessage | undefined;
  await waitFor(() => {
    found = results(c).find((r) => r.actionId === actionId);
    return found !== undefined;
  }, 'action result');
  if (found === undefined) throw new Error('unreachable');
  return found;
}

const increment = { type: 'increment', v: 1, payload: { amount: 1 } };

/**
 * The clock always belongs to the seat that must act: `turn` mode for the turn seat, `choice`
 * mode (RD-164) for another seat answering a choice; no clock once the match is over.
 */
function expectClockFollowsPhase(view: MatchViewMessage): void {
  const { activeSeat, turnSeat } = view.phase;
  if (view.outcome !== null || activeSeat === null) {
    expect(view.clock, `clock at revision ${String(view.revision)}`).toBeNull();
    return;
  }
  const clock = clockOf(view);
  expect(clock.seat).toBe(activeSeat);
  expect(clock.mode).toBe(turnSeat !== null && turnSeat !== activeSeat ? 'choice' : 'turn');
}

interface Side {
  readonly seat: Seat;
  readonly agent: Agent;
  conn: Connection;
}

interface Table {
  readonly roomId: string;
  readonly seats: readonly [Side, Side];
}

/** One server per describe block (its own env), with connection bookkeeping. */
function useServer(env: Record<string, string>) {
  let server: TestServer | undefined;
  const open: Connection[] = [];

  beforeAll(async () => {
    server = await startTestServer({ env });
  });
  afterEach(async () => {
    await closeAll(open);
  });
  afterAll(async () => {
    await server?.stop();
  });

  const url = (): string => {
    if (server === undefined) throw new Error('server not started');
    return server.url;
  };

  async function track(promise: Promise<Connection>): Promise<Connection> {
    const connection = await promise;
    open.push(connection);
    return connection;
  }

  /** Two seated, connected, ready players; resolves once both have the revision 0 view. */
  async function started(): Promise<Table> {
    const host = await newPlayer(url());
    const guest = await newPlayer(url());
    const created = await host.agent.createRoom();
    const joined = await guest.agent.joinRoom(created.code ?? '');
    const a = await track(connect(url(), created));
    const b = await track(connect(url(), joined));
    await waitFor(() => a.ofType('welcome').length === 1 && b.ofType('welcome').length === 1);
    for (const c of [a, b]) c.room.send(ClientMessage.Ready, { ready: true });
    await waitFor(() => views(a).length === 1 && views(b).length === 1, 'initial views');
    return {
      roomId: created.roomId,
      seats: [
        { seat: 0, agent: host.agent, conn: a },
        { seat: 1, agent: guest.agent, conn: b },
      ],
    };
  }

  /** Rejoins a seat with a fresh ticket (the normal reconnect path, RD-41). */
  async function rejoin(table: Table, side: Side): Promise<Connection> {
    const admission = await side.agent.ticket(table.roomId);
    const back = await track(connect(url(), admission));
    side.conn = back;
    await waitFor(() => views(back).length === 1, 'rejoin view');
    return back;
  }

  return { started, rejoin };
}

/** Seat whose turn clock runs in the revision 0 view (seat 0's copy). */
function firstClockSeat(table: Table): Seat {
  const view = latest(table.seats[0].conn);
  const clock = clockOf(view);
  expect(clock.seat).toBe(view.phase.activeSeat);
  return clock.seat;
}

// --------------------------------------------------------------------------------------------
// Synthetic rules: deterministic alternating turns (a timeout skip is `increment {amount: 1}`).
// --------------------------------------------------------------------------------------------

const TURN_MS = 500;
const PAUSE_MS = 1_500;

describe('match clock (synthetic rules)', () => {
  const s = useServer({
    MATCH_RULES: 'synthetic',
    TURN_TIMEOUT_SECONDS: String(TURN_MS / 1000),
    CHOICE_TIMEOUT_SECONDS: '0.2',
    PAUSE_BUDGET_SECONDS: String(PAUSE_MS / 1000),
  });

  it('a turn timeout skips the turn: cause timeout, new revision, a fresh clock for the next seat', async () => {
    const table = await s.started();
    const x = firstClockSeat(table);
    const watcher = table.seats[0].conn;

    const initial = latest(watcher);
    expect(initial.cause).toBe('action');
    expect(clockOf(initial)).toMatchObject({
      seat: x,
      mode: 'turn',
      running: true,
      remainingMs: TURN_MS,
      deadline: clockOf(initial).serverTime + TURN_MS,
      pauseLeftMs: [PAUSE_MS, PAUSE_MS],
      consecutiveTimeouts: [0, 0],
    });

    const skipped = await waitView(watcher, (v) => v.revision === 1, 'first timeout');
    expect(skipped.cause).toBe('timeout');
    expect(skipped.outcome).toBeNull();
    expect(skipped.phase.activeSeat).toBe(other(x));
    expect(skipped.phase.turnSeat).toBe(other(x));
    expect((skipped.public as { counter: number }).counter).toBe(1); // the skip action ran
    const expected: Partial<ClockView> = {
      seat: other(x),
      mode: 'turn',
      running: true,
      remainingMs: TURN_MS, // a fresh turn clock, not the expired one
    };
    expect(clockOf(skipped)).toMatchObject(expected);
    expect(clockOf(skipped).consecutiveTimeouts[x]).toBe(1);
    expect(clockOf(skipped).consecutiveTimeouts[other(x)]).toBe(0);
    // The expiry did not fire early (server time).
    expect(clockOf(skipped).serverTime - clockOf(initial).serverTime).toBeGreaterThanOrEqual(
      TURN_MS - 2,
    );
    // Both seats get the timeout view.
    const theirs = await waitView(table.seats[1].conn, (v) => v.revision === 1, 'seat 1 timeout');
    expect(theirs.cause).toBe('timeout');
    expect(theirs.clock).toEqual(skipped.clock);

    // Guard against a clock stuck at 0: the next skip waits a full turn again.
    const second = await waitView(watcher, (v) => v.revision === 2, 'second timeout');
    expect(second.cause).toBe('timeout');
    expect(second.phase.activeSeat).toBe(x);
    expect(clockOf(second).serverTime - clockOf(skipped).serverTime).toBeGreaterThanOrEqual(
      TURN_MS - 2,
    );
    for (const view of views(watcher)) expectClockFollowsPhase(view);
  });

  it('RD-43: the second consecutive timeout of the same seat forfeits (forfeitTimeouts)', async () => {
    const table = await s.started();
    const x = firstClockSeat(table);
    const watcher = table.seats[0].conn;

    // x times out, then the other seat, then x again: x's second consecutive timeout.
    const over = await waitView(watcher, (v) => v.outcome !== null, 'forfeit');
    expect(over.cause).toBe('forfeit');
    expect(over.outcome).toEqual({ result: 'winner', winner: other(x), reason: 'forfeitTimeouts' });
    expect(over.clock).toBeNull();
    expect(over.phase.activeSeat).toBeNull();

    const all = views(watcher);
    expect(all.map((v) => v.cause)).toEqual(['action', 'timeout', 'timeout', 'forfeit']);
    expect(all.map((v) => v.revision)).toEqual([0, 1, 2, 3]);
    const beforeForfeit = all[2];
    if (beforeForfeit === undefined) throw new Error('unreachable');
    expect(clockOf(beforeForfeit).seat).toBe(x);
    expect(clockOf(beforeForfeit).consecutiveTimeouts).toEqual([1, 1]);
    for (const view of all) expectClockFollowsPhase(view);

    const loser = await waitView(table.seats[1].conn, (v) => v.outcome !== null, 'seat 1 forfeit');
    expect(loser.outcome).toEqual(over.outcome);
    await waitFor(() => watcher.state()['phase'] === 'finished', 'finished phase');
    expect(await act(table.seats[x].conn, increment, over.revision)).toMatchObject({
      status: 'rejected',
      code: 'MATCH_FINISHED',
    });
  });

  it('a late action on the pre-timeout revision is STALE_REVISION; an own accepted action resets the RD-43 counter', async () => {
    const table = await s.started();
    const x = firstClockSeat(table);
    const xc = table.seats[x].conn;
    const yc = table.seats[other(x)].conn;

    await waitView(yc, (v) => v.revision === 1 && v.cause === 'timeout', 'x timeout');
    // x answers the revision it saw before its turn expired: the timeout bumped the revision.
    expect(await act(xc, increment, 0)).toMatchObject({
      status: 'rejected',
      code: 'STALE_REVISION',
    });

    // The other seat plays normally on the new revision...
    expect(await act(yc, increment, 1)).toMatchObject({ status: 'accepted', revision: 2 });
    const afterY = await waitView(xc, (v) => v.revision === 2, 'y action view');
    expect(afterY.cause).toBe('action');
    expect(clockOf(afterY)).toMatchObject({ seat: x, mode: 'turn', remainingMs: TURN_MS });
    expect(clockOf(afterY).consecutiveTimeouts[x]).toBe(1); // only x's own action resets it

    // ...and x ends its own turn by an accepted action: its counter resets.
    expect(await act(xc, increment, 2)).toMatchObject({ status: 'accepted', revision: 3 });
    const afterX = await waitView(yc, (v) => v.revision === 3, 'x action view');
    expect(clockOf(afterX).consecutiveTimeouts).toEqual([0, 0]);

    // y times out (y: 1), x times out (x: 1, not 2: the reset held), y times out again (y: 2).
    const over = await waitView(xc, (v) => v.outcome !== null, 'forfeit');
    expect(over.outcome).toEqual({ result: 'winner', winner: x, reason: 'forfeitTimeouts' });
    const tail = views(xc).slice(-3);
    expect(tail.map((v) => v.cause)).toEqual(['timeout', 'timeout', 'forfeit']);
    expect(tail.map((v) => v.revision)).toEqual([4, 5, 6]);
    const xTimedOut = tail[1];
    if (xTimedOut === undefined) throw new Error('unreachable');
    expect(clockOf(xTimedOut).consecutiveTimeouts[x]).toBe(1);
    expect(clockOf(xTimedOut).consecutiveTimeouts[other(x)]).toBe(1);
  });

  it('RD-41: disconnecting the clock seat pauses its clock; reconnecting resumes it', async () => {
    const table = await s.started();
    const x = firstClockSeat(table);
    const leaver = table.seats[x];
    const stayer = table.seats[other(x)].conn;

    await leaver.conn.room.leave();
    const paused = await waitClock(stayer, (m) => !(m.clock?.running ?? true), 'pause message');
    expect(paused.revision).toBe(0);
    const pausedClock = paused.clock;
    if (pausedClock === null) throw new Error('unreachable');
    expect(pausedClock).toMatchObject({ seat: x, mode: 'turn', running: false, deadline: null });
    expect(pausedClock.remainingMs).toBeGreaterThan(0);
    expect(pausedClock.remainingMs).toBeLessThanOrEqual(TURN_MS);

    // Longer than a whole turn: a running clock would have expired by now.
    await sleep(TURN_MS + 300);
    expect(views(stayer).map((v) => v.revision)).toEqual([0]);

    const back = await s.rejoin(table, leaver);
    const view = latest(back);
    expect(view.revision).toBe(0);
    expect(view.cause).toBe('action');
    const resumed = clockOf(view);
    expect(resumed).toMatchObject({ seat: x, mode: 'turn', running: true });
    expect(resumed.remainingMs).toBe(pausedClock.remainingMs); // the turn clock stood still
    expect(resumed.deadline).toBe(resumed.serverTime + resumed.remainingMs);
    // The budget drained instead (cumulative), but is not used up.
    expect(resumed.pauseLeftMs[x]).toBeGreaterThan(0);
    expect(resumed.pauseLeftMs[x]).toBeLessThanOrEqual(PAUSE_MS - (TURN_MS + 300));
    expect(resumed.pauseLeftMs[other(x)]).toBe(PAUSE_MS);

    // The other seat is told with a `match:clock`; the rejoining seat got the full view instead.
    const resumedMessage = await waitClock(stayer, (m) => m.clock?.running === true, 'resume');
    expect(resumedMessage.clock).toEqual(resumed);

    // The clock runs again: an ordinary timeout (budget left, so not the after-pause forfeit).
    const skipped = await waitView(stayer, (v) => v.revision === 1, 'timeout after resume');
    expect(skipped.cause).toBe('timeout');
    expect(skipped.outcome).toBeNull();
    expect(clockOf(skipped).consecutiveTimeouts[x]).toBe(1);
    expect(clockOf(skipped).serverTime - resumed.serverTime).toBeGreaterThanOrEqual(
      resumed.remainingMs - 2,
    );
    expect(clockMessages(back)).toEqual([]);
    expect(clockMessages(stayer)).toHaveLength(2);
  });

  it('RD-166 / RD-41: the budget drains only on the own clock; used up, the clock resumes and an empty turn forfeits (forfeitTimeoutAfterPause)', async () => {
    const table = await s.started();
    const x = firstClockSeat(table);
    const y = other(x);
    const stayer = table.seats[x].conn;

    // y leaves during x's turn: x's clock keeps running, nothing is announced.
    await table.seats[y].conn.room.leave();
    const skipped = await waitView(stayer, (v) => v.revision === 1, 'x timeout');
    expect(skipped.cause).toBe('timeout');
    // y's turn starts paused, with its whole budget (nothing drained during x's turn).
    expect(clockOf(skipped)).toMatchObject({
      seat: y,
      mode: 'turn',
      running: false,
      deadline: null,
      remainingMs: TURN_MS,
    });
    expect(clockOf(skipped).pauseLeftMs[y]).toBe(PAUSE_MS);

    // The budget runs out: the clock resumes (announced with `match:clock`).
    const resumed = await waitClock(stayer, (m) => m.clock?.running === true, 'budget used up');
    expect(resumed.revision).toBe(1);
    const clock = resumed.clock;
    if (clock === null) throw new Error('unreachable');
    expect(clock).toMatchObject({ seat: y, mode: 'turn', running: true });
    expect(clock.pauseLeftMs[y]).toBe(0);
    expect(clock.serverTime - clockOf(skipped).serverTime).toBeGreaterThanOrEqual(PAUSE_MS - 2);
    // The wake-up may run a few ms late; the clock already ran since the budget ended, so the
    // deadline is exactly budget + turn after the turn started (± rounding).
    expect(clock.remainingMs).toBeGreaterThan(0);
    expect(clock.remainingMs).toBeLessThanOrEqual(TURN_MS);
    const expectedDeadline = clockOf(skipped).serverTime + PAUSE_MS + TURN_MS;
    expect(Math.abs((clock.deadline ?? 0) - expectedDeadline)).toBeLessThanOrEqual(2);

    // It expires with nothing played by y this turn: immediate forfeit.
    const over = await waitView(stayer, (v) => v.outcome !== null, 'forfeit after pause');
    expect(over.cause).toBe('forfeit');
    expect(over.revision).toBe(2);
    expect(over.outcome).toEqual({
      result: 'winner',
      winner: x,
      reason: 'forfeitTimeoutAfterPause',
    });
    expect(over.clock).toBeNull();
    expect(clockMessages(stayer)).toHaveLength(1); // only the resume
  });
});

// --------------------------------------------------------------------------------------------
// Cartignon rules.
//
// RD-164 choice clock: a `choice`-mode clock needs a pending choice of the seat NOT on turn,
// which only arises from S-19 Gambit Prism (RD-160): the turn seat must hold S-19, play it, and
// its random graveyard draw must reveal a spell that needs a choice. The deal and the round RNG
// come from `randomBytes` inside MatchRoom and cannot be seeded from outside, so that state is
// not reachable reliably through the real game; the choice clock (fresh per prompt, expiry
// answers, does not count toward RD-43, paused chooser) is covered by turn-clock.test.ts.
// Here every Cartignon view is checked against the clock/phase invariant, which would also
// catch a choice state with a wrong clock if one occurred.
// --------------------------------------------------------------------------------------------

const CARTIGNON_TURN_MS = 300;

describe('match clock (cartignon rules)', () => {
  const s = useServer({
    MATCH_RULES: 'cartignon',
    TURN_TIMEOUT_SECONDS: String(CARTIGNON_TURN_MS / 1000),
    CHOICE_TIMEOUT_SECONDS: '0.2',
    PAUSE_BUDGET_SECONDS: '1',
  });

  const turnKey = (view: MatchViewMessage): string => {
    const pub = cartignonPublicViewSchema.parse(view.public);
    return `${String(pub.match.roundNumber)}.${String(pub.round.turnNumber)}`;
  };

  it('timeouts skip turns (new turnKey each time) until a seat forfeits by RD-43', async () => {
    const table = await s.started();
    const watcher = table.seats[0].conn;
    const initial = latest(watcher);
    const x = firstClockSeat(table);
    expect(clockOf(initial)).toMatchObject({ mode: 'turn', running: true });

    const skipped = await waitView(watcher, (v) => v.revision === 1, 'first timeout');
    expect(skipped.cause).toBe('timeout');
    expect(turnKey(skipped)).not.toBe(turnKey(initial));
    expect(clockOf(skipped).remainingMs).toBe(CARTIGNON_TURN_MS);
    expect(clockOf(skipped).consecutiveTimeouts[x]).toBe(1);
    expect(clockOf(skipped).serverTime - clockOf(initial).serverTime).toBeGreaterThanOrEqual(
      CARTIGNON_TURN_MS - 2,
    );

    const over = await waitView(watcher, (v) => v.outcome !== null, 'forfeit', 15_000);
    expect(over.cause).toBe('forfeit');
    expect(over.clock).toBeNull();
    const all = views(watcher);
    const beforeForfeit = all[all.length - 2];
    if (beforeForfeit === undefined) throw new Error('unreachable');
    const loser = clockOf(beforeForfeit).seat;
    expect(clockOf(beforeForfeit).consecutiveTimeouts[loser]).toBe(1);
    expect(over.outcome).toEqual({
      result: 'winner',
      winner: other(loser),
      reason: 'forfeitTimeouts',
    });
    expect(cartignonPublicViewSchema.parse(over.public).match.status).toMatchObject({
      kind: 'matchOver',
      reason: 'forfeitTimeouts',
      winner: other(loser),
    });

    // Every revision in between is a timeout skip into a new turn, with a fresh clock.
    const middle = all.slice(1, -1);
    expect(middle.length).toBeGreaterThanOrEqual(1);
    expect(middle.length).toBeLessThanOrEqual(2); // x, y, x at most
    middle.forEach((view, index) => {
      expect(view.cause).toBe('timeout');
      expect(view.revision).toBe(index + 1);
      const previous = all[index];
      if (previous === undefined) throw new Error('unreachable');
      expect(turnKey(view)).not.toBe(turnKey(previous));
    });
    for (const view of all) {
      expectClockFollowsPhase(view);
      cartignonPublicViewSchema.parse(view.public);
      expect(cartignonPrivateViewSchema.parse(view.private).seat).toBe(view.seat);
      cartignonSeatEventsSchema.parse(view.events);
    }
    const theirs = await waitView(table.seats[1].conn, (v) => v.outcome !== null, 'seat 1 end');
    expect(theirs.outcome).toEqual(over.outcome);
  });
});
