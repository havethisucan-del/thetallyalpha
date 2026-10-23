import { COLORS, isColor, type Color } from './colors.js';

/**
 * Declarative card definitions. Definitions are data (generated from `docs/cards/*.csv`, ADR-0007);
 * rules code interprets them generically. The only `defId` lookup is a spell's Primary handler in
 * the registry (spell-handlers.ts).
 */

export const CREATURE_LEVELS = [1, 2, 3, 4, 5] as const;
export type CreatureLevel = (typeof CREATURE_LEVELS)[number];

/**
 * RD-39: buff/nerf leader modifiers are always +/-30. A rule constant, NOT per-card data, so the
 * card data shape has no `amount` field.
 */
export const LEADER_MODIFIER_AMOUNT = 30;

/**
 * Positional modifier kinds (RD-11, RD-54 as reversed for creatures by RD-98):
 * - buffSelf: +LEADER_MODIFIER_AMOUNT on the card itself (derived while live, RD-53).
 * - nerfEnemyLeader: -LEADER_MODIFIER_AMOUNT on the enemy's current Leading Minion (derived).
 * - linkUp: arms Link Up for the owner (RD-10); one-shot on going live.
 * - drawDeck / drawGrave: the controller draws 1 card from the deck / the graveyard (RD-98,
 *   RD-48, RD-23); one-shot on going live, executed by the round layer (it owns the RNG).
 */
export const MODIFIER_KINDS = [
  'buffSelf',
  'nerfEnemyLeader',
  'linkUp',
  'drawDeck',
  'drawGrave',
] as const;
export type ModifierKind = (typeof MODIFIER_KINDS)[number];

export interface CreatureDef {
  readonly defId: string;
  readonly kind: 'creature';
  readonly color: Color;
  readonly level: CreatureLevel;
  /** RD-28 / RD-37: always an integer >= 0. */
  readonly atk: number;
  /**
   * RD-97: entry `i - 1` belongs to stack position `i`. The Base Minion is position 0 and never
   * live (RD-35), so it has no entry. Positions beyond the list carry no modifier. Liveness
   * (RD-53: Leading Minion at that position) is derived in board.ts.
   */
  readonly modifiers: readonly ModifierKind[];
}

// ---------------------------------------------------------------------------------------------
// Spells (ADR-0007, R4c).
//
// A spell's Primary is code, not data: it is looked up by `defId` in the handler registry
// (spell-handlers.ts). The data carries the printed text (for the UI) and the Secondary, which is
// one of a few fixed shapes (ADR-0007 section 1, RD-14, RD-115, RD-119).

/** Where a spell draw effect draws from (RD-54). */
export const SPELL_DRAW_SOURCES = ['deck', 'graveyard'] as const;
export type SpellDrawSource = (typeof SPELL_DRAW_SOURCES)[number];

/**
 * The Secondary effect of a spell (ADR-0007 mapping table). Amounts are spell data (RD-100: the
 * RD-39 constant covers creature modifiers only). Targets are fixed (RD-115): buff -> the caster's
 * own Leading creature, nerf -> the opponent's Leading creature; a missing target does nothing.
 */
export type SecondarySpec =
  | { readonly kind: 'nerfEnemyLeader'; readonly amount: number }
  | { readonly kind: 'buffOwnLeader'; readonly amount: number }
  | { readonly kind: 'draw'; readonly from: SpellDrawSource; readonly count: number }
  | { readonly kind: 'none' };

/** The spell's printed text, verbatim from the CSV (Croatian), for the UI. */
export interface SpellText {
  readonly condition: string;
  readonly primary: string;
  readonly secondary: string;
}

/**
 * A spell card (the `spells` array of `data/cards.json`). The Primary and its feasibility are
 * `SPELL_REGISTRY[defId]` (spell-handlers.ts); a catalog spell without a registry entry is
 * rejected by `createRoundContext`.
 */
export interface SpellDef {
  readonly defId: string;
  readonly kind: 'spell';
  readonly name: string;
  readonly text: SpellText;
  readonly secondary: SecondarySpec;
}

export type CardDef = CreatureDef | SpellDef;
export type CardCatalog = readonly CardDef[];

/** RD-02: required deck composition, as data. */
export interface DeckComposition {
  readonly colors: readonly Color[];
  readonly levels: readonly CreatureLevel[];
  /** Creatures required for each color × level slot. */
  readonly creaturesPerSlot: number;
  readonly creatureCount: number;
  readonly spellCount: number;
  readonly totalCount: number;
}

/** RD-02: 35 creatures (7 colors × 5 levels, one each) + 19 spells = 54 cards. */
export const DEFAULT_DECK_COMPOSITION: DeckComposition = Object.freeze({
  colors: COLORS,
  levels: CREATURE_LEVELS,
  creaturesPerSlot: 1,
  creatureCount: 35,
  spellCount: 19,
  totalCount: 54,
});

