import type { CartignonPublicView, CartignonSeatEvent } from '@cartignon/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  atkDeltaText,
  attachedEffectSummary,
  attachedEffectText,
  attachedSpellText,
  attachedBranch,
  spellBranchesFromEvents,
  type SpellBranch,
} from '../src/match/cartignon/attachedSpells';
import type { SeatArea } from '../src/match/cartignon/tableModel';
import { SeatStack } from '../src/screens/cartignon/Stacks';
import { tableModel } from './fixtures/cartignonTable';

const played = (
  cardId: string,
  branch: SpellBranch,
): Extract<CartignonSeatEvent, { type: 'spellPlayed' }> => ({
  type: 'spellPlayed',
  seat: 0,
  cardId,
  branch,
});

describe('attached spell branch', () => {
  it('prefers the view branch (RD-174) over the events', () => {
    const fromEvents = spellBranchesFromEvents([played('c40', 'primary')]);
    expect(attachedBranch({ cardId: 'c40', branch: 'secondary' }, fromEvents)).toBe('secondary');
  });

  it('falls back to the events only when the view has no branch; null when neither knows', () => {
    const fromEvents = spellBranchesFromEvents([
      played('c40', 'primary'),
      played('c41', 'secondary'),
      played('c40', 'secondary'),
    ]);
    expect(attachedBranch({ cardId: 'c40', branch: null }, fromEvents)).toBe('secondary');
    expect(attachedBranch({ cardId: 'c41', branch: null }, fromEvents)).toBe('secondary');
    expect(attachedBranch({ cardId: 'c42', branch: null }, fromEvents)).toBeNull();
  });

  it('marks a lapsed trap or one triggered into its Secondary as secondary', () => {
    const map = spellBranchesFromEvents([
      played('c40', 'primary'),
      { type: 'trapLapsed', seat: 0, cardId: 'c40', spellId: 'S-16', attachedTo: 'c20' },
      played('c41', 'primary'),
      {
        type: 'trapTriggered',
        seat: 0,
        cardId: 'c41',
        spellId: 'S-12',
        targetSeat: 1,
        triggerCardId: 'c20',
        outcome: 'secondary',
      },
    ]);
    expect(map.get('c40')).toBe('secondary');
    expect(map.get('c41')).toBe('secondary');
  });
});

describe('attachedEffectSummary / texts', () => {
  const board = {
    attachedEffects: [
      { effectId: 'e1', kind: 'atkDelta', amount: -30, sourceCardId: 'c40', targetCardId: 'c21' },
      { effectId: 'e2', kind: 'atkDelta', amount: -10, sourceCardId: 'c40', targetCardId: 'c21' },
      { effectId: 'e3', kind: 'atkDelta', amount: 30, sourceCardId: 'c40', targetCardId: 'c20' },
    ],
    copiedModifiers: [
      {
        effectId: 'e4',
        kind: 'nerfEnemyLeader',
        carrierCardId: 'c10',
        sourceCardId: 'c41',
        live: true,
      },
    ],
  } as unknown as CartignonPublicView['board'];

  it('sums the ATK changes of one card on one creature and finds an S-06 copy', () => {
    expect(attachedEffectSummary(board, 'c40', 'c21')).toEqual({ atkDelta: -40, copied: null });
    expect(attachedEffectSummary(board, 'c41', 'c10')).toEqual({
      atkDelta: null,
      copied: 'nerfEnemyLeader',
    });
  });

  it('formats signed amounts and labels', () => {
    expect(atkDeltaText(30)).toBe('+30');
    expect(atkDeltaText(-30)).toBe('−30');
    expect(attachedEffectText({ atkDelta: -30, copied: null })).toBe('ATK −30');
    expect(attachedEffectText({ atkDelta: null, copied: 'buffSelf' })).toBe('copied Buff');
    expect(
      attachedSpellText('Foresight', 'theirs', 'secondary', { atkDelta: -30, copied: null }),
    ).toBe("Opponent's spell Foresight, attached: secondary effect fired, ATK −30");
    expect(attachedSpellText('Foresight', 'mine', null, { atkDelta: null, copied: null })).toBe(
      'Your spell Foresight, attached',
    );
  });
});

describe('table model: attached spells', () => {
  it('lists each creature’s attached spells in attach order with caster side and effect', () => {
    const model = tableModel({
      board: {
        attachedSpells: [
          { cardId: 'c40', seat: 0, targetCardId: 'c21', branch: 'secondary' },
          { cardId: 'c42', seat: 1, targetCardId: 'c21' },
        ],
        attachedEffects: [
          {
            effectId: 'e1',
            kind: 'atkDelta',
            amount: -30,
            sourceCardId: 'c40',
            targetCardId: 'c21',
          },
        ],
      },
    });
    const leading = model.opponent.stack[1];
    expect(leading?.attached.map((s) => [s.cardId, s.side, s.branch, s.effect.atkDelta])).toEqual([
      ['c40', 'mine', 'secondary', -30],
      ['c42', 'theirs', null, null],
    ]);
    expect(model.opponent.stack[0]?.attached).toEqual([]);
    expect(model.me.stack[0]?.attached).toEqual([]);
  });
});

describe('SeatStack: attached spell markup', () => {
  const area: SeatArea = {
    seat: 1,
    side: 'theirs',
    handCount: 3,
    atk: 27,
    traps: [],
    armedTrapCount: 0,
    stack: [
      {
        cardId: 'c21',
        label: 'c21',
        defId: 'C-B2',
        summary: { kind: 'creature', color: 'yellow', level: 2, atk: 57, modifiers: [] },
        color: 'yellow',
        position: 0,
        attached: [
          {
            cardId: 'c40',
            label: 'c40',
            defId: 'S-01',
            summary: { kind: 'spell', name: 'Foresight' },
            color: null,
            side: 'mine',
            branch: null,
            effect: { atkDelta: -30, copied: null },
          },
        ],
      },
    ],
  };

  const withBranch = (branch: SpellBranch): SeatArea => ({
    ...area,
    stack: area.stack.map((card) => ({
      ...card,
      attached: card.attached.map((spell) => ({ ...spell, branch })),
    })),
  });

  it('glues the spell to its creature with the fired-effect band and ATK change', () => {
    const html = renderToStaticMarkup(createElement(SeatStack, { area: withBranch('secondary') }));
    expect(html).toContain('data-testid="attached-spells"');
    expect(html).toContain('data-attached-to="c21"');
    expect(html).toMatch(/data-testid="spell-hint"[^>]*data-branch="secondary"/);
    expect(html).toContain('data-testid="attached-delta"');
    expect(html).toContain('−30');
    expect(html).toContain(
      'aria-label="Your spell Foresight, attached: secondary effect fired, ATK −30"',
    );
    expect(html).toContain('Attached: Foresight (secondary effect, ATK −30)');
  });

  it('uses the event fallback only when the view has no branch', () => {
    const html = renderToStaticMarkup(
      createElement(SeatStack, { area, branches: new Map([['c40', 'primary' as const]]) }),
    );
    expect(html).toMatch(/data-testid="spell-hint"[^>]*data-branch="primary"/);
  });

  it('shows no band when the branch is unknown (old saved board) but keeps the card', () => {
    const html = renderToStaticMarkup(createElement(SeatStack, { area }));
    expect(html).toContain('data-attached-to="c21"');
    expect(html).not.toContain('data-testid="spell-hint"');
  });
});
