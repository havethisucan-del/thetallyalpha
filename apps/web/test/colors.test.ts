import { colorSchema } from '@cartignon/protocol';
import { describe, expect, it } from 'vitest';
import {
  CARTIGNON_COLORS,
  COLORBLIND_PALETTE,
  COLOR_INFO,
  NORMAL_PALETTE,
  colorInfo,
  type Palette,
} from '../src/match/cartignon/colors';

/** WCAG 2 relative luminance of a `#rrggbb` color. */
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((start) => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The dark ink used on light swatches (`--cartignon-ink-dark` in `index.css`). */
const DARK_INK = '#0f172a';

const darkInkContrast = (hex: string) => (luminance(hex) + 0.05) / (luminance(DARK_INK) + 0.05);

describe('Cartignon colors', () => {
  it('maps every protocol color', () => {
    expect([...CARTIGNON_COLORS].sort()).toEqual([...colorSchema.options].sort());
    expect(Object.keys(COLOR_INFO).sort()).toEqual([...colorSchema.options].sort());
    for (const color of colorSchema.options) expect(colorInfo(color).color).toBe(color);
  });

  it('names every color in its label and uses unique CSS variables', () => {
    const labels = CARTIGNON_COLORS.map((color) => COLOR_INFO[color].label);
    expect(labels).toEqual(['Orange', 'Yellow', 'Green', 'Blue', 'Indigo', 'Violet', 'Red']);
    const vars = CARTIGNON_COLORS.map((color) => COLOR_INFO[color].cssVar);
    expect(new Set(vars).size).toBe(7);
    expect(vars.every((name) => name.startsWith('--'))).toBe(true);
  });

  it('flags dark text for orange, yellow, green and blue', () => {
    const dark = CARTIGNON_COLORS.filter((color) => COLOR_INFO[color].darkText);
    expect(dark).toEqual(['orange', 'yellow', 'green', 'blue']);
  });

  it('flags dark text in the colorblind palette for all but indigo', () => {
    const light = CARTIGNON_COLORS.filter((color) => !COLORBLIND_PALETTE[color].darkText);
    expect(light).toEqual(['indigo']);
  });

  it.each([
    ['normal', NORMAL_PALETTE],
    ['colorblind', COLORBLIND_PALETTE],
  ] as const)(
    '%s palette: valid unique hex, darkText iff dark ink reaches 4.5:1',
    (_, palette: Palette) => {
      const hexes = CARTIGNON_COLORS.map((color) => palette[color].hex.toLowerCase());
      expect(hexes.every((hex) => /^#[0-9a-f]{6}$/.test(hex))).toBe(true);
      expect(new Set(hexes).size).toBe(7);
      for (const color of CARTIGNON_COLORS) {
        const swatch = palette[color];
        expect(swatch.darkText, color).toBe(darkInkContrast(swatch.hex) >= 4.5);
      }
    },
  );

  it('matches the info darkText flag in the normal palette', () => {
    for (const color of CARTIGNON_COLORS) {
      expect(NORMAL_PALETTE[color].darkText).toBe(COLOR_INFO[color].darkText);
    }
  });

  it('uses only original Okabe-Ito colors in the colorblind palette', () => {
    const okabeIto = new Set([
      '#E69F00',
      '#56B4E9',
      '#009E73',
      '#F0E442',
      '#0072B2',
      '#D55E00',
      '#CC79A7',
      '#000000',
    ]);
    for (const color of CARTIGNON_COLORS) {
      expect(okabeIto.has(COLORBLIND_PALETTE[color].hex), color).toBe(true);
    }
  });
});
