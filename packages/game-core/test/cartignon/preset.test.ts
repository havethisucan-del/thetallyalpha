import { describe, expect, it } from 'vitest';
import {
  createCardInstances,
  createCartignonRules,
  createMatchFromState,
  createRngFromSeedBytes,
  expandTestSeed,
  loadBuiltCatalog,
  startPresetCartignonMatch,
  step,
  toCartignonAction,
  viewFor,
  type CardCatalog,
  type CartignonMatchPreset,
  type CartignonMatchState,
} from '../../src/index.js';
import { deepFreeze, realCatalog } from './test-fixtures.js';

/** ADR-0018: the preset deal (tutorial). */

const catalog: CardCatalog = loadBuiltCatalog(realCatalog());
const idOf = new Map(createCardInstances(catalog).map((c) => [c.defId, c.id]));

function id(defId: string): string {
  const found = idOf.get(defId);
  if (found === undefined) throw new Error(`no card ${defId}`);
  return found;
}

const PRESET: CartignonMatchPreset = deepFreeze({
  p1: 1,
  hands: [
    ['C-B1', 'C-C2', 'S-15'],
    ['C-G2', 'C-B3'],
  ],
  deckTop: ['C-A5', 'S-04'],
  graveyard: ['C-E1'],
  tokens: { orange: 1, yellow: 0 },
  roundNumber: 4,
});

function start(preset: CartignonMatchPreset = PRESET): CartignonMatchState {
  const result = startPresetCartignonMatch(catalog, preset);
  if (!result.ok) throw new Error(result.message);
  return result.state;
}

describe('startPresetCartignonMatch', () => {
  it('deals the exact hands, deck order and graveyard', () => {
    const { zones } = start().round.board;
    expect(zones.hands[0]).toEqual([id('C-B1'), id('C-C2'), id('S-15')]);
    expect(zones.hands[1]).toEqual([id('C-G2'), id('C-B3')]);
    expect(zones.graveyard).toEqual([id('C-E1')]);
    expect(zones.stacks).toEqual([[], []]);
    const named = new Set(['C-B1', 'C-C2', 'S-15', 'C-G2', 'C-B3', 'C-A5', 'S-04', 'C-E1']);
    const rest = createCardInstances(catalog)
      .filter((c) => !named.has(c.defId))
      .map((c) => c.id);
    expect(zones.deck).toEqual([id('C-A5'), id('S-04'), ...rest]);
    expect(zones.deck.length + 6).toBe(catalog.length);
  });

  it('sets P1, the Base step, tokens and the round number', () => {
    const state = start();
    expect(state.round.p1).toBe(1);
    expect(state.round.phase).toEqual({ kind: 'p1Base', active: 1 });
    expect(state.roundNumber).toBe(4);
    expect(state.tokens).toEqual({
      orange: 1,
      yellow: 0,
      green: null,
      blue: null,
      indigo: null,
      violet: null,
      red: null,
    });
    expect(state.status).toEqual({ kind: 'playing' });
    expect(state.poolAfterCleanup).toBe(catalog.length - 1);
  });

  it('emits round start, both deals and the first turn', () => {
    const result = startPresetCartignonMatch(catalog, PRESET);
    if (!result.ok) throw new Error(result.message);
    expect(result.events.map((e) => e.type)).toEqual([
      'roundStarted',
      'cardsDrawn',
      'cardsDrawn',
      'turnStarted',
    ]);
  });

  it('defaults: round 1, empty graveyard, all tokens in the supply', () => {
    const state = start({ p1: 0, hands: [['C-A1'], []] });
    expect(state.roundNumber).toBe(1);
    expect(state.round.board.zones.graveyard).toEqual([]);
    expect(Object.values(state.tokens).every((t) => t === null)).toBe(true);
    expect(state.round.board.zones.deck[0]).not.toBe(id('C-A1'));
  });

  it('consumes no RNG: the snapshot rngState equals the freshly seeded state', () => {
    const rules = createCartignonRules(catalog);
    const seed = expandTestSeed(11);
    const snapshot = createMatchFromState(rules, start(), seed);
    expect(snapshot.revision).toBe(0);
    expect(snapshot.rngState).toBe(createRngFromSeedBytes(seed).getState());
    expect(snapshot.rulesVersion).toBe(rules.rulesVersion);
  });

  it('is playable through step()', () => {
    const rules = createCartignonRules(catalog);
    const snapshot = createMatchFromState(rules, start(), expandTestSeed(3));
    const action = toCartignonAction({ type: 'playCreature', cardId: id('C-G2') });
    const result = step(rules, snapshot, 1, action, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(viewFor(rules, result.snapshot, 0).phase.activeSeat).toBe(0);
  });

  it('rejects every invalid preset', () => {
    const cases: [CartignonMatchPreset, string][] = [
      [{ p1: 0, hands: [['C-Z9'], []] }, 'UNKNOWN_CARD'],
      [{ p1: 0, hands: [['C-A1'], []], graveyard: ['C-A1'] }, 'DUPLICATE_CARD'],
      [{ p1: 0, hands: [['C-A1'], ['C-A1']] }, 'DUPLICATE_CARD'],
      [
        {
          p1: 0,
          hands: [
            ['C-A1', 'C-A2', 'C-A3', 'C-A4', 'C-A5', 'C-B1', 'C-B2', 'C-B3', 'C-B4', 'C-B5'],
            [],
          ],
        },
        'HAND_TOO_LARGE',
      ],
    ];
    for (const [preset, code] of cases) {
      const result = startPresetCartignonMatch(catalog, preset);
      expect(result.ok ? null : result.code).toBe(code);
    }
    const broken = startPresetCartignonMatch([{ defId: 'X', kind: 'creature' }] as never, PRESET);
    expect(broken.ok ? null : broken.code).toBe('INVALID_CATALOG');
  });

  it('throws on an invalid round number (programmer error)', () => {
    expect(() => start({ ...PRESET, roundNumber: 0 })).toThrow(RangeError);
  });
});
