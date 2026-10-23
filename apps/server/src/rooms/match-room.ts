import { randomBytes, randomUUID } from 'node:crypto';
import {
  ClientState,
  CloseCode,
  ErrorCode,
  Room,
  ServerError,
  type AuthContext,
  type Client,
  type RoomException,
  type RoomMethodName,
} from '@colyseus/core';
import {
  createMatch,
  eventsFor,
  RNG_SEED_BYTES,
  step,
  viewFor,
  type AnyRulesModule,
  type Seat,
  type Snapshot,
  type StepResult,
} from '@cartignon/game-core';
import {
  actionMessageSchema,
  ClientMessage,
  inviteCodeSchema,
  matchJoinOptionsSchema,
  readyMessageSchema,
  ServerMessage,
  type ActionResultMessage,
  type ClockMessage,
  type ErrorCode as ApiErrorCode,
  type MatchViewMessage,
  type RoomPhase,
  type ServerErrorMessage,
  type ViewCause,
  type WelcomeMessage,
} from '@cartignon/protocol';
import { z } from 'zod';
import type { Logger } from '../logger.js';
import type { RoomHandle, RoomRegistry, SeatHolder } from './registry.js';
import { applyClockWake } from './clock-step.js';
import { rulesFor, type MatchRules } from './rules.js';
import { MatchRoomState, PlayerState } from './state.js';
import type { TicketGrant, TicketStore } from './tickets.js';
import {
  clockView,
  nextWakeAt,
  onWake,
  reconcile,
  wakeToken,
  type ClockToken,
  type TurnClock,
  type TurnClockConfig,
} from './turn-clock.js';

export interface MatchRoomDeps {
  readonly registry: RoomRegistry;
  readonly tickets: TicketStore;
  readonly logger: Logger;
  /** Dispose the room after this long with nobody connected. */
  readonly idleTimeoutMs: number;
  /** Dispose the room this long after its match finished. */
  readonly finishedTtlMs: number;
  /** Hard cap on the room's lifetime. */
  readonly maxLifetimeMs: number;
  /** Release a lobby guest seat whose holder stays disconnected this long. */
  readonly seatClaimTimeoutMs: number;
  /** Colyseus disconnects a client that sends more than this many messages per second. */
  readonly maxMessagesPerSecond: number;
  readonly isAllowedOrigin: (origin: string | null) => boolean;
  /** Rules for new matches (`current`) and for resumed ones (by `snapshot.rulesId`). */
  readonly rules: MatchRules;
  /** R7 turn clock per turn (RD-25). */
  readonly turnTimeoutMs: number;
  /** R7 choice clock of a non-turn seat answering a choice (RD-164). */
  readonly choiceTimeoutMs: number;
  /** R7 pause budget per seat per match while disconnected (RD-41). */
  readonly pauseBudgetMs: number;
  /** Wall-clock time in epoch ms (sent to clients as `serverTime` / `deadline`). */
  readonly now: () => number;
  /** Monotonic ms for clock accounting (default `performance.now()`). */
  readonly monoNow?: () => number;
  /** Delay before retrying a clock timeout the engine refused (default 5 s). */
  readonly clockRetryMs?: number;
}

const createOptionsSchema = z.strictObject({ code: inviteCodeSchema });

const SEATS: readonly Seat[] = [0, 1];

/** Seconds Colyseus keeps a matchmaking seat reservation before the WebSocket must connect. */
const SEAT_RESERVATION_SECONDS = 15;

/** setTimeout's maximum delay; a longer clock wakes early and re-arms. */
const MAX_TIMER_MS = 2_147_483_647;

/** Back-off before retrying a failed clock timeout, so a match never silently stalls. */
const DEFAULT_CLOCK_RETRY_MS = 5000;

type Committed = Extract<StepResult, { ok: true }>;

