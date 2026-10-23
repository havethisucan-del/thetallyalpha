import { BOT_LEVEL_NAMES, type BotLevel, type BotRequest, type TurnMemory } from '@cartignon/ai';
import {
  createMatch,
  createRngFromSeedBytes,
  observeForSeat,
  RNG_SEED_BYTES,
  step,
  type CartignonMatchState,
  type CartignonRules,
  type RoundCommand,
  type Seat,
  type Snapshot,
} from '@cartignon/game-core';
import {
  cartignonPrivateViewSchema,
  type ActionMessage,
  type ActionResultMessage,
  type CartignonCommand,
} from '@cartignon/protocol';
import { appendEventLog, commandToAction, parseCartignonView } from '../lib/cartignon';
import { randomUuid } from '../lib/secureContext';
import { IDLE_SNAPSHOT, type MatchSnapshot, type MatchSource } from '../net/matchSource';
import { createBotClient } from './botClient';
import type { BotTransport } from './botProtocol';
import { soloRules } from './rules';
import { buildSeatViewMessage } from './viewMessage';

/**
 * ADR-0017 decisions 1–2: a solo match against a bot, entirely in the browser. The human is
 * seat 0, the bot seat 1. The engine (`createMatch` / `step`) runs here on the main thread, seeded
 * from `crypto.getRandomValues`; the bot only ever receives `observeForSeat(state, 1)` and keeps
 * its own RNG (never the engine's). Snapshots go through the same parsing and event-log path as
 * `MatchConnection`, so the match screens cannot tell the two apart. No clock, no persistence: a
 * reload loses the match.
 */

export const HUMAN_SEAT: Seat = 0;
export const BOT_SEAT: Seat = 1;

/** `Bot · L3 Skilled`: the opponent label on the table. */
export function botLabel(level: BotLevel): string {
  return `Bot · L${level} ${BOT_LEVEL_NAMES[level]}`;
}

/** Whether the bot move is the first of its turn (a longer "thinking" pause) or a follow-up. */
export type BotMoveKind = 'first' | 'followUp';

/**
 * Cosmetic think time (ms) before a bot move is shown; the bot's own decision time is subtracted.
 * `Math.random` is fine here: it only affects pacing, never the game.
 */
export function defaultBotDelay(kind: BotMoveKind): number {
  return kind === 'first' ? 600 + Math.random() * 1200 : 300 + Math.random() * 400;
}

export interface LocalMatchOptions {
  level: BotLevel;
  /** Defaults to the worker bot (`createBotClient`). Tests pass `createInlineBot()`. */
  bot?: BotTransport;
  /** Cosmetic delay per bot move; tests pass `() => 0`. */
  delay?: (kind: BotMoveKind) => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** `RNG_SEED_BYTES` bytes; default CSPRNG. Tests may pass fixed seeds. */
  engineSeed?: Uint8Array;
  botSeed?: Uint8Array;
  rules?: CartignonRules;
  /**
   * ADR-0018: start from this engine snapshot (e.g. the tutorial's preset deal) instead of
   * `createMatch`; `engineSeed` is then unused. It must belong to `rules`.
   */
  initialSnapshot?: Snapshot;
}

function randomSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(RNG_SEED_BYTES));
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A bot `RoundCommand` as the protocol's (mutable) `CartignonCommand`; same fields. */
function wireCommand(command: RoundCommand): CartignonCommand {
  return command.type === 'chooseSpellOption'
    ? { ...command, selection: [...command.selection] }
    : { ...command };
}

/** The command the bot falls back to after an error: End Turn when legal, else the first legal one. */
function fallbackCommand(legal: readonly CartignonCommand[]): CartignonCommand | null {
  return legal.find((command) => command.type === 'endTurn') ?? legal[0] ?? null;
}

export class LocalMatch implements MatchSource {
  readonly level: BotLevel;
  readonly #rules: CartignonRules;
  readonly #bot: BotTransport;
  readonly #delay: (kind: BotMoveKind) => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #matchId = randomUuid();
  readonly #listeners = new Set<() => void>();
  #snapshot: MatchSnapshot = IDLE_SNAPSHOT;
  #engine: Snapshot;
  #botRngState: string;
  #botMemory: TurnMemory | undefined;
  /** `round:turn` of the bot's last move, to tell a turn's first move from follow-ups. */
  #botTurnKey: string | null = null;
  #botRunning = false;
  /** Incremented by `leave()`; bot work started under an older value is dropped. */
  #generation = 0;
  /** Resolves when the current bot run is over (tests). */
  #idle: Promise<void> = Promise.resolve();

