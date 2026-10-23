import { describe, expect, it } from 'vitest';
import {
  INVITE_CODE_ALPHABET,
  actionMessageSchema,
  cardIdSchema,
  cartignonActionSchema,
  cartignonPrivateViewSchema,
  cartignonSeatEventSchema,
  actionResultMessageSchema,
  cartignonCommandSchema,
  clockMessageSchema,
  clockViewSchema,
  inviteCodeSchema,
  ServerMessage,
  joinPrivateRoomRequestSchema,
  matchViewMessageSchema,
  readyMessageSchema,
} from '../src/index.js';

const uuid = '0b6f6f5e-6a4c-4c1e-9f0a-2d6a4a3c1b2e';

describe('invite codes', () => {
  it('accepts 6 characters from the alphabet', () => {
    expect(inviteCodeSchema.safeParse('ABC234').success).toBe(true);
  });

  it.each(['ABC23', 'ABC2345', 'abc234', 'ABC10O', 'ABC 23', ''])('rejects %j', (code) => {
    expect(inviteCodeSchema.safeParse(code).success).toBe(false);
  });

  it('alphabet has no ambiguous characters or duplicates', () => {
    expect(INVITE_CODE_ALPHABET).not.toMatch(/[01OIL]/);
    expect(new Set(INVITE_CODE_ALPHABET).size).toBe(INVITE_CODE_ALPHABET.length);
  });
});

describe('client messages are strict', () => {
  it('accepts a well-formed action envelope', () => {
    const msg = {
      actionId: uuid,
      expectedRevision: 0,
      action: { type: 'increment', v: 1, payload: { amount: 1 } },
    };
    expect(actionMessageSchema.parse(msg)).toEqual(msg);
  });

  it.each([
    ['non-uuid action id', { actionId: 'x', expectedRevision: 0, action: { type: 'a', v: 1 } }],
    ['missing action', { actionId: uuid, expectedRevision: 0 }],
    ['missing expectedRevision', { actionId: uuid, action: { type: 'a', v: 1, payload: null } }],
    [
      'negative expectedRevision',
      { actionId: uuid, expectedRevision: -1, action: { type: 'a', v: 1, payload: null } },
    ],
    [
      'fractional expectedRevision',
      { actionId: uuid, expectedRevision: 1.5, action: { type: 'a', v: 1, payload: null } },
    ],
    ['client-supplied revision', { actionId: uuid, revision: 3, action: { type: 'a', v: 1 } }],
    ['client-supplied seat', { actionId: uuid, seat: 0, action: { type: 'a', v: 1 } }],
    ['fractional version', { actionId: uuid, action: { type: 'a', v: 1.5, payload: null } }],
    ['oversized type', { actionId: uuid, action: { type: 'a'.repeat(65), v: 1, payload: null } }],
  ])('rejects %s', (_label, msg) => {
    expect(actionMessageSchema.safeParse(msg).success).toBe(false);
  });

  it('ready accepts only a boolean and nothing else', () => {
    expect(readyMessageSchema.safeParse({ ready: true }).success).toBe(true);
    expect(readyMessageSchema.safeParse({ ready: 'yes' }).success).toBe(false);
    expect(readyMessageSchema.safeParse({ ready: true, playerId: uuid }).success).toBe(false);
  });

  it('join request carries only the code (identity comes from the session)', () => {
    expect(joinPrivateRoomRequestSchema.safeParse({ code: 'ABC234' }).success).toBe(true);
    expect(joinPrivateRoomRequestSchema.safeParse({ code: 'ABC234', playerId: uuid }).success).toBe(
      false,
    );
  });
});

