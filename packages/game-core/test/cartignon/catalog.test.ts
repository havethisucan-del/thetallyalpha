import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildCatalog,
  CatalogBuildError,
  CatalogLoadError,
  COLORS,
  CREATURE_LEVELS,
  parseCatalog,
  parseCsv,
  createRoundContext,
  isSpellSupported,
  loadBuiltCatalog,
  loadCatalog,
  roundCatalogIssues,
  spellEntry,
  SPELL_REGISTRY,
  type BuiltCatalog,
} from '../../src/cartignon/index.js';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const CREATURES_CSV = read('../../../../docs/cards/creatures.csv');
const SPELLS_CSV = read('../../../../docs/cards/spells.csv');
const CREATURE_HEADER = 'card_id,color,level,atk,modifiers';
const SPELL_HEADER = 'card_id,name,condition,primary_effect,secondary_effect,secondary_type';

describe('parseCsv (RFC 4180 subset)', () => {
  it('splits fields and records (LF and CRLF), drops a BOM and the final newline', () => {
    expect(parseCsv('\uFEFFa,b\r\nc,d\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parseCsv('a,,b')).toEqual([['a', '', 'b']]);
  });

  it('handles quoted commas, escaped quotes, line breaks and UTF-8 text', () => {
    expect(parseCsv('"x, y","say ""hi""","a\nb",čćžšđ\n')).toEqual([
      ['x, y', 'say "hi"', 'a\nb', 'čćžšđ'],
    ]);
    expect(parseCsv('"",x')).toEqual([['', 'x']]);
  });

  it('rejects an unterminated quote and text after a closing quote', () => {
    expect(() => parseCsv('"abc')).toThrow(CatalogBuildError);
    expect(() => parseCsv('"abc"d,e')).toThrow(CatalogBuildError);
  });

  it('accepts CRLF directly after a closing quote', () => {
    expect(parseCsv('"a,b",x\r\n"c"\r\n"d"')).toEqual([['a,b', 'x'], ['c'], ['d']]);
  });

  it('keeps a blank line mid-file as one empty field (buildCatalog skips it)', () => {
    expect(parseCsv('a\n\nb\n')).toEqual([['a'], [''], ['b']]);
  });

  it('reports the physical line of an error after a multi-line quoted field', () => {
    expect(() => parseCsv('a\n"x\ny\nz"\n"bad"q')).toThrow(/^CSV line 5:/);
    expect(() => parseCsv('a\r\n"x\r\ny"\r\n"open')).toThrow(/^CSV line 4:/);
  });
});

describe('buildCatalog (ADR-0007 section 1)', () => {
  const catalog = buildCatalog(CREATURES_CSV, SPELLS_CSV);

  it('builds 35 creatures (one per color x level, RD-02, RD-99) and 19 spells', () => {
    expect(catalog.creatures).toHaveLength(35);
    expect(catalog.spells).toHaveLength(19);
    for (const color of COLORS) {
      for (const level of CREATURE_LEVELS) {
        expect(
          catalog.creatures.filter((c) => c.color === color && c.level === level),
        ).toHaveLength(1);
      }
    }
  });

  it('maps rows exactly (RD-97 positions, RD-98 draw kinds, RD-99 colors)', () => {
    expect(catalog.creatures[0]).toEqual({
      defId: 'C-A1',
      kind: 'creature',
      color: 'orange',
      level: 1,
      atk: 19,
      modifiers: ['nerfEnemyLeader', 'buffSelf', 'buffSelf', 'linkUp'],
    });
    expect(catalog.creatures.find((c) => c.defId === 'C-G1')).toMatchObject({
      color: 'red',
      modifiers: ['drawDeck', 'linkUp', 'drawDeck', 'nerfEnemyLeader'],
    });
    expect(catalog.creatures.find((c) => c.defId === 'C-B5')?.modifiers).toEqual(['drawGrave']);
  });

  it('keeps spell text verbatim (quoted commas) and maps secondary_type', () => {
    const s01 = catalog.spells[0];
    expect(s01).toEqual({
      defId: 'S-01',
      kind: 'spell',
      name: 'Foresight',
      text: {
        condition: 'There is a Level 3 creature on the field (either side).',
        primary:
          'Draw 2 cards from the deck and look at them. Keep 1 and put the other back into the deck, then shuffle the deck. Your opponent does not see the drawn cards.',
        secondary: "Your opponent's Leading creature gets -30 ATK until the end of the round.",
      },
      secondary: { kind: 'nerfEnemyLeader', amount: 30 },
    });
    const kinds = catalog.spells.map((s) => s.secondary);
    expect(kinds.filter((k) => k.kind === 'buffOwnLeader')).toHaveLength(5);
    expect(kinds.filter((k) => k.kind === 'nerfEnemyLeader')).toHaveLength(5);
    expect(kinds).toContainEqual({ kind: 'draw', from: 'deck', count: 1 });
    expect(kinds).toContainEqual({ kind: 'draw', from: 'graveyard', count: 1 });
    expect(catalog.spells.find((s) => s.defId === 'S-19')?.secondary).toEqual({ kind: 'none' });
  });

  it('creature and spell data pass the engine shape check (parseCatalog)', () => {
    expect(parseCatalog(catalog.creatures)).toEqual({ ok: true, value: catalog.creatures });
    expect(parseCatalog(catalog.spells)).toEqual({ ok: true, value: catalog.spells });
  });

  const creatureRow = (row: string): string =>
    CREATURES_CSV.replace(/^C-A1,.*$/m, row).replace(/\r/g, '');

  it.each([
    ['unknown modifier token', 'C-A1,A,1,19,Buff +30 / Fly'],
    ['unknown color letter', 'C-A1,H,1,19,Buff +30'],
    ['level out of range', 'C-A1,A,6,19,Buff +30'],
    ['non-integer atk', 'C-A1,A,1,19.5,Buff +30'],
    ['negative atk', 'C-A1,A,1,-1,Buff +30'],
    ['missing field', 'C-A1,A,1,19'],
    ['duplicate slot (composition)', 'C-A1,A,2,19,Buff +30'],
  ])('throws on %s', (_label, row) => {
    expect(() => buildCatalog(creatureRow(row), SPELLS_CSV)).toThrow(CatalogBuildError);
  });

  it('skips blank lines mid-file and extra trailing newlines', () => {
    const lines = CREATURES_CSV.split(/\r?\n/);
    const spaced = [...lines.slice(0, 10), '', ...lines.slice(10), '', ''].join('\n');
    expect(buildCatalog(spaced, `${SPELLS_CSV}\n\n`)).toEqual(catalog);
  });

  it('error messages name the physical source line, also after a multi-line field', () => {
    // S-01 (line 2) gets a line break in its condition, so S-02 starts on physical line 4.
    const multi = SPELLS_CSV.replace(
      'There is a Level 3 creature on the field (either side).',
      'There is a Level 3\ncreature on the field (either side).',
    ).replace('"Buff (+30 ATK)"', '"Heal"');
    expect(() => buildCatalog(CREATURES_CSV, multi)).toThrow(/^spells\.csv line 4: unknown/);
    const badRow = CREATURES_CSV.replace(/^C-A3,.*$/m, 'C-A3,A,3,52');
    expect(() => buildCatalog(badRow, SPELLS_CSV)).toThrow(/^creatures\.csv line 4: expected 5/);
  });

  it('throws on an unknown secondary_type, a wrong header and a missing spell', () => {
    const badType = SPELLS_CSV.replace('"Nerf (-30 ATK)"', '"Heal"');
    expect(() => buildCatalog(CREATURES_CSV, badType)).toThrow(/unknown secondary_type/);
    const badHeader = CREATURES_CSV.replace(CREATURE_HEADER, 'id,color,level,atk,modifiers');
    expect(() => buildCatalog(badHeader, SPELLS_CSV)).toThrow(/header/);
    const lines = SPELLS_CSV.split(/\r?\n/);
    expect(lines[0]).toBe(SPELL_HEADER);
    const short = lines.filter((l) => !l.startsWith('S-19,')).join('\n');
    expect(() => buildCatalog(CREATURES_CSV, short)).toThrow(/composition/);
  });
});

describe('data/cards.json drift (ADR-0007)', () => {
  const json = JSON.parse(read('../../data/cards.json')) as BuiltCatalog;

  it('equals a fresh build from docs/cards/*.csv (run `pnpm cards:generate` if this fails)', () => {
    expect(json).toEqual(buildCatalog(CREATURES_CSV, SPELLS_CSV));
  });

  it('every spell has exactly one handler registry entry, and every entry a spell', () => {
    const spellIds = json.spells.map((s) => s.defId);
    expect(new Set(spellIds).size).toBe(spellIds.length);
    const entries = Object.keys(SPELL_REGISTRY);
    expect([...entries].sort()).toEqual([...spellIds].sort());
    for (const s of json.spells) expect(spellEntry(s)).toBe(SPELL_REGISTRY[s.defId]);
  });

  it('the whole catalog loads and is a valid round context (R4c: spells included)', () => {
    const all = [...json.creatures, ...json.spells];
    expect(loadCatalog(all)).toEqual({ ok: true, value: all });
    expect(roundCatalogIssues(all)).toEqual([]);
    expect(() => createRoundContext(all)).not.toThrow();
  });

  it('loadBuiltCatalog equals the previous loadCatalog([...creatures, ...spells]) path', () => {
    const previous = loadCatalog([...json.creatures, ...json.spells]);
    expect(previous.ok).toBe(true);
    const catalog = loadBuiltCatalog(json);
    expect(catalog).toEqual(previous.ok ? previous.value : undefined);
    expect(catalog.filter((c) => c.kind === 'creature')).toHaveLength(35);
    expect(catalog.filter((c) => c.kind === 'spell')).toHaveLength(19);
    expect(catalog.map((c) => c.defId)).toEqual([
      ...json.creatures.map((c) => c.defId),
      ...json.spells.map((s) => s.defId),
    ]);
    expect(() => createRoundContext(catalog)).not.toThrow();
  });

  it('loadBuiltCatalog throws CatalogLoadError on malformed input', () => {
    for (const bad of [null, 42, 'x', [], {}, { creatures: [] }, { creatures: {}, spells: [] }]) {
      expect(() => loadBuiltCatalog(bad)).toThrow(CatalogLoadError);
    }
    const missingSpell = { creatures: json.creatures, spells: json.spells.slice(1) };
    expect(() => loadBuiltCatalog(missingSpell)).toThrow(/card catalog is invalid \(.*SPELL_COUNT/);
    const caught = ((): unknown => {
      try {
        return loadBuiltCatalog(missingSpell);
      } catch (e) {
        return e;
      }
    })();
    expect(caught).toBeInstanceOf(CatalogLoadError);
    expect((caught as CatalogLoadError).issues.length).toBeGreaterThan(0);
    const badCard = { creatures: [{ defId: 'x' }], spells: json.spells };
    expect(() => loadBuiltCatalog(badCard)).toThrow(CatalogLoadError);
  });

  it('R4c-5 supports every spell (S-19 included)', () => {
    const supported = json.spells.filter(isSpellSupported).map((s) => s.defId);
    expect(supported).toEqual([
      'S-01',
      'S-02',
      'S-03',
      'S-04',
      'S-05',
      'S-06',
      'S-07',
      'S-08',
      'S-09',
      'S-10',
      'S-11',
      'S-12',
      'S-13',
      'S-14',
      'S-15',
      'S-16',
      'S-17',
      'S-18',
      'S-19',
    ]);
  });
});
