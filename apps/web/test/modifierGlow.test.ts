import type { CartignonSeatEvent } from '@cartignon/protocol';
import { describe, expect, it } from 'vitest';
import { modifierGlows } from '../src/match/cartignon/modifierGlow';

function live(cardId: string, position: number): CartignonSeatEvent {
  return { type: 'modifierLive', seat: 0, cardId, kind: 'buffSelf', position };
}
function silenced(cardId: string, position: number): CartignonSeatEvent {
  return { type: 'modifierSilenced', seat: 0, cardId, kind: 'buffSelf', position };
}

describe('modifierGlows', () => {
  it('glows the live modifier (index = stack position - 1)', () => {
    const glows = modifierGlows(
      [live('c02', 1)],
      [{ cardId: 'c02', position: 1 }],
      [
        { cardId: 'c01', position: 0 },
        { cardId: 'c02', position: 1 },
      ],
    );
    expect(glows.get('c02')).toEqual({ index: 0, state: 'live' });
    expect(glows.has('c01')).toBe(false);
  });

  it('dims a modifier the events reported live and then silenced', () => {
    const glows = modifierGlows(
      [live('c02', 1), silenced('c02', 1), live('c03', 2)],
      [{ cardId: 'c03', position: 2 }],
      [
        { cardId: 'c01', position: 0 },
        { cardId: 'c02', position: 1 },
        { cardId: 'c03', position: 2 },
      ],
    );
    expect(glows.get('c02')).toEqual({ index: 0, state: 'silenced' });
    expect(glows.get('c03')).toEqual({ index: 1, state: 'live' });
  });

  it('glows again when a silenced modifier becomes live once more', () => {
    const glows = modifierGlows(
      [live('c02', 1), silenced('c02', 1), live('c02', 1)],
      [{ cardId: 'c02', position: 1 }],
      [{ cardId: 'c02', position: 1 }],
    );
    expect(glows.get('c02')?.state).toBe('live');
  });

  it('trusts the snapshot: live without events (rejoin), silenced when no longer live', () => {
    expect(
      modifierGlows([], [{ cardId: 'c02', position: 1 }], [{ cardId: 'c02', position: 1 }]).get(
        'c02',
      ),
    ).toEqual({ index: 0, state: 'live' });
    // Reported live, but the view no longer lists it (e.g. negated afterwards).
    expect(
      modifierGlows([live('c02', 1)], [], [{ cardId: 'c02', position: 1 }]).get('c02')?.state,
    ).toBe('silenced');
  });

  it('ignores cards off the stacks and stale entries for another position', () => {
    const glows = modifierGlows(
      [live('c02', 1), silenced('c02', 1), live('c09', 3)],
      [],
      [{ cardId: 'c02', position: 2 }],
    );
    expect(glows.size).toBe(0);
  });
});