describe('server messages', () => {
  it('action results are discriminated by status', () => {
    expect(
      actionResultMessageSchema.safeParse({ status: 'accepted', actionId: uuid, revision: 1 })
        .success,
    ).toBe(true);
    expect(
      actionResultMessageSchema.safeParse({ status: 'accepted', actionId: uuid, code: 'X' })
        .success,
    ).toBe(false);
    const rejected = { status: 'rejected', actionId: uuid, code: 'ILLEGAL', message: 'no' };
    expect(actionResultMessageSchema.safeParse(rejected).success).toBe(true);
    expect(
      actionResultMessageSchema.safeParse({ ...rejected, reason: 'CHOICE_PENDING' }).success,
    ).toBe(true);
    expect(
      actionResultMessageSchema.safeParse({ ...rejected, reason: 'x'.repeat(65) }).success,
    ).toBe(false);
  });

  it('match view validates phase and outcome shape', () => {
    const view = {
      matchId: uuid,
      seat: 1,
      revision: 0,
      rulesId: 'synthetic',
      rulesVersion: '1',
      phase: { id: 'playing', activeSeat: 0, turnSeat: 0 },
      public: {},
      private: {},
      events: [],
      outcome: null,
      clock: null,
      cause: 'action',
    };
    expect(matchViewMessageSchema.safeParse(view).success).toBe(true);
    expect(matchViewMessageSchema.safeParse({ ...view, seat: 2 }).success).toBe(false);
    expect(
      matchViewMessageSchema.safeParse({ ...view, phase: { id: 'playing', activeSeat: 0 } })
        .success,
    ).toBe(false);
    expect(matchViewMessageSchema.safeParse({ ...view, events: undefined }).success).toBe(false);
    expect(
      matchViewMessageSchema.safeParse({ ...view, events: Array.from({ length: 513 }, () => ({})) })
        .success,
    ).toBe(false);
  });

  // R7: match clocks.
  const clock = {
    seat: 0,
    mode: 'turn',
    running: true,
    remainingMs: 900_000,
    deadline: 1_760_000_900_000,
    serverTime: 1_760_000_000_000,
    pauseLeftMs: [180_000, 120_000],
    consecutiveTimeouts: [0, 1],
  };

  it('clock view is strict; deadline is null while paused', () => {
    expect(clockViewSchema.safeParse(clock).success).toBe(true);
    expect(
      clockViewSchema.safeParse({ ...clock, running: false, deadline: null, mode: 'choice' })
        .success,
    ).toBe(true);
    expect(clockViewSchema.safeParse({ ...clock, mode: 'pause' }).success).toBe(false);
    expect(clockViewSchema.safeParse({ ...clock, remainingMs: -1 }).success).toBe(false);
    expect(clockViewSchema.safeParse({ ...clock, remainingMs: 1.5 }).success).toBe(false);
    expect(clockViewSchema.safeParse({ ...clock, pauseLeftMs: [1] }).success).toBe(false);
    expect(clockViewSchema.safeParse({ ...clock, extra: 1 }).success).toBe(false);
    const missing: Record<string, unknown> = { ...clock };
    delete missing['consecutiveTimeouts'];
    expect(clockViewSchema.safeParse(missing).success).toBe(false);
  });

  it('match view requires clock (nullable) and a known cause', () => {
    const view: Record<string, unknown> = {
      matchId: uuid,
      seat: 0,
      revision: 3,
      rulesId: 'cartignon',
      rulesVersion: '1',
      phase: { id: 'turn', activeSeat: 0, turnSeat: 0 },
      public: {},
      private: {},
      events: [],
      outcome: null,
      clock,
      cause: 'timeout',
    };
    expect(matchViewMessageSchema.safeParse(view).success).toBe(true);
    for (const cause of ['action', 'timeout', 'forfeit']) {
      expect(matchViewMessageSchema.safeParse({ ...view, cause }).success).toBe(true);
    }
    expect(matchViewMessageSchema.safeParse({ ...view, cause: 'other' }).success).toBe(false);
    for (const key of ['cause', 'clock']) {
      const missing = Object.fromEntries(Object.entries(view).filter(([k]) => k !== key));
      expect(matchViewMessageSchema.safeParse(missing).success, key).toBe(false);
    }
    expect(
      matchViewMessageSchema.safeParse({ ...view, clock: { ...clock, seat: 2 } }).success,
    ).toBe(false);
  });

  it('match:clock carries the clock for a revision', () => {
    expect(ServerMessage.Clock).toBe('match:clock');
    const message = { matchId: uuid, revision: 3, clock };
    expect(clockMessageSchema.safeParse(message).success).toBe(true);
    expect(clockMessageSchema.safeParse({ ...message, clock: null }).success).toBe(true);
    expect(clockMessageSchema.safeParse({ ...message, seat: 0 }).success).toBe(false);
  });
});

