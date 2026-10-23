import { expandTestSeed } from '@cartignon/game-core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App, APP_ONLINE } from '../src/App';
import { ONLINE_ENABLED } from '../src/config';
import { HomeScreen } from '../src/screens/HomeScreen';
import { MatchScreen } from '../src/screens/MatchScreen';
import { OnlinePlaySection } from '../src/screens/OnlinePlaySection';
import { PlayScreen } from '../src/screens/PlayScreen';
import { createInlineBot } from '../src/solo/botClient';
import { botLabel, LocalMatch } from '../src/solo/localMatch';

/** ADR-0017 S3: entry screens (markup only, static server rendering like the table tests). */

const noop = () => undefined;

describe('HomeScreen', () => {
  it('shows the title and a vertical menu with Play', () => {
    const html = renderToStaticMarkup(
      createElement(HomeScreen, { items: [{ id: 'play', label: 'Play', onSelect: noop }] }),
    );
    expect(html).toContain('<h1');
    expect(html).toContain('The Tally');
    expect(html).toMatch(
      /<nav aria-label="Main menu"[^>]*><ul[^>]*><li><button[^>]*data-testid="menu-play"/,
    );
  });
});

describe('PlayScreen', () => {
  const render = (online: unknown) =>
    renderToStaticMarkup(
      createElement(PlayScreen, {
        level: 3,
        onLevelChange: noop,
        onPlayBot: noop,
        onBack: noop,
        online: online as never,
      }),
    );

  it('offers all five bot levels by name, the chosen one checked, and a Back control', () => {
    const html = render(null);
    for (const name of ['L1</span> Novice', 'L2</span> Casual', 'L3</span> Skilled']) {
      expect(html).toContain(name);
    }
    expect(html).toContain('L4</span> Expert');
    expect(html).toContain('L5</span> Master');
    expect(html.match(/type="radio"/g)).toHaveLength(5);
    expect(html).toMatch(/value="3" checked=""|checked="" [^>]*value="3"/);
    expect(html).toContain('data-testid="play-back"');
    expect(html).toContain('Play vs L3 Skilled');
    expect(html).not.toContain('create-room');
  });

  it('shows the online options when given (non-static builds)', () => {
    const online = createElement(OnlinePlaySection, {
      session: { kind: 'ready', player: { id: 'p1', displayName: 'Guest Fox' } } as never,
      busy: false,
      error: null,
      onRetrySession: noop,
      onCreate: noop,
      onJoin: noop,
    });
    const html = render(online);
    expect(html).toContain('data-testid="guest-name"');
    expect(html).toContain('data-testid="create-room"');
    expect(html).toContain('data-testid="join-room"');
    expect(html).toContain('data-testid="play-bot"');
  });
});

describe('App', () => {
  it('is online-enabled outside the static mode and renders Home without waiting on a session', () => {
    expect(ONLINE_ENABLED).toBe(true);
    expect(APP_ONLINE).toBe(ONLINE_ENABLED);
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('data-testid="menu-play"');
    expect(html).not.toContain('Starting guest session');
  });
});

describe('MatchScreen in solo play', () => {
  it('labels the opponent seat with the bot level', async () => {
    const match = new LocalMatch({
      level: 3,
      bot: createInlineBot(),
      delay: () => 0,
      engineSeed: expandTestSeed(2),
      botSeed: expandTestSeed(4),
    });
    await match.whenIdle();
    const html = renderToStaticMarkup(
      createElement(MatchScreen, {
        snapshot: match.getSnapshot(),
        opponentLabel: botLabel(3),
        onIncrement: noop,
        onAction: noop,
        onHome: noop,
      }),
    );
    match.leave();
    expect(html).toContain('Bot · L3 Skilled');
    expect(html).toContain('data-testid="theirs-bar"');
  });
});
