import { matchViewMessageSchema, type MatchViewMessage } from '@cartignon/protocol';
import { describe, expect, it } from 'vitest';
import { parseCartignonView } from '../src/lib/cartignon';
import { readClock } from '../src/match/cartignon/clock';
import { buildTableModel } from '../src/match/cartignon/tableModel';

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
      stacks: [
        ['c10', 'c11'],
        ['c20', 'c21', 'c22'],
      ],
      attachedEffects: [],
      attachedSpells: [],
      stackEffects: [],
      copiedModifiers: [],
      linkUp: { pending: [false, false], source: [null, null] },
      armedTraps: [{ cardId: 'c30', seat: 1, spellId: 'S-20', dormant: false }],
      negatedModifiers: [],
    },
    liveModifiers: [{ seat: 1, cardId: 'c22', kind: 'buffSelf', position: 2 }],
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
      c11: 'blue-2',
      c20: 'blue-2',
      c21: 'orange-3',
      c22: 'blue-2',
      c30: 'spell-x',
      c40: 'spell-x',
      c41: 'blue-2',
      c42: 'orange-3',
      c43: 'blue-2',
      c44: 'orange-3',
    },
    defs: {
      'orange-3': { kind: 'creature', color: 'orange', level: 3, atk: 4, modifiers: [] },
      'blue-2': { kind: 'creature', color: 'blue', level: 2, atk: 3, modifiers: ['buffSelf'] },
      'spell-x': { kind: 'spell', name: 'Gambit' },
    },
  };
}

function privateView(overrides: Record<string, unknown> = {}) {
  return {
    seat: 0,
    hand: ['c01', 'c02', 'c03'],
    lookingAt: null,
    pendingChoiceView: null,
    legal: [
      { type: 'playCreature', cardId: 'c01' },
      // RD-173: a card that can Nullify has Nullify as its only command.
      { type: 'nullify', cardId: 'c03' },
      { type: 'playSpell', cardId: 'c02' },
      { type: 'endTurn' },
      { type: 'mulligan' },
    ],
    spellHints: [{ cardId: 'c02', branch: 'primary', castable: true, reason: null }],
    ...overrides,
  };
}

function build(options: {
  seat?: 0 | 1;
  activeSeat?: 0 | 1 | null;
  turnSeat?: 0 | 1 | null;
  priv?: Record<string, unknown>;
  clock?: MatchViewMessage['clock'];
  /** Adjusts the public view before parsing. */
  mutate?: (pub: ReturnType<typeof publicView>) => void;
}) {
  const seat = options.seat ?? 0;
  const pub = publicView();
  options.mutate?.(pub);
  const view = matchViewMessageSchema.parse({
    matchId,
    seat,
    revision: 7,
    rulesId: 'cartignon',
    rulesVersion: '1',
    phase: {
      id: 'turn',
      activeSeat: options.activeSeat === undefined ? 0 : options.activeSeat,
      turnSeat: options.turnSeat === undefined ? 0 : options.turnSeat,
    },
    public: pub,
    private: privateView({ seat, ...options.priv }),
    events: [],
    outcome: null,
    clock: options.clock ?? null,
    cause: 'action',
  });
  const parts = parseCartignonView(view);
  if (!parts) throw new Error('fixture does not match the protocol');
  const clock = readClock(view.clock, 0, 0, seat);
  return buildTableModel(view, parts, clock, seat);
}

