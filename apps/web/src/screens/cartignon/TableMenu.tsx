import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/**
 * The small corner menu of the full-window match (top right): one 44px button that opens a short
 * column of items (theme, log, debug, leave). Disclosure pattern: `aria-expanded` on the button,
 * the items stay in the DOM while closed (`hidden`). Escape or a press outside closes it; Escape
 * returns focus to the button. Optional `status` (online connection) sits left of the button.
 */
export function TableMenu({
  status = null,
  children,
}: {
  status?: ReactNode;
  /** The items; `close` closes the menu (call it after an item that changes the view). */
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node && rootRef.current?.contains(event.target))) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
  };

  return (
    <div
      ref={rootRef}
      className="absolute top-[max(var(--menu-gut),env(safe-area-inset-top))] right-(--menu-gut) z-50 flex items-start gap-2 [--menu-gut:clamp(6px,1.1vmin,16px)]"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
      data-testid="table-menu"
    >
      {status && <div className="mt-3 min-w-0 text-sm">{status}</div>}
      <div className="relative">
        <button
          ref={buttonRef}
          type="button"
          className="ink-line inline-flex min-h-target min-w-target items-center justify-center rounded-md bg-paper-raised text-ink transition-colors hover:bg-paper-sunken aria-expanded:bg-paper-sunken"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => {
            setOpen((current) => !current);
          }}
          data-testid="menu-toggle"
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" className="size-5" focusable="false">
            <path
              d="M3 5.5h14M3 10h14M3 14.5h14"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          <span className="sr-only">Menu</span>
        </button>
        <div
          id={panelId}
          hidden={!open}
          className="ink-line absolute top-full right-0 mt-1.5 flex w-max min-w-40 flex-col items-stretch gap-1.5 rounded-md bg-paper-raised p-1.5 shadow-lg"
        >
          {children(close)}
        </div>
      </div>
    </div>
  );
}
