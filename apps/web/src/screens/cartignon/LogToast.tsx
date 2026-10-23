import { useEffect, useState } from 'react';
import type { NarrationLine } from '../../match/cartignon/narration';

/** How long a narrated line stays on the table (ms). */
export const LOG_TOAST_MS = 4500;

/**
 * The newest narrated event as a transient toast on the table (the full log sits behind the
 * corner menu). Visible for `LOG_TOAST_MS`, then gone until the next line; a timer, not an
 * animation, so it behaves the same with reduced motion. Screen readers get the same line from a
 * persistent polite live region.
 */
export function LogToast({ line }: { line: NarrationLine | null }) {
  const [expiredKey, setExpiredKey] = useState<string | null>(null);
  // Keyed by the line key: the narration is rebuilt on every render (e.g. each clock tick).
  const key = line?.key ?? null;
  useEffect(() => {
    if (key === null) return;
    const timer = setTimeout(() => {
      setExpiredKey(key);
    }, LOG_TOAST_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [key]);
  const visible = line !== null && line.key !== expiredKey;
  return (
    <>
      <div aria-live="polite" aria-atomic="true" className="sr-only" data-testid="log-live">
        {line && <p key={line.key}>{line.text}</p>}
      </div>
      {visible && (
        <p
          key={line.key}
          aria-hidden="true"
          className={`ink-line max-w-full rounded-full bg-paper-raised px-3 py-1 text-base leading-snug text-ink shadow-md ${
            line.actor === 'mine' ? 'border-l-4 border-l-turn' : ''
          }`}
          data-testid="log-toast"
          data-actor={line.actor ?? 'table'}
        >
          {line.text}
        </p>
      )}
    </>
  );
}
