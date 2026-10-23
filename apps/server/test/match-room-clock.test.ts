import { ClientState, type Client } from '@colyseus/core';
import { syntheticRules, type AnyRulesModule, type Seat } from '@cartignon/game-core';
import { ServerMessage } from '@cartignon/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger.js';
import { defineMatchRoom, type MatchRoomDeps } from '../src/rooms/match-room.js';
import { RoomRegistry } from '../src/rooms/registry.js';
import { TicketStore } from '../src/rooms/tickets.js';

/**
 * MatchRoom clock wiring without a Colyseus server: the room is constructed directly, clients are
 * stubs that record what they were sent, and Vitest fake timers drive the clock.
 */

const TURN_MS = 1000;
const RETRY_MS = 5000;

interface Sent {
  readonly type: string;
  readonly message: Record<string, unknown>;
}

interface StubClient {
  readonly client: Client;
  readonly sent: Sent[];
}

function stubClient(): StubClient {
  const sent: Sent[] = [];
  const client = {
    state: ClientState.JOINED,
    send: (type: string, message: Record<string, unknown>) => {
      sent.push({ type, message });
    },
  } as unknown as Client;
  return { client, sent };
}

/** Private members the tests drive directly. */
interface RoomInternals {
  roomId: string;
  onCreate(options: unknown): void;
  onJoin(client: Client, options: unknown, auth: unknown): void;
  onDispose(): void;
  handleReady(client: Client, message: unknown): void;
  syncClock(actor?: Seat): boolean;
  match: { snapshot: { revision: number }; clock: { consecutiveTimeouts: [number, number] } };
}

function startMatch(rules: AnyRulesModule) {
  const registry = new RoomRegistry();
  const tickets = new TicketStore();
  const logger = createLogger('silent');
  const errors = vi.spyOn(logger, 'error');
  const deps: MatchRoomDeps = {
    registry,
    tickets,
    logger,
    idleTimeoutMs: 600_000,
    finishedTtlMs: 60_000,
    maxLifetimeMs: 3_600_000,
    seatClaimTimeoutMs: 60_000,
    maxMessagesPerSecond: 100,
    isAllowedOrigin: () => true,
    rules: { current: rules, byId: new Map([[rules.rulesId, rules]]) },
    turnTimeoutMs: TURN_MS,
    choiceTimeoutMs: 100,
    pauseBudgetMs: 300,
    now: () => Date.now(),
    monoNow: () => Date.now(),
    clockRetryMs: RETRY_MS,
  };
  const RoomClass = defineMatchRoom(deps);
  const room = new RoomClass() as unknown as RoomInternals;
  room.roomId = 'room-1';
  const owner = { identityId: 'id-0', displayName: 'Zero' };
  const guest = { identityId: 'id-1', displayName: 'One' };
  const code = registry.reserveCode(owner);
  room.onCreate({ code });
  const record = registry.get('room-1');
  if (record === undefined) throw new Error('room not registered');
  registry.admit(record, guest);
  const clients = [stubClient(), stubClient()] as const;
  clients.forEach(({ client }, seat) => {
    room.onJoin(client, {}, { identityId: `id-${String(seat)}`, roomId: 'room-1', seat });
  });
  clients.forEach(({ client }) => {
    room.handleReady(client, { ready: true });
  });
  return { room, clients, errors };
}

function views(stub: StubClient): Record<string, unknown>[] {
  return stub.sent.filter((s) => s.type === ServerMessage.View).map((s) => s.message);
}

describe('MatchRoom clock wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a turn timeout commits one revision with cause timeout', () => {
    const { room, clients } = startMatch(syntheticRules);
    expect(room.match.snapshot.revision).toBe(0);
    vi.advanceTimersByTime(TURN_MS);
    expect(room.match.snapshot.revision).toBe(1);
    expect(views(clients[0]).at(-1)).toMatchObject({ revision: 1, cause: 'timeout' });
    expect(views(clients[1]).at(-1)).toMatchObject({ revision: 1, cause: 'timeout' });
  });

  it('a refused timeout keeps the old clock and retries after the back-off', () => {
    const base: AnyRulesModule = syntheticRules;
    let broken = true;
    const timeoutAction = vi.fn((state: unknown, seat: Seat) => {
      if (broken) throw new Error('invalid plan');
      return base.timeoutAction(state, seat);
    });
    const rules: AnyRulesModule = { ...base, timeoutAction };
    const { room, errors } = startMatch(rules);
    vi.advanceTimersByTime(TURN_MS);
    expect(timeoutAction).toHaveBeenCalledTimes(1);
    expect(room.match.snapshot.revision).toBe(0);
    expect(room.match.clock.consecutiveTimeouts).toEqual([0, 0]); // not bumped
    expect(errors).toHaveBeenCalled();
    vi.advanceTimersByTime(RETRY_MS - 1);
    expect(timeoutAction).toHaveBeenCalledTimes(1); // no tight loop
    vi.advanceTimersByTime(1);
    expect(timeoutAction).toHaveBeenCalledTimes(2);
    // The rules recover: the next retry commits.
    broken = false;
    vi.advanceTimersByTime(RETRY_MS);
    expect(room.match.snapshot.revision).toBe(1);
  });

  it('a commit whose clock sync throws is recovered by the retry (no stall)', () => {
    const { room, clients } = startMatch(syntheticRules);
    const real = room.syncClock.bind(room);
    let failNext = true;
    room.syncClock = (actor?: Seat) => {
      if (failNext) {
        failNext = false;
        throw new Error('sync failed');
      }
      return real(actor);
    };
    vi.advanceTimersByTime(TURN_MS); // timeout committed, then the sync throws: no timer armed
    expect(room.match.snapshot.revision).toBe(1);
    vi.advanceTimersByTime(RETRY_MS); // stale retry re-syncs and re-arms
    vi.advanceTimersByTime(TURN_MS);
    expect(room.match.snapshot.revision).toBe(2);
    expect(views(clients[0]).at(-1)).toMatchObject({ revision: 2, cause: 'timeout' });
  });

  it('after dispose no clock timer touches the room', () => {
    const { room, clients } = startMatch(syntheticRules);
    const before = clients[0].sent.length;
    room.onDispose();
    vi.advanceTimersByTime(TURN_MS * 10);
    expect(room.match.snapshot.revision).toBe(0);
    expect(clients[0].sent.length).toBe(before);
    expect(room.syncClock()).toBe(false);
  });
});
