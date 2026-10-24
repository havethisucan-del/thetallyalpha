import { useState } from 'react';
import { SettingsDialog } from '../components/Settings';
import { buttonClass } from '../components/ui';
import { GAME_NAME } from '../config';

/** One entry of the Home menu (Settings is built in and always last). */
export interface HomeMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
}

/**
 * Title screen: the game name as a large manuscript title and a vertical menu (later items stack
 * below Play). Needs no server and never waits on one, so it renders the same in the static
 * (solo-only) build. The last menu entry opens Settings (theme, card colours, Replay tutorial).
 */
export function HomeScreen({
  items,
  onReplayTutorial,
}: {
  items: readonly HomeMenuItem[];
  /** Offered in Settings as "Replay tutorial" when given. */
  onReplayTutorial?: (() => void) | undefined;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const menuButtonClass = `${buttonClass.primary} min-h-14 w-full text-3xl! tracking-widest uppercase`;
  return (
    <div className="relative mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pt-3 pb-8">
      <div className="flex flex-1 flex-col items-center justify-center gap-10">
        <h1 className="ui-title text-center">{GAME_NAME}</h1>
        <nav aria-label="Main menu" className="w-full max-w-xs">
          <ul className="flex flex-col gap-3">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={menuButtonClass}
                  onClick={item.onSelect}
                  data-testid={`menu-${item.id}`}
                >
                  {item.label}
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                className={`${buttonClass.secondary} min-h-14 w-full text-3xl! tracking-widest uppercase`}
                aria-haspopup="dialog"
                onClick={() => {
                  setSettingsOpen(true);
                }}
                data-testid="menu-settings"
              >
                Settings
              </button>
            </li>
          </ul>
        </nav>
      </div>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
        }}
        onReplayTutorial={onReplayTutorial}
      />
    </div>
  );
}
