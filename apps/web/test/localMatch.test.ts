import type { BotRequest, BotResponse } from '@cartignon/ai';
import { createMatch, createSeededRng, expandTestSeed, type Rng } from '@cartignon/game-core';
import { matchViewMessageSchema, type CartignonCommand } from '@cartignon/protocol';
import { describe, expect, it } from 'vitest';
import { commandToAction } from '../src/lib/cartignon';
import type { MatchSnapshot } from '../src/net/matchSource';
import { createInlineBot } from '../src/solo/botClient';
import type { BotTransport } from '../src/solo/botProtocol';
import { botLabel, LocalMatch, type LocalMatchOptions } from '../src/solo/localMatch';
import { soloRules } from '../src/solo/rules';
import { buildSeatViewMessage } from '../src/solo/viewMessage';

/** ADR-0017 S2: the in-browser solo match (engine on the main thread, bot through a transport). */

const MATCH_ID = '0b6f6f5e-6a4c-4c1e-9f0a-2d6a4a3c1b2e';
const MAX_HUMAN_ACTIONS = 3000;

/** Records every request and answers with the inline bot (or `override`). */
class RecordingBot implements BotTransport {
  readonly requests: BotRequest[] = [];
  disposed = false;
  readonly #inner = createInlineBot();
  readonly #override: ((request: BotRequest) => BotResponse | null) | undefined;

  constructor(override?: (request: BotRequest) => BotResponse | null) {
    this.#override = override;
  }

  decide(request: BotRequest): Promise<BotResponse> {
    this.requests.push(request);
    const forced = this.#override?.(request) ?? null;
    return forced ? Promise.resolve(forced) : this.#inner.decide(request);
  }

  dispose(): void {
    this.disposed = true;
    this.#inner.dispose();
  }
}

function newMatch(bot: BotTransport, options: Partial<LocalMatchOptions> = {}): LocalMatch {
  return new LocalMatch({
    level: 1,
    bot,
    delay: () => 0,
    engineSeed: expandTestSeed(7),
    botSeed: expandTestSeed(8),
    ...options,
  });
}

/** Every distinct view the match publishes, validated against the protocol schema. */
function collectViews(match: LocalMatch): MatchSnapshot['view'][] {
  const views: MatchSnapshot['view'][] = [match.getSnapshot().view];
  match.subscribe(() => {
    const view = match.getSnapshot().view;
    if (view !== views.at(-1)) views.push(view);
  });
  return views;
}

function humanLegal(snapshot: MatchSnapshot): CartignonCommand[] {
  return snapshot.cartignon?.private.legal ?? [];
}

function pick(legal: CartignonCommand[], rng: Rng): CartignonCommand {
  const command = legal[rng.nextInt(legal.length)];
  if (!command) throw new Error('no legal command');
  return command;
}

/** Plays seat 0 with random legal commands until the match is over. */
async function playToEnd(match: LocalMatch, rng: Rng): Promise<number> {
  let actions = 0;
  for (;;) {
    await match.whenIdle();
    const snapshot = match.getSnapshot();
    expect(snapshot.error).toBeNull();
    const view = snapshot.view;
    if (!view || view.outcome) return actions;
    expect(view.phase.activeSeat).toBe(0);
    if (++actions > MAX_HUMAN_ACTIONS) throw new Error('match did not end');
    match.sendAction(commandToAction(pick(humanLegal(snapshot), rng)));
    expect(match.getSnapshot().lastResult?.status).toBe('accepted');
  }
}

describe('buildSeatViewMessage', () => {
  it('produces views that pass matchViewMessageSchema for both seats, without a clock', () => {
    const rules = soloRules();
    const snapshot = createMatch(rules, { options: {} }, expandTestSeed(1));
    for (const seat of [0, 1] as const) {
      const message = buildSeatViewMessage(rules, snapshot, seat, MATCH_ID, undefined);
      expect(matchViewMessageSchema.parse(message)).toEqual(message);
      expect(message).toMatchObject({ seat, clock: null, events: [], cause: 'action' });
    }
  });
});

