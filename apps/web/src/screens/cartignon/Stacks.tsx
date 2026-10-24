import type { CSSProperties } from 'react';
import {
  atkDeltaText,
  attachedBranch,
  attachedEffectText,
  attachedSpellText,
  type SpellBranch,
} from '../../match/cartignon/attachedSpells';
import { cardAriaLabel, stackAriaLabel } from '../../match/cartignon/labels';
import type { ModifierGlow } from '../../match/cartignon/modifierGlow';
import { spellText, spellVerdict } from '../../match/cartignon/spellArt';
import type {
  AttachedSpellCard,
  SeatArea,
  StackCard,
  TableCard,
  TrapCard,
} from '../../match/cartignon/tableModel';
import { CardView, EmptySlot, SpellHintBadge } from './CardView';
import { SpellCard } from './SpellCard';

/**
 * A seat's stack as a physical pile (`.ct-stack` in table.css): bottom to top, each card lying
 * over the previous one with an offset, so earlier cards peek out (own stack: left and top; the
 * opponent's, mirrored across the middle line: left and bottom) and the Leading (top) card is
 * whole. Every card is a tab stop; hover, focus, long-press or a tap opens the enlarged preview
 * (both seats' stacks are public). Armed traps are public too (RD-130; S-12 / S-16), drawn
 * face-up and smaller beside the stack; the accessible name says whose trap it is.
 */

function trapLabel(trap: TrapCard, mine: boolean): string {
  const dormant = trap.dormant ? ', dormant' : '';
  const owner = mine ? 'Your trap' : "Opponent's trap";
  return `${owner} ${trap.spellId}: ${cardAriaLabel(trap)}${dormant}`;
}

function spellName(card: TableCard): string {
  return card.summary?.kind === 'spell' ? card.summary.name : card.cardId;
}

/** The creature's accessible name plus what is attached to it (so the ATK change is explained). */
function creatureLabel(card: StackCard, branches: ReadonlyMap<string, SpellBranch>): string {
  const base = cardAriaLabel(card);
  if (card.attached.length === 0) return base;
  const spells = card.attached.map((spell) => {
    const branch = attachedBranch(spell, branches);
    const detail = [branch ? `${branch} effect` : '', attachedEffectText(spell.effect)]
      .filter((part) => part !== '')
      .join(', ');
    return `${spellName(spell)}${detail === '' ? '' : ` (${detail})`}`;
  });
  return `${base}. Attached: ${spells.join('; ')}`;
}

/**
 * A spell card glued to its creature (RD-12 / RD-14): tucked behind it and peeking out on the side
 * away from the middle line, with the band of the effect that fired (the hand's RD-171 band) and,
 * enlarged, that effect highlighted the same way as in the hand. Its own tab stop and preview.
 */
function AttachedSpell({
  spell,
  branch,
}: {
  spell: AttachedSpellCard;
  branch: SpellBranch | null;
}) {
  const label = attachedSpellText(spellName(spell), spell.side, branch, spell.effect);
  const hint = branch === null ? null : { branch, castable: true, reason: null };
  const text = spellText(spell.defId);
  if (!text) return <CardView card={spell} ariaLabel={label} focusable tapPreview />;
  return (
    <SpellCard
      card={spell}
      text={text}
      label={label}
      title={label}
      verdict={spellVerdict(hint)}
      footer={hint ? <SpellHintBadge hint={hint} onPaper /> : undefined}
      focusable
      tapPreview
    />
  );
}

export function SeatStack({
  area,
  glows = new Map(),
  branches = new Map(),
}: {
  area: SeatArea;
  /** Modifier glow per card id (`modifierGlows`). */
  glows?: ReadonlyMap<string, ModifierGlow>;
  /** Fallback branch per spell from the events (`spellBranchesFromEvents`), used only when an
   * attached spell's view entry has no `branch`. */
  branches?: ReadonlyMap<string, SpellBranch>;
}) {
  const mine = area.side === 'mine';
  const headingId = `${area.side}-stack-heading`;
  const count = area.stack.length;
  const lastIndex = count - 1;

  return (
    <>
      <section aria-labelledby={headingId} data-testid={`${area.side}-stack`}>
        <h2 id={headingId} className="sr-only">
          {mine ? 'Your stack' : 'Opponent stack'}
        </h2>
        {count === 0 ? (
          <EmptySlot text="Empty" />
        ) : (
          <ol
            aria-label={stackAriaLabel(area.side, count)}
            className="ct-stack"
            style={{ '--stack-n': count } as CSSProperties}
            data-side={area.side}
          >
            {area.stack.map((card) => {
              const leading = card.position === lastIndex;
              return (
                <li
                  key={card.cardId}
                  style={{ '--k': card.position, '--z': card.position + 1 } as CSSProperties}
                  data-leading={leading ? 'true' : undefined}
                >
                  <CardView
                    card={card}
                    ariaLabel={creatureLabel(card, branches)}
                    glow={glows.get(card.cardId) ?? null}
                    leading={leading}
                    focusable
                    tapPreview
                  />
                  {leading && <span className="sr-only">Leading</span>}
                  {card.attached.length > 0 && (
                    <ul
                      aria-label="Attached spells"
                      className="ct-attached"
                      style={{ '--att-n': card.attached.length } as CSSProperties}
                      data-testid="attached-spells"
                    >
                      {card.attached.map((spell, index) => (
                        <li
                          key={spell.cardId}
                          style={{ '--a': index } as CSSProperties}
                          data-attached-to={card.cardId}
                        >
                          <AttachedSpell spell={spell} branch={attachedBranch(spell, branches)} />
                          {spell.effect.atkDelta !== null && (
                            <span
                              aria-hidden="true"
                              className="ct-attached-delta ink-line rounded-full bg-paper-raised px-1 font-sans text-[11px] font-bold leading-4 text-ink tabular-nums"
                              data-testid="attached-delta"
                            >
                              {atkDeltaText(spell.effect.atkDelta)}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>
      {area.traps.length > 0 && (
        <ul
          aria-label={mine ? 'Your armed traps' : 'Opponent armed traps'}
          className="ct-traps flex gap-1.5"
          data-testid={`${area.side}-traps`}
        >
          {area.traps.map((trap) => (
            <li key={trap.cardId} className="flex flex-col items-center gap-0.5">
              <CardView card={trap} ariaLabel={trapLabel(trap, mine)} trap />
              <span
                aria-hidden="true"
                className="text-[11px] leading-3 whitespace-nowrap text-ink-muted"
              >
                {trap.dormant ? `${trap.spellId} dormant` : trap.spellId}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