describe('buildTableModel', () => {
  it('describes my turn with own and opponent areas', () => {
    const model = build({});
    expect(model).toMatchObject({
      mySeat: 0,
      opponentSeat: 1,
      onTurn: 'mine',
      activeSeat: 0,
      myAction: true,
      finished: false,
      myChoice: null,
      opponentChoosing: null,
      clock: null,
    });
    expect(model.me).toMatchObject({ seat: 0, side: 'mine', handCount: 3, atk: 7 });
    expect(model.opponent).toMatchObject({ seat: 1, side: 'theirs', handCount: 4, atk: 9 });
    // Stacks are bottom to top: the top card is last.
    expect(model.opponent.stack.map((card) => [card.cardId, card.position])).toEqual([
      ['c20', 0],
      ['c21', 1],
      ['c22', 2],
    ]);
    expect(model.me.stack[1]).toMatchObject({ cardId: 'c11', color: 'blue' });
    expect(model.opponent.armedTrapCount).toBe(1);
    expect(model.opponent.traps[0]).toMatchObject({ cardId: 'c30', spellId: 'S-20', color: null });
    expect(model.me.armedTrapCount).toBe(0);
  });

  it("describes the opponent's turn from the other seat", () => {
    const model = build({ seat: 1, priv: { legal: [] } });
    expect(model.onTurn).toBe('theirs');
    expect(model.myAction).toBe(false);
    expect(model.me.seat).toBe(1);
    expect(model.opponent.seat).toBe(0);
    expect(model.hand.every((card) => card.commands.length === 0)).toBe(true);
    expect(model.globalCommands).toEqual([]);
  });

  it('builds the center with token owners and live modifiers', () => {
    const { center } = build({});
    expect(center).toMatchObject({
      round: 2,
      turn: 4,
      deckCount: 21,
      graveyardCount: 5,
      phaseKind: 'turn',
    });
    expect(center.tokens).toHaveLength(7);
    expect(center.tokens.find((token) => token.color === 'orange')).toEqual({
      color: 'orange',
      owner: 0,
      side: 'mine',
    });
    expect(center.tokens.find((token) => token.color === 'green')?.side).toBe('theirs');
    expect(center.tokens.find((token) => token.color === 'red')).toEqual({
      color: 'red',
      owner: null,
      side: null,
    });
    expect(center.liveModifiers).toEqual([
      { seat: 1, side: 'theirs', cardId: 'c22', kind: 'buffSelf', position: 2 },
    ]);
  });

  it('maps legal card commands to hand cards and keeps global ones apart', () => {
    const model = build({});
    const [c01, c02, c03] = model.hand;
    expect(c01?.commands.map((ref) => [ref.index, ref.command.type])).toEqual([
      [0, 'playCreature'],
    ]);
    expect(c01?.label).toBe('c01 orange L3 ATK 4');
    expect(c02?.commands.map((ref) => ref.command.type)).toEqual(['playSpell']);
    expect(c02?.color).toBeNull();
    expect(c03?.commands.map((ref) => [ref.index, ref.command.type])).toEqual([[1, 'nullify']]);
    expect(model.globalCommands.map((ref) => [ref.index, ref.command.type])).toEqual([
      [3, 'endTurn'],
      [4, 'mulligan'],
    ]);
    expect(model.otherCardCommands).toEqual([]);
  });

  it('lists mulligan as a global command and keeps card commands for unknown hand cards', () => {
    const model = build({
      priv: { legal: [{ type: 'mulligan' }, { type: 'playCreature', cardId: 'c40' }] },
    });
    expect(model.globalCommands.map((ref) => ref.command.type)).toEqual(['mulligan']);
    expect(model.otherCardCommands.map((ref) => ref.index)).toEqual([1]);
  });

  it('builds my choice from pendingChoiceView options, not from legal', () => {
    const model = build({
      priv: {
        pendingChoiceView: {
          choiceId: 5,
          seat: 0,
          kind: 'enemyCreature',
          spellId: 'S-04',
          options: ['c20', 'c22'],
          min: 1,
          max: 1,
        },
        legal: [
          { type: 'chooseSpellOption', choiceId: 5, selection: ['c20'] },
          { type: 'chooseSpellOption', choiceId: 5, selection: ['c22'] },
        ],
      },
    });
    expect(model.myChoice).toMatchObject({
      choiceId: 5,
      kind: 'enemyCreature',
      spellId: 'S-04',
      min: 1,
      max: 1,
    });
    expect(model.myChoice?.options.map((card) => card.cardId)).toEqual(['c20', 'c22']);
    expect(model.myChoice?.options[1]?.label).toBe('c22 blue L2 ATK 3 [buffSelf]');
    // Choice answers never show up as global or card commands.
    expect(model.globalCommands).toEqual([]);
    expect(model.hand.every((card) => card.commands.length === 0)).toBe(true);
    expect(model.opponentChoosing).toBeNull();
  });

  it('builds a handCreature choice from the options the chooser receives', () => {
    const model = build({
      priv: {
        pendingChoiceView: {
          choiceId: 9,
          seat: 0,
          kind: 'handCreature',
          spellId: 'S-05',
          options: ['c01', 'c03'],
          min: 1,
          max: 1,
        },
        legal: [{ type: 'chooseSpellOption', choiceId: 9, selection: ['c01'] }],
      },
    });
    expect(model.myChoice?.kind).toBe('handCreature');
    // Only the offered cards: the hand's spell c02 is not synthesized into the options.
    expect(model.myChoice?.options.map((card) => card.cardId)).toEqual(['c01', 'c03']);
  });

  it('shows the opponent choosing a hidden-count handCreature choice', () => {
    const model = build({
      activeSeat: 1,
      turnSeat: 0,
      priv: {
        pendingChoiceView: { seat: 1, kind: 'handCreature', spellId: 'S-05', min: 1, max: 1 },
        legal: [],
      },
    });
    expect(model.onTurn).toBe('mine');
    expect(model.activeSeat).toBe(1);
    expect(model.myAction).toBe(false);
    expect(model.myChoice).toBeNull();
    expect(model.opponentChoosing).toEqual({
      seat: 1,
      kind: 'handCreature',
      spellId: 'S-05',
      min: 1,
      max: 1,
      optionCount: null,
    });
  });

  it('passes an opponent option count through when the kind reveals it', () => {
    const model = build({
      activeSeat: 1,
      priv: {
        pendingChoiceView: {
          seat: 1,
          kind: 'keepDrawn',
          spellId: 'S-01',
          optionCount: 3,
          min: 1,
          max: 2,
        },
        legal: [],
      },
    });
    expect(model.opponentChoosing?.optionCount).toBe(3);
  });

  it('handles clock: null and passes a clock reading through', () => {
    expect(build({ clock: null }).clock).toBeNull();
    const model = build({
      clock: {
        seat: 1,
        mode: 'choice',
        running: true,
        remainingMs: 5000,
        deadline: 105_000,
        serverTime: 100_000,
        pauseLeftMs: [180_000, 180_000],
        consecutiveTimeouts: [0, 0],
      },
    });
    expect(model.clock).toMatchObject({ seat: 1, mode: 'choice', isMine: false, warn: true });
  });

  it('reports no turn when the phase has no turn seat', () => {
    const model = build({ activeSeat: null, turnSeat: null, priv: { legal: [] } });
    expect(model.onTurn).toBeNull();
    expect(model.activeSeat).toBeNull();
    expect(model.myAction).toBe(false);
  });

  it('lists the shared graveyard oldest first with card summaries (RD-170)', () => {
    const { center } = build({});
    expect(center.graveyard.map((card) => card.cardId)).toEqual([
      'c40',
      'c41',
      'c42',
      'c43',
      'c44',
    ]);
    expect(center.graveyard[0]?.summary).toEqual({ kind: 'spell', name: 'Gambit' });
    expect(center.graveyard[1]?.color).toBe('blue');
  });

  it('passes spell hints through to hand spells only (RD-171)', () => {
    const model = build({
      priv: {
        spellHints: [
          { cardId: 'c02', branch: 'secondary', castable: false, reason: 'NOT_YOUR_TURN' },
        ],
      },
    });
    const [c01, c02] = model.hand;
    expect(c01?.spellHint).toBeNull();
    expect(c02?.spellHint).toEqual({
      branch: 'secondary',
      castable: false,
      reason: 'NOT_YOUR_TURN',
    });
  });

  it('builds the round-over view from this seat (RD-169)', () => {
    const model = build({
      seat: 1,
      mutate: (pub) => {
        Object.assign(pub.round, {
          phase: { kind: 'roundOver', reason: 'opponentAhead', seat: 0, atk: [5, 9] },
        });
      },
    });
    expect(model.center.roundOver).toEqual({
      reason: 'opponentAhead',
      endedBy: 'theirs',
      iAmP1: false,
      atk: [9, 5],
    });
    expect(model.center.phaseKind).toBe('roundOver');
  });

  it('maps the last round outcome to sides and own-first ATK', () => {
    const model = build({
      mutate: (pub) => {
        Object.assign(pub.match, {
          lastOutcome: {
            kind: 'win',
            winner: 1,
            decidedBy: 'tieBreak',
            atk: [6, 8],
            tieBreakIterations: 2,
          },
        });
      },
    });
    expect(model.center.lastOutcome).toEqual({
      kind: 'win',
      winner: 'theirs',
      decidedBy: 'tieBreak',
      atk: [6, 8],
      tieBreakIterations: 2,
    });
    expect(model.center.roundOver).toBeNull();
  });
});
