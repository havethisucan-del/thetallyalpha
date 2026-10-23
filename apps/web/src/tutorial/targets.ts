import type { TargetId } from './types';

/**
 * ADR-0018 decision 5: the one registry from tutorial highlight targets to DOM selectors, over
 * the table's existing `data-testid` / `data-card-id` attributes (no tutorial markup in the table
 * components). These attributes are therefore a contract for the tutorial; the e2e test guards
 * them.
 */

export const TARGET_SELECTORS: Readonly<Record<Exclude<TargetId, `card:${string}`>, string>> = {
  'my-stack': '[data-testid="mine-stack"]',
  'their-stack': '[data-testid="theirs-stack"]',
  'my-atk': '[data-testid="mine-atk"]',
  'their-atk': '[data-testid="theirs-atk"]',
  hand: '[data-testid="hand"]',
  'end-turn': '[data-testid="global-endTurn"]',
  'card-actions': '[data-testid="card-actions"]',
  'token-track': '[data-testid="token-track"]',
  'center-strip': '[data-testid="center-strip"]',
  'turn-banner': '[data-testid="turn-banner"]',
  piles: '[data-testid="piles"]',
};

const CARD_PREFIX = 'card:';

/** Card instance ids are `c01` … (game-core `createCardInstances`); anything else is refused. */
const CARD_ID_PATTERN = /^c\d{2,}$/;

/** The CSS selector of a target; `cardIdOf` maps a `card:<defId>` target to its instance id. */
export function targetSelector(target: TargetId, cardIdOf: (defId: string) => string): string {
  if (target.startsWith(CARD_PREFIX)) {
    const cardId = cardIdOf(target.slice(CARD_PREFIX.length));
    if (!CARD_ID_PATTERN.test(cardId)) throw new Error(`invalid card id ${cardId}`);
    return `[data-card-id="${cardId}"]`;
  }
  return TARGET_SELECTORS[target as keyof typeof TARGET_SELECTORS];
}

/** Every element of `targets` currently in `root` (missing ones are skipped). */
export function findTargets(
  root: ParentNode,
  targets: readonly TargetId[],
  cardIdOf: (defId: string) => string,
): Element[] {
  const found: Element[] = [];
  for (const target of targets) {
    for (const element of root.querySelectorAll(targetSelector(target, cardIdOf))) {
      if (!found.includes(element)) found.push(element);
    }
  }
  return found;
}
