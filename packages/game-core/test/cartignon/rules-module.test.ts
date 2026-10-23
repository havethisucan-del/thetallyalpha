import {
  cartignonActionSchema,
  cartignonPrivateViewSchema,
  cartignonPublicViewSchema,
  cartignonSeatEventsSchema,
  matchViewMessageSchema,
} from '@cartignon/protocol';
import { describe, expect, it } from 'vitest';
import {
  createMatch,
  createSeededRng,
  expandTestSeed,
  eventsFor,
  forfeitMatch,
  step,
  stepTimeout,
  viewFor,
  type StepResult,
  type GameAction,
  type Seat,
  type SeatView,
  type Snapshot,
} from '../../src/index.js';
import {
  CARTIGNON_RULES_VERSION,
  InvalidCatalogError,
  applyMatchCommand,
  createCartignonRules,
  createTokenSupply,
  projectCartignonEvents,
  startCartignonMatch,
  toCartignonAction,
  type Board,
  type CardCatalog,
  type CardId,
  type CartignonMatchState,
  type CartignonPrivateView,
  type CartignonPublicView,
  type CartignonRules,
  type MatchEvent,
  type RoundCommand,
  type RoundState,
} from '../../src/cartignon/index.js';
import { realCatalog } from './self-play.js';
import {
  catalog as kitCatalog,
  catalogWithModifiers,
  cr,
  ps,
  spell,
  stateOf,
} from './spell-kit.js';
import { deepFreeze } from './test-fixtures.js';

// R6: the Cartignon RulesModule adapter, per-seat projection and event redaction
// (docs/tasks/r6-cartignon-integration.md "Hidden information").

const other = (seat: Seat): Seat => (seat === 0 ? 1 : 0);
const choose = (choiceId: number, selection: readonly CardId[]): RoundCommand => ({
  type: 'chooseSpellOption',
  choiceId,
  selection,
});

const kitRules = createCartignonRules(kitCatalog);

function matchOf(round: RoundState): CartignonMatchState {
  return deepFreeze({
    round,
    roundNumber: 2,
    tokens: createTokenSupply(),
    finalRound: false,
    replays: 0,
    poolAfterCleanup: 54,
    roundsWithoutProgress: 0,
    lastOutcome: null,
    status: { kind: 'playing' },
  });
}

function snapshotOf(rules: CartignonRules, round: RoundState, revision = 5): Snapshot {
  return {
    rulesId: rules.rulesId,
    rulesVersion: rules.rulesVersion,
    revision,
    rngState: '0123456789abcdef0123456789abcdef',
    state: matchOf(round),
  };
}

function mustStep(rules: CartignonRules, s: Snapshot, seat: Seat, command: RoundCommand) {
  const result = step(rules, s, seat, toCartignonAction(command), s.revision);
  if (!result.ok) throw new Error(`unexpected rejection ${result.code} ${result.reason ?? ''}`);
  return result;
}

const pub = (v: SeatView) => v.public as CartignonPublicView;
const priv = (v: SeatView) => v.private as CartignonPrivateView;

describe('createCartignonRules', () => {
  it('identifies itself with a catalog fingerprint in rulesVersion', () => {
    const { catalog } = realCatalog();
    const rules = createCartignonRules(catalog);
    expect(rules.rulesId).toBe('cartignon');
    expect(rules.rulesVersion).toMatch(
      new RegExp(`^${CARTIGNON_RULES_VERSION}\\+cards\\.[0-9a-f]{8}$`),
    );
    expect(createCartignonRules(catalog).rulesVersion).toBe(rules.rulesVersion);
    expect(kitRules.rulesVersion).not.toBe(rules.rulesVersion);
  });

  it('throws at construction for an invalid catalog', () => {
    const broken: CardCatalog = kitCatalog.map((d) =>
      d.defId === 'S-01' ? { ...d, defId: 'S-99' } : d,
    );
    expect(() => createCartignonRules(broken)).toThrow(InvalidCatalogError);
  });
});

