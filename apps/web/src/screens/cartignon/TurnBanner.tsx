import type { ClockReading } from '../../match/cartignon/clock';
import { ClockBadge } from './ClockBadge';

/**
 * Who must act now, with the clock beside it. Highlighted (turn colour) when this seat acts.
 * The table keeps it in the fixed dock so it is always visible (RD-163, RD-164).
 */
export function TurnBanner({
  text,
  myAction,
  clock,
}: {
  text: string;
  myAction: boolean;
  clock: ClockReading | null;
}) {
  const look = myAction ? 'bg-turn text-on-turn' : 'bg-paper-sunken text-ink';
  return (
    <div
      className={`ink-line flex min-h-bar items-center justify-between gap-2 rounded-md px-3 py-1 ${look}`}
      data-testid="turn-banner"
    >
      <p
        role="status"
        className="text-lg font-bold uppercase tracking-wide"
        data-testid="turn"
        data-my-turn={myAction ? 'true' : 'false'}
      >
        {text}
      </p>
      <ClockBadge reading={clock} />
    </div>
  );
}
