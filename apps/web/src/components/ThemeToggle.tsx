import { useSyncExternalStore } from 'react';
import { currentTheme, serverTheme, setTheme, subscribeTheme } from '../theme/theme';

/**
 * On/off switch for the dark theme (a toggle button: `aria-pressed` = dark on). The accessible
 * name stays "Dark theme" in both states; the icon and the pressed fill show the state. 44px
 * target, keyboard operable as a native button.
 */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, serverTheme);
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      aria-pressed={dark}
      onClick={() => {
        setTheme(dark ? 'light' : 'dark');
      }}
      className={
        'ink-line inline-flex min-h-target min-w-target shrink-0 items-center justify-center ' +
        'gap-1.5 rounded-md bg-paper-raised px-2.5 text-base leading-none text-ink ' +
        `transition-colors hover:bg-paper-sunken aria-pressed:bg-paper-sunken ${className}`
      }
      data-testid="theme-toggle"
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" className="size-5" focusable="false">
        {dark ? (
          // Crescent moon (dark on).
          <path d="M13.5 2.8a7.5 7.5 0 1 0 3.7 11.4A6.2 6.2 0 0 1 13.5 2.8Z" fill="currentColor" />
        ) : (
          // Sun (dark off).
          <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <circle cx="10" cy="10" r="3.6" fill="currentColor" />
            <path d="M10 1.5v2.2M10 16.3v2.2M1.5 10h2.2M16.3 10h2.2M4 4l1.6 1.6M14.4 14.4 16 16M4 16l1.6-1.6M14.4 5.6 16 4" />
          </g>
        )}
      </svg>
      <span>
        Dark<span className="sr-only"> theme</span>
      </span>
    </button>
  );
}
