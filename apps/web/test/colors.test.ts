import { readFileSync } from 'node:fs';
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

  it.each([
    // The first definition of the swatch variables is the default (:root) block.
    ['normal', NORMAL_PALETTE, '--cartignon-color-orange:'],
    ['colorblind', COLORBLIND_PALETTE, "[data-palette='colorblind'] {"],
  ] as const)('%s palette matches its index.css block', (_, palette: Palette, marker) => {
    const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
    const from = css.indexOf(marker);
    expect(from, marker).toBeGreaterThanOrEqual(0);
    const block = css.slice(from, css.indexOf('}', from));
    for (const color of CARTIGNON_COLORS) {
      const match = new RegExp(`--cartignon-color-${color}:\\s*(#[0-9a-fA-F]{6});`).exec(block);
      expect(match?.[1]?.toLowerCase(), color).toBe(palette[color].hex.toLowerCase());
      const ink = new RegExp(
        `--cartignon-ink-${color}:\\s*var\\(--cartignon-ink-(dark|light)\\)`,
      ).exec(block);
      expect(ink?.[1], `${color} ink`).toBe(palette[color].darkText ? 'dark' : 'light');
    }
  });
});

/*
 * Colour-vision deficiency check. Simulation: Machado, Oliveira & Fernandes (2009) matrices at
 * severity 1.0, applied in linear sRGB; distance: Euclidean OKLab (Ottosson 2020; a just
 * noticeable difference is about 0.02). Every pair of the seven gameplay colours (RD-01, RD-03)
 * must stay clearly apart for each vision type.
 */
const CVD: Readonly<Record<string, readonly number[]>> = {
  normal: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  protanopia: [
    0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998,
  ],
  deuteranopia: [
    0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881,
  ],
  tritanopia: [
    1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039,
  ],
};

function linearRgb(hex: string): [number, number, number] {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((start) => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return [r, g, b];
}

function simulate(hex: string, m: readonly number[]): [number, number, number] {
  const [r, g, b] = linearRgb(hex);
  const at = (i: number) => m[i] ?? 0;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return [
    clamp(at(0) * r + at(1) * g + at(2) * b),
    clamp(at(3) * r + at(4) * g + at(5) * b),
    clamp(at(6) * r + at(7) * g + at(8) * b),
  ];
}

function oklab([r, g, b]: [number, number, number]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Smallest pairwise OKLab distance of a palette under one simulated vision type. */
function minDistance(palette: Palette, m: readonly number[]): { value: number; pair: string } {
  let best = { value: Infinity, pair: '' };
  CARTIGNON_COLORS.forEach((a, i) => {
    for (const b of CARTIGNON_COLORS.slice(i + 1)) {
      const [x, y] = [oklab(simulate(palette[a].hex, m)), oklab(simulate(palette[b].hex, m))];
      const value = Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
      if (value < best.value) best = { value, pair: `${a}/${b}` };
    }
  });
  return best;
}

describe('colour-blind palette', () => {
  it.each(Object.keys(CVD))('keeps every colour pair apart under %s', (vision) => {
    const worst = minDistance(COLORBLIND_PALETTE, CVD[vision] ?? []);
    // 0.15 OKLab is several times a just noticeable difference (tuned palette: >= 0.152).
    expect(worst.value, worst.pair).toBeGreaterThanOrEqual(0.15);
  });

  it('separates the closest pairs better than the standard palette does', () => {
    for (const vision of ['protanopia', 'deuteranopia', 'tritanopia']) {
      const m = CVD[vision] ?? [];
      expect(minDistance(COLORBLIND_PALETTE, m).value).toBeGreaterThan(
        minDistance(NORMAL_PALETTE, m).value,
      );
    }
  });
});