export type CatalogIssueCode =
  | 'MALFORMED'
  | 'DUPLICATE_DEF_ID'
  | 'MISSING_CREATURE'
  | 'DUPLICATE_CREATURE'
  | 'UNEXPECTED_CREATURE'
  | 'CREATURE_COUNT'
  | 'SPELL_COUNT'
  | 'TOTAL_COUNT'
  /** A spell `defId` without an entry in the spell handler registry (`createRoundContext`). */
  | 'UNKNOWN_SPELL';

export interface CatalogIssue {
  readonly code: CatalogIssueCode;
  readonly message: string;
}

export type CatalogResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly CatalogIssue[] };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLevel(value: unknown): value is CreatureLevel {
  return (CREATURE_LEVELS as readonly unknown[]).includes(value);
}

function isModifierKind(value: unknown): value is ModifierKind {
  return (MODIFIER_KINDS as readonly unknown[]).includes(value);
}

function unknownKeys(record: UnknownRecord, allowed: readonly string[]): string[] {
  return Object.keys(record).filter((k) => !allowed.includes(k));
}

/** RD-97: a list of known modifier kinds (entry i-1 = position i). RD-39: no amounts. */
function parseModifiers(
  input: unknown,
  at: string,
  issues: CatalogIssue[],
): readonly ModifierKind[] | null {
  if (!Array.isArray(input)) {
    issues.push({ code: 'MALFORMED', message: `${at}.modifiers: must be an array` });
    return null;
  }
  const out: ModifierKind[] = [];
  for (const [i, kind] of (input as unknown[]).entries()) {
    if (!isModifierKind(kind)) {
      issues.push({ code: 'MALFORMED', message: `${at}.modifiers[${i}]: unknown kind` });
      return null;
    }
    out.push(kind);
  }
  return out;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** Shape check of a `SecondarySpec` (ADR-0007). Returns an error message or null. */
function secondaryError(input: unknown): string | null {
  if (!isRecord(input)) return 'must be an object';
  const kind = input['kind'];
  const keys = (allowed: readonly string[]): string | null => {
    const extra = unknownKeys(input, allowed);
    return extra.length > 0 ? `unknown keys ${extra.join(', ')}` : null;
  };
  if (kind === 'none') return keys(['kind']);
  if (kind === 'buffOwnLeader' || kind === 'nerfEnemyLeader') {
    return (
      keys(['kind', 'amount']) ??
      (isPositiveInt(input['amount']) ? null : 'amount must be an integer >= 1')
    );
  }
  if (kind !== 'draw') return 'unknown kind';
  const extra = keys(['kind', 'from', 'count']);
  if (extra !== null) return extra;
  if (!(SPELL_DRAW_SOURCES as readonly unknown[]).includes(input['from'])) {
    return 'from must be "deck" or "graveyard"';
  }
  return isPositiveInt(input['count']) ? null : 'count must be an integer >= 1';
}

/** Shape check of a `SpellText`. Returns an error message or null. */
function textError(input: unknown): string | null {
  if (!isRecord(input)) return 'must be an object';
  const extra = unknownKeys(input, ['condition', 'primary', 'secondary']);
  if (extra.length > 0) return `unknown keys ${extra.join(', ')}`;
  for (const key of ['condition', 'primary', 'secondary']) {
    if (typeof input[key] !== 'string') return `${key} must be a string`;
  }
  return null;
}

/**
 * Checks the `text` and `secondary` fields of a spell-like record. Pushes MALFORMED issues and
 * returns false on any problem. Shared by `parseCatalog` (untrusted JSON) and `validateCatalog`
 * (catalogs built in code).
 */
function checkSpellData(input: UnknownRecord, at: string, issues: CatalogIssue[]): boolean {
  let ok = true;
  for (const [key, check] of [
    ['text', textError],
    ['secondary', secondaryError],
  ] as const) {
    const error = check(input[key]);
    if (error !== null) {
      issues.push({ code: 'MALFORMED', message: `${at}.${key}: ${error}` });
      ok = false;
    }
  }
  return ok;
}

function copySecondary(spec: SecondarySpec): SecondarySpec {
  switch (spec.kind) {
    case 'none':
      return { kind: 'none' };
    case 'draw':
      return { kind: 'draw', from: spec.from, count: spec.count };
    default:
      return { kind: spec.kind, amount: spec.amount };
  }
}

function parseSpell(
  input: UnknownRecord,
  defId: string,
  at: string,
  issues: CatalogIssue[],
): SpellDef | null {
  const bad = (message: string): null => {
    issues.push({ code: 'MALFORMED', message: `${at}: ${message}` });
    return null;
  };
  const extra = unknownKeys(input, ['defId', 'kind', 'name', 'text', 'secondary']);
  if (extra.length > 0) return bad(`unknown keys ${extra.join(', ')}`);
  const name = input['name'];
  if (typeof name !== 'string' || name.length === 0) return bad('name must be a non-empty string');
  if (!checkSpellData(input, at, issues)) return null;
  // Fresh objects with known fields only.
  const text = input['text'] as SpellText;
  return {
    defId,
    kind: 'spell',
    name,
    text: { condition: text.condition, primary: text.primary, secondary: text.secondary },
    secondary: copySecondary(input['secondary'] as SecondarySpec),
  };
}

function parseCard(input: unknown, at: string, issues: CatalogIssue[]): CardDef | null {
  const bad = (message: string): null => {
    issues.push({ code: 'MALFORMED', message: `${at}: ${message}` });
    return null;
  };
  if (!isRecord(input)) return bad('must be an object');
  const defId = input['defId'];
  if (typeof defId !== 'string' || defId.length === 0)
    return bad('defId must be a non-empty string');
  const kind = input['kind'];
  if (kind === 'spell') return parseSpell(input, defId, at, issues);
  if (kind !== 'creature') return bad('kind must be "creature" or "spell"');
  const extra = unknownKeys(input, ['defId', 'kind', 'color', 'level', 'atk', 'modifiers']);
  if (extra.length > 0) return bad(`unknown keys ${extra.join(', ')}`);
  const color = input['color'];
  if (!isColor(color)) return bad('color must be a known color');
  const level = input['level'];
  if (!isLevel(level)) return bad('level must be an integer 1-5');
  const atk = input['atk'];
  // RD-28 / RD-37: ATK is always an integer >= 0.
  if (typeof atk !== 'number' || !Number.isInteger(atk) || atk < 0) {
    return bad('atk must be an integer >= 0');
  }
  const modifiers = parseModifiers(input['modifiers'], at, issues);
  if (modifiers === null) return null;
  return { defId, kind, color, level, atk, modifiers };
}

/**
 * Shape validation of an untrusted catalog (e.g. JSON from the database). Unknown keys are
 * rejected so typos surface instead of being silently ignored. Returns fresh objects that
 * contain only known fields. Composition is checked separately by `validateCatalog`.
 */
export function parseCatalog(input: unknown): CatalogResult<CardCatalog> {
  if (!Array.isArray(input)) {
    return { ok: false, issues: [{ code: 'MALFORMED', message: 'catalog must be an array' }] };
  }
  const issues: CatalogIssue[] = [];
  const cards: CardDef[] = [];
  input.forEach((item: unknown, i) => {
    const card = parseCard(item, `[${i}]`, issues);
    if (card !== null) cards.push(card);
  });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: cards };
}

