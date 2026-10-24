import {
  cardAriaLabel,
  spellHintBadge,
  spellHintText,
  spellNameSize,
} from '../../match/cartignon/labels';
import type { ModifierGlow } from '../../match/cartignon/modifierGlow';
import { spellText, spellVerdict } from '../../match/cartignon/spellArt';
import type { SpellHint, TableCard } from '../../match/cartignon/tableModel';
import { MinionCard } from './MinionCard';
import { SpellCard } from './SpellCard';

/**
 * A face-up card: creature = the illustrated minion face (`MinionCard`); spell = the illustrated
 * spell face (`SpellCard`, banner + name, full text enlarged). Armed traps (`trap`) and a spell the
 * catalog does not list keep the plain face with the name. The whole card is one image with an
 * accessible name; `SelectableCard` and the choice sheet wrap it in a control.
 */

const cardBase =
  'relative flex h-card-h w-card-w shrink-0 select-none flex-col overflow-hidden ' +
  'ink-line rounded-md p-1';

export function CardView({
  card,
  ariaLabel,
  hint = null,
  glow = null,
  leading = false,
  trap = false,
  preview = true,
  focusable = false,
  tapPreview = false,
}: {
  card: TableCard;
  ariaLabel?: string;
  /** RD-171: the server's spell hint (own hand only); shown as a badge on a spell. */
  hint?: SpellHint | null;
  /** Minion only: the glow of its modifier at its stack position (`modifierGlows`). */
  glow?: ModifierGlow | null;
  /** Minion only: the Leading (top) card of a stack, drawn with full-strength modifier symbols. */
  leading?: boolean;
  /** An armed trap: keeps the plain spell face (user 2026-10-22: traps keep their look for now). */
  trap?: boolean;
  /** Minion / spell: enlarge on hover / keyboard focus / touch long-press or double tap. */
  preview?: boolean;
  /** Minion / spell: the card itself is a tab stop (read-only places such as stacks). */
  focusable?: boolean;
  /** Minion / spell: a tap or click also opens (and toggles) the preview (stack cards). */
  tapPreview?: boolean;
}) {
  const summary = card.summary;
  const baseLabel = ariaLabel ?? cardAriaLabel(card);
  const label =
    hint && summary?.kind === 'spell' ? `${baseLabel}. ${spellHintText(hint)}` : baseLabel;

  if (summary?.kind === 'creature') {
    return (
      <MinionCard
        card={card}
        summary={summary}
        label={label}
        glow={glow}
        leading={leading}
        preview={preview}
        focusable={focusable}
        tapPreview={tapPreview}
      />
    );
  }

  const text = summary?.kind === 'spell' && !trap ? spellText(card.defId) : null;
  if (text) {
    return (
      <SpellCard
        card={card}
        text={text}
        label={label}
        title={hint ? `${text.name} — ${spellHintText(hint)}` : undefined}
        verdict={spellVerdict(hint)}
        footer={hint ? <SpellHintBadge hint={hint} onPaper /> : undefined}
        preview={preview}
        focusable={focusable}
        tapPreview={tapPreview}
      />
    );
  }

  if (summary?.kind === 'spell') {
    return (
      <div
        role="img"
        aria-label={label}
        title={hint ? `${summary.name} — ${spellHintText(hint)}` : summary.name}
        className={`${cardBase} justify-between bg-paper-sunken text-ink`}
        data-card-id={card.cardId}
      >
        <span className="text-[10px] font-bold uppercase tracking-wide">Spell</span>
        {/* Breaks only between words or at hyphenation points (lang="en" on <html>), never
            mid-word; long names get a smaller size. The full name is in the aria-label. */}
        <span
          lang="en"
          className={`${hint ? 'line-clamp-3' : 'line-clamp-4'} hyphens-auto font-semibold leading-tight ${
            spellNameSize(summary.name) === 'small' ? 'text-[10px]' : 'text-xs'
          }`}
        >
          {summary.name}
        </span>
        {hint && <SpellHintBadge hint={hint} className="-mx-1 -mb-1" />}
      </div>
    );
  }

  return (
    <div
      role="img"
      aria-label={label}
      className={`${cardBase} items-center justify-center border-dashed text-xs text-ink-muted`}
      data-card-id={card.cardId}
    >
      {card.cardId}
    </div>
  );
}

