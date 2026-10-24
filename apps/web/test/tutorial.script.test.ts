import { expandTestSeed, type CartignonMatchState } from '@cartignon/game-core';
import type { CartignonSeatEvent } from '@cartignon/protocol';
import { describe, expect, it } from 'vitest';
import { commandToAction } from '../src/lib/cartignon';
import { buildTutorial } from '../src/tutorial/buildTutorial';
import { TUTORIAL_SCRIPT } from '../src/tutorial/script';
import { TutorialMatch } from '../src/tutorial/tutorialMatch';
import { MAX_STEP_TEXT, SPELL_PARTS, type TutorialSection } from '../src/tutorial/types';

/** ADR-0018: the shipped script plays to its end on the real engine and catalog. */

const SECTION_ORDER: readonly TutorialSection[] = ['card', 'flow', 'combat', 'goal'];
const MAX_ITERATIONS = 200;

function scriptDefIds(): string[] {
  const { preset, prelude, botMoves, steps, mulliganDraw } = TUTORIAL_SCRIPT;
  const ids = [...preset.hands[0], ...preset.hands[1], ...(preset.graveyard ?? [])];
  ids.push(...(preset.deckTop ?? []), ...(mulliganDraw?.defIds ?? []));
  for (const command of [...prelude.map((m) => m.command), ...botMoves]) {
    if ('defId' in command) ids.push(command.defId);
  }
  for (const step of steps) {
    if (step.zoom) ids.push(step.zoom.defId);
    if (step.gate.kind === 'command' && 'defId' in step.gate.command) {
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
    } else if (gate.kind === 'play') {
      // Free play: the whole legal list is offered; end the turn when allowed, else the first
      // legal command (a Base, a stack card or a choice), and let the L1 bot answer.
      const legal = match.getSnapshot().cartignon?.private.legal ?? [];
      const pick = legal.find((c) => c.type === 'endTurn') ?? legal[0];
      if (pick !== undefined) {
        expect(match.sendAction(commandToAction(pick))).not.toBeNull();
      }
      await match.whenIdle();
      await Promise.resolve();
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

  it('starts at the beginning of a round: empty stacks, the bot (P1) in its Base step', () => {
    const built = buildTutorial();
    const state = built.snapshot.state as CartignonMatchState;
    expect(state.round.board.zones.stacks).toEqual([[], []]);
    expect(state.round.phase).toMatchObject({ kind: 'p1Base', active: 1 });
    expect(state.round.board.zones.hands[0]).toHaveLength(9);
  });

  it('zooms only cards of the own hand, with a part of their kind, and highlights them', () => {
    const built = buildTutorial();
    // The dealt hand, and the cards the Mulligan draws (the spell is one of them).
    const hand = new Set([
      ...TUTORIAL_SCRIPT.preset.hands[0],
      ...(TUTORIAL_SCRIPT.mulliganDraw?.defIds ?? []),
    ]);
    const spellParts: readonly string[] = SPELL_PARTS;
    for (const step of TUTORIAL_SCRIPT.steps) {
      const zoom = step.zoom;
      if (zoom === undefined) continue;
      expect(hand.has(zoom.defId), step.id).toBe(true);
      expect(step.targets, step.id).toContain(`card:${zoom.defId}`);
      const kind = built.catalog.find((d) => d.defId === zoom.defId)?.kind;
      const isSpellPart = spellParts.includes(zoom.part);
      expect(kind, step.id).toBe(isSpellPart ? 'spell' : 'creature');
    }
    // The spell is read part by part: Condition, Primary, Secondary.
    expect(
      TUTORIAL_SCRIPT.steps.flatMap((s) =>
        s.zoom && spellParts.includes(s.zoom.part) ? [s.zoom.part] : [],
      ),
    ).toEqual(['condition', 'primary', 'secondary']);
  });

  it('plays to the end: scripted round won, then a free final round, match over', async () => {
    const match = new TutorialMatch({ delay: () => 0, botSeed: expandTestSeed(5) });
    const events = await playThrough(match);
    const state = match.getTutorialState();
    expect(state.offScript).toBe(false);
    expect(state.freePlay).toBe(true);
    expect(state.status).toBe('finished');

    const id = match.cardIdOf;
    const blue = id('C-D4');
    // The Mulligan really happened and drew the scripted cards (deck ordered for the shuffle).
    expect(events).toContainEqual({ type: 'mulliganed', seat: 0, returned: 9, drawnCount: 5 });
    expect(events).toContainEqual({
      type: 'cardsDrawn',
      seat: 0,
      reason: 'mulligan',
      cardIds: ['C-F2', 'C-C2', 'C-D3', 'S-15', 'C-D4'].map(id),
    });
    // Nullify, then the bot's second Base and the human's Base.
    expect(events).toContainEqual({
      type: 'nullified',
      seat: 0,
      cardId: id('C-F2'),
      nullifiedCardId: id('C-G3'),
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'creaturePlayed',
        seat: 1,
        cardId: id('C-G2'),
        role: 'p1Base',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'creaturePlayed',
        seat: 0,
        cardId: id('C-C2'),
        role: 'p2Base',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'spellPlayed', seat: 0, branch: 'primary' }),
    );
    expect(events).toContainEqual({
      type: 'roundOver',
      reason: 'opponentAhead',
      seat: 1,
      atk: [317, 249],
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
    // The scripted win does not end the match: 4 tokens to 1, two still in the supply.
    const matchOver = events.filter((e) => e.type === 'matchOver');
    expect(matchOver).toHaveLength(1);
    // RD-22: the pool after round 7's cleanup is 18, so round 8 is the final round, 9 cards each.
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'deckExhausted', reason: 'finalRound', perSeat: 9 }),
    );
    // Exactly two rounds are resolved: the scripted round 7 and the free final round 8.
    expect(events.flatMap((e) => (e.type === 'roundResolved' ? [e.round] : []))).toEqual([7, 8]);
    // RD-24: the match ends after the final round; more tokens wins (no tie is possible).
    expect(matchOver[0]).toMatchObject({ reason: 'finalRoundPlayed', winner: 0 });
    expect(match.getSnapshot().view?.outcome).not.toBeNull();
    match.leave();
  });

  it('starts with a token lead that cannot be lost in one round, and an 18-card pool after it', () => {
    const tokens = TUTORIAL_SCRIPT.preset.tokens ?? {};
    const held = Object.values(tokens);
    expect(held.filter((seat) => seat === 0)).toHaveLength(3);
    expect(held.filter((seat) => seat === 1)).toHaveLength(1);
    const built = buildTutorial();
    const zones = (built.snapshot.state as CartignonMatchState).round.board.zones;
    expect(zones.deck).toHaveLength(9);
    expect(zones.hands[1]).toHaveLength(6);
    expect(zones.graveyard).toHaveLength(30);
  });

  it('ends with free play, then a last Continue after the match is over', () => {
    const tail = TUTORIAL_SCRIPT.steps.slice(-2);
    expect(tail.map((s) => s.gate.kind)).toEqual(['play', 'continue']);
    expect(tail[0]?.gate).toEqual({ kind: 'play', until: { type: 'matchOver' } });
  });
});
