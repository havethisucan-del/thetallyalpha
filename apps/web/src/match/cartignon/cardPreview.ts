import { CARD_ART_HEIGHT, CARD_ART_WIDTH } from './minionArt';

/**
 * Enlarged card preview (hover, keyboard focus, touch long-press): pure placement helpers.
 * The preview is centred on the card it enlarges and clamped into the viewport.
 */

/** Hold time before a touch press opens the preview (and suppresses the tap). */
export const LONG_PRESS_MS = 450;
/** A touch that moves further than this (px) is a scroll or drag, not a long-press. */
export const LONG_PRESS_SLOP_PX = 10;
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
