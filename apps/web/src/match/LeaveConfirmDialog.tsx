import { useEffect, useRef } from 'react';
import { buttonClass } from '../components/ui';

interface LeaveConfirmDialogProps {
  open: boolean;
  onLeave: () => void;
  onStay: () => void;
}

/**
 * Modal "leave the match?" confirmation on the native <dialog>: showModal() traps focus and makes
 * the rest of the page inert; Escape fires `cancel`, which maps to Stay. Stay gets initial focus,
 * so a stray Enter / Space keeps the player in the match.
 */
export function LeaveConfirmDialog({ open, onLeave, onStay }: LeaveConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stayRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      stayRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="leave-confirm-title"
      className="ink-line m-auto max-w-sm rounded-lg bg-paper-raised p-5 text-ink backdrop:bg-[rgb(22_18_13/0.6)]"
      onCancel={(event) => {
        event.preventDefault(); // keep the dialog under React's control
        onStay();
      }}
      data-testid="leave-confirm"
    >
      <h2 id="leave-confirm-title" className="text-2xl leading-tight">
        Are you sure you want to leave the match?
      </h2>
      <div className="mt-4 flex justify-end gap-2">
        <button
          ref={stayRef}
          type="button"
          className={buttonClass.secondary}
          onClick={onStay}
          data-testid="leave-confirm-stay"
        >
          Stay
        </button>
        <button
          type="button"
          className={buttonClass.primary}
          onClick={onLeave}
          data-testid="leave-confirm-leave"
        >
          Leave
        </button>
      </div>
    </dialog>
  );
}