describe('determinism via createMatch / step', () => {
  const { catalog, ctx } = realCatalog();
  const rules = createCartignonRules(catalog);

  function run(seed: number, steps: number) {
    const bot = createSeededRng(seed + 1);
    let s = createMatch(rules, { options: {} }, expandTestSeed(seed));
    const commands: { seat: Seat; command: RoundCommand }[] = [];
    const seen: unknown[] = [];
    for (let i = 0; i < steps; i++) {
      const phase = rules.getPhase(s.state as CartignonMatchState);
      if (phase.activeSeat === null) break;
      const legal = priv(viewFor(rules, s, phase.activeSeat)).legal;
      const command = legal[bot.nextInt(legal.length)] as RoundCommand;
      const result = mustStep(rules, s, phase.activeSeat, command);
      commands.push({ seat: phase.activeSeat, command });
      seen.push(eventsFor(rules, result.events, 0), eventsFor(rules, result.events, 1));
      s = result.snapshot;
    }
    return { s, commands, seen };
  }

  it('same seed and actions give identical snapshots and events', () => {
    expect(run(21, 150)).toEqual(run(21, 150));
  });

  it('matches the match layer driven with one continuous RNG (RNG state persists)', () => {
    const { s, commands } = run(8, 150);
    const rng = createSeededRng(8);
    const started = startCartignonMatch(catalog, rng);
    if (!started.ok) throw new Error(started.code);
    let match = started.state;
    for (const { seat, command } of commands) {
      const r = applyMatchCommand(ctx, match, seat, command, rng);
      if (!r.ok) throw new Error(r.code);
      match = r.state;
    }
    expect(s.state).toEqual(JSON.parse(JSON.stringify(match)));
    expect(s.rngState).toBe(rng.getState());
    expect(s.revision).toBe(commands.length);
  });
});

