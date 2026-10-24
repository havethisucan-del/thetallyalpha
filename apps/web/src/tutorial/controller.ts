import type { CartignonSeatEvent } from '@cartignon/protocol';
import type { EventMatch, TutorialState, TutorialStep } from './types';

/**
 * ADR-0018: the coach's step machine. Pure (no DOM, no match): `TutorialMatch` feeds it the seat
 * events of every new revision and tells it when the gated command was accepted.
 *
 * Event gates: seat events are buffered from the last completed gate on, so an event that arrives
 * in the same revision as the command that completed the previous step (e.g. the bot's turn start
 * right after End Turn) still counts. A `continue` step clears the buffer (nothing the player
 * reads about may be skipped by an older event).
 *
 * Revision 2026-10-25: `play` steps wait for their `until` event like event steps; reaching one
 * sets `freePlay` for the rest of the tutorial.
 */
export function eventMatches(event: CartignonSeatEvent, match: EventMatch): boolean {
  if (event.type !== match.type) return false;
  if (match.seat === undefined) return true;
  return 'seat' in event && event.seat === match.seat;
}

export class TutorialController {
  readonly #steps: readonly TutorialStep[];
  readonly #listeners = new Set<() => void>();
  #buffer: CartignonSeatEvent[] = [];
  #state: TutorialState;

  constructor(steps: readonly TutorialStep[]) {
    const first = steps[0];
    if (first === undefined) throw new Error('a tutorial needs at least one step');
    this.#steps = steps;
    this.#state = {
      status: 'running',
      index: 0,
      step: first,
      total: steps.length,
      offScript: false,
      freePlay: first.gate.kind === 'play',
    };
  }

  get state(): TutorialState {
    return this.#state;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Continue on a `continue` step; the last step finishes the tutorial. False if not allowed. */
  continue(): boolean {
    if (!this.#running() || this.#state.step.gate.kind !== 'continue') return false;
    this.#buffer = [];
    this.#advance();
    return true;
  }

  /** The gated command of the current step was accepted by the engine. */
  commandAccepted(): void {
    if (!this.#running() || this.#state.step.gate.kind !== 'command') return;
    this.#advance();
  }

  /** Seat events of one new revision, in order. */
  observe(events: readonly CartignonSeatEvent[]): void {
    if (this.#state.status !== 'running' || events.length === 0) return;
    this.#buffer.push(...events);
    this.#drainEvents();
  }

  /** The bot left the script (or the gated command is not legal): free play from now on. */
  goOffScript(): void {
    if (this.#state.offScript || this.#state.status !== 'running') return;
    this.#set({ ...this.#state, offScript: true });
  }

  skip(): void {
    if (this.#state.status !== 'running') return;
    this.#set({ ...this.#state, status: 'skipped' });
  }

  #running(): boolean {
    return this.#state.status === 'running' && !this.#state.offScript;
  }

  #advance(): void {
    const next = this.#steps[this.#state.index + 1];
    if (next === undefined) {
      this.#set({ ...this.#state, status: 'finished' });
      return;
    }
    this.#set({
      ...this.#state,
      index: this.#state.index + 1,
      step: next,
      freePlay: this.#state.freePlay || next.gate.kind === 'play',
    });
    this.#drainEvents();
  }

  /** Completes the current event / play step if the buffer holds its event (`#advance` recurses). */
  #drainEvents(): void {
    if (!this.#running()) return;
    const gate = this.#state.step.gate;
    if (gate.kind !== 'event' && gate.kind !== 'play') return;
    const awaited = gate.kind === 'event' ? gate.match : gate.until;
    const at = this.#buffer.findIndex((event) => eventMatches(event, awaited));
    if (at < 0) return;
    this.#buffer = this.#buffer.slice(at + 1);
    this.#advance();
  }

  #set(state: TutorialState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}
