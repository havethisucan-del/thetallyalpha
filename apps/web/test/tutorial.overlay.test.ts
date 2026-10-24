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
  anchorNote,
  anchorWidth,
  chooseVerticalPlacement,
  sideFits,
  TutorialOverlay,
  zoomLayout,
  type Box,
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

function intersects(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

describe('anchored coach note (revision 2026-10-25)', () => {
  const desktop = { width: 1280, height: 800 };
  const phone = { width: 360, height: 800 };

  it('sits right of a target on desktop, without covering it', () => {
    const target: Box = { left: 500, top: 300, right: 700, bottom: 420 };
    const note = anchorNote([target], { width: 320, height: 180 }, desktop);
    expect(note?.side).toBe('right');
    expect(note?.left).toBe(716);
  });

  it('goes below or above on a phone, and never over any target', () => {
    const stack: Box = { left: 130, top: 420, right: 230, bottom: 560 };
    const atk: Box = { left: 240, top: 470, right: 300, bottom: 510 };
    const width = anchorWidth(phone.width);
    const note = anchorNote([stack, atk], { width, height: 180 }, phone);
    expect(note).not.toBeNull();
    expect(['below', 'above']).toContain(note?.side);
    if (note) {
      const box = {
        left: note.left,
        top: note.top,
        right: note.left + width,
        bottom: note.top + 180,
      };
      expect(intersects(box, stack) || intersects(box, atk)).toBe(false);
      expect(box.top).toBeGreaterThanOrEqual(60);
      expect(box.bottom).toBeLessThanOrEqual(phone.height);
    }
  });

  it('gives up (null) when no side fits', () => {
    const huge: Box = { left: 0, top: 0, right: 360, bottom: 800 };
    expect(anchorNote([huge], { width: 336, height: 200 }, phone)).toBeNull();
    expect(anchorNote([], { width: 336, height: 200 }, phone)).toBeNull();
  });
});

describe('zoom layout (revision 2026-10-25)', () => {
  const width = (box: Box) => box.right - box.left;

  it('enlarges every card to one size, whatever the note text', () => {
    for (const viewport of [
      { width: 360, height: 800 },
      { width: 375, height: 740 },
      { width: 1280, height: 800 },
    ]) {
      const short = zoomLayout(viewport, () => 120);
      const long = zoomLayout(viewport, () => 260);
      expect(width(short.card)).toBeCloseTo(width(long.card), 5);
    }
  });

  it('puts the card in the middle and the note beside it on desktop, clear of the card', () => {
    const { card, note } = zoomLayout({ width: 1280, height: 800 }, () => 200);
    expect((card.left + card.right) / 2).toBeCloseTo(640, 5);
    expect(note.left).toBeGreaterThanOrEqual(card.right);
    expect(width(card)).toBe(250);
  });

  it('stacks card and note on a phone, the note under the card', () => {
    const { card, note } = zoomLayout({ width: 360, height: 800 }, () => 220);
    expect((card.left + card.right) / 2).toBeCloseTo(180, 5);
    expect(note.top).toBeGreaterThanOrEqual(card.bottom);
    expect(note.top + 220).toBeLessThanOrEqual(800);
    expect(card.top).toBeGreaterThanOrEqual(60);
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
    // Play the script to its end: every gated command is the only legal entry; in the free final
    // round, end the turn when allowed, else the first legal command.
    for (let guard = 0; guard < 200; guard += 1) {
      const state = match.getTutorialState();
      if (state.status !== 'running') break;
      if (state.step.gate.kind === 'continue') {
        match.continue();
        continue;
      }
      const legal = match.getSnapshot().cartignon?.private.legal ?? [];
      const command =
        state.step.gate.kind === 'play'
          ? (legal.find((c) => c.type === 'endTurn') ?? legal[0])
          : legal[0];
      if (command && state.step.gate.kind !== 'event') {
        match.sendAction(commandToAction(command));
      }
      await match.whenIdle();
      await Promise.resolve();
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
