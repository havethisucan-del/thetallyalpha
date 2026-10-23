import { expandTestSeed } from '@cartignon/game-core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { commandToAction } from '../src/lib/cartignon';
import { MatchScreen } from '../src/screens/MatchScreen';
import { PlayScreen } from '../src/screens/PlayScreen';
import { buildTutorial } from '../src/tutorial/buildTutorial';
import { TutorialMatch } from '../src/tutorial/tutorialMatch';
import {
  chooseVerticalPlacement,
  sideFits,
  TutorialOverlay,
} from '../src/tutorial/TutorialOverlay';

/** ADR-0018 UI integration: coach placement, the panel markup, outcome hold-back, Replay. */

const noop = () => undefined;

function newMatch(): TutorialMatch {
  return new TutorialMatch({
    tutorial: buildTutorial(),
    delay: () => 0,
    botSeed: expandTestSeed(9),
  });
}

describe('coach placement', () => {
  const vh = 740;
  it('goes to the top when the target is in the bottom dock, and the other way round', () => {
    expect(chooseVerticalPlacement([{ top: 600, bottom: 700 }], 200, vh, 'bottom')).toBe('top');
    expect(chooseVerticalPlacement([{ top: 70, bottom: 150 }], 200, vh, 'top')).toBe('bottom');
  });

  it('keeps the previous side without targets or on a tie', () => {
    expect(chooseVerticalPlacement([], 200, vh, 'bottom')).toBe('bottom');
    expect(chooseVerticalPlacement([{ top: 300, bottom: 400 }], 100, vh, 'top')).toBe('top');
  });

  it('weighs several targets by how much of them each side covers', () => {
    const targets = [
      { top: 80, bottom: 120 },
      { top: 560, bottom: 720 },
    ];
    expect(chooseVerticalPlacement(targets, 250, vh, 'bottom')).toBe('top');
  });

  it('uses the side only when it clears the table', () => {
    expect(sideFits(976, 1280)).toBe(true);
    expect(sideFits(976, 1100)).toBe(false);
    expect(sideFits(null, 1920)).toBe(false);
  });
});

describe('TutorialOverlay markup', () => {
  it('is a labelled region with a polite live text, Continue and Skip', () => {
    const match = newMatch();
    const html = renderToStaticMarkup(
      createElement(TutorialOverlay, { tutorial: match, onSkip: noop, onFinish: noop }),
    );
    match.leave();
    expect(html).toMatch(/^<section[^>]*aria-labelledby="tutorial-heading"/);
    expect(html).toContain('data-testid="tutorial-overlay"');
    expect(html).toMatch(/<p aria-live="polite"[^>]*data-testid="tutorial-text"/);
    expect(html).toContain('data-testid="tutorial-continue"');
    expect(html).toContain('data-testid="tutorial-skip"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('Step 1 of');
  });
});

describe('MatchScreen hideOutcome', () => {
  it('holds back the outcome card of a finished match', async () => {
    const match = newMatch();
    // Play the script to its end: every gated command is the only legal entry.
    for (let guard = 0; guard < 100; guard += 1) {
      const state = match.getTutorialState();
      if (state.status !== 'running') break;
      if (state.step.gate.kind === 'continue') {
        match.continue();
        continue;
      }
      const legal = match.getSnapshot().cartignon?.private.legal ?? [];
      const command = legal[0];
      if (command && state.step.gate.kind === 'command') {
        match.sendAction(commandToAction(command));
      }
      await match.whenIdle();
    }
    const snapshot = match.getSnapshot();
    match.leave();
    expect(snapshot.view?.outcome).not.toBeNull();
    const render = (hideOutcome: boolean) =>
      renderToStaticMarkup(
        createElement(MatchScreen, {
          snapshot,
          hideOutcome,
          onIncrement: noop,
          onAction: noop,
          onHome: noop,
        }),
      );
    expect(render(false)).toContain('data-testid="outcome"');
    expect(render(true)).not.toContain('data-testid="outcome"');
  });
});

describe('PlayScreen Replay tutorial', () => {
  const render = (onReplayTutorial?: () => void) =>
    renderToStaticMarkup(
      createElement(PlayScreen, {
        level: 1,
        onLevelChange: noop,
        onPlayBot: noop,
        onBack: noop,
        online: null,
        ...(onReplayTutorial ? { onReplayTutorial } : {}),
      }),
    );

  it('offers Replay tutorial as a secondary action when wired', () => {
    expect(render(noop)).toMatch(/data-testid="play-tutorial"[^>]*>Replay tutorial</);
    expect(render()).not.toContain('play-tutorial');
  });
});
