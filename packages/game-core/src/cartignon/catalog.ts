import {
  CREATURE_LEVELS,
  DEFAULT_DECK_COMPOSITION,
  loadCatalog,
  validateCatalog,
  type CardCatalog,
  type CatalogIssue,
  type CreatureDef,
  type CreatureLevel,
  type ModifierKind,
  type SecondarySpec,
  type SpellDef,
} from './cards.js';
import type { Color } from './colors.js';

/**
 * Card catalog built from the user-edited CSVs in `docs/cards/` (ADR-0007 section 1, R4b).
 * `buildCatalog` is pure (strings in, data out); the generator script
 * (`packages/game-core/scripts/generate-cards.js`) writes the result to `data/cards.json`, and a
 * drift test keeps the two in sync. Any unknown token or malformed row throws
 * `CatalogBuildError`: generation stops instead of guessing.
 */

/** RD-99: CSV color letters in RD-01 order. */
export const CSV_COLOR_MAP: Readonly<Record<string, Color>> = Object.freeze({
  A: 'orange',
  B: 'yellow',
  C: 'green',
  D: 'blue',
  E: 'indigo',
  F: 'violet',
  G: 'red',
});

/** RD-97 / RD-98: CSV modifier tokens. Amounts are the RD-39 constant, not data. */
export const CSV_MODIFIER_MAP: Readonly<Record<string, ModifierKind>> = Object.freeze({
  'Buff +30': 'buffSelf',
  'Nerf -30': 'nerfEnemyLeader',
  'Link Up': 'linkUp',
  'Draw Deck': 'drawDeck',
  'Draw Grave': 'drawGrave',
});

/** CSV `secondary_type` -> SecondarySpec (ADR-0007). */
const SECONDARY_TYPE_MAP: Readonly<Record<string, SecondarySpec>> = Object.freeze({
  'Nerf (-30 ATK)': { kind: 'nerfEnemyLeader', amount: 30 },
  'Buff (+30 ATK)': { kind: 'buffOwnLeader', amount: 30 },
  'Deck Draw': { kind: 'draw', from: 'deck', count: 1 },
  'Grave Draw': { kind: 'draw', from: 'graveyard', count: 1 },
  None: { kind: 'none' },
});

/**
 * A spell of `data/cards.json`. Since R4c this is the engine `SpellDef`, so the whole catalog
 * (`[...creatures, ...spells]`) is loadable by `loadCatalog`.
 */
export type CatalogSpell = SpellDef;

export interface BuiltCatalog {
  readonly creatures: readonly CreatureDef[];
  readonly spells: readonly CatalogSpell[];
}

export class CatalogBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogBuildError';
  }
}

/**
 * Thrown by `loadBuiltCatalog` when the input is not a loadable `BuiltCatalog`. `issues` holds
 * the `loadCatalog` issues (empty when the top-level shape itself is wrong).
 */
export class CatalogLoadError extends Error {
  readonly issues: readonly CatalogIssue[];
  constructor(message: string, issues: readonly CatalogIssue[] = []) {
    super(message);
    this.name = 'CatalogLoadError';
    this.issues = issues;
  }
}

/**
 * Turns the already-parsed built `data/cards.json` (`{ creatures, spells }`, ADR-0007) into the
 * `CardCatalog` (`[...creatures, ...spells]`) that `createCartignonRules` / `createRoundContext`
 * consume, validated by `loadCatalog` (shape + RD-02 composition). Environment-neutral: callers
 * read/import the JSON themselves (Node `fs`/`require`, or a bundler JSON import in the browser).
 * Throws `CatalogLoadError` on malformed input.
 */
export function loadBuiltCatalog(json: unknown): CardCatalog {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new CatalogLoadError(
      'card catalog is invalid (expected an object { creatures, spells })',
    );
  }
  const { creatures, spells } = json as { creatures?: unknown; spells?: unknown };
  if (!Array.isArray(creatures) || !Array.isArray(spells)) {
    throw new CatalogLoadError('card catalog is invalid (creatures and spells must be arrays)');
  }
  const loaded = loadCatalog([...(creatures as unknown[]), ...(spells as unknown[])]);
  if (!loaded.ok) {
    const codes = loaded.issues.slice(0, 5).map((issue) => issue.code);
    throw new CatalogLoadError(`card catalog is invalid (${codes.join(', ')})`, loaded.issues);
  }
  return loaded.value;
}

/**
 * Minimal RFC 4180 parser: comma-separated fields, CRLF or LF record ends, double-quoted fields
 * that may contain commas, line breaks and `""` escapes. A leading UTF-8 BOM is dropped, and so
 * is a final empty line. Throws on an unterminated quote or text after a closing quote.
 */
export function parseCsv(text: string): string[][] {
  return parseCsvRows(text).map((r) => r.fields);
}

/** One CSV record and the physical (1-based) source line it starts on. */
interface CsvRow {
  readonly fields: string[];
  readonly line: number;
}