describe('step contract', () => {
  const { catalog } = realCatalog();
  const rules = createCartignonRules(catalog);
  const s0 = createMatch(rules, { options: {} }, expandTestSeed(3));
  const phase0 = rules.getPhase(s0.state as CartignonMatchState);
  const seat = phase0.activeSeat as Seat;
  const legal0 = priv(viewFor(rules, s0, seat)).legal;

  it('initial phase: P1 Base step, acting seat = turn seat, no events on join', () => {
    expect(phase0.id).toBe('p1Base');
    expect(phase0.turnSeat).toBe(seat);
    expect(legal0.length).toBeGreaterThan(0);
    expect(priv(viewFor(rules, s0, other(seat))).legal).toEqual([]);
  });

  it('rejects a stale expectedRevision before anything else', () => {
    const action = toCartignonAction(legal0[0] as RoundCommand);
    const before = JSON.stringify(s0);
    expect(step(rules, s0, seat, action, 1)).toMatchObject({ ok: false, code: 'STALE_REVISION' });
    expect(step(rules, s0, other(seat), { type: 'x', v: 9, payload: 1 }, 7)).toMatchObject({
      code: 'STALE_REVISION',
    });
    expect(JSON.stringify(s0)).toBe(before);
    const ok = step(rules, s0, seat, action, 0);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(step(rules, ok.snapshot, seat, action, 0)).toMatchObject({ code: 'STALE_REVISION' });
    }
  });

  it('maps validation: NOT_YOUR_TURN passes through, rule violations are ILLEGAL + reason', () => {
    const action = toCartignonAction(legal0[0] as RoundCommand);
    expect(step(rules, s0, other(seat), action, 0)).toMatchObject({
      ok: false,
      code: 'NOT_YOUR_TURN',
    });
    const state = s0.state as CartignonMatchState;
    const foreign = state.round.board.zones.hands[other(seat)][0] as CardId;
    expect(
      step(rules, s0, seat, toCartignonAction({ type: 'playCreature', cardId: foreign }), 0),
    ).toMatchObject({ ok: false, code: 'ILLEGAL', reason: 'CARD_NOT_IN_HAND' });
    expect(step(rules, s0, seat, toCartignonAction({ type: 'endTurn' }), 0)).toMatchObject({
      code: 'ILLEGAL',
      reason: 'END_TURN_NOT_ALLOWED',
    });
  });

  it('parses actions strictly', () => {
    const malformed: unknown[] = [
      { type: 'playCreature', v: 1, payload: {} },
      { type: 'playCreature', v: 1, payload: { cardId: 'c1' } },
      { type: 'playCreature', v: 1, payload: { cardId: 'c01', extra: 1 } },
      { type: 'playCreature', v: 1, payload: null },
      { type: 'playCreature', v: 1, payload: ['c01'] },
      { type: 'playCreature', v: 1, payload: { cardId: 'c01' }, extra: true },
      { type: 'endTurn', v: 1, payload: { now: true } },
      { type: 'endTurn', v: 1 },
      { type: 'fold', v: 1, payload: {} }, // RD-169: Fold no longer exists
      { type: 'teleport', v: 1, payload: {} },
      { type: 'chooseSpellOption', v: 1, payload: { choiceId: 1.5, selection: [] } },
      { type: 'chooseSpellOption', v: 1, payload: { choiceId: -1, selection: [] } },
      { type: 'chooseSpellOption', v: 1, payload: { choiceId: 1, selection: ['x'] } },
      { type: 'chooseSpellOption', v: 1, payload: { choiceId: 1, selection: 'c01' } },
      {
        type: 'chooseSpellOption',
        v: 1,
        payload: { choiceId: 1, selection: Array.from({ length: 55 }, () => 'c01') },
      },
    ];
    for (const input of malformed) {
      expect(rules.parseAction(input as GameAction), JSON.stringify(input)).toMatchObject({
        ok: false,
        code: 'MALFORMED',
      });
      expect(cartignonActionSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
    expect(rules.parseAction({ type: 'endTurn', v: 2, payload: {} })).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_VERSION',
    });
    const commands: RoundCommand[] = [
      { type: 'playCreature', cardId: 'c01' },
      { type: 'nullify', cardId: 'c02' },
      { type: 'playSpell', cardId: 'c54' },
      { type: 'mulligan' },
      { type: 'endTurn' },
      choose(3, ['c01', 'c02']),
    ];
    for (const command of commands) {
      const action = toCartignonAction(command);
      expect(rules.parseAction(action)).toEqual({ ok: true, value: action });
      expect(cartignonActionSchema.parse(action)).toEqual(action);
    }
  });
});

