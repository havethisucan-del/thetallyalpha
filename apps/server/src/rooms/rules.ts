import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  createCartignonRules,
  loadBuiltCatalog,
  syntheticRules,
  type AnyRulesModule,
  type CardCatalog,
  type Snapshot,
} from '@cartignon/game-core';
import type { MatchRulesId } from '../config.js';

/**
 * The rules modules this server can run. `current` starts new matches; `byId` resolves the
 * module of an existing (e.g. resumed) match from `snapshot.rulesId`. A snapshot whose
 * `rulesVersion` differs from the module's is refused by `step` with RULES_MISMATCH.
 */
export interface MatchRules {
  readonly current: AnyRulesModule;
  readonly byId: ReadonlyMap<string, AnyRulesModule>;
}

/**
 * Reads the generated catalog that @cartignon/game-core ships as `./cards.json`
 * (`data/cards.json`), resolved through the package's `exports` map so it works from `src`
 * (tsx, Vitest) and from the built `dist`. Throws on a missing file or an invalid catalog.
 */
export function loadCartignonCatalog(): CardCatalog {
  const require = createRequire(import.meta.url);
  const path = require.resolve('@cartignon/game-core/cards.json');
  return loadBuiltCatalog(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

/**
 * Builds every rules module once (call at startup: a bad catalog fails fast) and selects
 * `id` for new matches.
 */
export function selectRules(id: MatchRulesId): MatchRules {
  const cartignon = createCartignonRules(loadCartignonCatalog());
  const modules: readonly AnyRulesModule[] = [cartignon, syntheticRules];
  const byId = new Map(modules.map((rules) => [rules.rulesId, rules] as const));
  const current = byId.get(id);
  if (current === undefined) throw new Error(`unknown rules module: ${id}`);
  return { current, byId };
}

/** The module that runs `snapshot`, or undefined when this server does not know its rules. */
export function rulesFor(
  rules: MatchRules,
  snapshot: Pick<Snapshot, 'rulesId'>,
): AnyRulesModule | undefined {
  return rules.byId.get(snapshot.rulesId);
}