/** The in-memory match: authoritative snapshot plus committed action ids (idempotency). */
interface ActiveMatch {
  readonly matchId: string;
  /**
   * The module named by `snapshot.rulesId`; undefined when this server does not know those
   * rules (only possible for a resumed snapshot): actions are then refused as RULES_MISMATCH.
   */
  readonly rules: AnyRulesModule | undefined;
  snapshot: Snapshot;
  /** actionId → seat and the revision it produced. DB-backed in M6. */
  readonly committed: Map<string, { seat: Seat; revision: number }>;
  /** R7 match clock (JSON, remaining-time based); undefined before start and once finished. */
  clock: TurnClock | undefined;
}

function isGrant(value: unknown): value is TicketGrant {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['identityId'] === 'string' &&
    typeof v['roomId'] === 'string' &&
    (v['seat'] === 0 || v['seat'] === 1)
  );
}

function reject(message: string): never {
  throw new ServerError(ErrorCode.AUTH_FAILED, message);
}

/**
 * Admission happens in two steps:
 *  1. HTTP matchmaking (`joinById`) runs the static `onAuth`: strict options, allowed Origin,
 *     the ticket is redeemed (single use), and the seat must have neither a live connection
 *     nor another reservation in flight. The grant becomes `client.auth`.
 *  2. The WebSocket join runs `onJoin`: the grant must be for this room and match the
 *     registry's seat owner, and the seat must not already have a live connection.
 *
 * Seats are enforced by the registry, not by Colyseus capacity: `maxClients` has slack (4)
 * and each seat holds at most one connection or one reservation, so nobody can fill the
 * room's capacity to lock the other seat out.
 *
 * Duplicate connections for one seat: the newcomer is rejected and the existing connection
 * keeps the seat. Replacing would let anyone holding a fresh ticket kick a live player; a
 * dead socket is reaped by the transport heartbeat within seconds.
 *
 * Connection state (`connections`, `players[*].connected`) is kept apart from match state
 * (`match`), so M6 can add reconnection budgets without touching the game flow.
 */
export abstract class MatchRoom extends Room<{ state: MatchRoomState }> {
  declare protected readonly deps: MatchRoomDeps;

  private readonly connections: [Client | undefined, Client | undefined] = [undefined, undefined];
  private match: ActiveMatch | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private finishTimer: NodeJS.Timeout | undefined;
  private lifetimeTimer: NodeJS.Timeout | undefined;
  private clockTimer: NodeJS.Timeout | undefined;
  /** Set in onDispose: late timer callbacks must not touch the room. */
  private disposed = false;
  private readonly claimTimers: [NodeJS.Timeout | undefined, NodeJS.Timeout | undefined] = [
    undefined,
    undefined,
  ];

  constructor() {
    super();
    // Assigned before Colyseus initialises the room, so the accessors only store the values.
    this.maxClients = 4; // slack: seats are enforced by the registry and onJoin
    this.autoDispose = false; // lifetime is managed by the timers below
    this.seatReservationTimeout = SEAT_RESERVATION_SECONDS;
  }

  /** Static gate run during HTTP matchmaking; `this` is not bound here. */
  static authorize(deps: MatchRoomDeps, options: unknown, context: AuthContext): TicketGrant {
    const parsed = matchJoinOptionsSchema.safeParse(options);
    if (!parsed.success) reject('invalid join options');
    if (!deps.isAllowedOrigin(context.headers.get('origin'))) reject('origin not allowed');
    const grant = deps.tickets.consume(parsed.data.ticket);
    if (grant === undefined) reject('invalid or expired ticket');
    const record = deps.registry.get(grant.roomId);
    if (record === undefined) reject('room is no longer available');
    if (record.seats[grant.seat]?.identityId !== grant.identityId) {
      reject('seat is not held by this identity');
    }
    if (record.handle.isSeatLive(grant.seat)) reject('seat already has a live connection');
    if (!deps.registry.beginReservation(record, grant.seat, SEAT_RESERVATION_SECONDS * 1000)) {
      reject('seat already has a join in progress');
    }
    return grant;
  }

