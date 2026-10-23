import {
  ClientMessage,
  ServerMessage,
  actionMessageSchema,
  cartignonActionSchema,
  type CartignonCommand,
  type RoomAdmission,
} from '@cartignon/protocol';
import { describe, expect, it } from 'vitest';
import {
  appendEventLog,
  choiceWithOptions,
  chooseSpellOptionAction,
  commandLabel,
  commandToAction,
  eventText,
  parseCartignonView,
  rendererFor,
  toggleSelection,
  validateSelection,
} from '../src/lib/cartignon';
import { MatchConnection, type GameClient, type MatchRoom } from '../src/net/matchConnection';

const matchId = '0b6f6f5e-6a4c-4c1e-9f0a-2d6a4a3c1b2e';

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing value');
  return value;
}

function parsed(input: Parameters<typeof parseCartignonView>[0]) {
  return must(parseCartignonView(input));
}

function publicView() {
  return {
    match: {
      roundNumber: 1,
      tokens: {
        orange: null,
        yellow: null,
        green: 0,
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
      phase: { kind: 'p1Base', active: 0 },
      baseLevel: null,
      turnNumber: 0,
      playedThisTurn: false,
      stackEmptiedBySpell: false,
      p1StackTouchedBySpell: false,
      turnLocks: [],
    },
    board: {
      stacks: [[], []],
      attachedEffects: [],
      attachedSpells: [],
      stackEffects: [],
      copiedModifiers: [],
      linkUp: { pending: [false, false], source: [null, null] },
      armedTraps: [],
      negatedModifiers: [],
    },
    liveModifiers: [],
    atk: [0, 0],
    handCounts: [2, 2],
    deckCount: 40,
    graveyardCount: 0,
    graveyard: [],
    lookingAt: null,
    cardDefs: { c01: 'orange-3', c02: 'spell-x' },
    defs: {
      'orange-3': { kind: 'creature', color: 'orange', level: 3, atk: 4, modifiers: ['buffSelf'] },
      'spell-x': { kind: 'spell', name: 'Gambit' },
    },
  };
}

function privateView(overrides: Record<string, unknown> = {}) {
  return {
    seat: 0,
    hand: ['c01', 'c02'],
    lookingAt: null,
    pendingChoiceView: null,
    legal: [{ type: 'playCreature', cardId: 'c01' }, { type: 'endTurn' }],
    spellHints: [{ cardId: 'c02', branch: 'primary', castable: true, reason: null }],
    ...overrides,
  };
}

function view(revision: number, events: unknown[] = [], priv = privateView()) {
  return {
    matchId,
    seat: 0,
    revision,
    rulesId: 'cartignon',
    rulesVersion: '1',
    phase: { id: 'p1Base', activeSeat: 0, turnSeat: 0 },
    public: publicView(),
    private: priv,
    events,
    outcome: null,
    clock: null,
    cause: 'action',
  };
}

describe('rulesId renderer switch', () => {
  it('maps each rulesId to its renderer', () => {
    expect(rendererFor('cartignon')).toBe('cartignon');
    expect(rendererFor('synthetic')).toBe('synthetic');
    expect(rendererFor('chess')).toBe('unsupported');
  });
});

describe('action building from legal entries', () => {
  it('moves the non-type fields into a v1 payload', () => {
    expect(commandToAction({ type: 'playCreature', cardId: 'c01' })).toEqual({
      type: 'playCreature',
      v: 1,
      payload: { cardId: 'c01' },
    });
    expect(commandToAction({ type: 'endTurn' })).toEqual({ type: 'endTurn', v: 1, payload: {} });
    const choose: CartignonCommand = {
      type: 'chooseSpellOption',
      choiceId: 3,
      selection: ['c01'],
    };
    const action = commandToAction(choose);
    expect(cartignonActionSchema.safeParse(action).success).toBe(true);
    expect(action).toEqual({
      type: 'chooseSpellOption',
      v: 1,
      payload: { choiceId: 3, selection: ['c01'] },
    });
    expect(chooseSpellOptionAction(3, ['c01'])).toEqual(action);
  });

  it('labels commands with card names', () => {
    const pub = parsed(view(1)).public;
    expect(commandLabel({ type: 'playCreature', cardId: 'c01' }, pub)).toBe(
      'Play creature c01 orange L3 ATK 4 [buffSelf]',
    );
    expect(commandLabel({ type: 'playSpell', cardId: 'c02' }, pub)).toBe(
      'Play spell c02 spell "Gambit"',
    );
  });
});

describe('choice selection validation', () => {
  const choice = { options: ['c01', 'c02', 'c03'], min: 1, max: 2 };

  it('enforces min, max, offered cards and uniqueness', () => {
    expect(validateSelection([], choice)).toBe('Select at least 1.');
    expect(validateSelection(['c01'], choice)).toBeNull();
    expect(validateSelection(['c01', 'c03'], choice)).toBeNull();
    expect(validateSelection(['c01', 'c02', 'c03'], choice)).toBe('Select at most 2.');
    expect(validateSelection(['c09'], choice)).toBe('Select only offered cards.');
    expect(validateSelection(['c01', 'c01'], choice)).toBe('A card was selected twice.');
    expect(validateSelection([], { options: [], min: 0, max: 0 })).toBeNull();
  });

  it('toggles cards in option order', () => {
    expect(toggleSelection(['c03'], 'c01', choice.options)).toEqual(['c01', 'c03']);
    expect(toggleSelection(['c01', 'c03'], 'c01', choice.options)).toEqual(['c03']);
  });

  it('exposes options only to the choosing seat', () => {
    const pending = { choiceId: 2, seat: 0, kind: 'handDiscard', spellId: 's1' };
    const mine = parsed(
      view(
        1,
        [],
        privateView({ pendingChoiceView: { ...pending, options: ['c01'], min: 0, max: 1 } }),
      ),
    );
    expect(choiceWithOptions(mine.private)).toEqual({
      choiceId: 2,
      options: ['c01'],
      min: 0,
      max: 1,
    });
    const other = parsed(
      view(
        1,
        [],
        privateView({
          pendingChoiceView: { seat: 1, kind: 'handDiscard', spellId: 's1', min: 1, max: 1 },
        }),
      ),
    );
    expect(choiceWithOptions(other.private)).toBeNull();
  });
});

describe('Cartignon view parsing and event log', () => {
  it('rejects views that break the strict schemas', () => {
    expect(parseCartignonView(view(1))).not.toBeNull();
    expect(parseCartignonView({ ...view(1), private: { ...privateView(), extra: 1 } })).toBeNull();
    expect(parseCartignonView(view(1, [{ type: 'nope' }]))).toBeNull();
  });

  it('appends only newer revisions and caps the log', () => {
    const turn = { type: 'turnStarted', seat: 0, turnNumber: 1 } as const;
    let log = appendEventLog([], 1, [turn]);
    log = appendEventLog(log, 1, [turn]);
    expect(log).toHaveLength(1);
    log = appendEventLog(log, 2, [turn, turn, turn], 3);
    expect(log.map((entry) => entry.key)).toEqual(['2:0', '2:1', '2:2']);
    expect(eventText(turn)).toBe('turnStarted seat=0 turnNumber=1');
  });
});

class FakeRoom implements MatchRoom {
  reconnection = { enabled: true };
  state: unknown = undefined;
  sent: [string, unknown][] = [];
  readonly #messages = new Map<string, (payload: unknown) => void>();
  onStateChange() {
    /* not exercised */
  }
  onMessage(type: string, callback: (payload: unknown) => void) {
    this.#messages.set(type, callback);
  }
  onError() {
    /* not exercised */
  }
  onLeave() {
    /* not exercised */
  }
  send(type: string, payload: unknown) {
    this.sent.push([type, payload]);
  }
  leave() {
    return Promise.resolve(4000);
  }
  emit(type: string, payload: unknown) {
    this.#messages.get(type)?.(payload);
  }
}

describe('MatchConnection with Cartignon views', () => {
  const admission: RoomAdmission = {
    roomId: 'room-1',
    code: 'ABCDEF',
    ticket: 'ticket-0123456789abcdef',
  } as RoomAdmission;

  async function connected() {
    const room = new FakeRoom();
    const client: GameClient = { joinById: () => Promise.resolve(room) };
    const connection = new MatchConnection(
      { getRoomTicket: () => Promise.reject(new Error()) },
      client,
    );
    await connection.connect(admission);
    return { room, connection };
  }

  it('parses views, logs events and sends actions for the last revision', async () => {
    const { room, connection } = await connected();
    room.emit(ServerMessage.View, view(4, [{ type: 'turnStarted', seat: 0, turnNumber: 1 }]));
    const snapshot = connection.getSnapshot();
    expect(snapshot.cartignon?.private.legal).toHaveLength(2);
    expect(snapshot.eventLog).toHaveLength(1);

    const legal = must(snapshot.cartignon?.private.legal[0]);
    const actionId = connection.sendAction(commandToAction(legal));
    expect(actionId).not.toBeNull();
    const [type, message] = must(room.sent[0]);
    expect(type).toBe(ClientMessage.Action);
    const parsed = actionMessageSchema.parse(message);
    expect(parsed.expectedRevision).toBe(4);
    expect(parsed.action).toEqual({ type: 'playCreature', v: 1, payload: { cardId: 'c01' } });
  });

  it('reports a view that breaks the Cartignon contract', async () => {
    const { room, connection } = await connected();
    room.emit(ServerMessage.View, { ...view(1), public: {} });
    expect(connection.getSnapshot().view).toBeNull();
    expect(connection.getSnapshot().error).toMatch(/invalid match data/);
  });
});