describe('redaction of each hidden-information event kind', () => {
  const ids: CardId[] = ['c01', 'c02'];
  const hidden: MatchEvent[] = [
    { type: 'cardsDrawn', seat: 0, reason: 'refill', cardIds: ids },
    { type: 'cardsDrawn', seat: 0, reason: 'spellGraveyard', cardIds: ids },
    { type: 'cardsLookedAt', seat: 0, cardIds: ids },
    { type: 'lookedAtSettled', seat: 0, kept: ['c01'], returned: ['c02'], deckShuffled: true },
    { type: 'spellChoiceMade', seat: 0, choiceId: 4, kind: 'keepDrawn', selection: ['c01'] },
    { type: 'spellChoiceMade', seat: 0, choiceId: 5, kind: 'handToDeck', selection: ids },
    { type: 'handCardsReturned', seat: 0, cardIds: ids },
  ];
  const publicEvents: MatchEvent[] = [
    { type: 'spellChoiceMade', seat: 0, choiceId: 6, kind: 'handDiscard', selection: ids },
    { type: 'spellChoiceMade', seat: 0, choiceId: 7, kind: 'handCreature', selection: ['c01'] },
    { type: 'cardsDiscarded', seat: 0, cardIds: ids },
    { type: 'gambitDrawn', seat: 0, cardId: 'c54', drawnCardId: 'c01', drawnKind: 'creature' },
    { type: 'trapArmed', seat: 0, cardId: 'c47', spellId: 'S-12', dormant: true },
    { type: 'mulliganed', seat: 0, returned: 5, drawnCount: 4 },
  ];

  it('the seat the event is about sees ids; the other seat sees counts only', () => {
    expect(projectCartignonEvents(hidden, 0)).toEqual(hidden);
    expect(projectCartignonEvents(hidden, 1)).toEqual([
      { type: 'cardsDrawn', seat: 0, reason: 'refill', count: 2 },
      { type: 'cardsDrawn', seat: 0, reason: 'spellGraveyard', count: 2 },
      { type: 'cardsLookedAt', seat: 0, count: 2 },
      { type: 'lookedAtSettled', seat: 0, keptCount: 1, returnedCount: 1, deckShuffled: true },
      { type: 'spellChoiceMade', seat: 0, choiceId: 4, kind: 'keepDrawn', selectionCount: 1 },
      { type: 'spellChoiceMade', seat: 0, choiceId: 5, kind: 'handToDeck', selectionCount: 2 },
      { type: 'handCardsReturned', seat: 0, count: 2 },
    ]);
    for (const seat of [0, 1] as const) {
      expect(cartignonSeatEventsSchema.parse(projectCartignonEvents(hidden, seat))).toHaveLength(7);
    }
  });

  it('public events are copied unchanged for both seats (copies, not shared objects)', () => {
    for (const seat of [0, 1] as const) {
      const out = projectCartignonEvents(publicEvents, seat);
      expect(out).toEqual(publicEvents);
      expect(out[0]).not.toBe(publicEvents[0]);
      expect(cartignonSeatEventsSchema.parse(out)).toEqual(out);
    }
  });
});

describe('S-01 keepDrawn through the RulesModule', () => {
  const Y1 = cr('yellow', 1);
  const Y2 = cr('yellow', 2);
  const Y3 = cr('yellow', 3);
  const round = stateOf({
    hands: [[spell(1), cr('red', 5)], [cr('violet', 1)]],
    stacks: [[cr('red', 1), cr('red', 2), cr('red', 3)], [cr('blue', 1)]],
    deck: [Y1, Y2, Y3],
  });
  const s0 = snapshotOf(kitRules, round);
  const played = mustStep(kitRules, s0, 0, ps(spell(1)));
  const s1 = played.snapshot;

  it('the looking seat sees the cards; the opponent sees counts', () => {
    expect(eventsFor(kitRules, played.events, 0)).toContainEqual({
      type: 'cardsLookedAt',
      seat: 0,
      cardIds: [Y1, Y2],
    });
    const theirs = eventsFor(kitRules, played.events, 1);
    expect(theirs).toContainEqual({ type: 'cardsLookedAt', seat: 0, count: 2 });
    expect(JSON.stringify(theirs)).not.toMatch(new RegExp(`${Y1}|${Y2}`));
    expect(theirs).toContainEqual(
      expect.objectContaining({ type: 'spellChoiceRequested', kind: 'keepDrawn', optionCount: 2 }),
    );
  });

  it('views: phase choosing, own ids for the chooser, counts and no options for the opponent', () => {
    const mine = viewFor(kitRules, s1, 0);
    const theirs = viewFor(kitRules, s1, 1);
    expect(mine.phase).toEqual({ id: 'choosing', activeSeat: 0, turnSeat: 0, turnKey: '2.3' });
    expect(pub(mine)).toEqual(pub(theirs));
    expect(pub(mine).lookingAt).toEqual({ seat: 0, count: 2 });
    expect(priv(mine).lookingAt).toEqual([Y1, Y2]);
    expect(priv(mine).pendingChoiceView).toEqual({
      choiceId: 1,
      seat: 0,
      kind: 'keepDrawn',
      spellId: 'S-01',
      options: [Y1, Y2],
      min: 1,
      max: 1,
    });
    expect(priv(mine).legal).toEqual([choose(1, [Y1]), choose(1, [Y2])]);
    expect(priv(theirs)).toEqual({
      seat: 1,
      hand: [cr('violet', 1)],
      lookingAt: null,
      pendingChoiceView: {
        seat: 0,
        kind: 'keepDrawn',
        spellId: 'S-01',
        optionCount: 2,
        min: 1,
        max: 1,
      },
      legal: [],
      spellHints: [],
    });
    const visible = { ...pub(theirs), cardDefs: {} };
    expect(JSON.stringify([visible, theirs.private])).not.toMatch(new RegExp(`${Y1}|${Y2}|${Y3}`));
  });

  it('the answer: selection and settle redacted for the opponent', () => {
    const done = mustStep(kitRules, s1, 0, choose(1, [Y2]));
    const theirs = eventsFor(kitRules, done.events, 1);
    expect(theirs).toContainEqual({
      type: 'spellChoiceMade',
      seat: 0,
      choiceId: 1,
      kind: 'keepDrawn',
      selectionCount: 1,
    });
    expect(theirs).toContainEqual(
      expect.objectContaining({ type: 'lookedAtSettled', keptCount: 1, returnedCount: 1 }),
    );
    expect(JSON.stringify(theirs)).not.toMatch(new RegExp(`${Y1}|${Y2}`));
    expect(eventsFor(kitRules, done.events, 0)).toContainEqual(
      expect.objectContaining({ type: 'lookedAtSettled', kept: [Y2], returned: [Y1] }),
    );
    expect(viewFor(kitRules, done.snapshot, 0).phase.id).toBe('turn');
  });
});