  override onCreate(options: unknown): void {
    const { code } = createOptionsSchema.parse(options);
    this.maxMessagesPerSecond = this.deps.maxMessagesPerSecond;

    const state = new MatchRoomState();
    state.phase = 'lobby' satisfies RoomPhase;
    state.code = code;
    this.state = state;

    this.onMessage(ClientMessage.Ready, (client: Client, message: unknown) => {
      this.handleReady(client, message);
    });
    this.onMessage(ClientMessage.Action, (client: Client, message: unknown) => {
      this.handleAction(client, message);
    });
    this.onMessage('*', (client: Client, type: string | number) => {
      this.rejectMessage(client, String(type), 'unknown message type');
    });

    this.armIdleTimer();
    this.lifetimeTimer = this.timer(this.deps.maxLifetimeMs, () => {
      this.dispose('max lifetime reached');
    });

    // Last, so nothing after it can fail and leave a registered record behind.
    const handle: RoomHandle = {
      seatAssigned: (seat, holder) => {
        this.ensurePlayer(seat, holder);
        this.armClaimTimer(seat);
      },
      isSeatLive: (seat) => this.isLive(this.connections[seat]),
    };
    const record = this.deps.registry.bind(code, this.roomId, handle);
    SEATS.forEach((seat) => {
      const holder = record.seats[seat];
      if (holder !== undefined) this.ensurePlayer(seat, holder);
    });
    this.log().info('room created');
  }

  override onJoin(client: Client, _options: unknown, auth: unknown): void {
    if (!isGrant(auth) || auth.roomId !== this.roomId) {
      reject('ticket is not valid for this room');
    }
    this.deps.registry.endReservation(this.roomId, auth.seat);
    const record = this.deps.registry.get(this.roomId);
    const holder = record?.seats[auth.seat];
    if (holder?.identityId !== auth.identityId) reject('seat is not held by this identity');
    if (this.isLive(this.connections[auth.seat])) reject('seat already has a live connection');

    this.connections[auth.seat] = client;
    const player = this.ensurePlayer(auth.seat, holder);
    player.connected = true;
    this.clearIdleTimer();
    this.clearClaimTimer(auth.seat);

    const clockChanged = this.syncClock();
    client.send(ServerMessage.Welcome, { seat: auth.seat } satisfies WelcomeMessage);
    if (this.match !== undefined) this.sendView(client, auth.seat, undefined, 'action');
    if (clockChanged) this.sendClock(auth.seat);
    this.log().info({ seat: auth.seat }, 'seat connected');
  }

  override onLeave(client: Client, code?: number): void {
    const seat = this.seatOf(client);
    if (seat === undefined) return; // a join that was rejected in onJoin
    this.connections[seat] = undefined;
    const player = this.state.players.get(String(seat));
    if (player !== undefined) {
      player.connected = false;
      if (this.state.phase === 'lobby') player.ready = false;
    }
    if (this.state.phase === 'lobby' && seat !== 0) {
      // A guest who leaves on purpose gives the seat back; one who dropped gets a grace period.
      if (code === CloseCode.CONSENTED) this.releaseSeat(seat, 'guest left the lobby');
      else this.armClaimTimer(seat);
    }
    // RD-167: an active match is never idle-disposed (its clocks end it; the lifetime caps it).
    if (this.connections.every((c) => c === undefined) && this.state.phase !== 'active') {
      this.armIdleTimer();
    }
    if (this.syncClock()) this.sendClock();
    this.log().info({ seat, code }, 'seat disconnected');
  }

  override onDispose(): void {
    this.disposed = true;
    this.clearIdleTimer();
    for (const seat of SEATS) this.clearClaimTimer(seat);
    if (this.finishTimer !== undefined) clearTimeout(this.finishTimer);
    if (this.lifetimeTimer !== undefined) clearTimeout(this.lifetimeTimer);
    this.clearClockTimer();
    this.deps.registry.remove(this.roomId);
    this.deps.tickets.invalidateRoom(this.roomId);
    this.log().info('room disposed');
  }

