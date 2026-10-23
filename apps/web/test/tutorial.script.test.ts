import {
  createCardIndex,
  expandTestSeed,
  stackAtk,
  type CartignonMatchState,
} from '@cartignon/game-core';
import type { CartignonSeatEvent } from '@cartignon/protocol';
import { describe, expect, it } from 'vitest';
import { commandToAction } from '../src/lib/cartignon';
import { buildTutorial } from '../src/tutorial/buildTutorial';
import { TUTORIAL_SCRIPT } from '../src/tutorial/script';
import { TutorialMatch } from '../src/tutorial/tutorialMatch';
import { MAX_STEP_TEXT, type TutorialSection } from '../src/tutorial/types';

/** ADR-0018: the shipped script plays to its end on the real engine and catalog. */

const SECTION_ORDER: readonly TutorialSection[] = ['card', 'flow', 'combat', 'goal'];
const MAX_ITERATIONS = 200;

function scriptDefIds(): string[] {
  const { preset, prelude, botMoves, steps } = TUTORIAL_SCRIPT;
  const ids = [...preset.hands[0], ...preset.hands[1], ...(preset.graveyard ?? [])];
  ids.push(...(preset.deckTop ?? []));
  for (const command of [...prelude.map((m) => m.command), ...botMoves]) {
    if (command.type !== 'endTurn') ids.push(command.defId);
  }
  for (const step of steps) {
    if (step.anatomy) ids.push(step.anatomy.defId);
    if (step.gate.kind === 'command' && step.gate.command.type !== 'endTurn') {
      ids.push(step.gate.command.defId);
    }
    for (const target of step.targets ?? []) {
      if (target.startsWith('card:')) ids.push(target.slice(5));
    }
  }
  return ids;
}

/** Plays every step as a player following the coach would; returns every seat event seen. */
async function playThrough(match: TutorialMatch): Promise<CartignonSeatEvent[]> {
  const events: CartignonSeatEvent[] = [];
  let revision = match.getSnapshot().view?.revision ?? -1;
  match.subscribe(() => {
    const snapshot = match.getSnapshot();
    const view = snapshot.view;
    if (view && view.revision !== revision && snapshot.cartignon) {
      revision = view.revision;
      events.push(...snapshot.cartignon.events);
    }
  });
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const state = match.getTutorialState();
    if (state.status !== 'running' || state.offScript) break;
    const gate = state.step.gate;
    if (gate.kind === 'continue') {
      expect(match.continue()).toBe(true);
    } else if (gate.kind === 'command') {
      const legal = match.getSnapshot().cartignon?.private.legal ?? [];
      expect(legal).toHaveLength(1);
      const [only] = legal;
      if (only === undefined) throw new Error('no legal command');
      expect(match.sendAction(commandToAction(only))).not.toBeNull();
      expect(match.getSnapshot().lastResult?.status).toBe('accepted');
    } else {
      await match.whenIdle();
      if (match.getTutorialState() === state) await Promise.resolve();
      expect(match.getTutorialState()).not.toBe(state);
    }
  }
  return events;
}

describe('tutorial script', () => {
  it('names only cards of the catalog', () => {
    const built = buildTutorial();
    const defIds = new Set(built.catalog.map((d) => d.defId));
    for (const defId of scriptDefIds()) expect(defIds.has(defId), defId).toBe(true);
  });

  it('keeps coach texts within the limit and the sections in the mandatory order', () => {
    const seen: TutorialSection[] = [];
    for (const step of TUTORIAL_SCRIPT.steps) {
      expect(step.text.length, step.id).toBeLessThanOrEqual(MAX_STEP_TEXT);
      expect(step.text.trim().length, step.id).toBeGreaterThan(0);
      if (seen.at(-1) !== step.section) seen.push(step.section);
    }
    expect(seen).toEqual(SECTION_ORDER);
    expect(new Set(TUTORIAL_SCRIPT.steps.map((s) => s.id)).size).toBe(TUTORIAL_SCRIPT.steps.length);
  });

  it('starts behind, 128 to 153, with the human on turn', () => {
    const built = buildTutorial();
    const state = built.snapshot.state as CartignonMatchState;
    const cards = createCardIndex(built.catalog);
    expect(stackAtk(cards, state.round.board, 0)).toBe(128);
    expect(stackAtk(cards, state.round.board, 1)).toBe(153);
    expect(state.round.phase).toMatchObject({ kind: 'turn', active: 0 });
  });

  it('plays to the end on script: round and token won by seat 0, match over', async () => {
    const match = new TutorialMatch({ delay: () => 0, botSeed: expandTestSeed(5) });
    const events = await playThrough(match);
    const state = match.getTutorialState();
    expect(state.offScript).toBe(false);
    expect(state.status).toBe('finished');

    const blue = match.cardIdOf('C-D4');
    expect(events).toContainEqual({
      type: 'roundOver',
      reason: 'opponentAhead',
      seat: 1,
      atk: [363, 299],
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'roundResolved',
        outcome: expect.objectContaining({ kind: 'win', winner: 0 }) as unknown,
      }),
    );
    expect(events).toContainEqual({
      type: 'tokenChanged',
      change: { seat: 0, color: 'blue', kind: 'awarded', leadingCardId: blue },
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'matchOver', reason: 'allTokensHeld', winner: 0 }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'spellPlayed', seat: 0, branch: 'secondary' }),
    );
    expect(match.getSnapshot().view?.outcome).not.toBeNull();
    match.leave();
  });
});
