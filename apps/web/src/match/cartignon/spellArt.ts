import { spells as CATALOG_SPELLS } from '@cartignon/game-core/cards.json';
import type { SpellHint } from './tableModel';

/**
 * Data for the spell card face (user-approved look, `docs/cards/spell-prototype.mjs`,
 * 2026-10-22). Pure and renderer-neutral: the printed card text from the generated catalog
 * (`@cartignon/game-core/cards.json`, built from `docs/cards/spells.csv`), the verdict shown on the
 * enlarged card (from the server's spell hint, RD-171; no client rule logic) and the text sizes.
 */

export interface SpellText {
  name: string;
  condition: string;
  primary: string;
  secondary: string;
}

const TEXT_BY_DEF: ReadonlyMap<string, SpellText> = new Map(
  CATALOG_SPELLS.map((spell) => [spell.defId, { name: spell.name, ...spell.text }]),
);

/** The printed text of a spell definition (`S-01` …), or null if the catalog does not list it. */
export function spellText(defId: string | null): SpellText | null {
  return defId === null ? null : (TEXT_BY_DEF.get(defId) ?? null);
}

/** Every spell in the catalog (19), in catalog order. */
export function allSpellTexts(): SpellText[] {
  return [...TEXT_BY_DEF.values()];
}

/**
 * `met` = the condition holds, the Primary fires; `unmet` = the Secondary fires; `blocked` = the
 * Secondary would do nothing, so the spell cannot be played (RD-175 `SPELL_NO_EFFECT`).
 */
export type SpellVerdict = 'met' | 'unmet' | 'blocked';

/**
 * The verdict chip of the enlarged spell, straight from the server's hint branch and reason. Null
 * when there is no hint (not in the own hand) or the build cannot play the spell (`branch: null`).
 */
export function spellVerdict(hint: SpellHint | null): SpellVerdict | null {
  if (hint === null || hint.branch === null) return null;
  if (hint.reason === 'SPELL_NO_EFFECT') return 'blocked';
  return hint.branch === 'primary' ? 'met' : 'unmet';
}

/** Chip text per verdict: a symbol plus words, so colour or frame style is never the only cue. */
export const VERDICT_TEXT: Readonly<Record<SpellVerdict, { mark: string; text: string }>> = {
  met: { mark: '✓', text: 'Condition met — Primary fires' },
  unmet: { mark: '✗', text: 'Condition not met — Secondary fires' },
  blocked: { mark: '✗', text: 'No effect now — cannot be played' },
};

/**
 * Name size at table size, in `cqw` (percent of the card width): ONE size for every spell, the
 * largest at which the longest single word still fits the name box on one line (user decision
 * 2026-10-22; the prototype measured 23.5 with the Google Fonts build). Re-measured on
 * integration in Chromium with the bundled `@fontsource/jaini` against every word of the 19
 * names: the widest word is "Withdrawal", which fits up to 23.4 (60.0 of 60 px at 64 px wide).
 * The rendered size is 90 % of that fit, 21.06 (2026-10-23): with the 7cqw side margins in
 * `spellCard.css` the wrapped lines stay clear of the card's ink edge (the full 23.4 left ~2px per
 * side on "Mutual Withdrawal" / "Mass Recall"). spellCard.css uses this value unscaled.
 * A new spell name with a wider word needs a re-measure (fit size x 0.9).
 */
export const SPELL_NAME_SMALL_CQW = 21.06;

/** Body text size of the enlarged spell (`cqw`): the approved size and the floor it may shrink to. */
export const SPELL_BODY_CQW = 5.4;
export const SPELL_BODY_MIN_CQW = 3;
const SPELL_BODY_STEP_CQW = 0.1;

/**
 * The largest size from `start` down to `min` (in `step`s) at which `fits(size)` holds, or `min`
 * when nothing fits. Used to shrink a long spell's body text until it fits the card.
 */
export function shrinkToFit(
  fits: (size: number) => boolean,
  start = SPELL_BODY_CQW,
  min = SPELL_BODY_MIN_CQW,
  step = SPELL_BODY_STEP_CQW,
): number {
  // Integer steps so the sizes stay exact decimals (5.4, 5.3, …) instead of drifting floats.
  const steps = Math.round((start - min) / step);
  for (let k = 0; k <= steps; k++) {
    const size = Math.round((start - k * step) * 1000) / 1000;
    if (fits(size)) return size;
  }
  return min;
}
