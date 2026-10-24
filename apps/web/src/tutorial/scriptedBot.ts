import {
  decideFromRequest,
  EMPTY_TURN_MEMORY,
  type BotRequest,
  type BotResponse,
} from '@cartignon/ai';
import { validateCommand, type RoundCommand, type RoundContext } from '@cartignon/game-core';
import type { BotTransport } from '../solo/botProtocol';

/**
 * ADR-0018 decision 4: the tutorial's bot. It answers `LocalMatch`'s requests with the scripted
 * moves, but only while the coach has released it (`setReleased(true)`, during "watch the bot"
 * steps); until then a request waits. A scripted move that is not legal in the observed position
 * switches it to the L1 bot for good and reports `offScript`, so the match never hangs.
 *
 * Revision 2026-10-25 (the tutorial plays to the end of the match): a request after the script
 * ran out is the planned handover, not a deviation: it is answered by the L1 bot, still only
 * while released (the coach's free-play step releases it), and `offScript` stays false.
 */

class DisposedError extends Error {
  constructor() {
    super('the bot was stopped');
    this.name = 'DisposedError';
  }
}

interface Waiting {
  readonly request: BotRequest;
  readonly resolve: (response: BotResponse) => void;
  readonly reject: (error: Error) => void;
}

export interface ScriptedBotOptions {
  readonly context: RoundContext;
  /** The scripted moves (instance ids resolved), in order. */
  readonly moves: readonly RoundCommand[];
  /** Called once when the bot leaves the script. */
  readonly onOffScript?: () => void;
}

export class ScriptedBot implements BotTransport {
  readonly #context: RoundContext;
  readonly #moves: readonly RoundCommand[];
  readonly #onOffScript: (() => void) | undefined;
  #next = 0;
  #released = false;
  #offScript = false;
  #disposed = false;
  #waiting: Waiting[] = [];

  constructor(options: ScriptedBotOptions) {
    this.#context = options.context;
    this.#moves = options.moves;
    this.#onOffScript = options.onOffScript;
  }

  get offScript(): boolean {
    return this.#offScript;
  }

  /** Scripted moves not played yet. */
  get remaining(): number {
    return this.#moves.length - this.#next;
  }

  setReleased(released: boolean): void {
    this.#released = released;
    if (released) this.#flush();
  }

  decide(request: BotRequest): Promise<BotResponse> {
    if (this.#disposed) return Promise.reject(new DisposedError());
    return new Promise<BotResponse>((resolve, reject) => {
      this.#waiting.push({ request, resolve, reject });
      // A microtask, as the inline bot: the caller's state settles first.
      queueMicrotask(() => {
        this.#flush();
      });
    });
  }

  dispose(): void {
    this.#disposed = true;
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const w of waiting) w.reject(new DisposedError());
  }

  #flush(): void {
    if (this.#disposed || !(this.#released || this.#offScript)) return;
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const w of waiting) {
      try {
        w.resolve(this.#answer(w.request));
      } catch (error) {
        w.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  #answer(request: BotRequest): BotResponse {
    if (!this.#offScript) {
      const move = this.#moves[this.#next];
      // The script ran out: the planned handover to the L1 bot.
      if (move === undefined) return decideFromRequest(this.#context, { ...request, level: 1 });
      const { match, seat } = request.observation;
      if (
        match.status.kind === 'playing' &&
        validateCommand(this.#context, match.round, seat, move).ok
      ) {
        this.#next++;
        return {
          command: move,
          memory: request.memory ?? EMPTY_TURN_MEMORY,
          rngState: request.rngState,
          loopDetected: false,
          elapsedMs: 0,
        };
      }
      this.#offScript = true;
      this.#onOffScript?.();
    }
    return decideFromRequest(this.#context, { ...request, level: 1 });
  }
}