describe('cartignon schemas', () => {
  it('card ids are c + two digits', () => {
    expect(cardIdSchema.safeParse('c01').success).toBe(true);
    for (const bad of ['c1', 'c001', 'C01', 'x01', '']) {
      expect(cardIdSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('forfeit end reasons pass the matchOver event schema', () => {
    for (const reason of ['forfeitTimeouts', 'forfeitTimeoutAfterPause']) {
      expect(
        cartignonSeatEventSchema.safeParse({
          type: 'matchOver',
          reason,
          winner: 1,
          tokenCounts: [2, 3],
        }).success,
        reason,
      ).toBe(true);
    }
    expect(
      cartignonSeatEventSchema.safeParse({
        type: 'matchOver',
        reason: 'forfeit',
        winner: 1,
        tokenCounts: [2, 3],
      }).success,
    ).toBe(false);
  });

  it('the internal timeout skip is neither an action nor a listed command (RD-163)', () => {
    expect(
      cartignonActionSchema.safeParse({ type: 'timeoutSkip', v: 1, payload: {} }).success,
    ).toBe(false);
    expect(cartignonCommandSchema.safeParse({ type: 'timeoutSkip' }).success).toBe(false);
  });

  it('actions are strict per type', () => {
    const ok = [
      { type: 'playCreature', v: 1, payload: { cardId: 'c01' } },
      { type: 'endTurn', v: 1, payload: {} },
      { type: 'chooseSpellOption', v: 1, payload: { choiceId: 2, selection: ['c01', 'c02'] } },
    ];
    for (const a of ok) expect(cartignonActionSchema.parse(a)).toEqual(a);
    const bad = [
      { type: 'playCreature', v: 2, payload: { cardId: 'c01' } },
      { type: 'playCreature', v: 1, payload: { cardId: 'c01', seat: 0 } },
      { type: 'endTurn', v: 1, payload: { cardId: 'c01' } },
      { type: 'endTurn', v: 1 },
      // RD-169: Fold and End Turn are one action; `fold` is no longer an action type.
      { type: 'fold', v: 1, payload: {} },
      {
        type: 'chooseSpellOption',
        v: 1,
        payload: { choiceId: 1, selection: Array(55).fill('c01') },
      },
      { type: 'chooseSpellOption', v: 1, payload: { choiceId: 1.5, selection: [] } },
      { type: 'endTurn', v: 1, payload: {}, extra: 1 },
    ];
    for (const a of bad)
      expect(cartignonActionSchema.safeParse(a).success, JSON.stringify(a)).toBe(false);
  });

  it('a redacted event must not also carry ids; private views reject unknown keys', () => {
    expect(
      cartignonSeatEventSchema.safeParse({
        type: 'cardsDrawn',
        seat: 0,
        reason: 'refill',
        count: 2,
      }).success,
    ).toBe(true);
    expect(
      cartignonSeatEventSchema.safeParse({
        type: 'cardsDrawn',
        seat: 0,
        reason: 'refill',
        count: 2,
        cardIds: ['c01', 'c02'],
      }).success,
    ).toBe(false);
    const priv = {
      seat: 0,
      hand: ['c40'],
      lookingAt: null,
      pendingChoiceView: null,
      legal: [],
      spellHints: [
        { cardId: 'c40', branch: 'secondary', castable: false, reason: 'NOT_YOUR_TURN' },
      ],
    };
    expect(cartignonPrivateViewSchema.safeParse(priv).success).toBe(true);
    expect(cartignonPrivateViewSchema.safeParse({ ...priv, spellHints: undefined }).success).toBe(
      false,
    );
    expect(cartignonCommandSchema.safeParse({ type: 'fold' }).success).toBe(false);
    // RD-169 event shapes: `folded` is gone; `roundOver` carries `seat` and the new reasons.
    expect(
      cartignonSeatEventSchema.safeParse({
        type: 'roundOver',
        reason: 'equalStall',
        seat: 1,
        atk: [30, 30],
      }).success,
    ).toBe(true);
    expect(
      cartignonSeatEventSchema.safeParse({
        type: 'folded',
        seat: 1,
        atk: [30, 10],
        opponentAhead: true,
      }).success,
    ).toBe(false);
    expect(
      cartignonPrivateViewSchema.safeParse({ ...priv, pendingChoice: { continuation: {} } })
        .success,
    ).toBe(false);
  });
});
