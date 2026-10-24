import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type RefObject,
} from 'react';
import { buttonClass } from '../components/ui';
import { ZOOM_ATTRIBUTE } from '../screens/cartignon/SpellCard';
import { findTargets, targetSelector } from './targets';
import type { TutorialMatch } from './tutorialMatch';
import { SECTION_TITLES, type TutorialState } from './types';
import './tutorialOverlay.css';

/**
 * ADR-0018: the coach panel over the match table, a paper note on the manuscript tokens
 * (`tutorialOverlay.css`). It reads the coach state and the (gated) match snapshot from
 * `TutorialMatch`, shows the step text (polite live region), Continue / Finish / Skip, and marks
 * the step's highlight targets with `data-tutorial-highlight` (resolved through `targets.ts`).
 * Persisting the outcome (`markTutorial`) and leaving the match are the caller's job
 * (`onFinish` / `onSkip`).
 *
 * Card steps (`step.zoom`, revision 2026-10-25): the hand card gets `data-tutorial-zoom="<part>"`
 * and is moved to the middle of the table, enlarged to one size for minions and spells alike
 * (`zoomLayout`, from the viewport only), while the rest of the table dims
 * (`tutorialOverlay.css`). The card's slot receives the offset and scale as CSS variables
 * (`--tz-x`, `--tz-y`, `--tz-s`); the note sits beside the card (desktop) or under it (phone).
 *
 * Placement otherwise (revision 2026-10-25): next to the highlighted objects (`anchorNote`: right,
 * left, below or above them, never covering one); when nothing fits, right of the table's central
 * column ("side") or at the top or the bottom, whichever covers less (`chooseVerticalPlacement`).
 * Re-measured on step change, table re-render, resize and scroll. The note can be collapsed to
 * its header and buttons; free-play steps start collapsed so the whole table is playable.
 * Non-modal: the table stays usable; Escape does nothing here (no accidental skip).
 */

export interface TutorialOverlayProps {
  tutorial: TutorialMatch;
  /** The player skipped: record `markTutorial('skipped')` and leave the match. */
  onSkip: () => void;
  /** The player pressed Finish on the last step: record 'completed' and leave. */
  onFinish: () => void;
}

export const HIGHLIGHT_ATTRIBUTE = 'data-tutorial-highlight';
export { ZOOM_ATTRIBUTE };

export type CoachPlacement = 'top' | 'bottom' | 'side' | 'anchored';

/** A vertical extent in viewport pixels (a `DOMRect`'s top / bottom). */
export interface VerticalSpan {
  readonly top: number;
  readonly bottom: number;
}

/** A box in viewport pixels. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Where an anchored note goes (viewport pixels). */
export interface NoteBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

/** Distance of the top note from the viewport top: below the match toolbar row. */
const TOP_OFFSET_PX = 60;
const BOTTOM_OFFSET_PX = 8;
/** Side note width (Tailwind `w-64`) and the gaps it keeps to the table and the viewport edge. */
const SIDE_WIDTH_PX = 256;
const SIDE_GAP_PX = 16;
/** Anchored note: width (at most), gap to its object, margin to the viewport edge. */
const ANCHOR_WIDTH_PX = 320;
const ANCHOR_GAP_PX = 16;
const EDGE_PX = 12;
/** Stacked (phone) zoom layout: the widest note under the card. */
const STACKED_NOTE_MAX_PX = 672;
/** Zoomed card: aspect (minion art 279:394), widest size, and the note height kept free. */
const CARD_RATIO = 1.4125;
const ZOOM_MAX_WIDTH_PX = 250;
const ZOOM_NOTE_RESERVE_PX = 230;

