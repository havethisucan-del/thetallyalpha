import {
  createCartignonRules,
  createRoundContext,
  loadBuiltCatalog,
  type CardCatalog,
  type CartignonRules,
  type RoundContext,
} from '@cartignon/game-core';
import builtCards from '@cartignon/game-core/cards.json';

/**
 * ADR-0017: the card catalog, rules module and bot round context for solo play, built once on
 * first use (the same `cards.json` the server loads). No DOM or worker API: the bot worker uses
 * this module too.
 */

let catalog: CardCatalog | undefined;
let rules: CartignonRules | undefined;
let roundContext: RoundContext | undefined;

function soloCatalog(): CardCatalog {
  catalog ??= loadBuiltCatalog(builtCards);
  return catalog;
}

export function soloRules(): CartignonRules {
  rules ??= createCartignonRules(soloCatalog());
  return rules;
}

export function soloRoundContext(): RoundContext {
  roundContext ??= createRoundContext(soloCatalog());
  return roundContext;
}