  override onUncaughtException(error: RoomException, methodName: RoomMethodName): void {
    const expected = error.cause instanceof ServerError;
    const fields = { roomId: this.roomId, method: methodName, err: error.message };
    if (expected) this.deps.logger.warn(fields, 'room rejected a request');
    else this.deps.logger.error(fields, 'room handler failed');
  }

  private handleReady(client: Client, message: unknown): void {
    const seat = this.seatOf(client);
    if (seat === undefined) return;
    const parsed = readyMessageSchema.safeParse(message);
    if (!parsed.success) {
      this.rejectMessage(client, ClientMessage.Ready, 'invalid ready message');
      return;
    }
    if (this.state.phase !== 'lobby') return; // late or repeated Ready: nothing to do
    const player = this.state.players.get(String(seat));
    if (player === undefined) return;
    player.ready = parsed.data.ready;
    this.startIfReady();
  }

  /** Synchronous and guarded by the phase, so the match starts exactly once. */
  private startIfReady(): void {
    if (this.state.phase !== 'lobby' || this.match !== undefined) return;
    const bothReady = SEATS.every((seat) => {
      const player = this.state.players.get(String(seat));
      return this.connections[seat] !== undefined && player?.connected === true && player.ready;
    });
    if (!bothReady) return;

    const snapshot = createMatch(
      this.deps.rules.current,
      { options: {} },
      randomBytes(RNG_SEED_BYTES),
    );
    this.match = {
      matchId: randomUUID(),
      rules: rulesFor(this.deps.rules, snapshot),
      snapshot,
      committed: new Map(),
      clock: undefined,
    };
    this.setPhase('active');
    this.clearIdleTimer();
    this.syncClock();
    this.log().info({ matchId: this.match.matchId, rulesId: snapshot.rulesId }, 'match started');
    this.sendViews(undefined, 'action');
  }

  private handleAction(client: Client, message: unknown): void {
    const seat = this.seatOf(client);
    if (seat === undefined) return;
    const parsed = actionMessageSchema.safeParse(message);
    if (!parsed.success) {
      this.rejectMessage(client, ClientMessage.Action, 'invalid action message');
      return;
    }
    const { actionId, action, expectedRevision } = parsed.data;
    const match = this.match;
    if (match === undefined) {
      this.sendResult(client, {
        status: 'rejected',
        actionId,
        code: 'MATCH_NOT_STARTED',
        message: 'Match has not started',
      });
      return;
    }

    const previous = match.committed.get(actionId);
    if (previous !== undefined) {
      this.sendResult(
        client,
        previous.seat === seat
          ? { status: 'duplicate', actionId, revision: previous.revision }
          : {
              status: 'rejected',
              actionId,
              code: 'DUPLICATE_ACTION_ID',
              message: 'Action id already used',
            },
      );
      return;
    }

    // Order: duplicate id (above) -> stale revision (first check inside `step`) -> rules.
    const rules = match.rules;
    if (rules === undefined) {
      this.sendResult(client, {
        status: 'rejected',
        actionId,
        code: 'RULES_MISMATCH',
        message: 'Snapshot was created by other rules',
      });
      return;
    }
    const result = step(rules, match.snapshot, seat, action, expectedRevision);
    if (!result.ok) {
      this.sendResult(client, {
        status: 'rejected',
        actionId,
        code: result.code,
        message: result.message.slice(0, 200),
        ...(result.reason !== undefined ? { reason: result.reason.slice(0, 64) } : {}),
      });
      return;
    }

    match.committed.set(actionId, { seat, revision: result.snapshot.revision });
    this.commit(match, result, 'action', seat);
    this.sendResult(client, { status: 'accepted', actionId, revision: result.snapshot.revision });
  }

