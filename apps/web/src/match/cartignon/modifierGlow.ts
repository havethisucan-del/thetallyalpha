import type { CartignonSeatEvent } from '@cartignon/protocol';

/**
 * Modifier glow on stack cards (user idea, 2026-10-22). A creature's modifier at stack position
 * `p` (entry `p - 1` of its modifiers, RD-53) lights up while it is live and turns dim once it is
 * silenced. Driven by the engine's `modifierLive` / `modifierSilenced` events as they reach the
 * client (the rolling event log), reconciled with the view's `liveModifiers` snapshot: the snapshot
 * is authoritative for what is live now (a rejoin resends the view without events, and a negated
 * activation, RD-109, is not live), the events add which covered cards were live before.
 */

export type ModifierGlowState = 'live' | 'silenced';

export interface ModifierGlow {
  /** Index into the card's `modifiers` (= stack position - 1). */
  index: number;
  state: ModifierGlowState;
}

interface Placed {
  cardId: string;
  position: number;
}

function key(cardId: string, position: number): string {
  return `${cardId}@${position}`;
}

/**
 * Glow per stack card id. `events` oldest first; `live` = `public.liveModifiers`; `stacks` = the
 * cards now on both stacks with their positions. Cards off the stacks, Base cards (position 0) and
 * modifiers the events never reported live get no entry (drawn normally).
 */
export function modifierGlows(
  events: readonly CartignonSeatEvent[],
  live: readonly Placed[],
  stacks: readonly Placed[],
): ReadonlyMap<string, ModifierGlow> {
  const seen = new Map<string, ModifierGlowState>();
  for (const event of events) {
    if (event.type === 'modifierLive') seen.set(key(event.cardId, event.position), 'live');
    else if (event.type === 'modifierSilenced') {
      seen.set(key(event.cardId, event.position), 'silenced');
    }
  }
  const liveNow = new Set(live.map((m) => key(m.cardId, m.position)));
  const out = new Map<string, ModifierGlow>();
  for (const card of stacks) {
    if (card.position < 1) continue;
    const k = key(card.cardId, card.position);
    const index = card.position - 1;
    if (liveNow.has(k)) out.set(card.cardId, { index, state: 'live' });
    // Reported live earlier but not live now (covered, negated afterwards): silenced.
    else if (seen.has(k)) out.set(card.cardId, { index, state: 'silenced' });
  }
  return out;
}
