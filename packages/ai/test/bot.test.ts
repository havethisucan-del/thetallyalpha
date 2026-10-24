import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  activeSeat,
  createSeededRng,
  legalMatchCommands,
  observeForSeat,
  validateCommand,
  type CartignonMatchState,
  type Seat,
} from '@cartignon/game-core';
import {
  BOT_LEVELS,
  commandKey,
  createBot,
  decideCommand,
  decideFromRequest,
  EMPTY_TURN_MEMORY,
  isPlay,
  NotBotsTurnError,
  playBotMatch,
  restrictPlays,
  type BotLevel,
  type BotRequest,
  type SerializableBudget,
} from '../src/index.js';
import { permuteHidden, realCatalog, sampleStates } from './helpers.js';

/** Small deterministic budgets so the suite stays fast; strength is the tournament's job. */
function testBudget(level: BotLevel): SerializableBudget | undefined {
  return level >= 4 ? { kind: 'playouts', playouts: 8 } : undefined;
}

function request(level: BotLevel, match: CartignonMatchState, seat: Seat): BotRequest {
  const budget = testBudget(level);
  return {
    level,
    observation: observeForSeat(match, seat),
    rngState: createSeededRng(level * 97 + match.round.turnNumber).getState(),
    ...(budget === undefined ? {} : { budget }),
  };
}

/** Every `stride`-th decision point of three sampled matches, plus every pending choice. */
function decisionPoints(stride: number): { match: CartignonMatchState; seat: Seat }[] {
  const out: { match: CartignonMatchState; seat: Seat }[] = [];
  for (const seed of [3, 8, 13]) {
    sampleStates(seed).forEach((match, i) => {
      const seat = activeSeat(match.round);
      const pending = match.round.pendingChoice !== undefined;
      if (seat !== null && (i % stride === 0 || pending)) out.push({ match, seat });
    });
  }
  return out;
}

describe('bot decisions (ADR-0016)', () => {
  const { ctx } = realCatalog();
  const points = decisionPoints(9);

  it('samples enough decision points, including pending choices', () => {
    expect(points.length).toBeGreaterThan(30);
    expect(points.some((p) => p.match.round.pendingChoice !== undefined)).toBe(true);
  });

  it.each(BOT_LEVELS)(
    'L%i plays legally and decides the same under any permutation of the hidden cards (no leak)',
    (level) => {
      const rng = createSeededRng(555 + level);
      for (const { match, seat } of points) {
        const base = decideFromRequest(ctx, request(level, match, seat));
        const keys = legalMatchCommands(ctx, match, seat).map(commandKey);
        expect(keys).toContain(commandKey(base.command));
        for (let k = 0; k < 2; k++) {
          const permuted = decideFromRequest(
            ctx,
            request(level, permuteHidden(match, seat, rng), seat),
          );
          expect(permuted.command).toEqual(base.command);
          expect(permuted.rngState).toBe(base.rngState);
        }
      }
    },
    60_000,
  );

  it('is deterministic for a given request and survives structured cloning', () => {
    const { match, seat } = points[points.length >> 1] as (typeof points)[number];
    for (const level of BOT_LEVELS) {
      const req = request(level, match, seat);
      const cloned = structuredClone(req);
      const a = decideFromRequest(ctx, req);
      const b = decideFromRequest(ctx, cloned);
      expect(b.command).toEqual(a.command);
      expect(b.memory).toEqual(a.memory);
      expect(b.rngState).toBe(a.rngState);
      expect(structuredClone(a)).toEqual(a);
    }
  });

  it('refuses to decide for a seat that is not acting', () => {
    const { match, seat } = points[0] as (typeof points)[number];
    const other: Seat = seat === 0 ? 1 : 0;
    expect(() => decideCommand(2, ctx, observeForSeat(match, other), createSeededRng(1))).toThrow(
      NotBotsTurnError,
    );
  });

  it('a time budget of 0 ms still returns a legal command (L4 and L5)', () => {
    const { match, seat } = points[points.length >> 1] as (typeof points)[number];
    const keys = legalMatchCommands(ctx, match, seat).map(commandKey);
    for (const level of [4, 5] as const) {
      const response = decideFromRequest(ctx, {
        ...request(level, match, seat),
        budget: { kind: 'time', ms: 0 },
      });
      expect(keys).toContain(commandKey(response.command));
    }
  });
});