/**
 * RD-02 composition check: unique defIds, exactly `creaturesPerSlot` creature(s) per
 * color × level, and the creature/spell/total counts. Collects every issue; never throws.
 */
export function validateCatalog(
  catalog: CardCatalog,
  composition: DeckComposition,
): CatalogResult<CardCatalog> {
  const issues: CatalogIssue[] = [];
  const seen = new Set<string>();
  for (const card of catalog) {
    if (seen.has(card.defId)) {
      issues.push({ code: 'DUPLICATE_DEF_ID', message: `duplicate defId ${card.defId}` });
    }
    seen.add(card.defId);
  }

  const creatures = catalog.filter((c): c is CreatureDef => c.kind === 'creature');
  const spells = catalog.filter((c): c is SpellDef => c.kind === 'spell');
  // Catalogs built in code bypass `parseCatalog`, so the spell data is shape-checked here too.
  for (const s of spells) checkSpellData({ ...s }, s.defId, issues);
  const slotKey = (color: Color, level: CreatureLevel): string => `${color}/${level}`;
  const slotCounts = new Map<string, number>();
  for (const c of creatures) {
    const key = slotKey(c.color, c.level);
    if (!composition.colors.includes(c.color) || !composition.levels.includes(c.level)) {
      issues.push({ code: 'UNEXPECTED_CREATURE', message: `${c.defId}: slot ${key} not allowed` });
    }
    slotCounts.set(key, (slotCounts.get(key) ?? 0) + 1);
  }
  for (const color of composition.colors) {
    for (const level of composition.levels) {
      const key = slotKey(color, level);
      const n = slotCounts.get(key) ?? 0;
      if (n < composition.creaturesPerSlot) {
        issues.push({ code: 'MISSING_CREATURE', message: `slot ${key}: ${n} creature(s)` });
      } else if (n > composition.creaturesPerSlot) {
        issues.push({ code: 'DUPLICATE_CREATURE', message: `slot ${key}: ${n} creature(s)` });
      }
    }
  }

  const counts: readonly [CatalogIssueCode, string, number, number][] = [
    ['CREATURE_COUNT', 'creatures', creatures.length, composition.creatureCount],
    ['SPELL_COUNT', 'spells', spells.length, composition.spellCount],
    ['TOTAL_COUNT', 'cards', catalog.length, composition.totalCount],
  ];
  for (const [code, what, actual, expected] of counts) {
    if (actual !== expected) {
      issues.push({ code, message: `expected ${expected} ${what}, found ${actual}` });
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: catalog };
}

/** Convenience: shape-parse untrusted input, then check composition. */
export function loadCatalog(
  input: unknown,
  composition: DeckComposition = DEFAULT_DECK_COMPOSITION,
): CatalogResult<CardCatalog> {
  const parsed = parseCatalog(input);
  return parsed.ok ? validateCatalog(parsed.value, composition) : parsed;
}
