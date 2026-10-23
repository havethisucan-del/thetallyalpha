import type { ClockReading } from '../../match/cartignon/clock';
import { ClockBadge } from './ClockBadge';

/**
 * Who must act now, with the clock beside it: a small pill at the top of the action dock, beside
 * the own hand (RD-163, RD-164). Filled with the turn colour when this seat acts, quiet paper
 * otherwise; the text always says it (colour is never the only cue). The hand of the seat that
 * acts also glows (`HandRow` / `OpponentHand`).
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
  const look = myAction ? 'bg-turn text-on-turn' : 'bg-paper-raised text-ink-muted';
  return (
    <div
      className={`ink-line flex items-center gap-2 rounded-full py-0.5 pl-3 ${clock ? 'pr-0.5' : 'pr-3'} ${look}`}
      data-testid="turn-banner"
    >
      <p
        role="status"
        className="text-base leading-tight tracking-wide whitespace-nowrap"
        data-testid="turn"
        data-my-turn={myAction ? 'true' : 'false'}
      >
        {text}
      </p>
      <ClockBadge reading={clock} compact />
    </div>
  );
}