describe('handCreature choice (RD-142) through the RulesModule', () => {
  const rules = createCartignonRules(
    catalogWithModifiers([['green', 2, ['buffSelf', 'drawDeck']]]),
  );
  const Y2 = cr('yellow', 2);
  const G2 = cr('green', 2);
  const round = stateOf({
    hands: [[spell(10), Y2, cr('red', 5), G2], [cr('violet', 1)]],
    stacks: [[cr('red', 1), cr('red', 2)], [cr('blue', 1)]],
    deck: [cr('yellow', 1), cr('yellow', 3)],
  });
  const played = mustStep(rules, snapshotOf(rules, round), 0, ps(spell(10)));

  it('the option count is hidden from the opponent in the view and the event', () => {
    const theirs = viewFor(rules, played.snapshot, 1);
    expect(priv(theirs).pendingChoiceView).toEqual({
      seat: 0,
      kind: 'handCreature',
      spellId: 'S-10',
      min: 1,
      max: 1,
    });
    const requested = eventsFor(rules, played.events, 1).find(
      (e) => (e as MatchEvent).type === 'spellChoiceRequested',
    );
    expect(requested).toBeDefined();
    expect(requested).not.toHaveProperty('optionCount');
    expect(priv(viewFor(rules, played.snapshot, 0)).pendingChoiceView).toMatchObject({
      options: [Y2, G2],
    });
  });

  it('a modifier draw after the choice is redacted for the opponent', () => {
    const done = mustStep(rules, played.snapshot, 0, choose(1, [G2]));
    const theirs = eventsFor(rules, done.events, 1);
    expect(theirs).toContainEqual({
      type: 'cardsDrawn',
      seat: 0,
      reason: 'modifierDeck',
      count: 1,
    });
    // The placed creature is public: the handCreature selection is not redacted.
    expect(theirs).toContainEqual(
      expect.objectContaining({ type: 'spellChoiceMade', kind: 'handCreature', selection: [G2] }),
    );
  });
});

