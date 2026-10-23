import type { ClockReading } from '../../match/cartignon/clock';
import { clockAriaLabel, clockText, clockWarn } from '../../match/cartignon/labels';

/**
 * The running turn/choice clock (ADR-0010), `m:ss` in tabular figures. Under 10 s it switches to
 * the warn background (always with its `on-warn` ink). Renders nothing when no clock runs.
 */
export function ClockBadge({ reading }: { reading: ClockReading | null }) {
  if (reading === null) return null;
  const look = clockWarn(reading) ? 'bg-warn text-on-warn' : 'bg-paper-raised text-ink';
  return (
    <span
      role="timer"
      aria-label={clockAriaLabel(reading)}
      className={`ink-line shrink-0 rounded-md px-2 py-1 text-lg font-bold leading-none tabular-nums ${look}`}
      data-testid="clock"
      data-warn={clockWarn(reading) ? 'true' : 'false'}
      data-paused={reading.paused ? 'true' : 'false'}
    >
      {clockText(reading)}
    </span>
  );
}
