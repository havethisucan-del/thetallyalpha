import { useRef, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import '@fontsource/jaini/latin-400.css';
import {
  atkDigits,
  colorVar,
  FIGURE_VIEWBOX,
  figureBox,
  figureForLevel,
  minionColors,
  modifierLabel,
  modifierSymbol,
  type ModifierSymbol,
} from '../../match/cartignon/minionArt';
import { PREVIEW_WIDTH } from '../../match/cartignon/cardPreview';
import { modifierText } from '../../match/cartignon/labels';
import type { ModifierGlow } from '../../match/cartignon/modifierGlow';
import type { TableCard } from '../../match/cartignon/tableModel';
import { CardTexture } from './CardTexture';
import { FIGURE_URLS } from './minionFigures';
import { useCardPreview } from './useCardPreview';
import './minionCard.css';

/**
 * Illustrated minion (creature) card, the user-approved layout of `docs/cards/card-prototype.mjs`
 * (2026-10-22). Layers bottom to top: card colour, ATK box (the colour that beats the card),
 * figure fill (the colour the card beats, `<Figure>_Blackout.svg` as a mask), figure line art,
 * four soft-light noise layers, box outline, then ATK/LVL, name and the modifier symbols.
 * Every size is relative to the card width (container query units), so the same face renders at
 * table size (64 px) and enlarged.
 *
 * Enlarged view (`useCardPreview`): mouse hover, keyboard focus or a touch long-press shows a
 * larger copy with a text label next to each modifier
 * symbol. The copy is decorative (`aria-hidden`); the card's accessible name carries the same
 * information.
 */

type CreatureSummary = Extract<NonNullable<TableCard['summary']>, { kind: 'creature' }>;

const SYMBOL_SHAPES: Readonly<Record<ModifierSymbol, ReactNode>> = {
  nerf: <polygon points="12,3 21.5,20 2.5,20" />,
  buff: <path d="M8.5 2.5h7v6h6v7h-6v6h-7v-6h-6v-7h6z" />,
  grave: <circle cx="12" cy="12" r="9.5" />,
  deck: <rect x="3" y="3" width="18" height="18" />,
  link: (
    <path d="M10 1.5h4l-.6 6.3 5.1-3.7 2 3.4-5.8 2.5 5.8 2.5-2 3.4-5.1-3.7.6 6.3h-4l.6-6.3-5.1 3.7-2-3.4 5.8-2.5-5.8-2.5 2-3.4 5.1 3.7z" />
  ),
};

/** Text with a black outline drawn behind it, offset slightly (intentional misregistration). */
function Ink({ className, text }: { className: string; text: string }) {
  return (
    <span className={`minion-ink ${className}`} data-t={text}>
      {text}
    </span>
  );
}

/**
 * The card face itself (no interaction). `labels` adds the modifier text labels. Modifier symbols
 * (user 2026-10-23, minionCard.css): every symbol is drawn plain (hollow); only the active one,
 * the live slot of the Leading (top) card (`leading` + a live `glow`), is filled and glows; on a
 * covered card a silenced slot is not drawn.
 */
export function MinionFace({
  summary,
  glow = null,
  labels = false,
  leading = false,
  className = '',
  style,
}: {
  summary: CreatureSummary;
  glow?: ModifierGlow | null;
  labels?: boolean;
  leading?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const { figure, name } = figureForLevel(summary.level);
  const colors = minionColors(summary.color);
  const urls = FIGURE_URLS[figure];
  const box = FIGURE_VIEWBOX[figure];
  const fillMask = `url("${urls.fill}")`;
  const faceStyle = {
    ...style,
    '--minion-bg': colorVar(colors.background),
    '--minion-fig': colorVar(colors.figure),
    '--minion-box': colorVar(colors.box),
  } as CSSProperties;

  return (
    <div
      className={`minion-card card-edge ${className}`}
      style={faceStyle}
      data-figure={figure}
      data-mods={leading ? 'active' : 'inactive'}
    >
      <div className="minion-box" />
      <div
        className="minion-fig"
        style={{ ...figureBox(box.fill), WebkitMaskImage: fillMask, maskImage: fillMask }}
      />
      <img
        className="minion-lines"
        style={figureBox(box.lines)}
        src={urls.lines}
        alt=""
        draggable={false}
        decoding="async"
      />
      <CardTexture />
      <div className="minion-boxline" />
      <div className="minion-boxtext">
        <Ink className="minion-atk" text={atkDigits(summary.atk)} />
        <Ink className="minion-lvl" text={`LVL ${summary.level}`} />
      </div>
      <Ink className="minion-name" text={name} />
      {summary.modifiers.length > 0 && (
        <ul className="minion-mods">
          {summary.modifiers.map((kind, index) => {
            const shape = SYMBOL_SHAPES[modifierSymbol(kind)];
            const state = glow?.index === index ? glow.state : undefined;
            return (
              // Modifier lists may repeat a kind, so the index is the key.
              <li key={index} className="minion-mod" data-glow={state} data-kind={kind}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <g className="minion-sym-o" transform="translate(0.13 0.1)">
                    {shape}
                  </g>
                  <g className="minion-sym-f">{shape}</g>
                </svg>
                {labels && <span className="minion-mod-label">{modifierLabel(kind)}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * A minion card at table size with its enlarged preview. `focusable` makes the card itself a tab
 * stop (read-only places such as stacks); inside a button or label the control is the focus target.
 */
export function MinionCard({
  card,
  summary,
  label,
  glow = null,
  leading = false,
  preview = true,
  focusable = false,
  tapPreview = false,
}: {
  card: TableCard;
  summary: CreatureSummary;
  label: string;
  glow?: ModifierGlow | null;
  /** The Leading (top) card of a stack: its live modifier is the highlighted, active one. */
  leading?: boolean;
  preview?: boolean;
  focusable?: boolean;
  /** A tap or click also opens / toggles the preview. */
  tapPreview?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const placement = useCardPreview(ref, preview, PREVIEW_WIDTH, tapPreview);
  // The symbols are decorative: the name says which modifier is active or was silenced.
  const kind = glow ? summary.modifiers[glow.index] : undefined;
  const state =
    kind === undefined || glow === null
      ? ''
      : glow.state === 'live' && leading
        ? `, active: ${modifierText(kind)}`
        : glow.state === 'silenced' && !leading
          ? `, ${modifierText(kind)} silenced`
          : '';

  return (
    <>
      <div
        ref={ref}
        role="img"
        aria-label={`${label}${state}`}
        tabIndex={focusable ? 0 : undefined}
        className="relative w-card-w shrink-0 select-none rounded-md"
        data-card-id={card.cardId}
        data-glow={glow?.state}
      >
        <MinionFace summary={summary} glow={glow} leading={leading} className="rounded-md" />
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
            <MinionFace
              summary={summary}
              glow={glow}
              leading={leading}
              labels
              className="rounded-lg"
            />
          </div>,
          document.body,
        )}
    </>
  );
}
