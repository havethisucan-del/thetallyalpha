import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialog } from '../src/components/Settings';
import { COLORBLIND_PALETTE, NORMAL_PALETTE } from '../src/match/cartignon/colors';
import { HomeScreen } from '../src/screens/HomeScreen';
import {
  applyPalette,
  applyStoredPalette,
  currentPalette,
  PALETTE_LABELS,
  PALETTE_SETTINGS,
  PALETTE_STORAGE_KEY,
  readPalette,
  setPalette,
  subscribePalette,
  swatchesFor,
  writePalette,
  type SettingsStorage,
} from '../src/settings/palette';
import {
  currentTheme,
  currentThemePreference,
  setThemePreference,
  subscribeTheme,
  THEME_PREFERENCES,
} from '../src/theme/theme';

class MemoryStorage implements SettingsStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

const throwing: SettingsStorage = {
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('QuotaExceededError');
  },
  removeItem() {
    throw new Error('SecurityError');
  },
};

/** A minimal browser: <html> dataset, localStorage and an OS dark-mode query. */
function stubBrowser(storage: SettingsStorage | null, osDark = false) {
  const dataset: Record<string, string> = {};
  vi.stubGlobal('document', { documentElement: { dataset } });
  vi.stubGlobal('localStorage', storage ?? undefined);
  vi.stubGlobal('window', {
    get localStorage() {
      if (storage === null) throw new Error('SecurityError');
      return storage;
    },
    matchMedia: () => ({
      matches: osDark,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  return dataset;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('palette setting persistence', () => {
  it('defaults to the standard palette without a valid stored value', () => {
    expect(readPalette(new MemoryStorage())).toBe('normal');
    expect(readPalette(null)).toBe('normal');
    expect(readPalette(throwing)).toBe('normal');
    const junk = new MemoryStorage();
    junk.setItem(PALETTE_STORAGE_KEY, 'rainbow');
    expect(readPalette(junk)).toBe('normal');
  });

  it('round-trips the colour-blind choice; standard removes the key', () => {
    const storage = new MemoryStorage();
    expect(writePalette('colorblind', storage)).toBe(true);
    expect(storage.items.get(PALETTE_STORAGE_KEY)).toBe('colorblind');
    expect(readPalette(storage)).toBe('colorblind');
    expect(writePalette('normal', storage)).toBe(true);
    expect(storage.items.has(PALETTE_STORAGE_KEY)).toBe(false);
    expect(readPalette(storage)).toBe('normal');
  });

  it('reports a failed write instead of throwing', () => {
    expect(writePalette('colorblind', throwing)).toBe(false);
    expect(writePalette('colorblind', null)).toBe(false);
  });

  it('applies the setting as data-palette on the given root', () => {
    const root = { dataset: {} as DOMStringMap };
    applyPalette('colorblind', root);
    expect(root.dataset['palette']).toBe('colorblind');
    applyPalette('normal', root);
    expect(root.dataset['palette']).toBe('normal');
    expect(() => {
      applyPalette('normal', null);
    }).not.toThrow();
  });

  it('setPalette applies, stores and notifies; applyStoredPalette restores it', () => {
    const storage = new MemoryStorage();
    const dataset = stubBrowser(storage);
    const listener = vi.fn();
    const unsubscribe = subscribePalette(listener);
    setPalette('colorblind', storage);
    expect(currentPalette()).toBe('colorblind');
    expect(dataset['palette']).toBe('colorblind');
    expect(storage.items.get(PALETTE_STORAGE_KEY)).toBe('colorblind');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setPalette('normal', storage);
    expect(listener).toHaveBeenCalledTimes(1);

    storage.setItem(PALETTE_STORAGE_KEY, 'colorblind');
    const fresh = stubBrowser(storage);
    applyStoredPalette(storage);
    expect(currentPalette()).toBe('colorblind');
    expect(fresh['palette']).toBe('colorblind');
    setPalette('normal', storage);
  });

  it('still switches for this page when storage throws', () => {
    const dataset = stubBrowser(null);
    setPalette('colorblind', throwing);
    expect(currentPalette()).toBe('colorblind');
    expect(dataset['palette']).toBe('colorblind');
    setPalette('normal', throwing);
  });
});

describe('palette mapping', () => {
  it('maps each setting to its swatches', () => {
    expect(PALETTE_SETTINGS).toEqual(['normal', 'colorblind']);
    expect(swatchesFor('normal')).toBe(NORMAL_PALETTE);
    expect(swatchesFor('colorblind')).toBe(COLORBLIND_PALETTE);
    expect(PALETTE_LABELS).toEqual({ normal: 'Standard', colorblind: 'Colour-blind safe' });
  });

  it('changes every colour in the colour-blind palette', () => {
    for (const color of Object.keys(NORMAL_PALETTE) as (keyof typeof NORMAL_PALETTE)[]) {
      expect(COLORBLIND_PALETTE[color].hex.toLowerCase(), color).not.toBe(
        NORMAL_PALETTE[color].hex.toLowerCase(),
      );
    }
  });
});

describe('theme preference', () => {
  it('lists System, Light and Dark', () => {
    expect(THEME_PREFERENCES).toEqual(['system', 'light', 'dark']);
  });

  it('stores Light / Dark and clears both for System', () => {
    const storage = new MemoryStorage();
    const dataset = stubBrowser(storage, true);
    const listener = vi.fn();
    const unsubscribe = subscribeTheme(listener);

    expect(currentThemePreference()).toBe('system');
    expect(currentTheme()).toBe('dark'); // follows the OS

    setThemePreference('light');
    expect(dataset['theme']).toBe('light');
    expect(storage.items.get('cartignon.theme')).toBe('light');
    expect(currentThemePreference()).toBe('light');
    expect(currentTheme()).toBe('light');

    setThemePreference('dark');
    expect(storage.items.get('cartignon.theme')).toBe('dark');
    expect(currentThemePreference()).toBe('dark');

    setThemePreference('system');
    expect(dataset['theme']).toBeUndefined();
    expect(storage.items.has('cartignon.theme')).toBe(false);
    expect(currentThemePreference()).toBe('system');
    expect(currentTheme()).toBe('dark');
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it('works for this page without storage', () => {
    const dataset = stubBrowser(null);
    setThemePreference('dark');
    expect(dataset['theme']).toBe('dark');
    setThemePreference('system');
    expect(dataset['theme']).toBeUndefined();
  });
});

describe('Settings markup', () => {
  const noop = () => undefined;

  it('offers theme and card colour radios with labels, swatch strips and Done', () => {
    const html = renderToStaticMarkup(
      createElement(SettingsDialog, { open: false, onClose: noop }),
    );
    expect(html).toContain('data-testid="settings-dialog"');
    expect(html).toMatch(/<legend[^>]*>Theme<\/legend>/);
    expect(html).toMatch(/<legend[^>]*>Card colours<\/legend>/);
    for (const value of ['system', 'light', 'dark']) {
      expect(html).toContain(`data-testid="settings-theme-${value}"`);
    }
    // Server snapshot: System and Standard are checked.
    expect(html).toMatch(/data-testid="settings-theme-system"[^>]*checked=""/);
    expect(html).toMatch(/data-testid="settings-palette-normal"[^>]*checked=""/);
    expect(html).not.toMatch(/data-testid="settings-palette-colorblind"[^>]*checked=""/);
    expect(html).toContain('Colour-blind safe');
    expect(html).toContain('data-testid="palette-strip-colorblind"');
    expect(html).toContain(`background-color:${COLORBLIND_PALETTE.violet.hex}`);
    expect(html).toContain('data-testid="settings-close"');
    expect(html).not.toContain('settings-replay-tutorial');
  });

  it('links Replay tutorial when given', () => {
    const html = renderToStaticMarkup(
      createElement(SettingsDialog, { open: false, onClose: noop, onReplayTutorial: noop }),
    );
    expect(html).toContain('data-testid="settings-replay-tutorial"');
  });

  it('puts Settings in the main menu after Play', () => {
    const html = renderToStaticMarkup(
      createElement(HomeScreen, { items: [{ id: 'play', label: 'Play', onSelect: noop }] }),
    );
    expect(html).toMatch(/data-testid="menu-play"[\s\S]*data-testid="menu-settings"/);
    expect(html).not.toContain('theme-toggle');
  });
});
