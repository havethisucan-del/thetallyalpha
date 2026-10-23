import { readFileSync } from 'node:fs';
import { DEFAULT_COLOR_RULES, LEADER_MODIFIER_AMOUNT, type ColorRules } from '@cartignon/game-core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { previewPlacement, PREVIEW_MARGIN } from '../src/match/cartignon/cardPreview';
import { CARTIGNON_COLORS } from '../src/match/cartignon/colors';
import {
  atkDigits,
  FIGURE_VIEWBOX,
  figureBox,
  figureForLevel,
  minionColors,
  modifierLabel,
  modifierSymbol,
  TEXTURE_LAYERS,
  type MinionFigure,
} from '../src/match/cartignon/minionArt';
import type { TableCard } from '../src/match/cartignon/tableModel';
import { CardView } from '../src/screens/cartignon/CardView';
import { MinionFace } from '../src/screens/cartignon/MinionCard';

describe('minionColors', () => {
  it('uses the card colour, the colour it beats (figure) and the colour that beats it (box)', () => {
    expect(minionColors('orange')).toEqual({
      background: 'orange',
      figure: 'yellow',
      box: 'red',
    });
    expect(minionColors('blue')).toEqual({ background: 'blue', figure: 'indigo', box: 'green' });
  });

  it('follows the rules for every colour: box beats the card, the card beats the figure', () => {
    for (const color of CARTIGNON_COLORS) {
      const c = minionColors(color);
      expect(DEFAULT_COLOR_RULES[c.box]).toBe(color);
      expect(DEFAULT_COLOR_RULES[color]).toBe(c.figure);
    }
  });

  it('takes other colour rules into account (nothing hardcoded)', () => {
    const reversed: ColorRules = {
      orange: 'red',
      red: 'violet',
      violet: 'indigo',
      indigo: 'blue',
      blue: 'green',
      green: 'yellow',
      yellow: 'orange',
    };
    expect(minionColors('orange', reversed)).toEqual({
      background: 'orange',
      figure: 'red',
      box: 'yellow',
    });
  });
});

describe('figureForLevel', () => {
  it('maps levels 1-5 to Rootlet, Willow, Morrow, Oddkin, Sir Eck', () => {
    expect(([1, 2, 3, 4, 5] as const).map((level) => figureForLevel(level))).toEqual([
      { figure: 'Rootlet', name: 'Rootlet' },
      { figure: 'Willow', name: 'Willow' },
      { figure: 'Morrow', name: 'Morrow' },
      { figure: 'Oddkin', name: 'Oddkin' },
      { figure: 'SirEck', name: 'Sir Eck' },
    ]);
  });

  it('knows the viewBox of every bundled figure SVG', () => {
    const viewBox = (file: string) => {
      const svg = readFileSync(new URL(`../src/assets/cards/${file}`, import.meta.url), 'utf8');
      const match = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
      return match ? [Number(match[1]), Number(match[2])] : null;
    };
    for (const figure of Object.keys(FIGURE_VIEWBOX) as MinionFigure[]) {
      expect(viewBox(`${figure}_Blacklines.svg`), figure).toEqual(FIGURE_VIEWBOX[figure].lines);
      expect(viewBox(`${figure}_Blackout.svg`), figure).toEqual(FIGURE_VIEWBOX[figure].fill);
    }
  });

  it('sizes a figure by its viewBox x 1.01 relative to the 279 x 394 card', () => {
    expect(figureBox([279, 394])).toEqual({ width: '101%', height: '101%' });
    expect(figureBox([218, 329])).toEqual({ width: '78.918%', height: '84.338%' });
  });
});

describe('modifier labels', () => {
  it('uses the rules amount for Buff / Nerf and plain names for the rest', () => {
    expect(modifierLabel('nerfEnemyLeader')).toBe(`−${LEADER_MODIFIER_AMOUNT} ATK`);
    expect(modifierLabel('buffSelf')).toBe(`+${LEADER_MODIFIER_AMOUNT} ATK`);
    expect(modifierLabel('drawDeck')).toBe('Draw Deck');
    expect(modifierLabel('drawGrave')).toBe('Draw Grave');
    expect(modifierLabel('linkUp')).toBe('Link Up');
  });

  it('maps each modifier to its symbol', () => {
    expect(
      (['nerfEnemyLeader', 'buffSelf', 'linkUp', 'drawGrave', 'drawDeck'] as const).map(
        modifierSymbol,
      ),
    ).toEqual(['nerf', 'buff', 'link', 'grave', 'deck']);
  });
});

