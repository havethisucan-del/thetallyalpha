import { describe, expect, it } from 'vitest';
import {
  beatenBy,
  beats,
  COLORS,
  DEFAULT_COLOR_RULES,
  validateColorRules,
} from '../../src/cartignon/index.js';

describe('color cycle (RD-01)', () => {
  it('has the canonical order', () => {
    expect(COLORS).toEqual(['orange', 'yellow', 'green', 'blue', 'indigo', 'violet', 'red']);
  });

  it('default: each color beats the next, red beats orange', () => {
    COLORS.forEach((c, i) => {
      const next = COLORS[(i + 1) % COLORS.length];
      expect(DEFAULT_COLOR_RULES[c]).toBe(next);
    });
    expect(beats(DEFAULT_COLOR_RULES, 'red', 'orange')).toBe(true);
    expect(beats(DEFAULT_COLOR_RULES, 'orange', 'red')).toBe(false);
  });

  it('each color beats exactly one, is beaten by exactly one, neutral vs the rest', () => {
    for (const a of COLORS) {
      const beaten = COLORS.filter((b) => beats(DEFAULT_COLOR_RULES, a, b));
      const beatenByList = COLORS.filter((b) => beats(DEFAULT_COLOR_RULES, b, a));
      expect(beaten).toHaveLength(1);
      expect(beatenByList).toEqual([beatenBy(DEFAULT_COLOR_RULES, a)]);
      expect(beats(DEFAULT_COLOR_RULES, a, a)).toBe(false);
    }
  });

  it('accepts the default config and returns a copy', () => {
    const result = validateColorRules({ ...DEFAULT_COLOR_RULES });
    expect(result).toEqual({ ok: true, value: DEFAULT_COLOR_RULES });
  });

  it.each([
    ['non-object', 'orange'],
    ['null', null],
    ['array', []],
    ['missing color', { ...DEFAULT_COLOR_RULES, red: undefined }],
    ['unknown key', { ...DEFAULT_COLOR_RULES, pink: 'red' }],
    ['unknown target', { ...DEFAULT_COLOR_RULES, red: 'pink' }],
    ['beats itself', { ...DEFAULT_COLOR_RULES, red: 'red' }],
    ['two colors beat the same one', { ...DEFAULT_COLOR_RULES, red: 'yellow' }],
    [
      'mutual pairs (not neutral vs the other four)',
      {
        orange: 'yellow',
        yellow: 'orange',
        green: 'blue',
        blue: 'green',
        indigo: 'violet',
        violet: 'red',
        red: 'indigo',
      },
    ],
  ])('rejects invalid config: %s', (_label, input) => {
    const result = validateColorRules(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_COLOR_RULES');
  });

  it('accepts a 3+4 cycle config (a single 7-cycle is not a confirmed requirement)', () => {
    const input = {
      orange: 'yellow',
      yellow: 'green',
      green: 'orange',
      blue: 'indigo',
      indigo: 'violet',
      violet: 'red',
      red: 'blue',
    };
    expect(validateColorRules(input)).toEqual({ ok: true, value: input });
  });

  it('beatenBy throws on unvalidated broken rules (programmer error)', () => {
    const broken = { ...DEFAULT_COLOR_RULES, red: 'yellow' } as const;
    expect(() => beatenBy(broken, 'orange')).toThrow();
  });
});