describe('acting seat differs from the turn seat (S-19, RD-160)', () => {
  const S19 = spell(19);
  const S11 = spell(11);
  const R1 = cr('red', 1);
  const R2 = cr('red', 2);
  const base = stateOf({ hands: [[S19], []], stacks: [[R1, R2], [cr('blue', 1)]] });
  // Exactly S-11 in the graveyard (taken out of the deck).
  const z = base.board.zones;
  const board: Board = {
    ...base.board,
    zones: { ...z, deck: z.deck.filter((c) => c !== S11), graveyard: [S11] },
  };
  const round = deepFreeze({ ...base, board });
  const played = mustStep(kitRules, snapshotOf(kitRules, round), 0, ps(S19));

  it('the nested spell caster answers while it is still the S-19 caster turn', () => {
    const s1 = played.snapshot;
    const phase = viewFor(kitRules, s1, 0).phase;
    expect(phase).toEqual({ id: 'choosing', activeSeat: 1, turnSeat: 0, turnKey: '2.3' });
    expect(priv(viewFor(kitRules, s1, 0)).legal).toEqual([]);
    const legal = priv(viewFor(kitRules, s1, 1)).legal;
    expect(legal).toEqual([choose(1, [R1]), choose(1, [R2])]);
    expect(
      step(kitRules, s1, 0, toCartignonAction(legal[0] as RoundCommand), s1.revision),
    ).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });
    expect(
      step(kitRules, s1, 0, toCartignonAction({ type: 'endTurn' }), s1.revision),
    ).toMatchObject({ ok: false, code: 'ILLEGAL', reason: 'CHOICE_PENDING' });
    const done = mustStep(kitRules, s1, 1, legal[0] as RoundCommand);
    expect(viewFor(kitRules, done.snapshot, 0).phase).toMatchObject({ activeSeat: 1, turnSeat: 1 });
  });
});

// ---------------------------------------------------------------------------------------------
// Leak sweep: seeded matches with the real catalog, through the RulesModule.

const FORBIDDEN_KEYS = new Set([
  'continuation',
  'scratch',
  'rngState',
  'pendingChoice',
  'nextChoiceId',
  'nextEffectSeq',
]);

/** Every string value and every key in `value`, skipping the subtree under `skipKey`. */
function collect(value: unknown, strings: Set<string>, keys: Set<string>, skipKey?: string): void {
  if (typeof value === 'string') strings.add(value);
  else if (Array.isArray(value)) for (const v of value) collect(v, strings, keys, skipKey);
  else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      keys.add(k);
      if (k !== skipKey) collect(v, strings, keys, skipKey);
    }
  }
}

function findPath(value: unknown, needle: string, at: string): string {
  if (value === needle) return at;
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'cardDefs') continue;
      const found = findPath(v, needle, `${at}.${k}`);
      if (found !== '') return found;
    }
  }
  return '';
}

/** Card ids `viewer` must not learn from a view of `match`. */
function hiddenFrom(match: CartignonMatchState, viewer: Seat): Set<CardId> {
  const { board, pendingChoice } = match.round;
  const opp = other(viewer);
  const out = new Set<CardId>([
    // RD-170: the graveyard is public (ordered list in the public view).
    ...board.zones.deck,
    ...board.zones.hands[opp],
  ]);
  if (board.lookingAt?.seat === opp) for (const id of board.lookingAt.cardIds) out.add(id);
  if (
    pendingChoice?.seat === opp &&
    pendingChoice.kind !== 'enemyCreature' &&
    pendingChoice.kind !== 'ownCreature'
  ) {
    for (const id of pendingChoice.options) out.add(id);
  }
  // RD-117: a replay lock names a creature that left the field publicly (S-09 returned it to its
  // owner's hand); the lock is public by design, so that id is known.
  for (const lock of match.round.turnLocks ?? []) out.delete(lock.cardId);
  // Effects name the spell that made them (`sourceCardId`); that spell was played publicly
  // (`spellPlayed` + `spellResolved` to the graveyard), so the id is public.
  for (const e of [...board.stackEffects, ...board.copiedModifiers, ...board.attachedEffects]) {
    out.delete(e.sourceCardId);
  }
  return out;
}

