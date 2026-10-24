import { colorSchema } from '@cartignon/protocol';

/**
 * Cartignon color identity for display (R8a). On the default table color is the only visual cue
 * (user decision 2026-10-22: no letters or shape glyphs on tokens or cards). Colour-blind support
 * is a separate full palette switch (`COLORBLIND_PALETTE`), not extra glyphs. Accessible names
 * always name the color (`label`). Two palettes are data only; applying them (CSS custom
 * properties, theming) belongs to the design layer, which defines the `cssVar` properties named
 * here.
 */

/** The protocol's color names (`colorSchema` in `@cartignon/protocol`). */
export type CartignonColor = (typeof colorSchema.options)[number];

export const CARTIGNON_COLORS: readonly CartignonColor[] = colorSchema.options;

export interface ColorInfo {
  color: CartignonColor;
  label: string;
  /** CSS custom property the design layer defines for this color. */
  cssVar: string;
  /** Text on this color in the normal palette uses dark ink (mirrors `NORMAL_PALETTE`). */
  darkText: boolean;
}

export const COLOR_INFO: Readonly<Record<CartignonColor, ColorInfo>> = {
  orange: info('orange', 'Orange', true),
  yellow: info('yellow', 'Yellow', true),
  green: info('green', 'Green', true),
  blue: info('blue', 'Blue', true),
  indigo: info('indigo', 'Indigo', false),
  violet: info('violet', 'Violet', false),
  red: info('red', 'Red', false),
};

function info(color: CartignonColor, label: string, darkText: boolean): ColorInfo {
  return { color, label, cssVar: `--cartignon-color-${color}`, darkText };
}

export function colorInfo(color: CartignonColor): ColorInfo {
  return COLOR_INFO[color];
}

export interface Swatch {
  hex: string;
  /**
   * Use dark ink (`#0f172a`) on this swatch. Rule: dark ink wherever it reaches the WCAG 4.5:1
   * text contrast minimum, otherwise white. Mirrors the `--cartignon-ink-*` variables in
   * `index.css`.
   */
  darkText: boolean;
  /** Where the value comes from. */
  source: string;
}

export type Palette = Readonly<Record<CartignonColor, Swatch>>;

/** Default palette: Tailwind CSS v3 default-palette shades (hex). */
export const NORMAL_PALETTE: Palette = {
  orange: { hex: '#f97316', darkText: true, source: 'tailwind orange-500' },
  yellow: { hex: '#facc15', darkText: true, source: 'tailwind yellow-400' },
  green: { hex: '#059669', darkText: true, source: 'tailwind emerald-600' },
  // User decision 2026-10-22: lighter blue so it separates from indigo/violet on the card art.
  // Dark ink 8.4:1 (white only 2.1:1).
  blue: { hex: '#38bdf8', darkText: true, source: 'tailwind sky-400' },
  indigo: { hex: '#4338ca', darkText: false, source: 'tailwind indigo-700' },
  violet: { hex: '#c026d3', darkText: false, source: 'tailwind fuchsia-600' },
  red: { hex: '#dc2626', darkText: false, source: 'tailwind red-600' },
};

/**
 * Colour-blind safe palette (Settings -> Card colours), used by the `data-palette="colorblind"`
 * block in index.css. DERIVED, not a published palette: it starts from the Okabe & Ito (2008)
 * "Color Universal Design" colours mapped to the seven Cartignon colours (orange, yellow, bluish
 * green, sky blue, blue, reddish purple, vermillion) and was then tuned in OKLCH, each hue kept
 * inside a window that still reads as its name, to raise the smallest pairwise OKLab distance
 * under simulated protanopia, deuteranopia and tritanopia (Machado et al. 2009, severity 1) from
 * 0.076 (pure Okabe-Ito: green/violet under deuteranopia) to 0.152, while every swatch keeps one
 * ink at >= 4.5:1. All seven colours are gameplay-relevant (RD-01 counter cycle, RD-03 tokens),
 * so every pair must stay apart; colourblind.test.ts re-checks this. Colour stays the only
 * visual cue on cards (user decision 2026-10-22); accessible names always name the colour.
 */
export const COLORBLIND_PALETTE: Palette = {
  orange: { hex: '#e9af76', darkText: true, source: 'okabe-ito orange, tuned lighter' },
  yellow: { hex: '#f1f22d', darkText: true, source: 'okabe-ito yellow, tuned' },
  green: { hex: '#26917b', darkText: true, source: 'okabe-ito bluish green, tuned' },
  blue: { hex: '#6ec9fe', darkText: true, source: 'okabe-ito sky blue, tuned' },
  indigo: { hex: '#2e4089', darkText: false, source: 'okabe-ito blue, tuned darker' },
  violet: { hex: '#c154fb', darkText: true, source: 'okabe-ito reddish purple, tuned violet' },
  red: { hex: '#ff1d01', darkText: true, source: 'okabe-ito vermillion, tuned redder' },
};