  /**
   * The one path that applies a new revision (accepted action, clock timeout, forfeit): stores
   * the snapshot, finishes the match or reconciles the clock, and sends every seat its view.
   * `actor` is the seat whose accepted action produced the revision (RD-43 / RD-166).
   */
  private commit(match: ActiveMatch, result: Committed, cause: ViewCause, actor?: Seat): void {
    match.snapshot = result.snapshot;
    if (result.outcome !== null) {
      match.clock = undefined;
      this.clearClockTimer();
      this.setPhase('finished');
      this.log().info({ matchId: match.matchId, cause }, 'match finished');
      this.finishTimer = this.timer(this.deps.finishedTtlMs, () => {
        this.dispose('finished match expired');
      });
    } else {
      this.syncClock(actor);
    }
    // Raw events may carry hidden information: only per-seat projections leave this room.
    this.sendViews(result.events, cause);
  }

  private clockConfig(): TurnClockConfig {
    return {
      turnMs: this.deps.turnTimeoutMs,
      choiceMs: this.deps.choiceTimeoutMs,
      pauseBudgetMs: this.deps.pauseBudgetMs,
    };
  }

  /**
   * Reconciles the match clock with the current snapshot and connections and re-arms the clock
   * timer. Returns true when the clock paused or resumed (worth a `match:clock`). No-op unless a
   * match is active.
   */
  private syncClock(actor?: Seat): boolean {
    const match = this.match;
    if (this.disposed || match?.rules === undefined || this.state.phase !== 'active') {
      this.clearClockTimer();
      return false;
    }
    const before = match.clock === undefined ? null : clockView(match.clock);
    match.clock = reconcile(
      match.clock,
      {
        phase: match.rules.getPhase(match.snapshot.state),
        revision: match.snapshot.revision,
        connected: [this.connections[0] !== undefined, this.connections[1] !== undefined],
        now: this.monoNow(),
        wallNow: this.deps.now(),
        ...(actor !== undefined ? { actor } : {}),
      },
      this.clockConfig(),
    );
    this.armClockTimer();
    const after = clockView(match.clock);
    return before !== null && after !== null && before.running !== after.running;
  }

  private monoNow(): number {
    return this.deps.monoNow?.() ?? performance.now();
  }

  private armClockTimer(): void {
    this.clearClockTimer();
    const clock = this.match?.clock;
    if (this.disposed || clock === undefined) return;
    const token = wakeToken(clock);
    const at = nextWakeAt(clock);
    if (token === null || at === null) return;
    this.scheduleClockWake(token, Math.ceil(at - this.monoNow()));
  }

