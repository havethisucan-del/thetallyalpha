import {
  createRngFromState,
  type RoundCommand,
  type RoundContext,
  type SeatObservation,
} from '@cartignon/game-core';
import { decideCommand, EMPTY_TURN_MEMORY, type BotLevel, type TurnMemory } from './bot.js';
import type { SearchBudget } from './montecarlo.js';

/**
 * ADR-0016 (browser-side bot): one bot decision as plain, structured-cloneable data, so the call
 * can cross a Web Worker boundary (`postMessage`) unchanged. The worker builds its `RoundContext`
 * once from the card catalog (`createRoundContext(loadCatalog(...))`) and answers each request
 * with `decideFromRequest`. Nothing here touches a DOM, Node or worker API: the caller owns the
 * transport.
 *
 * The RNG travels as its 128-bit state (`Rng.getState()`): the response carries the advanced
 * state, which the caller passes into its next request. This RNG is the bot's own and only drives
 * its choices; it must never be the engine's RNG (that would let the bot predict deck draws).
 */

/** A budget without functions (a `time` budget always uses `Date.now` on the bot's side). */
export type SerializableBudget =
  | { readonly kind: 'playouts'; readonly playouts: number }
  | { readonly kind: 'time'; readonly ms: number };

export interface BotRequest {
  readonly level: BotLevel;
  /** `observeForSeat(match, seat)` for the acting seat: the bot never receives the full match. */
  readonly observation: SeatObservation;
  /** The bot RNG state, 32 lowercase hex chars (`Rng.getState()`). */
  readonly rngState: string;
  /** L4 / L5 only; default: the level's time budget (`DEFAULT_TIME_BUDGET_MS`). */
  readonly budget?: SerializableBudget;
  /** The `memory` of the previous response in the same match (omit for the first decision). */
  readonly memory?: TurnMemory;
}

export interface BotResponse {
  readonly command: RoundCommand;
  readonly memory: TurnMemory;
  readonly rngState: string;
  readonly loopDetected: boolean;
  /** Wall-clock time spent deciding (`Date.now` resolution). */
  readonly elapsedMs: number;
}

/** Answers one `BotRequest` (pure apart from the clock). Throws `NotBotsTurnError`. */
export function decideFromRequest(ctx: RoundContext, request: BotRequest): BotResponse {
  const started = Date.now();
  const rng = createRngFromState(request.rngState);
  const budget: SearchBudget | undefined = request.budget;
  const decision = decideCommand(request.level, ctx, request.observation, rng, {
    memory: request.memory ?? EMPTY_TURN_MEMORY,
    ...(budget === undefined ? {} : { budget }),
  });
  return {
    command: decision.command,
    memory: decision.memory,
    rngState: rng.getState(),
    loopDetected: decision.loopDetected,
    elapsedMs: Date.now() - started,
  };
}
