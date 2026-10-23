import type { ReactNode } from 'react';
import { GAME_NAME } from '../config';
import { ThemeToggle } from './ThemeToggle';

/**
 * Page layout for the non-match screens: header with the game name, an optional status bar and
 * the theme toggle, over a gold manuscript rule.
 */
export function PageLayout({
  statusBar = null,
  children,
}: {
  statusBar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 px-4 py-4 sm:py-6">
      <header className="ui-rule flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pb-3">
        <h1 className="text-3xl leading-none tracking-wider uppercase">{GAME_NAME}</h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {statusBar}
          <ThemeToggle />
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}

/**
 * Full-viewport layout of a Cartignon match: no page header, the table fills the remaining height
 * and scrolls internally (R8b). The theme toggle sits in the match toolbar (MatchScreen).
 */
export function TableLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex h-dvh w-full max-w-3xl flex-col overflow-hidden px-3 pt-[max(0.5rem,env(safe-area-inset-top))]">
      <h1 className="sr-only">{GAME_NAME}</h1>
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
