import { buttonClass } from '../components/ui';
import { ThemeToggle } from '../components/ThemeToggle';
import { GAME_NAME } from '../config';

/** One entry of the Home menu (more follow later: Settings, Stats, …). */
export interface HomeMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
}

/**
 * Title screen: the game name as a large manuscript title and a vertical menu (later items stack
 * below Play). Needs no server and never waits on one, so it renders the same in the static
 * (solo-only) build. The theme toggle sits in the top corner.
 */
export function HomeScreen({ items }: { items: readonly HomeMenuItem[] }) {
  return (
    <div className="relative mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pt-3 pb-8">
      <div className="fixed top-3 right-4 z-10">
        <ThemeToggle />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-10">
        <h1 className="ui-title text-center">{GAME_NAME}</h1>
        <nav aria-label="Main menu" className="w-full max-w-xs">
          <ul className="flex flex-col gap-3">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`${buttonClass.primary} min-h-14 w-full text-3xl! tracking-widest uppercase`}
                  onClick={item.onSelect}
                  data-testid={`menu-${item.id}`}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </div>
  );
}
