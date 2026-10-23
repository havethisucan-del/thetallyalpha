import type { CartignonColor } from '../../match/cartignon/colors';

/**
 * Static Tailwind class strings per Cartignon color. Written out in full so Tailwind's source
 * scanner sees every utility (no string interpolation). Text on a swatch always uses the `-ink`
 * utility, which follows the active palette (`data-palette` on an ancestor).
 */

/** Background only (the token cells and token faces); pair it with a neutral outline. */
export const SWATCH_BG: Readonly<Record<CartignonColor, string>> = {
  orange: 'bg-cartignon-orange',
  yellow: 'bg-cartignon-yellow',
  green: 'bg-cartignon-green',
  blue: 'bg-cartignon-blue',
  indigo: 'bg-cartignon-indigo',
  violet: 'bg-cartignon-violet',
  red: 'bg-cartignon-red',
};

/** Outline only (e.g. an unclaimed token); text keeps the surrounding colour. */
export const SWATCH_BORDER: Readonly<Record<CartignonColor, string>> = {
  orange: 'border-cartignon-orange',
  yellow: 'border-cartignon-yellow',
  green: 'border-cartignon-green',
  blue: 'border-cartignon-blue',
  indigo: 'border-cartignon-indigo',
  violet: 'border-cartignon-violet',
  red: 'border-cartignon-red',
};