  /** Arms the one clock timer for `token`. */
  private scheduleClockWake(token: ClockToken, delayMs: number): void {
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, delayMs));
    this.clockTimer = this.timer(delay, () => {
      this.clockTimer = undefined;
      try {
        this.onClockWake(token);
      } catch (error: unknown) {
        // A timer callback runs outside Colyseus' handler guards: never crash the process.
        this.deps.logger.error({ roomId: this.roomId, err: String(error) }, 'match clock failed');
        this.scheduleClockRetry(token);
      }
    });
  }

  /**
   * Wakes `token` again after a back-off unless something already re-armed the clock. A retry
   * whose token no longer matches re-syncs the clock (see `onClockWake`).
   */
  private scheduleClockRetry(token: ClockToken): void {
    if (this.disposed || this.clockTimer !== undefined || this.state.phase !== 'active') return;
    this.scheduleClockWake(token, this.deps.clockRetryMs ?? DEFAULT_CLOCK_RETRY_MS);
  }

  private clearClockTimer(): void {
    if (this.clockTimer !== undefined) clearTimeout(this.clockTimer);
    this.clockTimer = undefined;
  }

  /**
   * Clock timer callback. A wake that no longer matches the clock re-syncs it (so a commit that
   * failed half-way can never leave the match without a timer); an early one re-arms. The clock
   * is stored only after the engine step succeeded; a refused step keeps the old clock and
   * retries after a back-off.
   */
  private onClockWake(token: ClockToken): void {
    if (this.disposed || this.state.phase !== 'active') return;
    const match = this.match;
    const rules = match?.rules;
    if (match?.clock === undefined || rules === undefined) {
      this.syncClock();
      return;
    }
    const wake =
      token.revision === match.snapshot.revision
        ? onWake(match.clock, token, this.monoNow(), this.deps.now())
        : ({ kind: 'stale' } as const);
    switch (wake.kind) {
      case 'stale':
        this.syncClock();
        return;
      case 'early':
        match.clock = wake.clock;
        this.armClockTimer();
        return;
      case 'resumed':
        match.clock = wake.clock;
        this.armClockTimer();
        this.sendClock();
        return;
      case 'stuck': {
        // RD-165 anti-spin: the last uncounted skip did not move the turn on; retry it later.
        match.clock = wake.clock;
        this.log().error({ matchId: match.matchId, seat: wake.seat }, 'owed skip made no progress');
        this.clearClockTimer();
        this.scheduleClockRetry(token);
        return;
      }
      case 'timeout':
      case 'forfeit': {
        const applied = applyClockWake(rules, match.snapshot, wake);
        const fields =
          wake.kind === 'timeout'
            ? { matchId: match.matchId, seat: wake.seat, mode: wake.mode, counted: wake.counted }
            : { matchId: match.matchId, seat: wake.seat, reason: wake.reason };
        if (!applied.ok) {
          // Broken invariant (clock and rules disagree): keep the old clock, retry later.
          this.log().error({ ...fields, err: applied.error }, `clock ${wake.kind} refused`);
          this.scheduleClockRetry(token);
          return;
        }
        this.log().info(fields, wake.kind === 'timeout' ? 'clock timeout' : 'forfeit');
        match.clock = applied.clock;
        this.commit(match, applied.result, applied.cause);
        return;
      }
    }
  }

  /** `match:clock` to every connected seat except `skip` (which just got a full view). */
  private sendClock(skip?: Seat): void {
    const match = this.match;
    if (match === undefined) return;
    const message: ClockMessage = {
      matchId: match.matchId,
      revision: match.snapshot.revision,
      clock: match.clock === undefined ? null : clockView(match.clock),
    };
    SEATS.forEach((seat) => {
      const client = this.connections[seat];
      if (client !== undefined && seat !== skip) client.send(ServerMessage.Clock, message);
    });
  }

  /**
   * Each seat gets only its own projection; views are never broadcast. `rawEvents` are the
   * step's raw events (server-only); each seat receives `eventsFor(rules, rawEvents, seat)`.
   */
  private sendViews(rawEvents: readonly unknown[] | undefined, cause: ViewCause): void {
    SEATS.forEach((seat) => {
      const client = this.connections[seat];
      if (client !== undefined) this.sendView(client, seat, rawEvents, cause);
    });
  }

  /**
   * Join, rejoin and match start send `events: []`: events are never replayed. The clock is
   * public (the same for both seats).
   */
  private sendView(
    client: Client,
    seat: Seat,
    rawEvents: readonly unknown[] | undefined,
    cause: ViewCause,
  ): void {
    const match = this.match;
    if (match?.rules === undefined) return;
    const rules = match.rules;
    const view = viewFor(rules, match.snapshot, seat);
    const message: MatchViewMessage = {
      matchId: match.matchId,
      seat,
      revision: view.revision,
      rulesId: view.rulesId,
      rulesVersion: view.rulesVersion,
      phase: {
        id: view.phase.id,
        activeSeat: view.phase.activeSeat,
        turnSeat: view.phase.turnSeat,
      },
      public: view.public,
      private: view.private,
      events: rawEvents === undefined ? [] : [...eventsFor(rules, rawEvents, seat)],
      outcome: view.outcome,
      clock: match.clock === undefined ? null : clockView(match.clock),
      cause,
    };
    client.send(ServerMessage.View, message);
  }

  private sendResult(client: Client, result: ActionResultMessage): void {
    client.send(ServerMessage.ActionResult, result);
  }

  private sendError(client: Client, code: ApiErrorCode, message: string): void {
    client.send(ServerMessage.Error, { code, message } satisfies ServerErrorMessage);
  }

  /** Invalid input never crashes the room: the sender gets an error, payloads are not logged. */
  private rejectMessage(client: Client, type: string, reason: string): void {
    this.log().warn({ type: type.slice(0, 64), seat: this.seatOf(client) }, reason);
    this.sendError(client, 'BAD_REQUEST', 'Invalid message');
  }

  private setPhase(phase: RoomPhase): void {
    this.state.phase = phase;
    this.deps.registry.setPhase(this.roomId, phase);
  }

  private ensurePlayer(seat: Seat, holder: SeatHolder): PlayerState {
    const key = String(seat);
    let player = this.state.players.get(key);
    if (player === undefined) {
      player = new PlayerState();
      player.displayName = holder.displayName;
      player.ready = false;
      player.connected = false;
      this.state.players.set(key, player);
    }
    return player;
  }

  /** Gives a lobby seat back: registry, public state and the holder's tickets. */
  private releaseSeat(seat: Seat, reason: string): void {
    this.clearClaimTimer(seat);
    const holder = this.deps.registry.releaseSeat(this.roomId, seat);
    if (holder === undefined) return;
    this.deps.tickets.invalidateIdentity(holder.identityId, this.roomId);
    this.state.players.delete(String(seat));
    this.log().info({ seat }, reason);
  }

  /** Guest seats only: the creator's seat lives as long as the room. */
  private armClaimTimer(seat: Seat): void {
    if (seat === 0 || this.state.phase !== 'lobby') return;
    this.clearClaimTimer(seat);
    this.claimTimers[seat] = this.timer(this.deps.seatClaimTimeoutMs, () => {
      this.claimTimers[seat] = undefined;
      if (this.state.phase !== 'lobby' || this.connections[seat] !== undefined) return;
      if (this.deps.registry.hasReservationInFlight(this.roomId)) {
        this.armClaimTimer(seat); // a join is in progress: check again later
        return;
      }
      this.releaseSeat(seat, 'unclaimed seat released');
    });
  }

  private clearClaimTimer(seat: Seat): void {
    const timer = this.claimTimers[seat];
    if (timer !== undefined) clearTimeout(timer);
    this.claimTimers[seat] = undefined;
  }

  private isLive(client: Client | undefined): boolean {
    return (
      client !== undefined &&
      client.state !== ClientState.LEAVING &&
      client.state !== ClientState.CLOSED
    );
  }

  private seatOf(client: Client): Seat | undefined {
    if (this.connections[0] === client) return 0;
    if (this.connections[1] === client) return 1;
    return undefined;
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = this.timer(this.deps.idleTimeoutMs, () => {
      this.idleTimer = undefined;
      if (this.state.phase === 'active') return; // RD-167
      const busy =
        this.connections.some((c) => c !== undefined) ||
        this.deps.registry.hasReservationInFlight(this.roomId);
      if (busy) {
        this.armIdleTimer(); // a join is in flight; don't pull the room from under it
        return;
      }
      this.dispose('room idle');
    });
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private timer(ms: number, run: () => void): NodeJS.Timeout {
    const handle = setTimeout(run, ms);
    handle.unref();
    return handle;
  }

  private dispose(reason: string): void {
    this.log().info(reason);
    this.disconnect().catch((error: unknown) => {
      this.deps.logger.error({ roomId: this.roomId, err: String(error) }, 'dispose failed');
    });
  }

  private log(): Logger {
    return this.deps.logger.child({ roomId: this.roomId });
  }
}

/** Binds dependencies to a concrete room class for `matchMaker.defineRoomType`. */
export function defineMatchRoom(deps: MatchRoomDeps): new () => MatchRoom {
  class ConfiguredMatchRoom extends MatchRoom {
    protected override readonly deps = deps;

    static override onAuth(
      _token: string,
      options: unknown,
      context: AuthContext,
    ): Promise<TicketGrant> {
      return new Promise((resolve) => {
        resolve(MatchRoom.authorize(deps, options, context)); // a throw becomes a rejection
      });
    }
  }
  return ConfiguredMatchRoom;
}
