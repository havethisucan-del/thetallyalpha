import { CARD_ART_HEIGHT, CARD_ART_WIDTH } from './minionArt';

/**
 * Enlarged card preview (hover, keyboard focus, touch long-press or double tap): pure helpers.
 * The preview is centred on the card it enlarges and clamped into the viewport.
 */

/** Hold time before a touch press opens the preview (and suppresses the tap). */
export const LONG_PRESS_MS = 450;
/** A touch that moves further than this (px) is a scroll or drag, not a long-press. */
export const LONG_PRESS_SLOP_PX = 10;
/**
 * Touch double tap (user 2026-10-23): a second tap on the same card within this many ms opens the
 * preview. The first tap keeps its normal meaning (a hand card is selected at once, no delay); the
 * second tap of the pair is swallowed, so the selection stays as the first tap left it.
 */
export const DOUBLE_TAP_MS = 300;
/** The second tap of a double tap lands within this distance (px) of the first. */
export const DOUBLE_TAP_SLOP_PX = 24;

/** One touch tap: where (viewport px) and when (ms, any monotonic clock). */
export interface Tap {
  x: number;
  y: number;
  time: number;
}

/** `next` completes a double tap with `previous` (the last tap on the same card, if any). */
export function isDoubleTap(
  previous: Tap | null,
  next: Tap,
  maxMs: number = DOUBLE_TAP_MS,
  slopPx: number = DOUBLE_TAP_SLOP_PX,
): boolean {
  if (previous === null) return false;
  const elapsed = next.time - previous.time;
  return (
    elapsed >= 0 &&
    elapsed <= maxMs &&
    Math.hypot(next.x - previous.x, next.y - previous.y) <= slopPx
  );
}

/** Preview width (px) of a minion when the viewport allows it. */
export const PREVIEW_WIDTH = 180;
/**
 * Preview width (px) of a spell: wider than a minion because it carries its full card text (the
 * approved prototype size, 240 px, keeps the body text at ~13 px).
 */
export const SPELL_PREVIEW_WIDTH = 240;
/** Minimum gap (px) between the preview and the viewport edge. */
export const PREVIEW_MARGIN = 8;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PreviewPlacement {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Start scale for the grow animation (the card's own width / preview width). */
  fromScale: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * Where the preview goes for a card at `card` in a `viewportWidth` x `viewportHeight` viewport.
 * `preferredWidth` is the preview width when the viewport allows it.
 */
export function previewPlacement(
  card: Rect,
  viewportWidth: number,
  viewportHeight: number,
  preferredWidth: number = PREVIEW_WIDTH,
): PreviewPlacement {
  const fit = Math.min(
    preferredWidth,
    viewportWidth - 2 * PREVIEW_MARGIN,
    ((viewportHeight - 2 * PREVIEW_MARGIN) * CARD_ART_WIDTH) / CARD_ART_HEIGHT,
  );
  const width = Math.max(card.width, Math.floor(fit));
  const height = Math.round((width * CARD_ART_HEIGHT) / CARD_ART_WIDTH);
  const left = clamp(
    card.left + card.width / 2 - width / 2,
    PREVIEW_MARGIN,
    Math.max(PREVIEW_MARGIN, viewportWidth - width - PREVIEW_MARGIN),
  );
  const top = clamp(
    card.top + card.height / 2 - height / 2,
    PREVIEW_MARGIN,
    Math.max(PREVIEW_MARGIN, viewportHeight - height - PREVIEW_MARGIN),
  );
  return {
    left: Math.round(left),
    top: Math.round(top),
    width,
    height,
    fromScale: width > 0 ? Math.min(1, card.width / width) : 1,
  };
}
