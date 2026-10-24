import { useSyncExternalStore } from 'react';
import {
  currentThemePreference,
  serverThemePreference,
  subscribeTheme,
  type ThemePreference,
} from '../theme/theme';
import { currentPalette, serverPalette, subscribePalette, type PaletteSetting } from './palette';

/** The Settings theme choice (System / Light / Dark), live. */
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribeTheme, currentThemePreference, serverThemePreference);
}

/** The card colour palette setting, live. */
export function usePalette(): PaletteSetting {
  return useSyncExternalStore(subscribePalette, currentPalette, serverPalette);
}
