import type { ActionResultMessage } from '@cartignon/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MyChoice } from '../src/match/cartignon/tableModel';
import { ActionBar } from '../src/screens/cartignon/ActionBar';
import { ActionLog } from '../src/screens/cartignon/ActionLog';
import { CartignonTable } from '../src/screens/cartignon/CartignonTable';
import { ChoiceSheet } from '../src/screens/cartignon/ChoiceSheet';
import { tableModel } from './fixtures/cartignonTable';

/**
 * Markup-level component tests (R8c): static server rendering in Node, no DOM library. Interaction
 * state transitions are covered by the pure helpers in interaction.test.ts.
 */

const noop = () => undefined;

function choiceModel(pending: Record<string, unknown>) {
  return tableModel({ priv: { pendingChoiceView: { seat: 0, spellId: 'S-01', ...pending } } });
}

function sheet(choice: MyChoice, canAct = true): string {
  return renderToStaticMarkup(
    createElement(ChoiceSheet, { choice, hidden: false, canAct, onConfirm: noop, onHide: noop }),
  );
}

function myChoice(pending: Record<string, unknown>): MyChoice {
  const choice = choiceModel({ choiceId: 3, ...pending }).myChoice;
  if (!choice) throw new Error('fixture has no choice');
  return choice;
}

function count(html: string, pattern: RegExp): number {
  return html.match(new RegExp(pattern.source, 'g'))?.length ?? 0;
}

describe('ChoiceSheet', () => {
  it('renders a fieldset with legend, counter and radios when max = 1; Confirm starts disabled', () => {
    const html = sheet(
      myChoice({ kind: 'enemyCreature', options: ['c20', 'c21'], min: 1, max: 1 }),
    );
    expect(html).toContain('<fieldset');
    expect(html).toMatch(/<legend[^>]*>An opponent&#x27;s creature<\/legend>/);
    expect(html).toContain('Choose 1 (0 selected)');
    expect(count(html, /type="radio"/)).toBe(2);
    expect(html).not.toContain('type="checkbox"');
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*data-testid="choice-confirm"/);
  });

  it('uses checkboxes when max > 1', () => {
    const html = sheet(
      myChoice({ kind: 'handDiscard', options: ['c01', 'c02', 'c03'], min: 1, max: 2 }),
    );
    expect(count(html, /type="checkbox"/)).toBe(3);
    expect(html).toContain('Choose 1–2 (0 selected)');
  });

  it('offers "None" for an optional single choice and allows confirming nothing', () => {
    const html = sheet(myChoice({ kind: 'keepDrawn', options: ['c01'], min: 0, max: 1 }));
    expect(html).toContain('data-testid="choice-option-none"');
    expect(html).toMatch(/<input type="radio"[^>]*checked=""[^>]*value=""/);
    expect(html).toMatch(/data-testid="choice-option-none" data-selected="true"/);
    expect(html).not.toMatch(/<button type="submit"[^>]*disabled=""/);
  });

  it('shows handCreature options as the own hand cards', () => {
    const html = sheet(myChoice({ kind: 'handCreature', options: ['c01', 'c03'], min: 1, max: 1 }));
    expect(html).toContain('A creature from your hand');
    expect(html).toContain('aria-label="Orange 3, ATK 4"');
    expect(html).toContain('aria-label="Blue 2, ATK 3"');
  });

  it('disables every input and Confirm when this seat cannot act', () => {
    const html = sheet(
      myChoice({ kind: 'enemyCreature', options: ['c20', 'c21'], min: 0, max: 1 }),
      false,
    );
    expect(count(html, /<input[^>]*disabled=""/)).toBe(3);
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""/);
  });
});

describe('ActionBar', () => {
  const model = tableModel();
  const render = (cardId: string | null, canAct = true) =>
    renderToStaticMarkup(
      createElement(ActionBar, {
        commands: model.globalCommands,
        selectedCard: model.hand.find((card) => card.cardId === cardId) ?? null,
        myChoice: null,
        choiceOpen: false,
        canAct,
        onCommand: noop,
        onClearSelection: noop,
        onOpenChoice: noop,
      }),
    );

  it('shows only global commands when no card is selected', () => {
    const html = render(null);
    expect(html).not.toContain('data-testid="card-actions"');
    expect(html).toContain('data-testid="global-endTurn"');
    expect(html).toContain('data-testid="global-mulligan"');
  });

  it('offers exactly the legal commands of the selected card plus the global commands', () => {
    const html = render('c01');
    expect(html).toContain('aria-label="Actions for Orange 3, ATK 4"');
    expect(html).toContain('aria-label="Play Orange 3, ATK 4"');
    expect(html).not.toContain('card-nullify');
    expect(html).not.toContain('card-playSpell');
    expect(html).toContain('data-testid="global-endTurn"');
  });

  it('offers only Nullify for a card that can nullify (RD-173: no Play next to it)', () => {
    const html = render('c03');
    expect(html).toContain('aria-label="Nullify Blue 2, ATK 3"');
    expect(html).not.toContain('data-testid="card-playCreature"');
  });

  it('says so when the selected card has no legal command', () => {
    const html = render('c04');
    expect(html).toContain('data-testid="no-card-actions"');
    expect(html).not.toContain('data-testid="card-playCreature"');
  });

  it('disables commands when this seat cannot act', () => {
    expect(render('c01', false)).toMatch(/disabled=""[^>]*data-testid="card-playCreature"/);
  });
});