describe('LocalMatch', () => {
  it('starts connected as seat 0 with a parsed Cartignon view and no clock', async () => {
    const match = newMatch(new RecordingBot());
    await match.whenIdle();
    const snapshot = match.getSnapshot();
    expect(snapshot).toMatchObject({ status: 'connected', seat: 0, clock: null, roomId: null });
    expect(snapshot.cartignon).not.toBeNull();
    expect(snapshot.view?.seat).toBe(0);
  });

  it('plays a full match vs L1 to an outcome; every view passes the protocol schema', async () => {
    const bot = new RecordingBot();
    const match = newMatch(bot);
    const views = collectViews(match);
    const actions = await playToEnd(match, createSeededRng(3));

    const final = match.getSnapshot();
    expect(final.view?.outcome).not.toBeNull();
    expect(actions).toBeGreaterThan(0);
    expect(bot.requests.length).toBeGreaterThan(0);
    for (const view of views) expect(matchViewMessageSchema.safeParse(view).success).toBe(true);
    // Revisions only grow, one view per committed step, and the log saw the bot's moves too.
    const revisions = views.map((view) => view?.revision ?? -1);
    expect([...revisions].sort((a, b) => a - b)).toEqual(revisions);
    expect(new Set(revisions).size).toBe(revisions.length);
    expect(final.eventLog.length).toBeGreaterThan(0);
  });

  it('sends the bot only the seat-1 observation: no hidden cards, its own RNG', async () => {
    const bot = new RecordingBot();
    const match = newMatch(bot);
    await playToEnd(match, createSeededRng(5));
    expect(bot.requests.length).toBeGreaterThan(0);
    const rngStates = new Set<string>();
    for (const request of bot.requests) {
      expect(Object.keys(request).sort()).toEqual(
        request.memory === undefined
          ? ['level', 'observation', 'rngState']
          : ['level', 'memory', 'observation', 'rngState'],
      );
      expect(request.level).toBe(1);
      const obs = request.observation;
      expect(obs.seat).toBe(1);
      const zones = obs.match.round.board.zones;
      expect(zones.hands[0]).toEqual([]); // the human's hand is hidden
      expect(zones.deck).toEqual([]);
      expect(obs.hidden.opponentHand).toBeGreaterThanOrEqual(0);
      rngStates.add(request.rngState);
    }
    // The bot RNG advances between decisions (the response state is fed back).
    expect(rngStates.size).toBeGreaterThan(1);
  });

  it('leave() stops further bot moves and disposes the bot', async () => {
    const bot = new RecordingBot();
    let release: () => void = () => undefined;
    let sleeps = 0;
    const match = newMatch(bot, {
      delay: () => 1000,
      now: () => 0,
      sleep: () => {
        sleeps++;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    const rng = createSeededRng(11);
    // Act as seat 0 until the bot is waiting on its cosmetic delay.
    for (let i = 0; sleeps === 0 && i < 200; i++) {
      const snapshot = match.getSnapshot();
      if (snapshot.view?.phase.activeSeat === 0) {
        match.sendAction(commandToAction(pick(humanLegal(snapshot), rng)));
      }
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(sleeps).toBe(1);
    const revision = match.getSnapshot().view?.revision;

    match.leave();
    release();
    await match.whenIdle();
    expect(match.getSnapshot().status).toBe('disconnected');
    expect(match.getSnapshot().view?.revision).toBe(revision);
    expect(bot.disposed).toBe(true);
    expect(match.sendAction(commandToAction({ type: 'endTurn' }))).toBeNull();
  });

  it('falls back to a legal move and surfaces an error when the bot command is illegal', async () => {
    const bot = new RecordingBot((request) => ({
      command: { type: 'playCreature', cardId: 'no-such-card' },
      memory: request.memory ?? { turnKey: '', plays: 0, seen: [] },
      rngState: request.rngState,
      loopDetected: false,
      elapsedMs: 0,
    }));
    const match = newMatch(bot);
    const rng = createSeededRng(13);
    for (let i = 0; bot.requests.length === 0 && i < 200; i++) {
      await match.whenIdle();
      const snapshot = match.getSnapshot();
      if (snapshot.view?.outcome) break;
      match.sendAction(commandToAction(pick(humanLegal(snapshot), rng)));
    }
    await match.whenIdle();
    expect(bot.requests.length).toBeGreaterThan(0);
    const snapshot = match.getSnapshot();
    expect(snapshot.error).toMatch(/illegal move.*safe move/);
    // The game did not hang: seat 0 can act again (or the match ended).
    expect(snapshot.view?.outcome !== null || snapshot.view.phase.activeSeat === 0).toBe(true);
  });

  it('labels the bot with its level name', () => {
    expect(botLabel(3)).toBe('Bot · L3 Skilled');
    expect(botLabel(5)).toBe('Bot · L5 Master');
  });
});
