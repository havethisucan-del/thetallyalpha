import { useEffect, useState, type RefObject } from 'react';
import {
  LONG_PRESS_MS,
  LONG_PRESS_SLOP_PX,
  PREVIEW_WIDTH,
  previewPlacement,
  type PreviewPlacement,
} from '../../match/cartignon/cardPreview';

/**
 * Enlarged card preview trigger, shared by minion and spell cards: mouse hover, keyboard focus
 * (`:focus-visible` on the card or its control) or a touch long-press (hold `LONG_PRESS_MS`; the
 * tap that ends a long-press is swallowed, so a hand card is not selected by it). Escape, scroll
 * and resize close it.
 */

function focusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

/**
 * Opens the enlarged preview for the card `cardRef` from its control (the closest button, label or
 * focusable element, else the card itself). Returns the placement while open, else null.
 */
export function useCardPreview(
  cardRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  preferredWidth: number = PREVIEW_WIDTH,
): PreviewPlacement | null {
  const [placement, setPlacement] = useState<PreviewPlacement | null>(null);

  useEffect(() => {
    const card = cardRef.current;
    if (!enabled || !card) return;
    const host = card.closest<HTMLElement>('button, label, [tabindex]') ?? card;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let start: { x: number; y: number } | null = null;
    let longPressed = false;

    const show = () => {
      const r = card.getBoundingClientRect();
      setPlacement(
        previewPlacement(
          { left: r.left, top: r.top, width: r.width, height: r.height },
          window.innerWidth,
          window.innerHeight,
          preferredWidth,
        ),
      );
    };
    const hide = () => {
      setPlacement(null);
    };
    const clearTimer = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
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
      if (e.pointerType === 'mouse') return;
      longPressed = false;
      start = { x: e.clientX, y: e.clientY };
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        longPressed = true;
        show();
      }, LONG_PRESS_MS);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (timer === null || start === null) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > LONG_PRESS_SLOP_PX) clearTimer();
    };
    const onPointerEnd = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      clearTimer();
      start = null;
      if (longPressed) hide();
    };
    // The tap that ends a long-press must not select / toggle the card's control.
    const onClickCapture = (e: MouseEvent) => {
      if (!longPressed) return;
      longPressed = false;
      e.preventDefault();
      e.stopPropagation();
    };
    const onContextMenu = (e: MouseEvent) => {
      if (timer !== null || longPressed) e.preventDefault();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };

    host.addEventListener('pointerenter', onPointerEnter);
    host.addEventListener('pointerleave', onPointerLeave);
    host.addEventListener('focusin', onFocusIn);
    host.addEventListener('focusout', onFocusOut);
    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('pointermove', onPointerMove);
    host.addEventListener('pointerup', onPointerEnd);
    host.addEventListener('pointercancel', onPointerEnd);
    host.addEventListener('click', onClickCapture, true);
    host.addEventListener('contextmenu', onContextMenu);
    host.addEventListener('keydown', onKeyDown);
    // The preview is placed in viewport coordinates: any scroll closes it.
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      clearTimer();
      host.removeEventListener('pointerenter', onPointerEnter);
      host.removeEventListener('pointerleave', onPointerLeave);
      host.removeEventListener('focusin', onFocusIn);
      host.removeEventListener('focusout', onFocusOut);
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerup', onPointerEnd);
      host.removeEventListener('pointercancel', onPointerEnd);
      host.removeEventListener('click', onClickCapture, true);
      host.removeEventListener('contextmenu', onContextMenu);
      host.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [cardRef, enabled, preferredWidth]);

  return enabled ? placement : null;
}