describe('CartignonTable', () => {
  const rejected: ActionResultMessage = {
    status: 'rejected',
    actionId: '6f1c2b8e-3d4a-4f5b-8c9d-0e1f2a3b4c5d',
    code: 'ILLEGAL',
    message: 'illegal',
  };

  it('opens the choice sheet in place of the hand when this seat must choose', () => {
    const html = renderToStaticMarkup(
      createElement(CartignonTable, {
        model: choiceModel({
          choiceId: 4,
          kind: 'ownCreature',
          options: ['c10'],
          min: 1,
          max: 1,
        }),
        canAct: true,
        onCommand: noop,
      }),
    );
    expect(html).toContain('data-testid="choice-sheet"');
    expect(html).not.toContain('data-testid="hand-row"');
  });

  it('shows the opponent choosing read-only, without a count for handCreature (RD-142)', () => {
    const model = tableModel({
      activeSeat: 1,
      priv: {
        legal: [],
        pendingChoiceView: { seat: 1, kind: 'handCreature', spellId: 'S-01', min: 1, max: 1 },
      },
    });
    const html = renderToStaticMarkup(
      createElement(CartignonTable, { model, canAct: false, onCommand: noop }),
    );
    const panel = /<p[^>]*data-testid="opponent-choosing"[^>]*>(.*?)<\/p>/.exec(html);
    expect(panel?.[1]).toBe('Opponent is choosing 1: a creature from their hand.');
    expect(html).not.toContain('data-testid="choice-sheet"');
    expect(html).not.toContain('data-testid="action-bar"');
  });

  it('keeps both live regions mounted and does not replay a result current at mount', () => {
    const html = renderToStaticMarkup(
      createElement(CartignonTable, {
        model: tableModel(),
        canAct: true,
        onCommand: noop,
        lastResult: rejected,
      }),
    );
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).not.toContain('data-testid="action-rejection"');
  });

  it('renders hand cards as toggle buttons', () => {
    const html = renderToStaticMarkup(
      createElement(CartignonTable, { model: tableModel(), canAct: true, onCommand: noop }),
    );
    expect(count(html, /aria-pressed="false"/)).toBe(4);
  });

  it('shows the deck and graveyard as pile buttons with counts, panels closed', () => {
    const html = renderToStaticMarkup(
      createElement(CartignonTable, { model: tableModel(), canAct: true, onCommand: noop }),
    );
    expect(html).toContain('aria-label="Deck: 21 cards"');
    expect(html).toContain('aria-label="Graveyard: 5 cards"');
    expect(count(html, /aria-expanded="false"/)).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain('data-testid="graveyard-panel"');
    expect(html).not.toMatch(/<dt[^>]*>Deck<\/dt>/);
  });

  it('badges a hand spell with the effect from spellHints and names it', () => {
    const html = renderToStaticMarkup(
      createElement(CartignonTable, { model: tableModel(), canAct: true, onCommand: noop }),
    );
    expect(count(html, /data-testid="spell-hint"/)).toBe(1);
    expect(html).toContain('data-branch="primary"');
    expect(html).toContain('aria-label="Spell Gambit. Cast now: primary effect."');
  });

  it('dims a spell that cannot be cast and gives the reason', () => {
    const model = tableModel({
      priv: {
        spellHints: [
          { cardId: 'c02', branch: 'secondary', castable: false, reason: 'NOT_YOUR_TURN' },
        ],
      },
    });
    const html = renderToStaticMarkup(
      createElement(CartignonTable, { model, canAct: true, onCommand: noop }),
    );
    expect(html).toContain('data-castable="false"');
    expect(html).toContain('Not castable now: It is not your turn.');
  });

  it('puts the event log behind a corner icon, closed, with the toast and live region', () => {
    const html = renderToStaticMarkup(
      createElement(CartignonTable, {
        model: tableModel(),
        canAct: true,
        onCommand: noop,
        log: [{ key: '1:0', revision: 1, actor: 'mine', text: 'First line.' }],
      }),
    );
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*data-testid="log-toggle"/);
    expect(html).toMatch(/<div[^>]*hidden=""[^>]*data-testid="log-panel"/);
    expect(html).toContain('data-testid="log-toast"');
    expect(html).toContain('data-testid="log-live"');
  });

  it('renders the detailed history grouped by round and turn, newest first', () => {
    const html = renderToStaticMarkup(
      createElement(ActionLog, {
        currentRound: 2,
        lines: [
          { key: '1:0', revision: 1, actor: null, text: 'Round one.', startsRound: true },
          {
            key: '2:0',
            revision: 2,
            actor: 'mine',
            text: 'First line.',
            turn: { number: 1, side: 'mine' },
            details: ['Activated: your Orange 3 — Buff +30 ATK.'],
          },
          { key: '3:0', revision: 3, actor: null, text: 'Round two.', startsRound: true },
          {
            key: '4:0',
            revision: 4,
            actor: 'theirs',
            text: 'Second line.',
            turn: { number: 1, side: 'theirs' },
          },
        ],
      }),
    );
    expect(html).toContain('role="log"');
    expect(html.indexOf('Second line.')).toBeLessThan(html.indexOf('First line.'));
    expect(html.indexOf('Round 2')).toBeLessThan(html.indexOf('Round 1'));
    expect(html).toContain('Turn 1 · Opponent');
    expect(html).toContain('Activated: your Orange 3 — Buff +30 ATK.');
  });
});
