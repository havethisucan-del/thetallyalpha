import {
  COLORBLIND_PALETTE,
  NORMAL_PALETTE,
  type Palette as Swatches,
} from '../match/cartignon/colors';

/**
 * Card colour palette setting (Settings → Card colours). `normal` is the default palette;
 * `colorblind` swaps every Cartignon colour for the colour-blind safe set (`COLORBLIND_PALETTE`).
 * Applied as `data-palette` on <html>, which the `--cartignon-color-*` variables in index.css
 * follow, so every card, token and swatch in the app changes at once. The choice is kept in
 * localStorage under `cartignon.palette`; every storage / DOM access is guarded (private windows,
 * blocked site data, non-browser renders), and without storage the default palette is used.
 */
export type PaletteSetting = 'normal' | 'colorblind';

export const PALETTE_SETTINGS: readonly PaletteSetting[] = ['normal', 'colorblind'];

export const PALETTE_STORAGE_KEY = 'cartignon.palette';

export const PALETTE_LABELS: Readonly<Record<PaletteSetting, string>> = {
  normal: 'Standard',
  colorblind: 'Colour-blind safe',
};

/** The storage methods used (tests pass a fake). */
export type SettingsStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): SettingsStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function defaultRoot(): HTMLElement | null {
  try {
    return typeof document === 'undefined' ? null : document.documentElement;
  } catch {
    return null;
  }
}

export function isPaletteSetting(value: unknown): value is PaletteSetting {
  return value === 'normal' || value === 'colorblind';
}

/** The swatches (hex values) a setting shows. */
export function swatchesFor(setting: PaletteSetting): Swatches {
  return setting === 'colorblind' ? COLORBLIND_PALETTE : NORMAL_PALETTE;
}

/** The stored setting; `normal` when absent, unreadable or invalid. */
export function readPalette(storage: SettingsStorage | null = defaultStorage()): PaletteSetting {
  try {
    const value = storage?.getItem(PALETTE_STORAGE_KEY) ?? null;
    return isPaletteSetting(value) ? value : 'normal';
  } catch {
    return 'normal';
  }
}

/** Stores the setting (`normal` removes the key); false when it could not be stored. */
export function writePalette(
  setting: PaletteSetting,
  storage: SettingsStorage | null = defaultStorage(),
): boolean {
  try {
    if (storage === null) return false;
    if (setting === 'normal') storage.removeItem(PALETTE_STORAGE_KEY);
    else storage.setItem(PALETTE_STORAGE_KEY, setting);
    return true;
  } catch {
    return false;
  }
}

/** Puts the setting on <html> (or the given element) as `data-palette`. */
export function applyPalette(
  setting: PaletteSetting,
  root: Pick<HTMLElement, 'dataset'> | null = defaultRoot(),
): void {
  try {
    if (root) root.dataset['palette'] = setting;
  } catch {
    // No document (non-browser render): nothing to apply.
  }
}

let current: PaletteSetting = 'normal';
const listeners = new Set<() => void>();

/** Reads the stored setting and applies it; call once before the first render. */
export function applyStoredPalette(storage: SettingsStorage | null = defaultStorage()): void {
  current = readPalette(storage);
  applyPalette(current);
}

/** The setting in effect (`useSyncExternalStore` snapshot). */
export function currentPalette(): PaletteSetting {
  return current;
}

/** Server / non-browser snapshot. */
export function serverPalette(): PaletteSetting {
  return 'normal';
}

/** Applies, stores and announces a new setting. */
export function setPalette(
  setting: PaletteSetting,
  storage: SettingsStorage | null = defaultStorage(),
): void {
  current = setting;
  applyPalette(setting);
  writePalette(setting, storage);
  for (const listener of listeners) listener();
}

/** `useSyncExternalStore` subscription. */
export function subscribePalette(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
