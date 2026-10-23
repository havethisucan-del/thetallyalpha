import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { NarrationLine } from '../../match/cartignon/narration';

/** How long a narrated line stays on the table before it leaves for the log icon (ms). */
export const LOG_TOAST_MS = 4500;
/** The flight into the log icon (ms; table.css `ct-toast-fly`, reduced motion: a fade). */
export const LOG_TOAST_FLY_MS = 560;

/** The toast leaving for the icon: the offset from its centre to the icon's centre. */
interface Flight {
  key: string;
  state: 'fly';
  x: number;
  y: number;
}

/**
 * The newest narrated event as a transient toast on the table. After `LOG_TOAST_MS` it flies into
 * the corner log icon (`target`), shrinking and fading on the way (reduced motion: a plain fade in
 * place), and `onLanded` reports its key so the icon's unread count picks it up then: the lines
 * "stack" in the icon. Screen readers get the same line from a persistent polite live region.
 */
export function LogToast({
  line,
  target,
  onLanded,
}: {
  line: NarrationLine | null;
  /** The log icon the toast flies into. */
  target?: RefObject<HTMLElement | null>;
  onLanded?: (key: string) => void;
}) {
  const [phase, setPhase] = useState<Flight | null>(null);
  const [landedKey, setLandedKey] = useState<string | null>(null);
  const toastRef = useRef<HTMLParagraphElement>(null);
  // Keyed by the line key: the narration is rebuilt on every render (e.g. each clock tick).
  const key = line?.key ?? null;
  const landedRef = useRef(onLanded);
  landedRef.current = onLanded;

  useEffect(() => {
    if (key === null) return;
    const fly = setTimeout(() => {
      const from = toastRef.current?.getBoundingClientRect();
      const to = target?.current?.getBoundingClientRect();
      const x = from && to ? to.left + to.width / 2 - (from.left + from.width / 2) : 0;
      const y = from && to ? to.top + to.height / 2 - (from.top + from.height / 2) : 0;
      setPhase({ key, state: 'fly', x, y });
    }, LOG_TOAST_MS);
    // Lands on a timer, not on `animationend`: it must land in a background tab and with
    // reduced motion too.
    const land = setTimeout(() => {
      setLandedKey(key);
      landedRef.current?.(key);
    }, LOG_TOAST_MS + LOG_TOAST_FLY_MS);
    return () => {
      clearTimeout(fly);
      clearTimeout(land);
    };
  }, [key, target]);

  const current = phase?.key === key ? phase : null;
  const visible = line !== null && line.key !== landedKey;
  const style =
    current?.state === 'fly'
      ? ({ '--fly-x': `${current.x}px`, '--fly-y': `${current.y}px` } as CSSProperties)
      : undefined;
  return (
    <>
      <div aria-live="polite" aria-atomic="true" className="sr-only" data-testid="log-live">
        {line && <p key={line.key}>{line.text}</p>}
      </div>
      {visible && (
        <p
          key={line.key}
          ref={toastRef}
          aria-hidden="true"
          className={`ct-toast ink-line max-w-full rounded-full bg-paper-raised px-3 py-1 text-base leading-snug text-ink shadow-md ${
            line.actor === 'mine' ? 'border-l-4 border-l-turn' : ''
          }`}
          style={style}
          data-phase={current?.state ?? 'show'}
          data-testid="log-toast"
          data-actor={line.actor ?? 'table'}
        >
          {line.text}
        </p>
      )}
    </>
  );
}
