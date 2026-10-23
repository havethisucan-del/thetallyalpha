import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { NarrationLine } from '../../match/cartignon/narration';
import { ActionLog, RecentLog } from './ActionLog';

/** How long the hover preview stays after the pointer leaves (ms), so it can be reached. */
const PEEK_CLOSE_MS = 180;

export type LogMode = 'closed' | 'peek' | 'pinned';

/**
 * The event log in the right edge, under the corner menu (2026-10-23). A 44px icon button with an
 * unread badge (the toasts fly into it and stack there). Pointer hover opens a small preview of
 * the newest lines (`peek`); a click or tap pins the panel open with the full, detailed history
 * grouped by round and turn (`pinned`); a second click, Escape, the Close button or a press
 * outside closes it, and Escape / Close return focus to the button. Disclosure pattern:
 * `aria-expanded` on the button, `aria-controls` the panel. Opening (either mode) marks every line
 * as read (`onOpen`).
 */
export function LogCorner({
  history,
  currentRound,
  unread,
  onOpen,
  buttonRef,
}: {
  /** The history, oldest first. */
  history: readonly NarrationLine[];
  currentRound: number;
  unread: number;
  onOpen: () => void;
  /** The icon button (the toasts measure where to fly to). */
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  const [mode, setMode] = useState<LogMode>('closed');
  const rootRef = useRef<HTMLDivElement>(null);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelId = useId();
  const open = mode !== 'closed';

  // Opening (or new lines arriving while open) marks everything read.
  const newestKey = history.at(-1)?.key ?? null;
  useEffect(() => {
    if (open) onOpen();
  }, [open, newestKey, onOpen]);

  // A press outside closes a pinned panel.
  useEffect(() => {
    if (mode !== 'pinned') return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node && rootRef.current?.contains(event.target))) {
        setMode('closed');
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [mode]);

  useEffect(
    () => () => {
      if (peekTimer.current) clearTimeout(peekTimer.current);
    },
    [],
  );

  const focusButton = () => {
    buttonRef.current?.focus();
  };
  const cancelPeekClose = () => {
    if (peekTimer.current) clearTimeout(peekTimer.current);
    peekTimer.current = null;
  };

  return (
    <div
      ref={rootRef}
      className="ct-logcorner"
      data-mode={mode}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'mouse') return;
        cancelPeekClose();
        setMode((current) => (current === 'closed' ? 'peek' : current));
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== 'mouse') return;
        cancelPeekClose();
        peekTimer.current = setTimeout(() => {
          setMode((current) => (current === 'peek' ? 'closed' : current));
        }, PEEK_CLOSE_MS);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setMode('closed');
          focusButton();
        }
      }}
      data-testid="log-corner"
    >
      <button
        ref={buttonRef}
        type="button"
        className="ct-log-button ink-line relative inline-flex min-h-target min-w-target items-center justify-center rounded-md bg-paper-raised text-ink transition-colors hover:bg-paper-sunken aria-expanded:bg-paper-sunken"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          cancelPeekClose();
          setMode((current) => (current === 'pinned' ? 'closed' : 'pinned'));
        }}
        data-testid="log-toggle"
      >
        {/* A scroll with lines: the event log. */}
        <svg aria-hidden="true" viewBox="0 0 24 24" className="size-6" focusable="false">
          <path
            d="M6 4.5h11.5a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H6.5M6 4.5a2 2 0 0 0-2 2v1.5h4V6.5a2 2 0 0 0-2-2ZM8 8v10.5a1.5 1.5 0 0 0 3 0M10 9.5h6.5M10 12.5h6.5M10 15.5h4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="sr-only">
          Event log{unread > 0 ? `, ${unread} new ${unread === 1 ? 'event' : 'events'}` : ''}
        </span>
        {unread > 0 && (
          <span
            // Re-mounted on every change, so the pop animation replays as toasts land.
            key={unread}
            aria-hidden="true"
            className="ct-log-badge ink-line absolute -top-2 -right-2 min-w-5 rounded-full bg-turn px-1 text-center text-xs leading-4 font-semibold text-on-turn tabular-nums"
            data-testid="log-unread"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="ct-log ink-line rounded-md bg-paper-raised p-2 shadow-lg"
        data-mode={mode}
        data-testid="log-panel"
      >
        {mode === 'pinned' && (
          <ActionLog
            lines={history}
            currentRound={currentRound}
            action={
              <button
                type="button"
                className="ink-line min-h-target min-w-target shrink-0 rounded-md bg-paper-raised px-2 text-sm hover:bg-paper-sunken"
                onClick={() => {
                  setMode('closed');
                  focusButton();
                }}
                data-testid="log-close"
              >
                Close
              </button>
            }
          />
        )}
        {mode === 'peek' && <RecentLog lines={history} />}
      </div>
    </div>
  );
}
