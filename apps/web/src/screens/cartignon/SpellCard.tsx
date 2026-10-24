import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import '@fontsource/jaini/latin-400.css';
import bannerUrl from '../../assets/cards/Banner.svg';
import { SPELL_PREVIEW_WIDTH } from '../../match/cartignon/cardPreview';
import {
  shrinkToFit,
  SPELL_BODY_CQW,
  SPELL_NAME_SMALL_CQW,
  VERDICT_TEXT,
  type SpellText,
  type SpellVerdict,
} from '../../match/cartignon/spellArt';
import type { TableCard } from '../../match/cartignon/tableModel';
import { CardTexture } from './CardTexture';
import { useCardPreview } from './useCardPreview';
import './spellCard.css';

/**
 * Spell card, the user-approved look of `docs/cards/spell-prototype.mjs` (2026-10-22): light paper
 * with the calibrated texture, the banner (`Banner.svg` as a mask in the ink tone) flush with the
 * top, the name in Jaini (ink fill, paper outline) and, on the enlarged card, Condition / Primary /
 * Secondary from the catalog. Every size is relative to the card width (container query units).
 *
 * Table size: banner + the name, wrapped between words (balanced) in ONE size for every spell
 * (`SPELL_NAME_SMALL_CQW`), plus the optional `footer` (the hint band). Enlarged (hover, keyboard
 * focus, touch long-press or double tap; `useCardPreview`): the full text and, with a hint, the verdict chip; the
 * effect that would fire stays full strength, the other fades. The enlarged copy is decorative
 * (`aria-hidden`); the card's accessible name carries the name and the hint. A tutorial zoom
 * (`ZOOM_ATTRIBUTE`) draws the full text on the card itself, without a verdict.
 */

const BANNER_MASK = `url("${bannerUrl}")`;

export function SpellFace({
  text,
  full = false,
  verdict = null,
  footer,
  fitFrom = SPELL_BODY_CQW,
  className = '',
}: {
  text: SpellText;
  /** The enlarged card: the full text (and the verdict chip when `verdict` is set). */
  full?: boolean;
  verdict?: SpellVerdict | null;
  /** Table size only: a band under the name (the spell hint). */
  footer?: ReactNode;
  /** Enlarged card: the body size (`cqw`) the fit starts from and shrinks down from. */
  fitFrom?: number;
  className?: string;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Long spells: shrink the body text until it fits the card (from the approved size down).
  // Measured again once the web font is ready, since the fallback font has other metrics.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!full || !body) return;
    let active = true;
    const fit = () => {
      if (!active) return;
      const size = shrinkToFit((fs) => {
        body.style.setProperty('--spell-fs', `${fs}cqw`);
        return body.scrollHeight <= body.clientHeight;
      }, fitFrom);
      body.style.setProperty('--spell-fs', `${size}cqw`);
      body.dataset['fs'] = String(size);
    };
    fit();
    void document.fonts.ready.then(fit);
    return () => {
      active = false;
    };
  }, [full, text, verdict, fitFrom]);

  return (
    <div
      className={`spell-card card-edge ${full ? 'spell-full' : 'spell-small'} ${className}`}
      data-verdict={verdict ?? undefined}
      style={
        {
          '--spell-name-small': `${SPELL_NAME_SMALL_CQW}cqw`,
          '--spell-body-fs': `${SPELL_BODY_CQW}cqw`,
        } as CSSProperties
      }
    >
      <div
        className="spell-banner"
        style={{ WebkitMaskImage: BANNER_MASK, maskImage: BANNER_MASK }}
      />
      <div className="spell-name" lang="en">
        <span>{text.name}</span>
      </div>
      {full && (
        <div ref={bodyRef} className="spell-body" data-testid="spell-body">
          {verdict && (
            <div className="spell-verdict" data-testid="spell-verdict">
              <span className="spell-verdict-mark">{VERDICT_TEXT[verdict].mark}</span>
              {VERDICT_TEXT[verdict].text}
            </div>
          )}
          <p className="spell-cond">
            <b>Condition</b> {text.condition}
          </p>
          <p className="spell-pri">
            <b>Primary</b> {text.primary}
          </p>
          <p className="spell-sec">
            <b>Secondary</b> {text.secondary}
          </p>
        </div>
      )}
      <CardTexture />
      {!full && footer}
    </div>
  );
}

/**
 * ADR-0018: the tutorial enlarges a hand card in place by setting this attribute on its
 * `data-card-id` element (`TutorialOverlay`); the value names the part of the face it rings.
 */
export const ZOOM_ATTRIBUTE = 'data-tutorial-zoom';

/**
 * Body size a zoomed spell's fit starts from (`cqw`): larger than the preview's, since the card is
 * smaller on screen than the preview and its free space is otherwise left empty.
 */
const ZOOM_BODY_CQW = 8;

/**
 * The tutorial zoom on `ref` (the attribute's value), or null. A zoomed spell shows its full text
 * in place, since the table-size face carries only the name.
 */
function useZoomAttribute(ref: RefObject<HTMLElement | null>): string | null {
  const [zoom, setZoom] = useState<string | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof MutationObserver === 'undefined') return;
    const read = () => {
      setZoom(element.getAttribute(ZOOM_ATTRIBUTE));
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(element, { attributes: true, attributeFilter: [ZOOM_ATTRIBUTE] });
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return zoom;
}

/** A spell at table size with its enlarged preview. */
export function SpellCard({
  card,
  text,
  label,
  title,
  verdict = null,
  footer,
  preview = true,
  focusable = false,
  tapPreview = false,
}: {
  card: TableCard;
  text: SpellText;
  label: string;
  title?: string;
  verdict?: SpellVerdict | null;
  footer?: ReactNode;
  preview?: boolean;
  focusable?: boolean;
  /** A tap or click also opens / toggles the preview. */
  tapPreview?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const zoomed = useZoomAttribute(ref) !== null;
  // Zoomed (tutorial): the full text on the card itself, no hover copy on top of it.
  const placement = useCardPreview(ref, preview && !zoomed, SPELL_PREVIEW_WIDTH, tapPreview);

  return (
    <>
      <div
        ref={ref}
        role="img"
        aria-label={label}
        title={title}
        tabIndex={focusable ? 0 : undefined}
        className="relative w-card-w shrink-0 select-none rounded-md"
        data-card-id={card.cardId}
        data-spell-verdict={verdict ?? undefined}
      >
        {zoomed ? (
          // All three parts at full strength (no verdict fade): the tutorial explains each.
          <SpellFace text={text} full fitFrom={ZOOM_BODY_CQW} className="rounded-md" />
        ) : (
          <SpellFace text={text} verdict={verdict} footer={footer} className="rounded-md" />
        )}
      </div>
      {placement &&
        createPortal(
          <div
            aria-hidden="true"
            className="card-preview"
            style={
              {
                left: placement.left,
                top: placement.top,
                width: placement.width,
                '--preview-from': placement.fromScale,
              } as CSSProperties
            }
            data-testid="card-preview"
          >
            <SpellFace text={text} full verdict={verdict} className="rounded-lg" />
          </div>,
          document.body,
        )}
    </>
  );
}
