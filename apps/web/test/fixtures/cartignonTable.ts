import { matchViewMessageSchema } from '@cartignon/protocol';
import { parseCartignonView } from '../../src/lib/cartignon';
import { buildTableModel, type TableModel } from '../../src/match/cartignon/tableModel';

/** A protocol-valid Cartignon view for table component tests (seat 0 receives it). */

const matchId = '0b6f6f5e-6a4c-4c1e-9f0a-2d6a4a3c1b2e';

function publicView() {
  return {
    match: {
      roundNumber: 2,
      tokens: {
        orange: 0,
        yellow: null,
        green: 1,
        blue: null,
        indigo: null,
        violet: null,
        red: null,
      },
      finalRound: false,
      replays: 0,
      status: { kind: 'playing' },
      lastOutcome: null,
    },
    round: {
      p1: 0,
      phase: { kind: 'turn', active: 0, equalEndBy: null },
      baseLevel: 3,
      turnNumber: 4,
      playedThisTurn: false,
      stackEmptiedBySpell: false,
      p1StackTouchedBySpell: false,
      turnLocks: [],
    },
    board: {
      stacks: [['c10'], ['c20', 'c21']],
      attachedEffects: [],
      attachedSpells: [],
      stackEffects: [],
      copiedModifiers: [],
      linkUp: { pending: [false, false], source: [null, null] },
      armedTraps: [],
      negatedModifiers: [],
    },
    liveModifiers: [],
    atk: [7, 9],
    handCounts: [3, 4],
    deckCount: 21,
    graveyardCount: 5,
    graveyard: ['c40', 'c41', 'c42', 'c43', 'c44'],
    lookingAt: null,
    cardDefs: {
      c01: 'orange-3',
      c02: 'spell-x',
      c03: 'blue-2',
      c10: 'orange-3',
      c20: 'blue-2',
      c21: 'orange-3',
      c40: 'spell-x',
      c41: 'blue-2',
      c42: 'orange-3',
      c43: 'blue-2',
      c44: 'orange-3',
    },
    defs: {
      'orange-3': { kind: 'creature', color: 'orange', level: 3, atk: 4, modifiers: [] },
      'blue-2': { kind: 'creature', color: 'blue', level: 2, atk: 3, modifiers: [] },
      'spell-x': { kind: 'spell', name: 'Gambit' },
    },
  };
}

export function tableModel(
  options: {
    activeSeat?: 0 | 1;
    priv?: Record<string, unknown>;
  } = {},
): TableModel {
  const activeSeat = options.activeSeat ?? 0;
  const view = matchViewMessageSchema.parse({
    matchId,
    seat: 0,
    revision: 7,
    rulesId: 'cartignon',
    rulesVersion: '1',
    phase: { id: 'turn', activeSeat, turnSeat: 0 },
    public: publicView(),
    private: {
      seat: 0,
      hand: ['c01', 'c02', 'c03'],
      lookingAt: null,
      pendingChoiceView: null,
      legal: [
        { type: 'playCreature', cardId: 'c01' },
        { type: 'nullify', cardId: 'c01' },
        { type: 'playSpell', cardId: 'c02' },
        { type: 'endTurn' },
        { type: 'mulligan' },
      ],
      spellHints: [{ cardId: 'c02', branch: 'primary', castable: true, reason: null }],
      ...options.priv,
    },
    events: [],
    outcome: null,
    clock: null,
    cause: 'action',
  });
  const parts = parseCartignonView(view);
  if (!parts) throw new Error('fixture does not match the protocol');
  return buildTableModel(view, parts, null, 0);
}
