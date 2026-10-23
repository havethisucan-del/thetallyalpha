import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import { buttonClass } from '../components/ui';
import { spellText } from '../match/cartignon/spellArt';
import { SpellFace } from '../screens/cartignon/SpellCard';
import { findTargets, targetSelector } from './targets';
import type { TutorialMatch } from './tutorialMatch';
import { SECTION_TITLES, type TutorialState } from './types';
import './tutorialOverlay.css';

/**
 * ADR-0018: the coach panel over the match table, a paper note on the manuscript tokens
 * (`tutorialOverlay.css`). It reads the coach state and the (gated) match snapshot from
 * `TutorialMatch`, shows the step text (polite live region), the full spell face on spell
 * anatomy steps, Continue / Finish / Skip, and marks the step's highlight targets with
 * `data-tutorial-highlight` (resolved through `targets.ts`). On card steps (`step.zoom`) the
 * hand card itself is enlarged in place: it gets `data-tutorial-zoom="<part>"`, and
 * `tutorialOverlay.css` lifts it out of the fan and rings that part of its face. Persisting the outcome
 * (`markTutorial`) and leaving the match are the caller's job (`onFinish` / `onSkip`).
 *
 * Placement: right of the table's central column (hands, stacks) when the viewport leaves room
 * and the note would cover no highlighted element there ("side"); otherwise at the top
 * or the bottom, whichever covers less of the highlighted elements (`chooseVerticalPlacement`,
 * re-measured on step change, table re-render, resize and scroll). The note can also be collapsed
 * to its header and buttons. Non-modal: the table stays usable; Escape does nothing here (no
 * accidental skip).
 */

export interface TutorialOverlayProps {
  tutorial: TutorialMatch;
  /** The player skipped: record `markTutorial('skipped')` and leave the match. */
  onSkip: () => void;
  /** The player pressed Finish on the last step: record 'completed' and leave. */
  onFinish: () => void;
}

export const HIGHLIGHT_ATTRIBUTE = 'data-tutorial-highlight';
export const ZOOM_ATTRIBUTE = 'data-tutorial-zoom';

export type CoachPlacement = 'top' | 'bottom' | 'side';

/** A vertical extent in viewport pixels (a `DOMRect`'s top / bottom). */
export interface VerticalSpan {
  readonly top: number;
  readonly bottom: number;
}

/** Distance of the top note from the viewport top: below the match toolbar row. */
const TOP_OFFSET_PX = 60;
const BOTTOM_OFFSET_PX = 8;
/** Side note width (Tailwind `w-64`) and the gaps it keeps to the table and the viewport edge. */
const SIDE_WIDTH_PX = 256;
const SIDE_GAP_PX = 16;

function overlap(span: VerticalSpan, top: number, bottom: number): number {
  return Math.max(0, Math.min(span.bottom, bottom) - Math.max(span.top, top));
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

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

function boxesIntersect(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
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
    case 'continue':
      return null;
  }
}

function currentTargets(state: TutorialState, cardIdOf: (defId: string) => string): Element[] {
  if (state.status !== 'running' || state.offScript) return [];
  return findTargets(document, state.step.targets ?? [], cardIdOf);
}

/** The hand card a card step enlarges in place (only in the own hand), or null. */
function currentZoom(state: TutorialState, cardIdOf: (defId: string) => string): Element | null {
  const zoom = state.step.zoom;
  if (zoom === undefined || state.status !== 'running' || state.offScript) return null;
  const selector = targetSelector(`card:${zoom.defId}`, cardIdOf);
  return document.querySelector(`[data-testid="hand"] ${selector}`);
}

/**
 * Marks the current step's targets and decides where the note goes. Targets can appear without a
 * new snapshot (e.g. the card action bar after a hand card is tapped), so highlights and
 * placement are refreshed on DOM changes (MutationObserver, childList only: setting the highlight
 * attribute does not re-trigger it), resize and scroll, at most once per frame.
 */
