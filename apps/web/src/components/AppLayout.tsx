import type { ReactNode } from 'react';
import { GAME_NAME } from '../config';
import { SettingsButton } from './Settings';

/**
 * Page layout for the non-match screens: header with the game name, an optional status bar and
 * the Settings button (theme, card colours), over a gold manuscript rule.
 */
export function PageLayout({
  statusBar = null,
  onReplayTutorial,
  children,
}: {
  statusBar?: ReactNode;
  /** Offered in Settings as "Replay tutorial" when given. */
  onReplayTutorial?: (() => void) | undefined;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 px-4 py-4 sm:py-6">
      <header className="ui-rule flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pb-3">
        <h1 className="text-3xl leading-none tracking-wider uppercase">{GAME_NAME}</h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {statusBar}
          <SettingsButton onReplayTutorial={onReplayTutorial} />
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}

/**
 * Full-window layout of a Cartignon match: no page header and no column, the table fills the
 * whole viewport (100dvw x 100dvh, no page scroll) and scales to it. Settings open from the
 * match's corner menu (MatchScreen).
 */
export function TableLayout({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 flex h-dvh w-dvw flex-col overflow-hidden pb-[env(safe-area-inset-bottom)]">
      <h1 className="sr-only">{GAME_NAME}</h1>
      <main className="relative flex min-h-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