/** Ids an event makes public by design (played, placed, discarded or drawn into play). */
function revealedBy(events: readonly MatchEvent[]): Set<CardId> {
  const out = new Set<CardId>();
  for (const e of events) {
    switch (e.type) {
      case 'creaturePlayed':
      case 'nullified':
      case 'creatureStacked':
      case 'creatureLinked':
      case 'controlTaken':
      case 'spellPlayed':
      case 'trapArmed':
        out.add(e.cardId);
        break;
      case 'gambitDrawn':
        if (e.drawnCardId !== undefined) out.add(e.drawnCardId);
        break;
      case 'cardsDiscarded':
        for (const id of e.cardIds) out.add(id);
        break;
      default:
        break;
    }
  }
  return out;
}

const HIDDEN_FIELDS: Readonly<Record<string, readonly string[]>> = {
  cardsDrawn: ['cardIds'],
  cardsLookedAt: ['cardIds'],
  lookedAtSettled: ['kept', 'returned'],
  handCardsReturned: ['cardIds'],
};

describe('leak sweep: seeded self-play through the RulesModule (real catalog)', () => {
  const { catalog } = realCatalog();
  const rules = createCartignonRules(catalog);
  const SEEDS = 12;
  const MAX_STEPS = 2_500;

  function checkView(view: SeatView, match: CartignonMatchState, seat: Seat, where: string): void {
    const strings = new Set<string>();
    const keys = new Set<string>();
    // `cardDefs` lists every instance id by design (ids are public, catalog order).
    collect(view, strings, keys, 'cardDefs');
    for (const key of keys) expect(FORBIDDEN_KEYS.has(key), `${where}: key ${key}`).toBe(false);
    for (const id of hiddenFrom(match, seat)) {
      if (strings.has(id)) {
        const path = findPath(view, id, '');
        expect.fail(`${where}: view leaks ${id} at ${path}`);
      }
    }
  }

  function checkEvents(
    seatEvents: readonly unknown[],
    raw: readonly MatchEvent[],
    before: CartignonMatchState,
    after: CartignonMatchState,
    seat: Seat,
    where: string,
  ): void {
    const pre = hiddenFrom(before, seat);
    const post = hiddenFrom(after, seat);
    const revealed = revealedBy(raw);
    const strings = new Set<string>();
    const keys = new Set<string>();
    collect(seatEvents, strings, keys);
    for (const key of keys) expect(FORBIDDEN_KEYS.has(key), `${where}: key ${key}`).toBe(false);
    for (const id of strings) {
      if (pre.has(id) && post.has(id) && !revealed.has(id)) {
        expect.fail(
          `${where}: events leak ${id} (hidden before and after the step): ${JSON.stringify(seatEvents)}`,
        );
      }
    }
    for (const e of seatEvents as readonly Record<string, unknown>[]) {
      if (e['seat'] === seat) continue;
      const type = e['type'] as string;
      const fields =
        type === 'spellChoiceMade' && (e['kind'] === 'keepDrawn' || e['kind'] === 'handToDeck')
          ? ['selection']
          : (HIDDEN_FIELDS[type] ?? []);
      for (const f of fields) expect(e, `${where}: ${type}.${f}`).not.toHaveProperty(f);
    }
  }

  it(`${SEEDS} matches: no hidden id, forbidden key or unredacted event reaches the other seat; views and events match the protocol schemas`, () => {
    let finished = 0;
    let totalSteps = 0;
    let maxEvents = 0;
    let timeouts = 0;
    let forfeits = 0;
    const kinds = new Set<string>();
    for (let seed = 1; seed <= SEEDS; seed++) {
      const bot = createSeededRng(seed * 7919);
      let s = createMatch(rules, { options: {} }, expandTestSeed(seed));
      for (const seat of [0, 1] as const) {
        const view = viewFor(rules, s, seat);
        checkView(view, s.state as CartignonMatchState, seat, `seed ${seed} r0 seat ${seat}`);
      }
      for (let i = 0; i < MAX_STEPS; i++) {
        const before = s.state as CartignonMatchState;
        const acting = rules.getPhase(before).activeSeat;
        if (acting === null) break;
        const legal = priv(viewFor(rules, s, acting)).legal;
        expect(legal.length).toBeGreaterThan(0);
        // R7: some steps are clock timeouts (choice clock while the other seat's turn runs), and
        // the last seed ends by forfeit.
        const roll = bot.nextInt(8);
        let result: StepResult;
        if (seed === SEEDS && i === 20) {
          result = forfeitMatch(rules, s, acting, 'turnTimeouts');
          forfeits++;
        } else if (roll === 0) {
          const phase = rules.getPhase(before);
          const mode = phase.activeSeat === phase.turnSeat ? 'turn' : 'choice';
          result = stepTimeout(rules, s, acting, mode, s.revision);
          timeouts++;
        } else {
          const command = legal[bot.nextInt(legal.length)] as RoundCommand;
          result = mustStep(rules, s, acting, command);
        }
        if (!result.ok) expect.fail(`seed ${seed}: ${result.code} ${result.reason ?? ''}`);
        expect(result.snapshot.revision).toBe(s.revision + 1);
        s = result.snapshot;
        totalSteps++;
        const after = s.state as CartignonMatchState;
        const raw = result.events as readonly MatchEvent[];
        maxEvents = Math.max(maxEvents, raw.length);
        for (const e of raw) kinds.add(e.type);
        for (const seat of [0, 1] as const) {
          const where = `seed ${seed} r${s.revision} seat ${seat}`;
          const view = viewFor(rules, s, seat);
          const events = eventsFor(rules, raw, seat);
          checkView(view, after, seat, where);
          checkEvents(events, raw, before, after, seat, where);
          // Contract: the projection matches the strict protocol schemas.
          expect(cartignonPublicViewSchema.safeParse(view.public).success, where).toBe(true);
          expect(cartignonPrivateViewSchema.safeParse(view.private).success, where).toBe(true);
          const parsedEvents = cartignonSeatEventsSchema.safeParse(events);
          if (!parsedEvents.success) expect.fail(`${where}: ${parsedEvents.error.message}`);
        }
      }
      if (rules.resolveOutcome(s.state as CartignonMatchState) !== null) finished++;
      // The envelope accepts the final view as the server would send it.
      const view = viewFor(rules, s, 0);
      expect(
        matchViewMessageSchema.safeParse({
          matchId: '0b6f6f5e-6a4c-4c1e-9f0a-2d6a4a3c1b2e',
          seat: 0,
          revision: view.revision,
          rulesId: view.rulesId,
          rulesVersion: view.rulesVersion,
          phase: {
            id: view.phase.id,
            activeSeat: view.phase.activeSeat,
            turnSeat: view.phase.turnSeat,
          },
          public: view.public,
          private: view.private,
          events: [],
          outcome: view.outcome,
          clock: null,
          cause: 'action',
        }).success,
      ).toBe(true);
    }
    // The sweep must actually exercise the hidden-information paths.
    expect(finished).toBeGreaterThan(0);
    expect(totalSteps).toBeGreaterThan(500);
    expect(timeouts).toBeGreaterThan(50);
    expect(forfeits).toBe(1);
    expect(maxEvents).toBeLessThanOrEqual(512);
    for (const kind of [
      'cardsDrawn',
      'cardsLookedAt',
      'lookedAtSettled',
      'handCardsReturned',
      'spellChoiceMade',
      'trapArmed',
      'roundResolved',
      'matchOver',
    ]) {
      expect(kinds.has(kind), kind).toBe(true);
    }
  }, 60_000);
});