  constructor(options: LocalMatchOptions) {
    this.level = options.level;
    this.#rules = options.rules ?? soloRules();
    this.#bot = options.bot ?? createBotClient();
    this.#delay = options.delay ?? defaultBotDelay;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#now = options.now ?? (() => performance.now());
    this.#engine =
      options.initialSnapshot ??
      createMatch(this.#rules, { options: {} }, options.engineSeed ?? randomSeed());
    this.#botRngState = createRngFromSeedBytes(options.botSeed ?? randomSeed()).getState();
    this.#publish(undefined, { status: 'connected', seat: HUMAN_SEAT });
    this.#runBot();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = (): MatchSnapshot => this.#snapshot;

  /** Resolves once the bot has nothing more to do right now (for tests). */
  whenIdle(): Promise<void> {
    return this.#idle;
  }

  sendAction(action: ActionMessage['action']): string | null {
    const view = this.#snapshot.view;
    if (!view || this.#snapshot.status !== 'connected') return null;
    const actionId = randomUuid();
    const result = step(this.#rules, this.#engine, HUMAN_SEAT, action, view.revision);
    if (!result.ok) {
      this.#update({
        lastResult: {
          status: 'rejected',
          actionId,
          code: result.code,
          message: result.message.slice(0, 200),
          ...(result.reason !== undefined ? { reason: result.reason.slice(0, 64) } : {}),
        },
      });
      return actionId;
    }
    this.#engine = result.snapshot;
    const accepted: ActionResultMessage = {
      status: 'accepted',
      actionId,
      revision: result.snapshot.revision,
    };
    this.#publish(result.events, { lastResult: accepted, error: null });
    this.#runBot();
    return actionId;
  }

  /** Solo matches are always Cartignon; the synthetic counter action does not apply. */
  sendIncrement(): string | null {
    return null;
  }

  /** No lobby in solo play. */
  setReady(): void {}

  leave(): void {
    this.#generation++;
    this.#bot.dispose();
    this.#update({ status: 'disconnected' });
  }

  #update(patch: Partial<MatchSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }

  /** Publishes the human seat's view of the current engine snapshot (as `match:view` would). */
  #publish(rawEvents: readonly unknown[] | undefined, patch: Partial<MatchSnapshot> = {}): void {
    const view = buildSeatViewMessage(
      this.#rules,
      this.#engine,
      HUMAN_SEAT,
      this.#matchId,
      rawEvents,
    );
    const cartignon = parseCartignonView(view);
    if (!cartignon) {
      this.#update({ ...patch, error: 'The match data could not be read.' });
      return;
    }
    this.#update({
      ...patch,
      view,
      seat: view.seat,
      cartignon,
      eventLog: appendEventLog(this.#snapshot.eventLog, view.revision, cartignon.events),
      clock: null,
      clockReceivedAt: null,
    });
  }

  #state(): CartignonMatchState {
    return this.#engine.state as CartignonMatchState;
  }

  #botMustAct(): boolean {
    const view = this.#snapshot.view;
    return (
      this.#snapshot.status === 'connected' &&
      view !== null &&
      view.outcome === null &&
      view.phase.activeSeat === BOT_SEAT
    );
  }

  #runBot(): void {
    if (this.#botRunning || !this.#botMustAct()) return;
    this.#botRunning = true;
    const generation = this.#generation;
    this.#idle = this.#botLoop(generation);
  }

  async #botLoop(generation: number): Promise<void> {
    const current = () => generation === this.#generation;
    try {
      await this.#botMoves(current);
    } finally {
      // Synchronously at the loop's end, so a human action right after can start the next run.
      if (current()) this.#botRunning = false;
    }
  }

  async #botMoves(current: () => boolean): Promise<void> {
    while (current() && this.#botMustAct()) {
      const started = this.#now();
      const state = this.#state();
      const turnKey = `${state.roundNumber}:${state.round.turnNumber}`;
      const kind: BotMoveKind = turnKey === this.#botTurnKey ? 'followUp' : 'first';
      const request: BotRequest = {
        level: this.level,
        observation: observeForSeat(state, BOT_SEAT),
        rngState: this.#botRngState,
        ...(this.#botMemory === undefined ? {} : { memory: this.#botMemory }),
      };

      let command: CartignonCommand | null = null;
      let failure: string | null = null;
      try {
        const response = await this.#bot.decide(request);
        if (!current()) return;
        this.#botRngState = response.rngState;
        this.#botMemory = response.memory;
        command = wireCommand(response.command);
      } catch (error) {
        if (!current()) return;
        failure = `The bot failed to decide (${errorText(error)}).`;
      }

      const wait = Math.max(0, this.#delay(kind) - (this.#now() - started));
      if (wait > 0) await this.#sleep(wait);
      if (!current()) return;
      this.#botTurnKey = turnKey;

      if (command !== null && this.#applyBot(command, null)) continue;
      if (command !== null) failure ??= 'The bot chose an illegal move.';
      if (!this.#applyFallback(failure ?? 'The bot could not move.')) return;
    }
  }

  /** Commits a bot command; false (nothing changed) when `step` rejects it. */
  #applyBot(command: CartignonCommand, error: string | null): boolean {
    let action: ActionMessage['action'];
    try {
      action = commandToAction(command);
    } catch {
      return false; // not even a well-formed command
    }
    const result = step(this.#rules, this.#engine, BOT_SEAT, action, this.#engine.revision);
    if (!result.ok) return false;
    this.#engine = result.snapshot;
    this.#publish(result.events, error === null ? {} : { error });
    return true;
  }

  /** The game must never hang on a bot error: play End Turn (or the first legal command). */
  #applyFallback(reason: string): boolean {
    const priv = cartignonPrivateViewSchema.safeParse(
      buildSeatViewMessage(this.#rules, this.#engine, BOT_SEAT, this.#matchId, undefined).private,
    );
    const fallback = priv.success ? fallbackCommand(priv.data.legal) : null;
    if (fallback !== null && this.#applyBot(fallback, `${reason} It played a safe move instead.`)) {
      return true;
    }
    this.#update({ error: `${reason} The match cannot continue.` });
    return false;
  }
}
