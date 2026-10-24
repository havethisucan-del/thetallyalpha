import {
  creatures as CATALOG_CREATURES,
  spells as CATALOG_SPELLS,
} from '@cartignon/game-core/cards.json';
import { colorInfo, type CartignonColor } from '../match/cartignon/colors';
import { figureForLevel, type MinionLevel } from '../match/cartignon/minionArt';
import type { TableCard } from '../match/cartignon/tableModel';

/**
 * The full card catalog as table cards, for the Deck screen (study view). Built once from the
 * generated catalog (`@cartignon/game-core/cards.json`, the same file the solo engine and the spell
 * faces read), so the existing card components render each entry exactly as on the table. The
 * card id of a catalog entry is its definition id (`C-A1`, `S-01` …): each appears once.
 */

type CardSummary = NonNullable<TableCard['summary']>;
type CreatureSummary = Extract<CardSummary, { kind: 'creature' }>;

/** Minion levels in display order. */
export const DECK_LEVELS: readonly MinionLevel[] = [1, 2, 3, 4, 5];

function creatureCard(def: (typeof CATALOG_CREATURES)[number]): TableCard {
  const summary: CreatureSummary = {
    kind: 'creature',
    color: def.color as CartignonColor,
    level: def.level as MinionLevel,
    atk: def.atk,
    modifiers: def.modifiers as CreatureSummary['modifiers'],
  };
  return { cardId: def.defId, label: def.defId, defId: def.defId, summary, color: summary.color };
}

function spellCard(def: (typeof CATALOG_SPELLS)[number]): TableCard {
  return {
    cardId: def.defId,
    label: def.defId,
    defId: def.defId,
    summary: { kind: 'spell', name: def.name },
    color: null,
  };
}

const CREATURE_CARDS: readonly TableCard[] = CATALOG_CREATURES.map(creatureCard);
const SPELL_CARDS: readonly TableCard[] = CATALOG_SPELLS.map(spellCard);
const CARD_BY_DEF: ReadonlyMap<string, TableCard> = new Map(
  [...CREATURE_CARDS, ...SPELL_CARDS].map((card) => [card.cardId, card]),
);

export interface LevelGroup {
  level: MinionLevel;
  cards: readonly TableCard[];
}

/** Every catalog creature, grouped by level 1..5 (catalog order inside a level). */
export function minionsByLevel(): LevelGroup[] {
  return DECK_LEVELS.map((level) => ({
    level,
    cards: CREATURE_CARDS.filter(
      (card) => card.summary?.kind === 'creature' && card.summary.level === level,
    ),
  }));
}

/** Every catalog spell, in catalog order. */
export function deckSpells(): readonly TableCard[] {
  return SPELL_CARDS;
}

/** The catalog card for a definition id, or null if the catalog does not list it. */
export function catalogCard(defId: string): TableCard | null {
  return CARD_BY_DEF.get(defId) ?? null;
}

/**
 * Display name of a catalog card: a spell's printed name; a creature's figure name with its
 * colour and level (creatures have no printed name of their own), e.g. "Rootlet (Orange, Level 1)".
 * Falls back to the id itself.
 */
export function catalogCardName(defId: string): string {
  const summary = catalogCard(defId)?.summary;
  if (!summary) return defId;
  if (summary.kind === 'spell') return summary.name;
  const { level, color } = summary;
  return `${figureForLevel(level).name} (${colorInfo(color).label}, Level ${level})`;
}
