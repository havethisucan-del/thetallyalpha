import type { CartignonPublicView, CartignonSeatEvent } from '@cartignon/protocol';

/**
 * Spell cards attached to creatures (RD-12 / RD-14 / RD-133 / RD-153), presentation only. The
 * public view lists the attached cards (`board.attachedSpells`: card, caster seat, creature) and the
 * ATK effects they delivered (`board.attachedEffects`) or the modifier they copied
 * (`board.copiedModifiers`, S-06), and which effect fired (`attachedSpells[].branch`, RD-174).
 * Nothing here knows the rules.
 */

export type SpellBranch = 'primary' | 'secondary';

type CopiedKind = CartignonPublicView['board']['copiedModifiers'][number]['kind'];

/** What one attached spell did to its creature, from the public view. */
export interface AttachedEffectSummary {
  /** The sum of the ATK changes this card gave this creature; null when it gave none. */
  atkDelta: number | null;
  /** S-06: the Buff / Nerf this card copied onto this creature; null when none. */
  copied: CopiedKind | null;
}

/**
 * Fallback for an attached spell without `branch` (RD-174: absent only on boards saved before the
 * field existed): the branch the events in the rolling log report (oldest first; a later event for
 * the same card wins). Not kept beyond the log, so nothing carries over between matches.
 */
export function spellBranchesFromEvents(
  events: readonly CartignonSeatEvent[],
): ReadonlyMap<string, SpellBranch> {
  const out = new Map<string, SpellBranch>();
  for (const event of events) {
    if (event.type === 'spellPlayed') out.set(event.cardId, event.branch);
    // Traps arm on cast; their Secondary fires when they lapse (RD-129) or trigger into it.
    else if (event.type === 'trapLapsed') out.set(event.cardId, 'secondary');
    else if (event.type === 'trapTriggered' && event.outcome === 'secondary') {
      out.set(event.cardId, 'secondary');
    }
  }
  return out;
}

/** The effect an attached spell fired: the view's `branch` first, else the event fallback. */
export function attachedBranch(
  spell: { cardId: string; branch: SpellBranch | null },
  fromEvents: ReadonlyMap<string, SpellBranch>,
): SpellBranch | null {
  return spell.branch ?? fromEvents.get(spell.cardId) ?? null;
}

/** What `sourceCardId` did to `targetCardId` (ATK change and / or copied modifier). */
export function attachedEffectSummary(
  board: CartignonPublicView['board'],
  sourceCardId: string,
  targetCardId: string,
): AttachedEffectSummary {
  let atkDelta: number | null = null;
  for (const effect of board.attachedEffects) {
    if (effect.sourceCardId === sourceCardId && effect.targetCardId === targetCardId) {
      atkDelta = (atkDelta ?? 0) + effect.amount;
    }
  }
  const copy = board.copiedModifiers.find(
    (m) => m.sourceCardId === sourceCardId && m.carrierCardId === targetCardId,
  );
  return { atkDelta, copied: copy?.kind ?? null };
}

/** Signed ATK text with a true minus sign, e.g. `+30`, `−30`. */
export function atkDeltaText(amount: number): string {
  if (amount > 0) return `+${amount}`;
  if (amount < 0) return `−${Math.abs(amount)}`;
  return '±0';
}

/**
 * Accessible name / tooltip of an attached spell, e.g. `Your spell Wither, attached: secondary
 * effect fired, ATK −30`. `branch` is null when the client never saw the cast (rejoin).
 */
export function attachedSpellText(
  name: string,
  caster: 'mine' | 'theirs',
  branch: SpellBranch | null,
  effect: AttachedEffectSummary,
): string {
  const owner = caster === 'mine' ? 'Your spell' : "Opponent's spell";
  const parts = [branch === null ? null : `${branch} effect fired`, attachedEffectText(effect)];
  const detail = parts.filter((part) => part !== null && part !== '').join(', ');
  return `${owner} ${name}, attached${detail === '' ? '' : `: ${detail}`}`;
}

/** Short words for what an attached spell did, e.g. `ATK −30` or `copied Nerf`; '' when nothing. */
export function attachedEffectText(effect: AttachedEffectSummary): string {
  const parts: string[] = [];
  if (effect.atkDelta !== null) parts.push(`ATK ${atkDeltaText(effect.atkDelta)}`);
  if (effect.copied === 'buffSelf') parts.push('copied Buff');
  else if (effect.copied === 'nerfEnemyLeader') parts.push('copied Nerf');
  return parts.join(', ');
}
