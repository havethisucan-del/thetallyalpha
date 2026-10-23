import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  previewPlacement,
  PREVIEW_WIDTH,
  SPELL_PREVIEW_WIDTH,
} from '../src/match/cartignon/cardPreview';
import {
  allSpellTexts,
  shrinkToFit,
  SPELL_BODY_CQW,
  SPELL_BODY_MIN_CQW,
  spellText,
  spellVerdict,
  VERDICT_TEXT,
} from '../src/match/cartignon/spellArt';
import type { SpellHint, TableCard } from '../src/match/cartignon/tableModel';
import { CardView } from '../src/screens/cartignon/CardView';
import { SeatBar } from '../src/screens/cartignon/SeatBar';

const hint = (branch: SpellHint['branch'], castable = true): SpellHint => ({
  branch,
  castable,
  reason: castable ? null : 'NOT_YOUR_TURN',
});

describe('spell text (catalog)', () => {
  it('has the printed text of all 19 spells', () => {
    const all = allSpellTexts();
    expect(all).toHaveLength(19);
    for (const spell of all) {
      expect(spell.name.length).toBeGreaterThan(0);
      expect(spell.condition.length).toBeGreaterThan(0);
      expect(spell.primary.length).toBeGreaterThan(0);
      expect(spell.secondary.length).toBeGreaterThan(0);
    }
  });

  it('looks a spell up by its definition id', () => {
    expect(spellText('S-01')?.name).toBe('Foresight');
    expect(spellText('S-99')).toBeNull();
    expect(spellText(null)).toBeNull();
  });

  it('names wrap only between words; the longest word sets the one table-size name size', () => {
    // SPELL_NAME_SMALL_CQW was measured against these words (widest: "Withdrawal", 10 letters);
    // a longer word means the size must be re-measured.
    const words = allSpellTexts().flatMap((s) => s.name.split(/\s+/));
    expect(Math.max(...words.map((w) => w.length))).toBe(10);
    expect(words).toContain('Withdrawal');
  });
});

describe('spell verdict (RD-171 hint)', () => {
  it('follows the hint branch, castable or not', () => {
    expect(spellVerdict(hint('primary'))).toBe('met');
    expect(spellVerdict(hint('secondary', false))).toBe('unmet');
    expect(spellVerdict(hint(null, false))).toBeNull();
    expect(spellVerdict(null)).toBeNull();
  });

  it('carries a symbol and words, never colour alone', () => {
    expect(VERDICT_TEXT.met).toEqual({ mark: '✓', text: 'Condition met — Primary fires' });
    expect(VERDICT_TEXT.unmet).toEqual({
      mark: '✗',
      text: 'Condition not met — Secondary fires',
    });
  });
});

describe('shrinkToFit', () => {
  it('keeps the approved size when it fits', () => {
    expect(shrinkToFit(() => true)).toBe(SPELL_BODY_CQW);
  });
  it('steps down in exact 0.1 steps to the largest size that fits', () => {
    const tried: number[] = [];
    expect(
      shrinkToFit((size) => {
        tried.push(size);
        return size <= 4.7;
      }),
    ).toBe(4.7);
    expect(tried.slice(0, 3)).toEqual([5.4, 5.3, 5.2]);
  });
  it('stops at the floor', () => {
    expect(shrinkToFit(() => false)).toBe(SPELL_BODY_MIN_CQW);
  });
});

describe('spell preview width', () => {
  const card = { left: 100, top: 600, width: 64, height: 90 };
  it('is wider than a minion preview when the viewport allows it', () => {
    expect(previewPlacement(card, 1024, 900, SPELL_PREVIEW_WIDTH).width).toBe(240);
    expect(previewPlacement(card, 1024, 900).width).toBe(PREVIEW_WIDTH);
  });
  it('still fits a 375 px screen', () => {
    const p = previewPlacement(card, 375, 812, SPELL_PREVIEW_WIDTH);
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + p.width).toBeLessThanOrEqual(375 - 8);
  });
});

describe('spell and trap markup', () => {
  const spell: TableCard = {
    cardId: 'c21',
    label: 'c21',
    defId: 'S-04',
    color: null,
    summary: { kind: 'spell', name: 'Mass Recall' },
  };

  it('a catalog spell gets the illustrated face, its name and the hint band', () => {
    const html = renderToStaticMarkup(
      createElement(CardView, { card: spell, hint: hint('primary') }),
    );
    expect(html).toContain('spell-card');
    expect(html).toContain('spell-banner');
    expect(html).toContain('Mass Recall');
    expect(html).toContain('aria-label="Spell Mass Recall. Cast now: primary effect."');
    expect(html).toContain('data-spell-verdict="met"');
    expect(html).toContain('data-testid="spell-hint"');
    // The card text is only on the enlarged (decorative) copy.
    expect(html).not.toContain('class="spell-body"');
  });

  it('an armed trap keeps the plain face', () => {
    const html = renderToStaticMarkup(createElement(CardView, { card: spell, trap: true }));
    expect(html).not.toContain('spell-card');
    expect(html).toContain('Mass Recall');
  });

  it('a spell the catalog does not list keeps the plain face', () => {
    const html = renderToStaticMarkup(
      createElement(CardView, { card: { ...spell, defId: 'S-99' } }),
    );
    expect(html).not.toContain('spell-card');
  });
});

describe('opponent hand backs', () => {
  const area = {
    seat: 1 as const,
    handCount: 9,
    atk: 0,
    stack: [],
    traps: [],
    armedTrapCount: 0,
  };
  it('draws at most six decorative backs next to the count', () => {
    const html = renderToStaticMarkup(
      createElement(SeatBar, { area: { ...area, side: 'theirs' }, tokens: 0 }),
    );
    expect(html.match(/data-testid="card-back"/g)).toHaveLength(6);
    expect(html).toContain('data-testid="opponent-hand-backs"');
    expect(html).toContain('>9</dd>');
  });
  it('draws no backs for the own hand', () => {
    const html = renderToStaticMarkup(
      createElement(SeatBar, { area: { ...area, side: 'mine' }, tokens: 0 }),
    );
    expect(html).not.toContain('card-back');
  });
});
