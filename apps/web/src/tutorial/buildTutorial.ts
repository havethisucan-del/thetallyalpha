import {
  createCardInstances,
  createCartignonRules,
  createMatchFromState,
  createRngFromSeedBytes,
  createRoundContext,
  loadBuiltCatalog,
  mulligan,
  startPresetCartignonMatch,
  step,
  toCartignonAction,
  type CardCatalog,
  type CardId,
  type CartignonMatchPreset,
  type CartignonRules,
  type Zones,
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
 *
 * Revision 2026-10-23: the scripted Mulligan (`mulliganDraw`) shuffles the deck with the match
 * RNG. `orderDeckForMulligan` runs game-core's own `mulligan` on labelled positions with the
 * same RNG state, learns which deck positions the shuffle deals, and puts the wanted cards there
 * (`preset.deckTop`). Any rule change in the Mulligan or the shuffle is caught by the script
 * unit test (it checks the drawn cards).
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
    command.type === 'endTurn' || command.type === 'mulligan'
      ? { type: command.type }
      : { type: command.type, cardId: cardIdOf(command.defId) };

  const { preset, engineSeed } =
    script.mulliganDraw === undefined
      ? script
      : orderDeckForMulligan(catalog, script.preset, script.mulliganDraw, script.engineSeed);
  const started = startPresetCartignonMatch(catalog, preset);
  if (!started.ok) throw new TutorialScriptError(`${started.code}: ${started.message}`);
  const rules = createCartignonRules(catalog);
  let snapshot = createMatchFromState(rules, started.state, seedBytes(engineSeed));
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
    script: { ...script, preset, engineSeed },
    catalog,
    rules,
    context: createRoundContext(catalog),
    snapshot,
    cardIdOf,
    resolve,
  };
}

/**
 * The preset with its deck ordered so that `seat`'s first Mulligan draws exactly `draw.defIds`
 * (in that hand order). Preconditions (`TutorialScript.mulliganDraw`): the Mulligan is the
 * match's first use of randomness, so the RNG is still the engine seed's; nothing moves cards
 * into or out of the deck or `seat`'s hand before it. The deck is then the preset's deck and the
 * hand the preset's hand, so their sizes give the shuffle's input.
 *
 * The shuffle mixes the returned hand into the deck; when a seed would deal a returned hand
 * card, the next seed variant is tried (last two bytes stepped, deterministic). How many seeds fit
 * depends on the deck size: with the shipped script's 9-card deck and 9-card hand (revision
 * 2026-10-25: a small deck so that the next round is the final round) about 1 in 68 fits, so up
 * to `MULLIGAN_SEED_TRIES` variants are tried. The seed used is returned with the preset.
 */
export function orderDeckForMulligan(
  catalog: CardCatalog,
  preset: CartignonMatchPreset,
  draw: NonNullable<TutorialScript['mulliganDraw']>,
  engineSeed: string,
): { readonly preset: CartignonMatchPreset; readonly engineSeed: string } {
  seedBytes(engineSeed); // validates the format
  const last = Number.parseInt(engineSeed.slice(28), 16);
  const plain = startPresetCartignonMatch(catalog, { ...preset, deckTop: [] });
  if (!plain.ok) throw new TutorialScriptError(`${plain.code}: ${plain.message}`);
  const zones = plain.state.round.board.zones;
  const defOf = new Map(createCardInstances(catalog).map((c) => [c.id, c.defId]));
  const deckDefs = zones.deck.map((id) => defOf.get(id) ?? id);
  for (const defId of draw.defIds) {
    if (!deckDefs.includes(defId)) {
      throw new TutorialScriptError(`mulligan card ${defId} is not in the deck`);
    }
  }
  // Probe: the real Mulligan on position labels ("d<i>" deck, "h<i>" hand), same RNG state.
  const label = (prefix: string, length: number) =>
    Array.from({ length }, (_, i) => `${prefix}${i}`);
  const hands: [string[], string[]] = [[], []];
  hands[draw.seat] = label('h', zones.hands[draw.seat].length);
  const probeZones: Zones = {
    deck: label('d', zones.deck.length),
    graveyard: [],
    hands,
    stacks: [[], []],
  };
  for (let attempt = 0; attempt < MULLIGAN_SEED_TRIES; attempt++) {
    const seed = engineSeed.slice(0, 28) + ((last + attempt) % 65536).toString(16).padStart(4, '0');
    const probe = mulligan(probeZones, draw.seat, createRngFromSeedBytes(seedBytes(seed)));
    if (!probe.ok) throw new TutorialScriptError(`mulligan not possible (${probe.code})`);
    if (probe.drawn.length !== draw.defIds.length) {
      throw new TutorialScriptError(
        `mulligan draws ${probe.drawn.length} cards, the script names ${draw.defIds.length}`,
      );
    }
    if (!probe.drawn.every((position) => position.startsWith('d'))) continue;
    const wanted = new Map(
      probe.drawn.map((position, k) => [Number(position.slice(1)), draw.defIds[k] as string]),
    );
    const others = deckDefs.filter((defId) => !draw.defIds.includes(defId));
    const deckTop = deckDefs.map((_, i) => wanted.get(i) ?? (others.shift() as string));
    return { preset: { ...preset, deckTop }, engineSeed: seed };
  }
  throw new TutorialScriptError('no engine seed variant deals the mulligan cards from the deck');
}

const MULLIGAN_SEED_TRIES = 4096;