function useTargets(
  noteRef: RefObject<HTMLElement | null>,
  state: TutorialState,
  cardIdOf: (defId: string) => string,
  revision: unknown,
  collapsed: boolean,
): CoachPlacement {
  const [placement, setPlacement] = useState<CoachPlacement>('top');
  const previous = useRef<'top' | 'bottom'>('top');
  const current = useRef<CoachPlacement>('top');

  useLayoutEffect(() => {
    const marked = new Set<Element>();
    let zoomed: Element | null = null;
    let frame = 0;
    const refresh = () => {
      frame = 0;
      const zoom = currentZoom(state, cardIdOf);
      if (zoomed !== zoom) zoomed?.removeAttribute(ZOOM_ATTRIBUTE);
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
      const note = noteRef.current?.getBoundingClientRect() ?? null;
      const height = note?.height ?? 0;
      const rects = targets.map((element) => element.getBoundingClientRect());
      if (sideFits(tableContentRight(), window.innerWidth)) {
        // The side note must not cover a target (e.g. the deck pile at the right end of the
        // middle line). Its height is estimated from the current note when it is not on the side
        // yet (same text, narrower box).
        const sideHeight =
          current.current === 'side' || note === null || note.width === 0
            ? height
            : (height * note.width) / SIDE_WIDTH_PX;
        const side: Box = {
          left: window.innerWidth - SIDE_GAP_PX - SIDE_WIDTH_PX,
          right: window.innerWidth - SIDE_GAP_PX,
          top: TOP_OFFSET_PX,
          bottom: Math.min(TOP_OFFSET_PX + sideHeight, window.innerHeight - SIDE_GAP_PX),
        };
        if (!rects.some((rect) => boxesIntersect(side, rect))) {
          current.current = 'side';
          setPlacement('side');
          return;
        }
      }
      const spans = rects.map((rect) => ({ top: rect.top, bottom: rect.bottom }));
      const next = chooseVerticalPlacement(spans, height, window.innerHeight, previous.current);
      previous.current = next;
      current.current = next;
      setPlacement(next);
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(refresh);
    };
    refresh();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    // Capture: the table scrolls in its own region, not the window.
    window.addEventListener('scroll', schedule, true);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      for (const element of marked) element.removeAttribute(HIGHLIGHT_ATTRIBUTE);
      zoomed?.removeAttribute(ZOOM_ATTRIBUTE);
    };
  }, [noteRef, state, cardIdOf, revision, collapsed]);

  // On a new step, bring its first target into view (the table region scrolls internally).
  // Only on step change: later re-renders must not fight the player's own scrolling.
  const scrolledStep = useRef<string | null>(null);
  useEffect(() => {
    if (scrolledStep.current === state.step.id) return;
    scrolledStep.current = state.step.id;
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
};

/** Spell steps: the full face (Condition / Primary / Secondary), `part` ringed (CSS). */
function AnatomyCard({ state }: { state: TutorialState }) {
  const anatomy = state.step.anatomy;
  if (anatomy === undefined) return null;
  const text = spellText(anatomy.defId);
  if (text === null) return null;
  return (
    <div className="flex justify-center" data-testid="tutorial-anatomy" data-part={anatomy.part}>
      <div className="w-32 sm:w-44">
        <SpellFace text={text} full />
      </div>
    </div>
  );
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
  // Collapsing applies to the current step only: a new step opens the note again.
  const [collapsedStep, setCollapsedStep] = useState<string | null>(null);
  const collapsed = collapsedStep === state.step.id;
  const placement = useTargets(noteRef, state, tutorial.cardIdOf, revision, collapsed);

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
        `bg-paper-raised p-3 text-ink sm:p-4 ${PLACEMENT_CLASS[placement]}`
      }
      data-testid="tutorial-overlay"
      data-step={state.step.id}
      data-placement={placement}
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
              setCollapsedStep(collapsed ? null : state.step.id);
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
        <AnatomyCard state={state} />
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
        {!finished && (
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
