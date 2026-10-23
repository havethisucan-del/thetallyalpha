import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  COLORS,
  CREATURE_LEVELS,
  type BuiltCatalog,
  type CardCatalog,
  type CreatureDef,
  type SpellDef,
} from '../../src/cartignon/index.js';

/** The generated catalog `data/cards.json` (ADR-0007), as checked in. */
export function realCatalog(): BuiltCatalog {
  const path = fileURLToPath(new URL('../../data/cards.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as BuiltCatalog;
}

/** The 19 real spells S-01..S-19 (R4c: spells are real data, handlers by `defId`). */
export function realSpells(): SpellDef[] {
  return [...realCatalog().spells];
}

/**
 * PLACEHOLDER creatures — not real card data: 35 creatures (atk = level * 10, a few sample
 * modifiers), followed by the 19 REAL spells S-01..S-19 in id order (c36..c54 = spell(1..19)).
 */
export function placeholderCatalog(): CardCatalog {
  const creatures: CreatureDef[] = [];
  for (const color of COLORS) {
    for (const level of CREATURE_LEVELS) {
      creatures.push({
        defId: `placeholder-${color}-${level}`,
        kind: 'creature',
        color,
        level,
        atk: level * 10,
        modifiers: [],
      });
    }
  }
  const withModifiers = creatures.map((c): CreatureDef => {
    if (c.color === 'orange' && c.level === 3) {
      return { ...c, modifiers: ['buffSelf', 'linkUp'] }; // Link Up at position 2
    }
    if (c.color === 'blue' && c.level === 4) {
      return { ...c, modifiers: ['nerfEnemyLeader', 'nerfEnemyLeader', 'buffSelf'] }; // buff at 3
    }
    return c;
  });
  return [...withModifiers, ...realSpells()];
}

/** Recursively freezes plain data so any mutation throws (ES modules run in strict mode). */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
