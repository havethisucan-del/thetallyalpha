import { createRequire } from 'node:module';
import {
  createRoundContext,
  loadBuiltCatalog,
  type CardCatalog,
  type RoundContext,
} from '@cartignon/game-core';

/** The real card catalog (`@cartignon/game-core/cards.json`) and its round context (Node only). */
export function realCatalog(): { readonly catalog: CardCatalog; readonly ctx: RoundContext } {
  const require = createRequire(import.meta.url);
  const catalog = loadBuiltCatalog(require('@cartignon/game-core/cards.json') as unknown);
  return { catalog, ctx: createRoundContext(catalog) };
}
