import {
  beatenBy,
  DEFAULT_COLOR_RULES,
  LEADER_MODIFIER_AMOUNT,
  type ColorRules,
} from '@cartignon/game-core';
import type { CartignonColor } from './colors';
import type { LiveModifierView } from './tableModel';

/**
 * Data for the illustrated minion card face (user-approved layout, `docs/cards/card-prototype.mjs`,
 * 2026-10-22). Pure and renderer-neutral: which figure a level shows, which colours a card's
 * layers use and the modifier symbol labels. The colour cycle comes from the game's rules
 * (`beatenBy` / `ColorRules`), never from a hardcoded pairing here.
 */

type ModifierKind = LiveModifierView['kind'];
export type MinionLevel = 1 | 2 | 3 | 4 | 5;

/** Figure asset base names (`<Figure>_Blacklines.svg` / `<Figure>_Blackout.svg`). */
export type MinionFigure = 'Rootlet' | 'Willow' | 'Morrow' | 'Oddkin' | 'SirEck';

export interface FigureInfo {
  figure: MinionFigure;
  /** The minion's displayed name (= its level's figure name). */
  name: string;
}

const FIGURE_BY_LEVEL: Readonly<Record<MinionLevel, FigureInfo>> = {
  1: { figure: 'Rootlet', name: 'Rootlet' },
  2: { figure: 'Willow', name: 'Willow' },
  3: { figure: 'Morrow', name: 'Morrow' },
  4: { figure: 'Oddkin', name: 'Oddkin' },
  5: { figure: 'SirEck', name: 'Sir Eck' },
};

/** The figure (and displayed name) of a minion level: 1 Rootlet … 5 Sir Eck. */
export function figureForLevel(level: MinionLevel): FigureInfo {
  return FIGURE_BY_LEVEL[level];
}

/**
 * The viewBox size (px) of each figure SVG. The card is 279 x 394 in the same units and each figure
 * is drawn at `FIGURE_SCALE` of its viewBox (test/minionArt.test.ts checks these against the files).
 */
export const FIGURE_VIEWBOX: Readonly<
  Record<MinionFigure, { lines: readonly [number, number]; fill: readonly [number, number] }>
> = {
  Rootlet: { lines: [218, 329], fill: [217, 327] },
  Willow: { lines: [245, 334], fill: [243, 332] },
  Morrow: { lines: [211, 331], fill: [208, 325] },
  Oddkin: { lines: [216, 328], fill: [213, 325] },
  SirEck: { lines: [218, 331], fill: [217, 330] },
};

export const CARD_ART_WIDTH = 279;
export const CARD_ART_HEIGHT = 394;
export const FIGURE_SCALE = 1.01;

/** A figure layer's size as percentages of the card (`width` / `height` CSS values). */
export function figureBox(size: readonly [number, number]): { width: string; height: string } {
  const pct = (value: number, of: number) => `${round((value * FIGURE_SCALE * 100) / of)}%`;
  return { width: pct(size[0], CARD_ART_WIDTH), height: pct(size[1], CARD_ART_HEIGHT) };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface MinionColors {
  /** Card background = the card's own colour. */
  background: CartignonColor;
  /** Figure fill = the colour this card's colour beats. */
  figure: CartignonColor;
  /** ATK box = the colour that beats this card's colour. */
  box: CartignonColor;
}

/**
 * The colours of a minion's layers from the colour rules. The view carries no colour rules, so the
 * table uses the game's default cycle (`DEFAULT_COLOR_RULES`, RD-01) unless `rules` is given.
 */
export function minionColors(
  color: CartignonColor,
  rules: ColorRules = DEFAULT_COLOR_RULES,
): MinionColors {
  return { background: color, figure: rules[color], box: beatenBy(rules, color) };
}

/** The CSS custom property of a Cartignon colour (follows a `[data-palette]` ancestor). */
export function colorVar(color: CartignonColor): string {
  return `var(--cartignon-color-${color})`;
}

/** ATK on the card: three digits, zero-padded (`019`); longer values are shown as they are. */
export function atkDigits(atk: number): string {
  return atk < 0 ? String(atk) : String(atk).padStart(3, '0');
}

/** The symbol shape of each modifier: ▲ Nerf, + Buff, ✱ Link Up, ● Draw Grave, ■ Draw Deck. */
export type ModifierSymbol = 'nerf' | 'buff' | 'link' | 'grave' | 'deck';

const MODIFIER_SYMBOL: Readonly<Record<ModifierKind, ModifierSymbol>> = {
  nerfEnemyLeader: 'nerf',
  buffSelf: 'buff',
  linkUp: 'link',
  drawGrave: 'grave',
  drawDeck: 'deck',
};

export function modifierSymbol(kind: ModifierKind): ModifierSymbol {
  return MODIFIER_SYMBOL[kind];
}

/**
 * Short label next to a modifier symbol on the enlarged card, e.g. `−30 ATK` (minus sign U+2212),
 * `+30 ATK`, `Draw Deck`. Buff/Nerf amounts are the rules constant (RD-39), not hardcoded here.
 */
export function modifierLabel(kind: ModifierKind): string {
  switch (kind) {
    case 'nerfEnemyLeader':
      return `−${LEADER_MODIFIER_AMOUNT} ATK`;
    case 'buffSelf':
      return `+${LEADER_MODIFIER_AMOUNT} ATK`;
    case 'linkUp':
      return 'Link Up';
    case 'drawDeck':
      return 'Draw Deck';
    case 'drawGrave':
      return 'Draw Grave';
  }
}

/**
 * Procedural grey-noise texture layers (grain, linen warp + weft, soft cloud), blended with
 * `soft-light`. The noise is offset by -0.26 so its mean sits at 50% grey and every colour renders
 * within 3/255 of its token (measured in Chromium for the prototype, 2026-10-22).
 */
export const TEXTURE_NOISE_OFFSET = -0.26;

function noise(baseFrequency: string, octaves: number, seed: number): string {
  const f = TEXTURE_NOISE_OFFSET;
  const func = (c: string) => `<feFunc${c} type="linear" slope="1" intercept="${f}"/>`;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><filter id="n">' +
    `<feTurbulence type="fractalNoise" baseFrequency="${baseFrequency}" numOctaves="${octaves}" seed="${seed}" stitchTiles="stitch"/>` +
    '<feColorMatrix type="saturate" values="0"/>' +
    `<feComponentTransfer>${func('R')}${func('G')}${func('B')}<feFuncA type="linear" slope="0" intercept="1"/></feComponentTransfer>` +
    '</filter><rect width="100%" height="100%" filter="url(#n)"/></svg>';
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** The four texture layers as CSS `background-image` values (bottom to top). */
export const TEXTURE_LAYERS: readonly string[] = [
  noise('0.9', 3, 1),
  noise('0.02 1.1', 2, 3),
  noise('1.1 0.02', 2, 7),
  noise('0.015', 4, 11),
];
