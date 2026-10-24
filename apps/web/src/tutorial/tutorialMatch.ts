import type { CartignonCommand, ActionMessage } from '@cartignon/protocol';
import { commandToAction } from '../lib/cartignon';
import type { MatchSnapshot, MatchSource } from '../net/matchSource';
import { LocalMatch, type BotMoveKind } from '../solo/localMatch';
import { buildTutorial, type BuiltTutorial } from './buildTutorial';
import { TutorialController } from './controller';
import { ScriptedBot } from './scriptedBot';
import type { ScriptCommand, TutorialState } from './types';

/**
 * ADR-0018 decision 3: the tutorial as a `MatchSource`. Wraps a `LocalMatch` started from the
 * tutorial position (`initialSnapshot`) with the scripted bot, and gates the human: the snapshot's
 * `cartignon.private.legal` holds only the current step's command (nothing on Continue / event
 * steps), and `sendAction` refuses every other action. The table components need no tutorial
 * knowledge: they derive every action from `private.legal`. Off script, nothing is filtered.
 * Revision 2026-10-25: nor from the first free-play (`play`) step on, where the bot is released
 * and plays as L1 once its script has run out, until the match ends.
 */

export interface TutorialMatchOptions {
  /** Default: `buildTutorial()` (the shipped script and catalog). */
  tutorial?: BuiltTutorial;
  /** Cosmetic bot pacing, as `LocalMatchOptions.delay`; tests pass `() => 0`. */
  delay?: (kind: BotMoveKind) => number;
  sleep?: (ms: number) => Promise<void>;
  /** `RNG_SEED_BYTES` bytes for the L1 fallback bot; default CSPRNG. */
  botSeed?: Uint8Array;
}

function sameAction(a: ActionMessage['action'], b: ActionMessage['action']): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class TutorialMatch implements MatchSource {
  readonly tutorial: BuiltTutorial;
  readonly #controller: TutorialController;
  readonly #bot: ScriptedBot;
  readonly #inner: LocalMatch;
  readonly #listeners = new Set<() => void>();
  #lastRevision: number | null = null;
  #innerSnapshot: MatchSnapshot | null = null;
  #gatedState: TutorialState | null = null;
  #filtered: MatchSnapshot | null = null;

  constructor(options: TutorialMatchOptions = {}) {
    this.tutorial = options.tutorial ?? buildTutorial();
    const { script, resolve, context } = this.tutorial;
    this.#controller = new TutorialController(script.steps);
    this.#bot = new ScriptedBot({
      context,
      moves: script.botMoves.map(resolve),
      onOffScript: () => {
        this.#controller.goOffScript();
      },
    });
    this.#inner = new LocalMatch({
      level: 1,
      bot: this.#bot,
      rules: this.tutorial.rules,
      initialSnapshot: this.tutorial.snapshot,
      ...(options.delay === undefined ? {} : { delay: options.delay }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.botSeed === undefined ? {} : { botSeed: options.botSeed }),
    });
    this.#observeInner();
    this.#inner.subscribe(() => {
      this.#observeInner();
      this.#emit();
    });
    this.#controller.subscribe(() => {
      this.#onStepChange();
      this.#emit();
    });
    this.#onStepChange();
  }

  // --- MatchSource ---------------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = (): MatchSnapshot => {
    const inner = this.#inner.getSnapshot();
    const state = this.#controller.state;
    if (this.#filtered !== null && inner === this.#innerSnapshot && state === this.#gatedState) {
      return this.#filtered;
    }
    this.#innerSnapshot = inner;
    this.#gatedState = state;
    this.#filtered = this.#filter(inner);
    return this.#filtered;
  };

  sendAction(action: ActionMessage['action']): string | null {
    if (!this.#gatingOff()) {
      const allowed = this.#allowedAction();
      if (allowed === null || !sameAction(allowed, action)) return null;
    }
    const actionId = this.#inner.sendAction(action);
    const result = this.#inner.getSnapshot().lastResult;
    if (actionId !== null && result?.status === 'accepted' && result.actionId === actionId) {
      this.#controller.commandAccepted();
    }
    return actionId;
  }

  sendIncrement(): string | null {
    return null;
  }

  setReady(): void {}

  leave(): void {
    this.#inner.leave();
  }

  // --- Coach API -----------------------------------------------------------------------------

  /** The coach state (stable object per change; use with `subscribe`). */
  getTutorialState = (): TutorialState => this.#controller.state;

  /** Continue on a Continue step (the last one finishes the tutorial). */
  continue(): boolean {
    return this.#controller.continue();
  }

  /** Stops the coach (the caller records `markTutorial('skipped')` and leaves). */
  skip(): void {
    this.#controller.skip();
  }

  /** Instance id of a script card (for highlight targets). */
  cardIdOf = (defId: string): string => this.tutorial.cardIdOf(defId);

  /** Resolves when the bot has nothing more to do right now (tests). */
  whenIdle(): Promise<void> {
    return this.#inner.whenIdle();
  }

  // --- internals -----------------------------------------------------------------------------

  /** No gating once the bot left the script, the coach was skipped, or free play began. */
  #gatingOff(): boolean {
    const state = this.#controller.state;
    return state.offScript || state.status === 'skipped' || state.freePlay;
  }

  /** The current step's command as a wire command, when it is a command step. */
  #gatedCommand(): CartignonCommand | null {
    const gate = this.#controller.state.step.gate;
    if (this.#controller.state.status !== 'running' || gate.kind !== 'command') return null;
    return this.#wire(gate.command);
  }

  #wire(command: ScriptCommand): CartignonCommand {
    return { ...this.tutorial.resolve(command) } as CartignonCommand;
  }

  #allowedAction(): ActionMessage['action'] | null {
    const command = this.#gatedCommand();
    return command === null ? null : commandToAction(command);
  }

  #filter(snapshot: MatchSnapshot): MatchSnapshot {
    const parts = snapshot.cartignon;
    if (parts === null || this.#gatingOff()) return snapshot;
    const allowed = this.#allowedAction();
    const legal = parts.private.legal.filter(
      (command) => allowed !== null && sameAction(commandToAction(command), allowed),
    );
    return { ...snapshot, cartignon: { ...parts, private: { ...parts.private, legal } } };
  }

  /** Feeds the controller the seat events of each new revision, once. */
  #observeInner(): void {
    const snapshot = this.#inner.getSnapshot();
    const view = snapshot.view;
    const parts = snapshot.cartignon;
    if (view === null || parts === null || view.revision === this.#lastRevision) return;
    this.#lastRevision = view.revision;
    this.#controller.observe(parts.events);
  }

  /**
   * Releases the scripted bot on "watch the bot" steps and free-play steps (and for good once
   * skipped: the match may start on the bot's turn, which must not hang); checks that a gated
   * command is legal.
   */
  #onStepChange(): void {
    const state = this.#controller.state;
    this.#bot.setReleased(
      state.offScript ||
        state.status === 'skipped' ||
        (state.status === 'running' &&
          (state.step.gate.kind === 'event' || state.step.gate.kind === 'play')),
    );
    const command = this.#gatedCommand();
    const parts = this.#inner.getSnapshot().cartignon;
    if (command === null || parts === null || state.offScript) return;
    const action = commandToAction(command);
    if (!parts.private.legal.some((c) => sameAction(commandToAction(c), action))) {
      // The script no longer fits the position: never leave the player stuck.
      this.#controller.goOffScript();
    }
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
