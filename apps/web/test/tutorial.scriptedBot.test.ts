import type { BotRequest } from '@cartignon/ai';
import {
  createRngFromSeedBytes,
  expandTestSeed,
  legalMatchCommands,
  observeForSeat,
  startPresetCartignonMatch,
  type RoundCommand,
} from '@cartignon/game-core';
import { describe, expect, it, vi } from 'vitest';
import { buildTutorial } from '../src/tutorial/buildTutorial';
import { TUTORIAL_SCRIPT } from '../src/tutorial/script';
import { ScriptedBot } from '../src/tutorial/scriptedBot';

/** ADR-0018 decision 4: scripted moves on release, L1 fallback off script. */

const built = buildTutorial();

/** The bot's first request: the preset deal, bot (seat 1) in its P1 Base step. */
function firstRequest(): BotRequest {
  const started = startPresetCartignonMatch(built.catalog, TUTORIAL_SCRIPT.preset);
  if (!started.ok) throw new Error(started.message);
  return {
    level: 1,
    observation: observeForSeat(started.state, 1),
    rngState: createRngFromSeedBytes(expandTestSeed(2)).getState(),
  };
}

function isLegal(request: BotRequest, command: RoundCommand): boolean {
  return legalMatchCommands(built.context, request.observation.match, 1).some(
    (c) => JSON.stringify(c) === JSON.stringify(command),
  );
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ScriptedBot', () => {
  it('waits until released, then plays the scripted move', async () => {
    const move: RoundCommand = { type: 'playCreature', cardId: built.cardIdOf('C-G2') };
    const bot = new ScriptedBot({ context: built.context, moves: [move] });
    let answered = false;
    const pending = bot.decide(firstRequest()).then((r) => {
      answered = true;
      return r;
    });
    await settle();
    expect(answered).toBe(false);
    bot.setReleased(true);
    const response = await pending;
    expect(response.command).toEqual(move);
    expect(bot.offScript).toBe(false);
    expect(bot.remaining).toBe(0);
  });

  it('falls back to the L1 bot on an illegal scripted move and reports offScript once', async () => {
    const onOffScript = vi.fn();
    // End Turn is illegal in the P1 Base step while a creature is in hand (RD-63).
    const bot = new ScriptedBot({
      context: built.context,
      moves: [{ type: 'endTurn' }],
      onOffScript,
    });
    bot.setReleased(true);
    const request = firstRequest();
    const response = await bot.decide(request);
    expect(bot.offScript).toBe(true);
    expect(isLegal(request, response.command)).toBe(true);
    // Off script it answers at once, even when not released.
    bot.setReleased(false);
    const again = await bot.decide(request);
    expect(isLegal(request, again.command)).toBe(true);
    expect(onOffScript).toHaveBeenCalledTimes(1);
  });

  it('goes off script when the script ran out', async () => {
    const bot = new ScriptedBot({ context: built.context, moves: [] });
    bot.setReleased(true);
    const request = firstRequest();
    const response = await bot.decide(request);
    expect(bot.offScript).toBe(true);
    expect(isLegal(request, response.command)).toBe(true);
  });

  it('rejects waiting and later requests after dispose', async () => {
    const bot = new ScriptedBot({ context: built.context, moves: [] });
    const pending = bot.decide(firstRequest());
    bot.dispose();
    await expect(pending).rejects.toThrow('stopped');
    await expect(bot.decide(firstRequest())).rejects.toThrow('stopped');
  });
});
