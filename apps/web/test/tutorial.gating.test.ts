import { expandTestSeed, toCartignonAction } from '@cartignon/game-core';
import { describe, expect, it } from 'vitest';
import { commandToAction } from '../src/lib/cartignon';
import { buildTutorial } from '../src/tutorial/buildTutorial';
import { TUTORIAL_SCRIPT } from '../src/tutorial/script';
import { TutorialMatch } from '../src/tutorial/tutorialMatch';
import type { TutorialScript } from '../src/tutorial/types';

/** ADR-0018 decision 3: the human may only send the current step's command. */

function newMatch(script: TutorialScript = TUTORIAL_SCRIPT): TutorialMatch {
  return new TutorialMatch({
    tutorial: buildTutorial(script),
    delay: () => 0,
    botSeed: expandTestSeed(9),
  });
}

/** Presses Continue until the current step is not a Continue step. */
function continueToGate(match: TutorialMatch): void {
  while (match.getTutorialState().step.gate.kind === 'continue') match.continue();
}

describe('tutorial gating', () => {
  it('shows no legal commands on Continue steps and refuses every action', () => {
    const match = newMatch();
    const snapshot = match.getSnapshot();
    expect(match.getTutorialState().step.gate.kind).toBe('continue');
    expect(snapshot.cartignon?.private.legal).toEqual([]);
    const revision = snapshot.view?.revision;
    expect(match.sendAction(toCartignonAction({ type: 'endTurn' }))).toBeNull();
    expect(match.getSnapshot().view?.revision).toBe(revision);
    match.leave();
  });

  it('returns a stable snapshot object between changes', () => {
    const match = newMatch();
    expect(match.getSnapshot()).toBe(match.getSnapshot());
    const before = match.getSnapshot();
    match.continue();
    expect(match.getSnapshot()).not.toBe(before);
    match.leave();
  });

  it('holds the bot until a watch step, then advances on the awaited event', async () => {
    const match = newMatch();
    continueToGate(match);
    expect(match.getTutorialState().step.id).toBe('flow-bot-base');
    expect(match.getSnapshot().cartignon?.private.legal).toEqual([]);
    await match.whenIdle();
    expect(match.getTutorialState().step.id).toBe('flow-mulligan');
    expect(match.getSnapshot().view?.phase.activeSeat).toBe(0);
    match.leave();
  });

  it('allows exactly the gated command on a command step', async () => {
    const match = newMatch();
    continueToGate(match);
    await match.whenIdle();
    expect(match.getTutorialState().step.id).toBe('flow-mulligan');
    expect(match.getSnapshot().cartignon?.private.legal).toEqual([{ type: 'mulligan' }]);
    expect(match.sendAction(commandToAction({ type: 'mulligan' }))).not.toBeNull();
    const state = match.getTutorialState();
    expect(state.step.id).toBe('flow-nullify');
    const f2 = match.cardIdOf('C-F2');
    expect(match.getSnapshot().cartignon?.private.legal).toEqual([{ type: 'nullify', cardId: f2 }]);
    // Legal for the engine (a Base minion), refused by the coach.
    expect(match.sendAction(commandToAction({ type: 'playCreature', cardId: f2 }))).toBeNull();
    expect(match.getTutorialState()).toBe(state);
    expect(match.sendAction(commandToAction({ type: 'nullify', cardId: f2 }))).not.toBeNull();
    expect(match.getSnapshot().lastResult?.status).toBe('accepted');
    expect(match.getTutorialState().step.id).toBe('flow-bot-rebase');
    match.leave();
  });

  it('turns gating off when the gated command is not legal (never stuck)', async () => {
    const steps = TUTORIAL_SCRIPT.steps.map((step) =>
      step.id === 'flow-mulligan'
        ? {
            ...step,
            gate: {
              kind: 'command' as const,
              command: { type: 'playCreature' as const, defId: 'C-A5' },
            },
          }
        : step,
    );
    const match = newMatch({ ...TUTORIAL_SCRIPT, steps });
    continueToGate(match);
    await match.whenIdle();
    expect(match.getTutorialState().offScript).toBe(true);
    const legal = match.getSnapshot().cartignon?.private.legal ?? [];
    expect(legal.length).toBeGreaterThan(1);
    expect(match.sendAction(toCartignonAction({ type: 'endTurn' }))).not.toBeNull();
    match.leave();
  });

  it('skip stops the coach, releases the bot and lifts the gate', async () => {
    const match = newMatch();
    match.skip();
    expect(match.getTutorialState().status).toBe('skipped');
    expect(match.continue()).toBe(false);
    // The round starts on the bot's turn: it must move on its own after a skip.
    await match.whenIdle();
    expect(match.getSnapshot().view?.phase.activeSeat).toBe(0);
    expect(match.getSnapshot().cartignon?.private.legal.length).toBeGreaterThan(0);
    match.leave();
  });
});
