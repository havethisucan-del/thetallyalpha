// Generates packages/game-core/data/cards.json from docs/cards/*.csv (ADR-0007 section 1).
// Plain ESM JavaScript on purpose: it runs on any Node >= 24 without TypeScript type stripping.
// It imports the COMPILED catalog builder, so run it through `pnpm --filter @cartignon/game-core
// generate:cards` (which builds first). The CSVs are the source of truth; never edit the JSON.
// Since R4c both arrays are engine data: `[...creatures, ...spells]` is loadable by `loadCatalog`
// (spells: text + SecondarySpec; the Primary is the handler registry, spell-handlers.ts).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const cardsDir = resolve(here, '../../../docs/cards');
const out = resolve(here, '../data/cards.json');

const catalog = buildCatalog(
  readFileSync(resolve(cardsDir, 'creatures.csv'), 'utf8'),
  readFileSync(resolve(cardsDir, 'spells.csv'), 'utf8'),
);
writeFileSync(out, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
console.log(`wrote ${out}: ${catalog.creatures.length} creatures, ${catalog.spells.length} spells`);