function overlap(span: VerticalSpan, top: number, bottom: number): number {
  return Math.max(0, Math.min(span.bottom, bottom) - Math.max(span.top, top));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Top or bottom: the one whose note area overlaps the targets less (summed over targets); a tie,
 * or no targets, keeps `previous` so the note does not jump between steps.
 */
export function chooseVerticalPlacement(
  targets: readonly VerticalSpan[],
  noteHeight: number,
  viewportHeight: number,
  previous: 'top' | 'bottom',
): 'top' | 'bottom' {
  if (targets.length === 0) return previous;
  const topArea = [TOP_OFFSET_PX, TOP_OFFSET_PX + noteHeight] as const;
  const bottomArea = [viewportHeight - BOTTOM_OFFSET_PX - noteHeight, viewportHeight] as const;
  let coveredTop = 0;
  let coveredBottom = 0;
  for (const span of targets) {
    coveredTop += overlap(span, ...topArea);
    coveredBottom += overlap(span, ...bottomArea);
  }
  if (coveredTop === coveredBottom) return previous;
  return coveredTop < coveredBottom ? 'top' : 'bottom';
}

/** True when a side note fits right of the table content without touching it. */
export function sideFits(tableRight: number | null, viewportWidth: number): boolean {
  if (tableRight === null) return false;
  return tableRight + SIDE_GAP_PX <= viewportWidth - SIDE_GAP_PX - SIDE_WIDTH_PX;
}

function boxesIntersect(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function union(boxes: readonly Box[]): Box {
  return {
    left: Math.min(...boxes.map((b) => b.left)),
    top: Math.min(...boxes.map((b) => b.top)),
    right: Math.max(...boxes.map((b) => b.right)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
  };
}

export type AnchorSide = 'right' | 'left' | 'below' | 'above';
const ANCHOR_SIDES: readonly AnchorSide[] = ['right', 'left', 'below', 'above'];

/** The anchored note's width in a viewport this wide. */
export function anchorWidth(viewportWidth: number): number {
  return Math.min(ANCHOR_WIDTH_PX, viewportWidth - 2 * EDGE_PX);
}

/**
 * A note box next to the targets: right of, left of, below or above them (all targets together
 * first, then the first target alone), inside the viewport (below the toolbar row) and covering
 * none of the targets. `preferred` (the side used last) is tried first so the note does not jump.
 * Null when no side fits (or there are no targets).
 */
export function anchorNote(
  targets: readonly Box[],
  note: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  preferred: AnchorSide | null = null,
): (NoteBox & { readonly side: AnchorSide }) | null {
  const first = targets[0];
  if (first === undefined) return null;
  const { width: w, height: h } = note;
  const anchors = targets.length > 1 ? [union(targets), first] : [first];
  const sides = preferred === null ? ANCHOR_SIDES : [preferred, ...ANCHOR_SIDES];
  const maxTop = viewport.height - BOTTOM_OFFSET_PX - h;
  const maxLeft = viewport.width - EDGE_PX - w;
  for (const anchor of anchors) {
    const midY = (anchor.top + anchor.bottom) / 2;
    const midX = (anchor.left + anchor.right) / 2;
    for (const side of sides) {
      let left: number;
      let top: number;
      if (side === 'right' || side === 'left') {
        left = side === 'right' ? anchor.right + ANCHOR_GAP_PX : anchor.left - ANCHOR_GAP_PX - w;
        top = clamp(midY - h / 2, TOP_OFFSET_PX, maxTop);
      } else {
        top = side === 'below' ? anchor.bottom + ANCHOR_GAP_PX : anchor.top - ANCHOR_GAP_PX - h;
        left = clamp(midX - w / 2, EDGE_PX, maxLeft);
      }
      if (left < EDGE_PX || left > maxLeft || top < TOP_OFFSET_PX || top > maxTop) continue;
      const box: Box = { left, top, right: left + w, bottom: top + h };
      if (targets.some((target) => boxesIntersect(box, target))) continue;
      return { left, top, width: w, side };
    }
  }
  return null;
}

/**
 * Card steps: where the enlarged card and the note go. The card size depends on the viewport only
 * (never on the note text), so every zoom step shows its card at the same size, minion or spell.
 * Wide viewports: the card in the middle, the note beside it (the pair is centred when the note
 * would not fit beside a centred card). Narrow ones: the card above, the note under it, the pair
 * centred vertically. `noteHeightAt(width)` estimates the note height at a width.
 */
export function zoomLayout(
  viewport: { readonly width: number; readonly height: number },
  noteHeightAt: (width: number) => number,
): { readonly card: Box; readonly note: NoteBox } {
  const { width: vw, height: vh } = viewport;
  const availH = vh - TOP_OFFSET_PX - BOTTOM_OFFSET_PX;
  const sideW = anchorWidth(vw);
  const wide = Math.min(ZOOM_MAX_WIDTH_PX, vw * 0.64, (vh * 0.46) / CARD_RATIO);
  if (wide + ANCHOR_GAP_PX + sideW <= vw - 2 * EDGE_PX) {
    const cardH = wide * CARD_RATIO;
    const pairW = wide + ANCHOR_GAP_PX + sideW;
    const centred = vw / 2 + wide / 2 + ANCHOR_GAP_PX + sideW <= vw - EDGE_PX;
    const cardLeft = centred ? vw / 2 - wide / 2 : (vw - pairW) / 2;
    const cardTop = TOP_OFFSET_PX + Math.max(0, (availH - cardH) / 2);
    const noteH = Math.min(noteHeightAt(sideW), availH);
    return {
      card: { left: cardLeft, top: cardTop, right: cardLeft + wide, bottom: cardTop + cardH },
      note: {
        left: cardLeft + wide + ANCHOR_GAP_PX,
        top: clamp(cardTop + cardH / 2 - noteH / 2, TOP_OFFSET_PX, vh - BOTTOM_OFFSET_PX - noteH),
        width: sideW,
      },
    };
  }
  const cardW = Math.min(wide, (availH - ANCHOR_GAP_PX - ZOOM_NOTE_RESERVE_PX) / CARD_RATIO);
  const cardH = cardW * CARD_RATIO;
  const noteW = Math.min(vw - 2 * EDGE_PX, STACKED_NOTE_MAX_PX);
  const noteH = noteHeightAt(noteW);
  const top = TOP_OFFSET_PX + Math.max(0, (availH - (cardH + ANCHOR_GAP_PX + noteH)) / 2);
  const cardLeft = (vw - cardW) / 2;
  return {
    card: { left: cardLeft, top, right: cardLeft + cardW, bottom: top + cardH },
    note: { left: (vw - noteW) / 2, top: top + cardH + ANCHOR_GAP_PX, width: noteW },
  };
}

/**
 * The central column of the full-window table (hands, stacks and their badges): the side note
 * goes right of it. The table itself spans the whole viewport, so it cannot be the measure.
 */
const TABLE_CONTENT_SELECTOR = [
  'hand',
  'theirs-hand',
  'mine-seat',
  'theirs-seat',
  'mine-bar',
  'theirs-bar',
  'mine-traps',
  'theirs-traps',
]
  .map((id) => `[data-testid="${id}"]`)
  .join(', ');

function tableContentRight(): number | null {
  let right: number | null = null;
  for (const element of document.querySelectorAll(TABLE_CONTENT_SELECTOR)) {
    const r = element.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    right = Math.max(right ?? r.right, r.right);
  }
  return right;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function gateHint(state: TutorialState): string | null {
  if (state.offScript) return 'The bot went off script. Play on freely, or skip the tutorial.';
  if (state.status !== 'running') return null;
  switch (state.step.gate.kind) {
    case 'command':
      return 'Do this on the table to continue.';
    case 'event':
      return 'Watch the table…';
    case 'play':
      return 'Play on your own: the tutorial goes on when the match ends.';
    case 'continue':
      return null;
  }
}

function currentTargets(state: TutorialState, cardIdOf: (defId: string) => string): Element[] {
  if (state.status !== 'running' || state.offScript) return [];
  return findTargets(document, state.step.targets ?? [], cardIdOf);
}

/** The hand card a card step enlarges (only in the own hand), or null. */
function currentZoom(state: TutorialState, cardIdOf: (defId: string) => string): Element | null {
  const zoom = state.step.zoom;
  if (zoom === undefined || state.status !== 'running' || state.offScript) return null;
  const selector = targetSelector(`card:${zoom.defId}`, cardIdOf);
  return document.querySelector(`[data-testid="hand"] ${selector}`);
}

const ZOOM_VARS = ['--tz-x', '--tz-y', '--tz-s'] as const;

/** The hand slot (`.ct-hand-card`) of a zoomed card: it carries the zoom variables. */
function zoomSlot(card: Element | null): HTMLElement | null {
  const slot = card?.closest('.ct-hand-card');
  return slot instanceof HTMLElement ? slot : null;
}

function clearZoomVars(slot: HTMLElement | null): void {
  for (const name of ZOOM_VARS) slot?.style.removeProperty(name);
}

/**
 * Moves the zoomed card's lift onto `target` (tutorialOverlay.css applies
 * `rotate(-fan) translate(--tz-x, --tz-y) scale(--tz-s)` about the slot's own 50% 60% origin, so
 * the slot's fan rotation cancels out). Measured from layout offsets, which transforms do not
 * change, so re-measuring a zoomed card gives the same result.
 */
function placeZoomCard(slot: HTMLElement, target: Box): void {
  const row = slot.parentElement;
  if (row === null || slot.offsetWidth === 0) return;
  const rowRect = row.getBoundingClientRect();
  const w = slot.offsetWidth;
  const h = slot.offsetHeight;
  const originX = rowRect.left + slot.offsetLeft + 0.5 * w;
  const originY = rowRect.top + slot.offsetTop + 0.6 * h;
  const scale = (target.right - target.left) / w;
  const centreX = (target.left + target.right) / 2;
  const centreY = (target.top + target.bottom) / 2;
  // The card's centre lies 0.1 h above the origin; scaled about the origin it moves 0.1 h s.
  slot.style.setProperty('--tz-x', `${(centreX - originX).toFixed(1)}px`);
  slot.style.setProperty('--tz-y', `${(centreY - originY + 0.1 * h * scale).toFixed(1)}px`);
  slot.style.setProperty('--tz-s', scale.toFixed(4));
}

interface Placement {
  readonly kind: CoachPlacement;
  readonly box: NoteBox | null;
  /** The step this placement was measured for (null before the first measure). */
  readonly step: string | null;
}

function samePlacement(a: Placement, b: Placement): boolean {
  if (a.kind !== b.kind || a.step !== b.step) return false;
  if (a.box === null || b.box === null) return a.box === b.box;
  return (
    Math.abs(a.box.left - b.box.left) < 1 &&
    Math.abs(a.box.top - b.box.top) < 1 &&
    Math.abs(a.box.width - b.box.width) < 1
  );
}

const INITIAL_PLACEMENT: Placement = { kind: 'top', box: null, step: null };
/** Extra frames after a placement change, so the note is measured at its new width. */
const SETTLE_FRAMES = 3;

/**
 * Marks the current step's targets, places a zoomed card, and decides where the note goes.
 * Targets can appear without a new snapshot (e.g. the card action bar after a hand card is
 * tapped), so highlights and placement are refreshed on DOM changes (MutationObserver, childList
 * only: setting the highlight attribute does not re-trigger it), resize and scroll, at most once
 * per frame.
 */
function useTargets(
  noteRef: RefObject<HTMLElement | null>,
  state: TutorialState,
  cardIdOf: (defId: string) => string,
  revision: unknown,
  collapsed: boolean,
): Placement {
  const [placement, setPlacement] = useState<Placement>(INITIAL_PLACEMENT);
  const previous = useRef<'top' | 'bottom'>('top');
  const current = useRef<Placement>(INITIAL_PLACEMENT);
  const anchorSide = useRef<AnchorSide | null>(null);

  useLayoutEffect(() => {
    const marked = new Set<Element>();
    let zoomed: Element | null = null;
    let frame = 0;
    let settle = SETTLE_FRAMES;
    const commit = (measured: Omit<Placement, 'step'>) => {
      const next: Placement = { ...measured, step: state.step.id };
      if (samePlacement(current.current, next)) return;
      current.current = next;
      setPlacement(next);
      // Re-measure once the note has its new size (bounded, so two sizes cannot ping-pong).
      if (settle > 0) {
        settle -= 1;
        schedule();
      }
    };
    const refresh = () => {
      frame = 0;
      const zoom = currentZoom(state, cardIdOf);
      if (zoomed !== zoom) {
        zoomed?.removeAttribute(ZOOM_ATTRIBUTE);
        clearZoomVars(zoomSlot(zoomed));
      }
      if (zoom !== null && state.step.zoom !== undefined) {
        // Set before measuring, so placement sees the enlarged card.
        if (zoom.getAttribute(ZOOM_ATTRIBUTE) !== state.step.zoom.part) {
          zoom.setAttribute(ZOOM_ATTRIBUTE, state.step.zoom.part);
        }
      }
      zoomed = zoom;
      const targets = currentTargets(state, cardIdOf);
      for (const element of marked) {
        if (!targets.includes(element)) {
          element.removeAttribute(HIGHLIGHT_ATTRIBUTE);
          marked.delete(element);
        }
      }
      for (const element of targets) {
        if (!marked.has(element)) {
          element.setAttribute(HIGHLIGHT_ATTRIBUTE, 'true');
          marked.add(element);
        }
      }
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const note = noteRef.current?.getBoundingClientRect() ?? null;
      const height = note?.height ?? 0;
      // The note's height at another width (same text, wrapped differently).
      const heightAt = (width: number) =>
        note === null || note.width === 0 ? height : (height * note.width) / width;

      const slot = zoomSlot(zoom);
      if (slot !== null) {
        const layout = zoomLayout(viewport, heightAt);
        placeZoomCard(slot, layout.card);
        commit({ kind: 'anchored', box: layout.note });
        return;
      }

      const rects = targets.map((element) => element.getBoundingClientRect());
      const width = anchorWidth(viewport.width);
      const anchored = anchorNote(
        rects,
        { width, height: heightAt(width) },
        viewport,
        anchorSide.current,
      );
      if (anchored !== null) {
        anchorSide.current = anchored.side;
        commit({ kind: 'anchored', box: anchored });
        return;
      }
      anchorSide.current = null;
      if (sideFits(tableContentRight(), viewport.width)) {
        // The side note must not cover a target (e.g. the deck pile at the right end of the
        // middle line).
        const sideHeight = heightAt(SIDE_WIDTH_PX);
        const side: Box = {
          left: viewport.width - SIDE_GAP_PX - SIDE_WIDTH_PX,
          right: viewport.width - SIDE_GAP_PX,
          top: TOP_OFFSET_PX,
          bottom: Math.min(TOP_OFFSET_PX + sideHeight, viewport.height - SIDE_GAP_PX),
        };
        if (!rects.some((rect) => boxesIntersect(side, rect))) {
          commit({ kind: 'side', box: null });
          return;
        }
      }
      const spans = rects.map((rect) => ({ top: rect.top, bottom: rect.bottom }));
      const next = chooseVerticalPlacement(spans, height, viewport.height, previous.current);
      previous.current = next;
      commit({ kind: next, box: null });
    };
    function schedule() {
      if (frame === 0) frame = window.requestAnimationFrame(refresh);
    }
    const external = () => {
      settle = SETTLE_FRAMES;
      schedule();
    };
    refresh();
    const observer = new MutationObserver(external);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', external);
    // Capture: the table scrolls in its own region, not the window.
    window.addEventListener('scroll', external, true);
    // A card moving back from (or to) the zoom, or a lifted hand card, ends a transition: the
    // targets are measured where they come to rest.
    window.addEventListener('transitionend', external, true);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', external);
      window.removeEventListener('scroll', external, true);
      window.removeEventListener('transitionend', external, true);
      for (const element of marked) element.removeAttribute(HIGHLIGHT_ATTRIBUTE);
      zoomed?.removeAttribute(ZOOM_ATTRIBUTE);
      clearZoomVars(zoomSlot(zoomed));
    };
  }, [noteRef, state, cardIdOf, revision, collapsed]);

  // On a new step, bring its first target into view (the table region scrolls internally).
  // Only on step change: later re-renders must not fight the player's own scrolling.
  const scrolledStep = useRef<string | null>(null);
  useEffect(() => {
    if (scrolledStep.current === state.step.id) return;
    scrolledStep.current = state.step.id;
    if (state.step.zoom !== undefined) return; // the zoomed card is moved into view itself
    const first = currentTargets(state, cardIdOf)[0];
    first?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, [state, cardIdOf]);

  return placement;
}

const PLACEMENT_CLASS: Readonly<Record<CoachPlacement, string>> = {
  top: 'inset-x-3 top-[60px] mx-auto max-h-[60dvh] max-w-2xl',
  bottom:
    'inset-x-3 bottom-[max(0.5rem,env(safe-area-inset-bottom))] mx-auto max-h-[60dvh] max-w-2xl',
  // Below the match toolbar row too, so the toolbar buttons stay free.
  side: 'right-4 top-[60px] w-64 max-h-[calc(100dvh-76px)]',
  // Position and width come from `anchorNote` / `zoomLayout` (inline style).
  anchored: '',
};

function anchoredStyle(box: NoteBox | null): CSSProperties | undefined {
  if (box === null) return undefined;
  return {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    maxHeight: `calc(100dvh - ${box.top + BOTTOM_OFFSET_PX}px)`,
  };
}

const smallButton = 'min-h-11 px-3 text-base';

export function TutorialOverlay({ tutorial, onSkip, onFinish }: TutorialOverlayProps) {
  const state = useSyncExternalStore(
    tutorial.subscribe,
    tutorial.getTutorialState,
    tutorial.getTutorialState,
  );
  const snapshot = useSyncExternalStore(
    tutorial.subscribe,
    tutorial.getSnapshot,
    tutorial.getSnapshot,
  );
  const continueRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLElement>(null);
  const revision = snapshot.view?.revision;
  // Collapsing applies to the current step only: a new step opens the note again, except a
  // free-play step, which starts collapsed (the whole table is in play); the toggle flips that.
  // A `compact` step collapses once (latched per step) when the note cannot sit beside its
  // targets, so it does not cover them.
  const [toggledStep, setToggledStep] = useState<string | null>(null);
  const [compactStep, setCompactStep] = useState<string | null>(null);
  const startsCollapsed =
    (state.status === 'running' && state.step.gate.kind === 'play') ||
    compactStep === state.step.id;
  const collapsed = (toggledStep === state.step.id) !== startsCollapsed;
  const placement = useTargets(noteRef, state, tutorial.cardIdOf, revision, collapsed);
  const covering =
    placement.step === state.step.id && (placement.kind === 'top' || placement.kind === 'bottom');
  useEffect(() => {
    if (state.step.compact === true && covering && compactStep !== state.step.id) {
      setCompactStep(state.step.id);
    }
  }, [state.step, covering, compactStep]);

  const finished = state.status === 'finished';
  const canContinue =
    state.status === 'running' && !state.offScript && state.step.gate.kind === 'continue';
  const isLast = state.index === state.total - 1;

  // Continue / Finish takes focus when it appears (command steps leave focus on the table).
  useEffect(() => {
    if (canContinue || finished) continueRef.current?.focus({ preventScroll: true });
  }, [state, canContinue, finished]);

  if (state.status === 'skipped') return null;
  const hint = gateHint(state);
  const bodyId = 'tutorial-body';

  return (
    <section
      ref={noteRef}
      aria-labelledby="tutorial-heading"
      className={
        'tutorial-note ink-line fixed z-50 flex flex-col gap-2 overflow-hidden rounded-lg ' +
        `bg-paper-raised p-3 text-ink sm:p-4 ${PLACEMENT_CLASS[placement.kind]}`
      }
      style={placement.kind === 'anchored' ? anchoredStyle(placement.box) : undefined}
      data-testid="tutorial-overlay"
      data-step={state.step.id}
      data-placement={placement.kind}
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      <header className="tutorial-note-rule flex flex-none flex-wrap items-baseline justify-between gap-x-2 pb-1">
        <h2 id="tutorial-heading" className="text-xl leading-none">
          <span className="text-rubric">Tutorial</span> · {SECTION_TITLES[state.step.section]}
        </h2>
        <span className="ml-auto flex items-baseline gap-2">
          <span
            className="text-sm whitespace-nowrap text-ink-muted"
            data-testid="tutorial-progress"
          >
            Step {state.index + 1} of {state.total}
          </span>
          <button
            type="button"
            className="min-h-11 min-w-11 rounded-md px-2 text-base text-ink-muted underline hover:text-ink"
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            onClick={() => {
              setToggledStep(toggledStep === state.step.id ? null : state.step.id);
            }}
            data-testid="tutorial-collapse"
          >
            {collapsed ? 'Show' : 'Hide'}
          </button>
        </span>
      </header>
      {/* Only the body scrolls: the header and the buttons always stay in the note. */}
      <div
        id={bodyId}
        className="flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain"
        hidden={collapsed}
      >
        <p aria-live="polite" className="text-lg leading-snug" data-testid="tutorial-text">
          {state.step.text}
        </p>
        {hint !== null && (
          <p className="text-base text-ink-muted" data-testid="tutorial-hint">
            {hint}
          </p>
        )}
      </div>
      <div className="flex flex-none flex-wrap justify-end gap-2">
        {/* Nothing is left to skip on the last step (Finish ends the tutorial). */}
        {!finished && !isLast && (
          <button
            type="button"
            className={`${buttonClass.secondary} ${smallButton}`}
            onClick={() => {
              tutorial.skip();
              onSkip();
            }}
            data-testid="tutorial-skip"
          >
            Skip tutorial
          </button>
        )}
        {canContinue && (
          <button
            ref={continueRef}
            type="button"
            className={`${buttonClass.primary} ${smallButton}`}
            onClick={() => {
              const advanced = tutorial.continue();
              // The last Continue finishes the tutorial and leads straight out (no extra click).
              if (advanced && isLast) onFinish();
            }}
            data-testid="tutorial-continue"
          >
            {isLast ? 'Finish' : 'Continue'}
          </button>
        )}
        {finished && (
          <button
            ref={continueRef}
            type="button"
            className={`${buttonClass.primary} ${smallButton}`}
            onClick={onFinish}
            data-testid="tutorial-finish"
          >
            Choose a bot
          </button>
        )}
      </div>
    </section>
  );
}