function parseCsvRows(text: string): CsvRow[] {
  const src = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const rows: CsvRow[] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let line = 1; // physical line of the current character
  let rowLine = 1; // physical line the current record started on
  let quoted = false; // the current field started with a quote
  let afterQuote = false; // its closing quote has been read
  const endField = (): void => {
    row.push(field);
    field = '';
    quoted = false;
    afterQuote = false;
  };
  const endRow = (): void => {
    endField();
    rows.push({ fields: row, line: rowLine });
    row = [];
    rowLine = line;
  };
  while (i < src.length) {
    const ch = src[i] as string;
    if (quoted && !afterQuote) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        afterQuote = true;
      } else {
        field += ch;
        if (ch === '\n') line++; // a line break inside a quoted field
      }
      i++;
      continue;
    }
    if (ch === ',') {
      endField();
    } else if (ch === '\n' || (ch === '\r' && src[i + 1] === '\n')) {
      if (ch === '\r') i++;
      line++;
      endRow();
    } else if (afterQuote) {
      throw new CatalogBuildError(`CSV line ${line}: unexpected character after a closing quote`);
    } else if (ch === '"' && field.length === 0) {
      quoted = true;
    } else {
      field += ch;
    }
    i++;
  }
  if (quoted && !afterQuote) {
    throw new CatalogBuildError(`CSV line ${rowLine}: unterminated quoted field`);
  }
  if (field.length > 0 || row.length > 0 || quoted) endRow();
  return rows;
}

interface CsvRecord {
  readonly rec: Record<string, string>;
  /** Physical 1-based source line the record starts on (correct after multi-line fields). */
  readonly line: number;
}

/**
 * Header check + rows as records keyed by column name. Blank lines (a row that is exactly one
 * empty field) are skipped, wherever they appear.
 */
function records(csv: string, file: string, header: readonly string[]): CsvRecord[] {
  const rows = parseCsvRows(csv).filter((r) => !(r.fields.length === 1 && r.fields[0] === ''));
  const [head, ...body] = rows;
  if (head === undefined || head.fields.join(',') !== header.join(',')) {
    throw new CatalogBuildError(`${file}: header must be ${header.join(',')}`);
  }
  return body.map(({ fields, line }) => {
    if (fields.length !== header.length) {
      throw new CatalogBuildError(
        `${file} line ${line}: expected ${header.length} fields, found ${fields.length}`,
      );
    }
    return { rec: Object.fromEntries(header.map((h, j) => [h, fields[j] as string])), line };
  });
}

function field(rec: Record<string, string>, key: string): string {
  return rec[key] ?? '';
}

function parseCreature(rec: Record<string, string>, at: string): CreatureDef {
  const defId = field(rec, 'card_id').trim();
  if (defId.length === 0) throw new CatalogBuildError(`${at}: empty card_id`);
  const color = CSV_COLOR_MAP[field(rec, 'color').trim()];
  if (color === undefined) throw new CatalogBuildError(`${at}: unknown color "${rec['color']}"`);
  const levelText = field(rec, 'level').trim();
  const level = Number(levelText);
  if (!/^\d+$/.test(levelText) || !(CREATURE_LEVELS as readonly number[]).includes(level)) {
    throw new CatalogBuildError(`${at}: level must be 1-5, found "${levelText}"`);
  }
  const atkText = field(rec, 'atk').trim();
  // RD-28 / RD-37: integer >= 0.
  if (!/^\d+$/.test(atkText)) {
    throw new CatalogBuildError(`${at}: atk must be an integer >= 0, found "${atkText}"`);
  }
  const modText = field(rec, 'modifiers').trim();
  const modifiers = modText.length === 0 ? [] : modText.split('/').map((t) => t.trim());
  const kinds = modifiers.map((token) => {
    const kind = CSV_MODIFIER_MAP[token];
    if (kind === undefined) throw new CatalogBuildError(`${at}: unknown modifier "${token}"`);
    return kind;
  });
  return {
    defId,
    kind: 'creature',
    color,
    level: level as CreatureLevel,
    atk: Number(atkText),
    modifiers: kinds,
  };
}

function parseSpell(rec: Record<string, string>, at: string): CatalogSpell {
  const defId = field(rec, 'card_id').trim();
  if (defId.length === 0) throw new CatalogBuildError(`${at}: empty card_id`);
  const name = field(rec, 'name').trim();
  if (name.length === 0) throw new CatalogBuildError(`${at}: empty name`);
  const type = field(rec, 'secondary_type').trim();
  const spec = SECONDARY_TYPE_MAP[type];
  if (spec === undefined) throw new CatalogBuildError(`${at}: unknown secondary_type "${type}"`);
  return {
    defId,
    kind: 'spell',
    name,
    text: {
      condition: field(rec, 'condition'),
      primary: field(rec, 'primary_effect'),
      secondary: field(rec, 'secondary_effect'),
    },
    secondary: { ...spec },
  };
}

const CREATURE_HEADER = ['card_id', 'color', 'level', 'atk', 'modifiers'] as const;
const SPELL_HEADER = [
  'card_id',
  'name',
  'condition',
  'primary_effect',
  'secondary_effect',
  'secondary_type',
] as const;

/**
 * ADR-0007 section 1: builds the catalog from `docs/cards/creatures.csv` and
 * `docs/cards/spells.csv` (their text content). Also checks the RD-02 composition (unique ids,
 * one creature per color x level, 35 + 19 cards). Throws `CatalogBuildError` on any problem.
 */
export function buildCatalog(creaturesCsv: string, spellsCsv: string): BuiltCatalog {
  const creatures = records(creaturesCsv, 'creatures.csv', CREATURE_HEADER).map((r) =>
    parseCreature(r.rec, `creatures.csv line ${r.line}`),
  );
  const spells = records(spellsCsv, 'spells.csv', SPELL_HEADER).map((r) =>
    parseSpell(r.rec, `spells.csv line ${r.line}`),
  );
  // Composition (RD-02) and spell data shape via the shared check.
  const composition = validateCatalog([...creatures, ...spells], DEFAULT_DECK_COMPOSITION);
  if (!composition.ok) {
    throw new CatalogBuildError(
      `catalog composition: ${composition.issues.map((x) => x.message).join('; ')}`,
    );
  }
  return { creatures, spells };
}