/* --- Spell hint badge (RD-171) ---------------------------------------------------------------
 * Which effect fires if cast now, as a full-width footer band on the card (60px, so even
 * "Unavailable" fits without truncation): Primary = solid turn colour, Secondary = solid amber
 * (2026-10-23: highlighted like Primary, no longer a pale tint), Unavailable = no fill on a dashed
 * rule. All three are separated from the card by an ink rule
 * (the one UI line; the amber edge Secondary had before is gone, its fill and text carry it).
 * Not castable now: struck through (thick line) at full contrast; the reason is in the card's tooltip and accessible name. Text always carries the
 * meaning, colour never alone. */
export function SpellHintBadge({
  hint,
  onPaper = false,
  className = '',
}: {
  hint: SpellHint;
  /** On the spell face: the card's light paper in both themes, so Unavailable uses its ink. */
  onPaper?: boolean;
  className?: string;
}) {
  const look =
    hint.branch === 'primary'
      ? 'bg-turn text-on-turn'
      : hint.branch === 'secondary'
        ? // Dark ink on amber reads lighter than Primary's light-on-blue: normal tracking and a
          // hairline stroke in the text's own ink stand in for the bold Jaini does not have.
          'bg-hint-secondary text-on-hint-secondary [-webkit-text-stroke:0.35px_currentColor]'
        : onPaper
          ? 'border-dashed text-[#1c1917]'
          : 'border-dashed text-ink';
  return (
    <span
      aria-hidden="true"
      className={`relative z-3 block shrink-0 overflow-hidden whitespace-nowrap rounded-b-sm border-t-(length:--line-width) border-line px-px text-center font-sans text-[10px] font-bold leading-4 ${
        hint.branch === 'secondary' ? '' : 'tracking-tight'
      } ${look} ${className} ${hint.castable ? '' : 'line-through decoration-2'}`}
      data-testid="spell-hint"
      data-branch={hint.branch ?? 'none'}
      data-castable={hint.castable ? 'true' : 'false'}
    >
      {spellHintBadge(hint)}
    </span>
  );
}

/**
 * Selected state (R8c): a 3px ring in the turn colour (offset so it reads on every swatch), plus
 * the lift on a hand card or a "Selected" label on a choice tile, so colour is never the only signal. A ring, not an outline, so the global
 * focus-visible outline stays visible on a selected card.
 */
export const selectedRingClass = 'ring-3 ring-turn ring-offset-2 ring-offset-paper';

/**
 * Decorative "Selected" label straddling the top edge of a selected choice tile (text, no glyph;
 * the control's state carries the meaning for assistive tech). Hand cards do not use it.
 */
export function CheckBadge() {
  return (
    <span
      aria-hidden="true"
      className="ink-line pointer-events-none absolute -top-3.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-turn px-1.5 text-[10px] font-bold leading-4 text-on-turn"
      data-testid="check-badge"
    >
      Selected
    </span>
  );
}

/**
 * A hand card as a toggle button (R8c tap-select): `aria-pressed` carries the selected state, the
 * accessible name is the card's name. No "Selected" label: the lift plus the ring already mark it
 * without relying on colour. The card itself is larger than the 44px target minimum.
 */
export function SelectableCard({
  card,
  selected,
  onTap,
  testId,
  hint = null,
}: {
  card: TableCard;
  selected: boolean;
  onTap: () => void;
  testId?: string;
  hint?: SpellHint | null;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onTap}
      // Two-tone focus indicator (dark outline over a light gap): it stays >= 3:1 whichever
      // swatch sits behind a card in the fanned hand.
      className={`relative block rounded-md focus-visible:outline-3 focus-visible:outline-ink focus-visible:shadow-[0_0_0_2px_var(--color-paper)] ${
        selected ? selectedRingClass : ''
      }`}
      data-testid={testId}
      data-selected={selected ? 'true' : 'false'}
    >
      <CardView card={card} hint={hint} />
    </button>
  );
}

/** Placeholder with card dimensions, e.g. an empty stack. */
export function EmptySlot({ text }: { text: string }) {
  return (
    <div
      aria-hidden="true"
      className="flex h-card-h w-card-w shrink-0 items-center justify-center ink-line rounded-md border-dashed text-xs text-ink-muted"
    >
      {text}
    </div>
  );
}
