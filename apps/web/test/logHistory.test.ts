import { describe, expect, it } from 'vitest';
import { groupHistory, mergeHistory, unreadCount } from '../src/match/cartignon/logHistory';
import type { NarrationLine } from '../src/match/cartignon/narration';

function line(key: string, extra: Partial<NarrationLine> = {}): NarrationLine {
  return { key, revision: Number(key.split(':')[0]), actor: 'mine', text: `line ${key}`, ...extra };
}

describe('mergeHistory', () => {
  it('appends new lines, keeps old ones and returns the same array when nothing changed', () => {
    const first = mergeHistory([], [line('1:0'), line('2:0')]);
    expect(first.map((l) => l.key)).toEqual(['1:0', '2:0']);
    // The rolling log dropped 1:0; the history keeps it.
    const second = mergeHistory(first, [line('2:0'), line('3:0')]);
    expect(second.map((l) => l.key)).toEqual(['1:0', '2:0', '3:0']);
    expect(mergeHistory(second, [line('3:0')])).toBe(second);
  });

  it('takes newer text but keeps the first-seen grouping', () => {
    const first = mergeHistory([], [line('1:0', { turn: { number: 2, side: 'mine' } })]);
    const next = mergeHistory(first, [line('1:0', { text: 'longer' })]);
    expect(next[0]?.text).toBe('longer');
    expect(next[0]?.turn).toEqual({ number: 2, side: 'mine' });
  });

  it('caps the history', () => {
    expect(mergeHistory([], [line('1:0'), line('2:0'), line('3:0')], 2).map((l) => l.key)).toEqual([
      '2:0',
      '3:0',
    ]);
  });
});

describe('unreadCount', () => {
  const history = [line('1:0'), line('2:0'), line('3:0')];
  it('counts lines after the seen one, skipping the toast still in the air', () => {
    expect(unreadCount(history, '1:0')).toBe(2);
    expect(unreadCount(history, '1:0', '3:0')).toBe(1);
    expect(unreadCount(history, '3:0')).toBe(0);
    expect(unreadCount(history, null)).toBe(3);
  });
});

describe('groupHistory', () => {
  it('groups by round (numbered back from the current one) and turn, newest first', () => {
    const groups = groupHistory(
      [
        line('1:0', { turn: { number: 3, side: 'theirs' } }),
        line('2:0', { startsRound: true }),
        line('3:0', { turn: { number: 1, side: 'mine' } }),
        line('4:0', { turn: { number: 1, side: 'mine' } }),
        line('5:0', { turn: { number: 2, side: 'theirs' } }),
        line('6:0', { turn: 'end' }),
      ],
      5,
    );
    expect(groups.map((g) => g.round)).toEqual([5, 4]);
    expect(groups[0]?.turns.map((t) => t.label)).toEqual([
      'Round result',
      'Turn 2 · Opponent',
      'Turn 1 · You',
      'Round start',
    ]);
    expect(groups[0]?.turns[2]?.lines.map((l) => l.key)).toEqual(['4:0', '3:0']);
  });

  it('labels a round the history does not see start as earlier when it cannot be numbered', () => {
    const groups = groupHistory([line('1:0'), line('2:0', { startsRound: true })], 1);
    expect(groups.map((g) => g.round)).toEqual([1, null]);
  });
});
