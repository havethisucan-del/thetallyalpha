import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DECK_COMPOSITION,
  LEADER_MODIFIER_AMOUNT,
  loadCatalog,
  parseCatalog,
  validateCatalog,
  type CardCatalog,
  type CatalogIssueCode,
} from '../../src/cartignon/index.js';
import { placeholderCatalog } from './test-fixtures.js';

/** A one-creature raw catalog carrying the given (untrusted) modifiers value. */
function withModifiers(modifiers: unknown): unknown[] {
  return [{ defId: 'x', kind: 'creature', color: 'red', level: 2, atk: 20, modifiers }];
}

function issueCodes(result: ReturnType<typeof validateCatalog>): CatalogIssueCode[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

describe('catalog validation (RD-02)', () => {
  it('accepts the placeholder fixture', () => {
    const catalog = placeholderCatalog();
    expect(catalog).toHaveLength(54);
    expect(validateCatalog(catalog, DEFAULT_DECK_COMPOSITION).ok).toBe(true);
  });

  it('round-trips through JSON (untrusted input path)', () => {
    const json: unknown = JSON.parse(JSON.stringify(placeholderCatalog()));
    expect(loadCatalog(json)).toEqual({ ok: true, value: placeholderCatalog() });
  });

  it('rejects duplicate defIds', () => {
    const catalog = placeholderCatalog();
    const [first] = catalog;
    const dup: CardCatalog = catalog.map((c, i) =>
      i === catalog.length - 1 && first ? { ...c, defId: first.defId } : c,
    );
    expect(issueCodes(validateCatalog(dup, DEFAULT_DECK_COMPOSITION))).toContain(
      'DUPLICATE_DEF_ID',
    );
  });

  it('rejects a missing creature slot and wrong counts', () => {
    const catalog = placeholderCatalog().filter(
      (c) => !(c.kind === 'creature' && c.color === 'red' && c.level === 5),
    );
    const codes = issueCodes(validateCatalog(catalog, DEFAULT_DECK_COMPOSITION));
    expect(codes).toEqual(
      expect.arrayContaining(['MISSING_CREATURE', 'CREATURE_COUNT', 'TOTAL_COUNT']),
    );
  });

  it('rejects two creatures in one color x level slot', () => {
    const catalog = placeholderCatalog().map((c) =>
      c.kind === 'creature' && c.color === 'red' && c.level === 5 ? { ...c, level: 4 as const } : c,
    );
    const codes = issueCodes(validateCatalog(catalog, DEFAULT_DECK_COMPOSITION));
    expect(codes).toEqual(expect.arrayContaining(['DUPLICATE_CREATURE', 'MISSING_CREATURE']));
    expect(codes).not.toContain('CREATURE_COUNT');
  });

  it('rejects a wrong spell count', () => {
    const catalog = placeholderCatalog().slice(0, 53);
    expect(issueCodes(validateCatalog(catalog, DEFAULT_DECK_COMPOSITION))).toEqual(
      expect.arrayContaining(['SPELL_COUNT', 'TOTAL_COUNT']),
    );
  });

  it.each([
    ['not an array', { cards: [] }],
    ['null entry', [null]],
    ['unknown kind', [{ defId: 'x', kind: 'land' }]],
    ['empty defId', [{ defId: '', kind: 'spell', name: 'n' }]],
    ['unknown key (typo)', [{ defId: 'x', kind: 'spell', name: 'n', nmae: 'n' }]],
    ['bad color', [{ defId: 'x', kind: 'creature', color: 'pink', level: 1, atk: 10 }]],
    ['level out of range', [{ defId: 'x', kind: 'creature', color: 'red', level: 6, atk: 10 }]],
    ['non-integer level', [{ defId: 'x', kind: 'creature', color: 'red', level: 1.5, atk: 10 }]],
    ['atk not a number', [{ defId: 'x', kind: 'creature', color: 'red', level: 1, atk: '10' }]],
    ['atk null', [{ defId: 'x', kind: 'creature', color: 'red', level: 1, atk: null }]],
    ['atk NaN (RD-28)', [{ defId: 'x', kind: 'creature', color: 'red', level: 1, atk: NaN }]],
    ['atk 12.5 (RD-28)', [{ defId: 'x', kind: 'creature', color: 'red', level: 1, atk: 12.5 }]],
    ['atk Infinity', [{ defId: 'x', kind: 'creature', color: 'red', level: 1, atk: Infinity }]],
    [
      'unknown modifier kind',
      [
        {
          defId: 'x',
          kind: 'creature',
          color: 'red',
          level: 1,
          atk: 1,
          modifiers: ['fly'],
        },
      ],
    ],
    ['atk -1 (RD-37)', [{ defId: 'x', kind: 'creature', color: 'red', level: 1, atk: -1 }]],
    ['modifiers missing', [{ defId: 'x', kind: 'creature', color: 'red', level: 1, atk: 1 }]],
    ['modifiers not an array', withModifiers('buffSelf')],
    ['drawGraveyard is not a kind (it is drawGrave)', withModifiers(['drawGraveyard'])],
    ['old name buffFriendlyLeader', withModifiers(['buffFriendlyLeader'])],
    ['old object shape (R2)', withModifiers([{ kind: 'linkUp', stackIndex: 1 }])],
    ['null entry', withModifiers(['linkUp', null])],
    [
      'old single modifier key',
      [{ ...(withModifiers([])[0] as object), modifier: { kind: 'linkUp', stackIndex: 1 } }],
    ],
  ])('parseCatalog rejects bad shape: %s', (_label, input) => {
    const result = parseCatalog(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.every((i) => i.code === 'MALFORMED')).toBe(true);
  });

  it('parseCatalog accepts an integer atk such as 253 (RD-28)', () => {
    const input = [
      { defId: 'x', kind: 'creature', color: 'red', level: 1, atk: 253, modifiers: [] },
    ];
    expect(parseCatalog(input)).toEqual({ ok: true, value: input });
  });

  it('parseCatalog accepts atk 0 (RD-37)', () => {
    const input = [{ defId: 'x', kind: 'creature', color: 'red', level: 1, atk: 0, modifiers: [] }];
    expect(parseCatalog(input)).toEqual({ ok: true, value: input });
  });

  it('placeholder fixture uses integer atk >= 0 only (RD-28, RD-37)', () => {
    for (const c of placeholderCatalog()) {
      if (c.kind === 'creature') {
        expect(Number.isInteger(c.atk)).toBe(true);
        expect(c.atk).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it.each([
    [[]],
    [['nerfEnemyLeader']],
    [['buffSelf', 'drawDeck', 'drawGrave', 'linkUp']],
    // RD-97: no upper bound, Link Up can grow a stack past 5 cards.
    [['linkUp', 'linkUp', 'linkUp', 'linkUp', 'linkUp', 'linkUp', 'buffSelf']],
  ])('parseCatalog keeps valid modifiers %j (RD-97, RD-98)', (modifiers) => {
    const input = withModifiers(modifiers);
    expect(parseCatalog(input)).toEqual({ ok: true, value: input });
  });

  it('leader buff/nerf magnitude is the RD-39 rule constant', () => {
    expect(LEADER_MODIFIER_AMOUNT).toBe(30);
  });
});