describe('card text and texture', () => {
  it('zero-pads ATK to three digits', () => {
    expect(atkDigits(19)).toBe('019');
    expect(atkDigits(267)).toBe('267');
    expect(atkDigits(1234)).toBe('1234');
    expect(atkDigits(-30)).toBe('-30');
  });

  it('builds four grey-noise layers with the calibrated -0.26 offset', () => {
    expect(TEXTURE_LAYERS).toHaveLength(4);
    for (const layer of TEXTURE_LAYERS) {
      expect(layer.startsWith('url("data:image/svg+xml,')).toBe(true);
      expect(decodeURIComponent(layer)).toContain('intercept="-0.26"');
    }
  });
});

describe('previewPlacement', () => {
  it('centres the enlarged card on the card when there is room', () => {
    const p = previewPlacement({ left: 300, top: 400, width: 64, height: 90 }, 800, 1000);
    expect(p.width).toBe(180);
    expect(p.height).toBe(254);
    expect(p.left).toBe(242);
    expect(p.top).toBe(318);
    expect(p.fromScale).toBeCloseTo(64 / 180);
  });

  it('stays inside a small viewport', () => {
    const p = previewPlacement({ left: 0, top: 0, width: 64, height: 90 }, 150, 600);
    expect(p.left).toBe(PREVIEW_MARGIN);
    expect(p.top).toBe(PREVIEW_MARGIN);
    expect(p.left + p.width).toBeLessThanOrEqual(150 - PREVIEW_MARGIN);
    const bottom = previewPlacement({ left: 700, top: 560, width: 64, height: 90 }, 760, 600);
    expect(bottom.left + bottom.width).toBeLessThanOrEqual(760 - PREVIEW_MARGIN);
    expect(bottom.top + bottom.height).toBeLessThanOrEqual(600 - PREVIEW_MARGIN);
  });
});

describe('minion card markup', () => {
  const card: TableCard = {
    cardId: 'c05',
    label: 'c05',
    defId: 'C-A2',
    summary: {
      kind: 'creature',
      color: 'orange',
      level: 2,
      atk: 57,
      modifiers: ['buffSelf', 'nerfEnemyLeader'],
    },
    color: 'orange',
  };

  it('renders the layers, Jaini text, colours from tokens and symbols in catalog order', () => {
    const html = renderToStaticMarkup(createElement(CardView, { card }));
    expect(html).toContain('role="img"');
    expect(html).toContain('data-figure="Willow"');
    expect(html).toContain('--minion-bg:var(--cartignon-color-orange)');
    expect(html).toContain('--minion-fig:var(--cartignon-color-yellow)');
    expect(html).toContain('--minion-box:var(--cartignon-color-red)');
    expect(html).toContain('data-t="057"');
    expect(html).toContain('data-t="LVL 2"');
    expect(html).toContain('data-t="Willow"');
    expect([...html.matchAll(/data-kind="(\w+)"/g)].map((m) => m[1])).toEqual([
      'buffSelf',
      'nerfEnemyLeader',
    ]);
    // Labels only on the enlarged face.
    expect(html).not.toContain('minion-mod-label');
  });

  it('marks the glowing modifier and shows labels on the enlarged face', () => {
    const summary = card.summary;
    if (summary?.kind !== 'creature') throw new Error('fixture');
    const html = renderToStaticMarkup(
      createElement(MinionFace, { summary, glow: { index: 1, state: 'live' }, labels: true }),
    );
    expect(html).toMatch(/data-glow="live" data-kind="nerfEnemyLeader"/);
    expect(html).not.toMatch(/data-glow="live" data-kind="buffSelf"/);
    expect(html).toContain(`>+${LEADER_MODIFIER_AMOUNT} ATK<`);
    expect(html).toContain(`>−${LEADER_MODIFIER_AMOUNT} ATK<`);
  });

  it('draws printed symbols inactive except on the Leading card', () => {
    expect(renderToStaticMarkup(createElement(CardView, { card }))).toContain(
      'data-mods="inactive"',
    );
    expect(renderToStaticMarkup(createElement(CardView, { card, leading: true }))).toContain(
      'data-mods="active"',
    );
  });
});