describe('play cap and loop guard (ADR-0016)', () => {
  const { ctx } = realCatalog();

  it('restrictPlays keeps only non-play commands once the cap is reached or a loop is seen', () => {
    const legal = [{ type: 'playSpell', cardId: 'x' }, { type: 'endTurn' }] as const;
    expect(restrictPlays(legal, 2, 3)).toEqual(legal);
    expect(restrictPlays(legal, 3, 3)).toEqual([{ type: 'endTurn' }]);
    expect(restrictPlays(legal, 0, 3, true)).toEqual([{ type: 'endTurn' }]);
    // A mandatory play (nothing else is legal) stays available.
    expect(restrictPlays([legal[0]], 9, 3)).toEqual([legal[0]]);
  });

  it('L1 at its cap of 3 plays ends the turn when it may', () => {
    const point = decisionPoints(1).find(({ match, seat }) => {
      const legal = legalMatchCommands(ctx, match, seat);
      return legal.some((c) => c.type === 'endTurn') && legal.some(isPlay);
    });
    if (point === undefined) throw new Error('no state with both a play and End Turn');
    const { match, seat } = point;
    const memory = {
      ...EMPTY_TURN_MEMORY,
      turnKey: `${match.roundNumber}:${match.round.turnNumber}`,
      plays: 3,
    };
    for (let s = 0; s < 10; s++) {
      const decision = decideCommand(1, ctx, observeForSeat(match, seat), createSeededRng(s), {
        memory,
      });
      expect(isPlay(decision.command)).toBe(false);
    }
  });

  it('never casts a spell that would have no effect (RD-175, SPELL_NO_EFFECT)', () => {
    // Decision points where the acting seat holds a spell whose branch would do nothing.
    const noEffect = decisionPoints(1)
      .filter(({ match }) => match.round.pendingChoice === undefined)
      .flatMap(({ match, seat }) => {
        const dead = match.round.board.zones.hands[seat].filter((cardId) => {
          const check = validateCommand(ctx, match.round, seat, { type: 'playSpell', cardId });
          return !check.ok && check.code === 'SPELL_NO_EFFECT';
        });
        return dead.length > 0 ? [{ match, seat, dead }] : [];
      })
      .slice(0, 6);
    expect(noEffect.length).toBeGreaterThan(0);
    for (const { match, seat, dead } of noEffect) {
      for (const level of BOT_LEVELS) {
        const { command } = decideFromRequest(ctx, request(level, match, seat));
        expect(command.type === 'playSpell' && dead.includes(command.cardId)).toBe(false);
      }
      for (const cardId of dead) {
        expect(legalMatchCommands(ctx, match, seat)).not.toContainEqual({
          type: 'playSpell',
          cardId,
        });
      }
    }
  });

  it('a repeated observation within a turn triggers the loop guard', () => {
    const { match, seat } = decisionPoints(1).find(({ match, seat }) =>
      legalMatchCommands(ctx, match, seat).some((c) => c.type === 'endTurn'),
    ) as { match: CartignonMatchState; seat: Seat };
    const obs = observeForSeat(match, seat);
    const first = decideCommand(2, ctx, obs, createSeededRng(1));
    expect(first.loopDetected).toBe(false);
    const again = decideCommand(2, ctx, obs, createSeededRng(1), { memory: first.memory });
    expect(again.loopDetected).toBe(true);
    expect(isPlay(again.command)).toBe(false);
  });
});

describe('arena (ADR-0016)', () => {
  const { catalog, ctx } = realCatalog();

  it.each([
    [1, 2],
    [3, 5],
  ] as const)(
    'L%i vs L%i plays a full match to its end',
    (a, b) => {
      const budget = { kind: 'playouts', playouts: 6 } as const;
      const result = playBotMatch(ctx, catalog, createSeededRng(77), [
        { bot: createBot(a, ctx), rng: createSeededRng(1), budget },
        { bot: createBot(b, ctx), rng: createSeededRng(2), budget },
      ]);
      expect(result.end).not.toBe('stepCap');
      expect(result.steps).toBeGreaterThan(10);
    },
    60_000,
  );
});

describe('environment neutrality (browser and Node)', () => {
  it('src imports nothing but game-core and its own modules, and uses no Node globals', () => {
    const dir = fileURLToPath(new URL('../src/', import.meta.url));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(dir + file, 'utf8');
      for (const [, spec] of text.matchAll(/from '([^']+)'/g)) {
        expect(spec === '@cartignon/game-core' || spec?.startsWith('./'), `${file}: ${spec}`).toBe(
          true,
        );
      }
      expect(/\b(process|require|Buffer|setImmediate|__dirname)\b/.test(text), file).toBe(false);
    }
  });
});
