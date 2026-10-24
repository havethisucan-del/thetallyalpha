import builtCards from '@cartignon/game-core/cards.json';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { catalogCardName, minionsByLevel } from '../src/deck/catalog';
import { DeckCards } from '../src/deck/DeckCards';
import { DeckScreen } from '../src/deck/DeckScreen';
import type { RulesSection } from '../src/deck/rulesTypes';
import { RulesView } from '../src/deck/RulesView';
import { HomeScreen } from '../src/screens/HomeScreen';

/** Deck screen (Cards / Rules tabs), markup only like the other screen tests. */

const noop = () => undefined;

const FIXTURE: readonly RulesSection[] = [
  {
    id: 'goal',
    title: 'Goal',
    blocks: [
      { kind: 'p', text: 'Win four colour tokens.' },
      { kind: 'note', text: 'Ties replay the round.' },
    ],
  },
  {
    id: 'turn',
    title: 'A turn',
    blocks: [{ kind: 'list', ordered: true, items: ['Play a card', 'Pass'] }],
    subsections: [
      {
        id: 'spells',
        title: 'Spells',
        blocks: [
          { kind: 'list', items: ['Condition', 'Primary', 'Secondary'] },
          { kind: 'card', defId: 'S-01', text: 'looks at the deck.' },
          { kind: 'card', defId: 'C-A1', text: 'a strong opener.' },
          { kind: 'card', defId: 'X-99', text: 'unknown id.' },
        ],
      },
    ],
  },
];

/** Every `data-card-id` value in the markup, in document order. */
function cardIds(html: string): string[] {
  return [...html.matchAll(/data-card-id="([^"]+)"/g)].map((m) => m[1] ?? '');
}

describe('Deck: Cards tab', () => {
  const html = renderToStaticMarkup(createElement(DeckCards));

  it('lists every catalog creature and spell exactly once', () => {
    const ids = cardIds(html);
    const expected = [...builtCards.creatures, ...builtCards.spells].map((c) => c.defId);
    expect(ids).toHaveLength(expected.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...expected].sort());
  });

  it('groups minions by level 1..5 in order, then the spells', () => {
    const headings = [...html.matchAll(/<h([23])[^>]*>([^<]+)<\/h\1>/g)].map((m) => m[2]);
    expect(headings).toEqual([
      'Minions',
      'Level 1',
      'Level 2',
      'Level 3',
      'Level 4',
      'Level 5',
      'Spells',
    ]);
    const ids = cardIds(html);
    const levelOf = new Map(builtCards.creatures.map((c) => [c.defId, c.level]));
    const levels = ids.filter((id) => levelOf.has(id)).map((id) => levelOf.get(id));
    expect(levels).toEqual([...levels].sort((a, b) => (a ?? 0) - (b ?? 0)));
    // Spells come after every creature.
    const firstSpell = ids.findIndex((id) => id.startsWith('S-'));
    expect(ids.slice(firstSpell).every((id) => id.startsWith('S-'))).toBe(true);
    for (const group of minionsByLevel()) {
      expect(group.cards.length).toBeGreaterThan(0);
    }
  });

  it('makes every card a tab stop and shows no spell hint', () => {
    expect(html.match(/tabindex="0"/g)).toHaveLength(cardIds(html).length);
    expect(html).not.toContain('data-testid="spell-hint"');
    expect(html).not.toContain('spell-verdict');
  });
});

describe('Deck: Rules tab', () => {
  const html = renderToStaticMarkup(createElement(RulesView, { sections: FIXTURE }));

  it('renders sections as h2, subsections as h3, with a contents list', () => {
    expect(html).toMatch(/<h2 id="rules-goal"[^>]*>Goal<\/h2>/);
    expect(html).toMatch(/<h2 id="rules-turn"[^>]*>A turn<\/h2>/);
    expect(html).toMatch(/<h3 id="rules-spells"[^>]*>Spells<\/h3>/);
    expect(html).toContain('<nav aria-label="Rules contents">');
    expect(html).toContain('href="#rules-goal"');
    expect(html).toContain('href="#rules-turn"');
  });

  it('renders paragraphs, lists, notes and card lines', () => {
    expect(html).toContain('<p>Win four colour tokens.</p>');
    expect(html).toMatch(/<ol[^>]*><li>Play a card<\/li><li>Pass<\/li><\/ol>/);
    expect(html).toMatch(/<ul[^>]*><li>Condition<\/li>/);
    expect(html).toMatch(/data-testid="rules-note"[^>]*>Ties replay the round.</);
    expect(html).toMatch(/aria-expanded="false"[^>]*>Foresight<\/button> looks at the deck./);
    expect(html).toContain(`>${catalogCardName('C-A1')}</button> a strong opener.`);
    expect(catalogCardName('C-A1')).toBe('Rootlet (Orange, Level 1)');
    // Unknown id: the id itself, not a button.
    expect(html).toContain('<span class="font-bold">X-99</span> unknown id.');
  });
});

describe('DeckScreen', () => {
  it('opens on Cards with a tablist and a Back control', () => {
    const html = renderToStaticMarkup(createElement(DeckScreen, { onBack: noop, rules: FIXTURE }));
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(/role="tab" id="deck-tab-cards" aria-selected="true"/);
    expect(html).toMatch(/role="tab" id="deck-tab-rules" aria-selected="false"/);
    expect(html).toContain('data-testid="deck-panel-cards"');
    expect(html).toContain('data-testid="deck-back"');
    expect(html).not.toContain('data-testid="rules"');
  });

  it('shows the Rules panel when that tab is selected', () => {
    const html = renderToStaticMarkup(
      createElement(DeckScreen, { onBack: noop, rules: FIXTURE, initialTab: 'rules' }),
    );
    expect(html).toMatch(/role="tab" id="deck-tab-rules" aria-selected="true"/);
    expect(html).toContain('data-testid="deck-panel-rules"');
    expect(html).toContain('Win four colour tokens.');
    expect(html).not.toContain('data-testid="deck-cards"');
  });
});

describe('Home menu', () => {
  it('App offers Deck after Play and before Settings', () => {
    const html = renderToStaticMarkup(createElement(App));
    const play = html.indexOf('data-testid="menu-play"');
    const deck = html.indexOf('data-testid="menu-deck"');
    const settings = html.indexOf('data-testid="menu-settings"');
    expect(play).toBeGreaterThan(-1);
    expect(deck).toBeGreaterThan(play);
    expect(settings).toBeGreaterThan(deck);
  });

  it('HomeScreen renders each given item as a menu button', () => {
    const html = renderToStaticMarkup(
      createElement(HomeScreen, {
        items: [
          { id: 'play', label: 'Play', onSelect: noop },
          { id: 'deck', label: 'Deck', onSelect: noop },
        ],
      }),
    );
    expect(html).toMatch(/data-testid="menu-deck"[^>]*>Deck<\/button>/);
  });
});
