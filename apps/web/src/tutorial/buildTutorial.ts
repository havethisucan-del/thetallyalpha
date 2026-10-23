import {
  createCardInstances,
  createCartignonRules,
  createMatchFromState,
  createRoundContext,
  loadBuiltCatalog,
  startPresetCartignonMatch,
  step,
  toCartignonAction,
  type CardCatalog,
  type CardId,
  type CartignonRules,
  type RoundCommand,
  type RoundContext,
  type Snapshot,
} from '@cartignon/game-core';
import builtCards from '@cartignon/game-core/cards.json';
import { TUTORIAL_SCRIPT } from './script';
import type { ScriptCommand, TutorialScript } from './types';

/**
 * ADR-0018: turns the tutorial script into a playable position: the preset deal
 * (`startPresetCartignonMatch`), a revision-0 snapshot (`createMatchFromState`) and the prelude
 * applied with real `step()` calls. A broken script (unknown card, illegal prelude move) throws
 * `TutorialScriptError`: it is a programmer error caught by the script unit test.
 */

export class TutorialScriptError extends Error {
  constructor(message: string) {
    super(`tutorial script: ${message}`);
    this.name = 'TutorialScriptError';
  }
}

export interface BuiltTutorial {
  readonly script: TutorialScript;
  readonly catalog: CardCatalog;
  readonly rules: CartignonRules;
  readonly context: RoundContext;
  /** The position after the prelude: the human (seat 0) is on turn. */
  readonly snapshot: Snapshot;
  /** Card instance id of a defId (each defId is one card in this catalog). */
  readonly cardIdOf: (defId: string) => CardId;
  /** The engine command of a script command. */
  readonly resolve: (command: ScriptCommand) => RoundCommand;
}

/** `hex` (32 lowercase hex chars) as 16 bytes. */
export function seedBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new TutorialScriptError('engineSeed must be 32 hex chars');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

let defaultCatalog: CardCatalog | undefined;

function builtCatalog(): CardCatalog {
  defaultCatalog ??= loadBuiltCatalog(builtCards);
  return defaultCatalog;
}

export function buildTutorial(
  script: TutorialScript = TUTORIAL_SCRIPT,
  catalog: CardCatalog = builtCatalog(),
): BuiltTutorial {
  const ids = new Map(createCardInstances(catalog).map((c) => [c.defId, c.id]));
  const cardIdOf = (defId: string): CardId => {
    const id = ids.get(defId);
    if (id === undefined) throw new TutorialScriptError(`unknown card ${defId}`);
    return id;
  };
  const resolve = (command: ScriptCommand): RoundCommand =>
    command.type === 'endTurn'
      ? { type: 'endTurn' }
      : { type: command.type, cardId: cardIdOf(command.defId) };

  const started = startPresetCartignonMatch(catalog, script.preset);
  if (!started.ok) throw new TutorialScriptError(`${started.code}: ${started.message}`);
  const rules = createCartignonRules(catalog);
  let snapshot = createMatchFromState(rules, started.state, seedBytes(script.engineSeed));
  for (const [index, move] of script.prelude.entries()) {
    const action = toCartignonAction(resolve(move.command));
    const result = step(rules, snapshot, move.seat, action, snapshot.revision);
    if (!result.ok) {
      throw new TutorialScriptError(
        `prelude move ${index} rejected (${result.reason ?? result.code})`,
      );
    }
    snapshot = result.snapshot;
  }
  return {
    script,
    catalog,
    rules,
    context: createRoundContext(catalog),
    snapshot,
    cardIdOf,
    resolve,
  };
}
