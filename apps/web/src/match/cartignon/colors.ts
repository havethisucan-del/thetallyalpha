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
 * Colorblind-safe palette from Okabe & Ito (2008), "Color Universal Design". Every hex value is
 * an original Okabe-Ito color; the palette has eight colors (including black) and no indigo or
 * violet.
 *
 * DERIVED: assigning the palette to the seven Cartignon colors is this project's own choice, not
 * part of Okabe-Ito. Orange, yellow and green map directly. Blue -> "sky blue", indigo ->
 * "blue", violet -> "reddish purple" and red -> "vermillion" are substitutions. Black is unused.
 * Intended for the future colour-blind palette toggle (colour stays the only visual cue).
 */
export const COLORBLIND_PALETTE: Palette = {
  orange: { hex: '#E69F00', darkText: true, source: 'okabe-ito orange' },
  yellow: { hex: '#F0E442', darkText: true, source: 'okabe-ito yellow' },
  green: { hex: '#009E73', darkText: true, source: 'okabe-ito bluish green' },
  blue: { hex: '#56B4E9', darkText: true, source: 'okabe-ito sky blue (derived mapping)' },
  indigo: { hex: '#0072B2', darkText: false, source: 'okabe-ito blue (derived mapping)' },
  violet: {
    hex: '#CC79A7',
    darkText: true,
    source: 'okabe-ito reddish purple (derived mapping)',
  },
  red: { hex: '#D55E00', darkText: true, source: 'okabe-ito vermillion (derived mapping)' },
};
