/**
 * Light / dark UI theme. Without a stored choice the page follows `prefers-color-scheme` (pure
 * CSS, no attribute). A Light / Dark choice in Settings sets `data-theme="light" | "dark"` on <html>
 * and is kept in localStorage. Every storage / matchMedia access is guarded: private windows,
 * blocked site data and non-browser renders (tests) simply fall back to the OS preference.
 */
export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'cartignon.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

function readStored(): Theme | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

function writeStored(theme: Theme): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}

function darkQuery(): MediaQueryList | null {
  try {
    return window.matchMedia(DARK_QUERY);
  } catch {
    return null;
  }
}

function explicitTheme(): Theme | null {
  try {
    const value = document.documentElement.dataset['theme'];
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

/** The theme in effect: the explicit choice, else the OS preference. */
export function currentTheme(): Theme {
  return explicitTheme() ?? (darkQuery()?.matches ? 'dark' : 'light');
}

/** Applies a stored choice to <html>; call once before the first render. */
export function applyStoredTheme(): void {
  const stored = typeof window === 'undefined' ? null : readStored();
  if (stored === null) return;
  try {
    document.documentElement.dataset['theme'] = stored;
  } catch {
    // No document (non-browser render): nothing to apply.
  }
}

const listeners = new Set<() => void>();

/** Sets and stores an explicit theme. */
export function setTheme(theme: Theme): void {
  try {
    document.documentElement.dataset['theme'] = theme;
  } catch {
    return;
  }
  writeStored(theme);
  for (const listener of listeners) listener();
}

/** The Settings choice: follow the OS (`system`, no attribute, nothing stored) or a fixed theme. */
export type ThemePreference = 'system' | Theme;

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];

/** The choice in effect on <html>: `system` when no explicit theme is set. */
export function currentThemePreference(): ThemePreference {
  return explicitTheme() ?? 'system';
}

/** Server / non-browser snapshot of the preference. */
export function serverThemePreference(): ThemePreference {
  return 'system';
}

/** Applies and stores a Settings choice; `system` removes the attribute and the stored value. */
export function setThemePreference(preference: ThemePreference): void {
  if (preference !== 'system') {
    setTheme(preference);
    return;
  }
  try {
    delete document.documentElement.dataset['theme'];
  } catch {
    return;
  }
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable: nothing was stored either.
  }
  for (const listener of listeners) listener();
}

/** `useSyncExternalStore` subscription: explicit changes and OS preference changes. */
export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  const query = darkQuery();
  query?.addEventListener('change', listener);
  return () => {
    listeners.delete(listener);
    query?.removeEventListener('change', listener);
  };
}

/** Server / non-browser snapshot. */
export function serverTheme(): Theme {
  return 'light';
}
