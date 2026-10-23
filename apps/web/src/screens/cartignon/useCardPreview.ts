import { useEffect, useState, type RefObject } from 'react';
import {
  isDoubleTap,
  LONG_PRESS_MS,
  LONG_PRESS_SLOP_PX,
  PREVIEW_WIDTH,
  previewPlacement,
  type PreviewPlacement,
  type Tap,
} from '../../match/cartignon/cardPreview';

/**
 * Enlarged card preview trigger, shared by minion and spell cards: mouse hover, keyboard focus
 * (`:focus-visible` on the card or its control), or on touch a long-press (hold `LONG_PRESS_MS`)
 * or a double tap (user 2026-10-23, `DOUBLE_TAP_MS`). Escape, scroll and resize close it.
 *
 * Touch (long-press and double tap alike): the preview stays open after the finger lifts, until
 * the next tap anywhere (a tap on the same card only closes it and is swallowed; a tap elsewhere
 * closes it and does its normal job), Escape or a scroll. It used to close on release, so it was
 * only visible under the finger, and any browser gesture that cancelled the press (pointercancel)
 * closed it at once.
 *
 * Double tap without a delay: the first tap keeps its normal meaning at once (a hand card is
 * selected exactly as before); the second tap of the pair is swallowed (never reaches the card's
 * control), so the selection stays where the first tap left it, and the first tap's card opens.
 * A selected hand card lifts a little, so the second tap may land on a neighbour: the pair is
 * matched by time and place across cards (`lastTouchTap`), and the card of the FIRST tap opens.
 * The table sets `touch-action: manipulation` (table.css) so the browser's double-tap zoom does
 * not take the second tap.
 */

function focusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

/** A touch click arriving this long (ms) after its pointerup is not that tap's click. */
const TAP_CLICK_MS = 1000;

/** The last single touch tap on any previewable card (the first half of a possible double tap). */
let lastTouchTap: { tap: Tap; open: () => void } | null = null;

/**
 * Opens the enlarged preview for the card `cardRef` from its control (the closest button, label or
 * focusable element, else the card itself). Returns the placement while open, else null.
 * `tapToggle` (read-only cards such as the stacks): a tap or click opens the preview too, a second
 * tap on the card or a press anywhere else closes it.
 */
export function useCardPreview(
  cardRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  preferredWidth: number = PREVIEW_WIDTH,
  tapToggle = false,
): PreviewPlacement | null {
  const [placement, setPlacement] = useState<PreviewPlacement | null>(null);

  useEffect(() => {
    const card = cardRef.current;
    if (!enabled || !card) return;
    const host = card.closest<HTMLElement>('button, label, [tabindex]') ?? card;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let start: { x: number; y: number } | null = null;
    let moved = false;
    let longPressed = false;
    let open = false;
    let lastPointer = 'mouse';
    /** The touch tap whose click is still to come (set on pointerup). */
    let pendingTap: Tap | null = null;

    const show = () => {
      const r = card.getBoundingClientRect();
      open = true;
      setPlacement(
        previewPlacement(
          { left: r.left, top: r.top, width: r.width, height: r.height },
          window.innerWidth,
          window.innerHeight,
          // Large table cards (wide screens) still get a clearly larger preview.
          Math.max(preferredWidth, Math.round(r.width * 1.8)),
        ),
      );
    };
    const hide = () => {
      open = false;
      setPlacement(null);
    };
    const clearTimer = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const onPointerEnter = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') show();
    };
    const onPointerLeave = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      // Keep it open while the control still has keyboard focus.
      const active = document.activeElement;
      if (!(active && host.contains(active) && focusVisible(active))) hide();
    };
    const onFocusIn = (e: FocusEvent) => {
      if (e.target instanceof Element && focusVisible(e.target)) show();
    };
    const onFocusOut = () => {
      hide();
    };
    const onPointerDown = (e: PointerEvent) => {
      lastPointer = e.pointerType;
      pendingTap = null;
      if (e.pointerType === 'mouse') return;
      longPressed = false;
      moved = false;
      start = { x: e.clientX, y: e.clientY };
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        longPressed = true;
        show();
      }, LONG_PRESS_MS);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (start === null) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > LONG_PRESS_SLOP_PX) {
        moved = true;
        clearTimer();
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      clearTimer();
      if (!longPressed && !moved) pendingTap = { x: e.clientX, y: e.clientY, time: e.timeStamp };
      start = null;
    };
    const onPointerCancel = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      // A long-press preview stays open; a scroll that cancelled the press closes it (scroll).
      clearTimer();
      start = null;
    };
    // Capture phase: a swallowed tap never reaches the card's control (or the tap toggle below).
    const onClickCapture = (e: MouseEvent) => {
      if (longPressed) {
        // The tap that ends a long-press must not select / toggle the card's control.
        longPressed = false;
        lastTouchTap = null;
        swallow(e);
        return;
      }
      const tap = pendingTap;
      pendingTap = null;
      if (tap === null || e.timeStamp - tap.time > TAP_CLICK_MS) return;
      if (lastTouchTap !== null && isDoubleTap(lastTouchTap.tap, tap)) {
        const openFirst = lastTouchTap.open;
        lastTouchTap = null;
        swallow(e);
        openFirst();
        return;
      }
      if (open && !tapToggle) {
        // A touch-opened preview: the next tap on its card only closes it.
        lastTouchTap = null;
        swallow(e);
        hide();
        return;
      }
      lastTouchTap = { tap, open: show };
    };
    // Tap toggle: runs after the capture handler above (a swallowed tap never gets here).
    const onTap = () => {
      if (!tapToggle) return;
      if (lastPointer === 'mouse' || !open) show();
      else hide();
    };
    const onDocumentPointerDown = (e: PointerEvent) => {
      if (open && !(e.target instanceof Node && host.contains(e.target))) hide();
    };
    const onContextMenu = (e: MouseEvent) => {
      if (timer !== null || longPressed) e.preventDefault();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) hide();
    };

    host.addEventListener('pointerenter', onPointerEnter);
    host.addEventListener('pointerleave', onPointerLeave);
    host.addEventListener('focusin', onFocusIn);
    host.addEventListener('focusout', onFocusOut);
    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('pointermove', onPointerMove);
    host.addEventListener('pointerup', onPointerUp);
    host.addEventListener('pointercancel', onPointerCancel);
    host.addEventListener('click', onClickCapture, true);
    host.addEventListener('click', onTap);
    // A press anywhere else closes a tap / long-press / double-tap preview.
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    host.addEventListener('contextmenu', onContextMenu);
    // Escape anywhere (a touch-opened preview has no focus on its card).
    document.addEventListener('keydown', onKeyDown);
    // The preview is placed in viewport coordinates: any scroll closes it.
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      clearTimer();
      if (lastTouchTap?.open === show) lastTouchTap = null;
      host.removeEventListener('pointerenter', onPointerEnter);
      host.removeEventListener('pointerleave', onPointerLeave);
      host.removeEventListener('focusin', onFocusIn);
      host.removeEventListener('focusout', onFocusOut);
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerup', onPointerUp);
      host.removeEventListener('pointercancel', onPointerCancel);
      host.removeEventListener('click', onClickCapture, true);
      host.removeEventListener('click', onTap);
      document.removeEventListener('pointerdown', onDocumentPointerDown, true);
      host.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [cardRef, enabled, preferredWidth, tapToggle]);

  return enabled ? placement : null;
}
