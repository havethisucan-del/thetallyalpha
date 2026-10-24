import { useRef, useState, type KeyboardEvent } from 'react';
import { buttonClass } from '../components/ui';
import { DeckCards } from './DeckCards';
import { RULES } from './rulesContent';
import type { RulesSection } from './rulesTypes';
import { RulesView } from './RulesView';

/**
 * Deck screen (study view, no server needed): two tabs, Cards (every catalog card) and Rules (the
 * rulebook). A WAI-ARIA tablist: the selected tab is the one tab stop, Left / Right / Home / End
 * move between tabs and select them.
 */

export type DeckTab = 'cards' | 'rules';

const TABS: readonly { id: DeckTab; label: string }[] = [
  { id: 'cards', label: 'Cards' },
  { id: 'rules', label: 'Rules' },
];

export function DeckScreen({
  onBack,
  initialTab = 'cards',
  rules = RULES,
}: {
  onBack: () => void;
  initialTab?: DeckTab;
  /** The rulebook to show (tests pass a fixture). */
  rules?: readonly RulesSection[];
}) {
  const [tab, setTab] = useState<DeckTab>(initialTab);
  const tabRefs = useRef<Partial<Record<DeckTab, HTMLButtonElement | null>>>({});

  const select = (next: DeckTab) => {
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.findIndex((t) => t.id === tab);
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    if (next === null) return;
    event.preventDefault();
    const target = TABS[next];
    if (target) select(target.id);
  };

  return (
    <div className="flex flex-col gap-6" data-testid="deck-screen">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-3xl leading-none">Deck</h2>
        <button
          type="button"
          className={buttonClass.secondary}
          onClick={onBack}
          data-testid="deck-back"
        >
          Back
        </button>
      </div>

      <div role="tablist" aria-label="Deck" className="flex gap-3">
        {TABS.map((t) => {
          const selected = t.id === tab;
          return (
            <button
              key={t.id}
              ref={(element) => {
                tabRefs.current[t.id] = element;
              }}
              type="button"
              role="tab"
              id={`deck-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`deck-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              className={`${selected ? buttonClass.primary : buttonClass.secondary} flex-1 sm:flex-none`}
              onClick={() => {
                setTab(t.id);
              }}
              onKeyDown={onTabKeyDown}
              data-testid={`deck-tab-${t.id}`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`deck-panel-${tab}`}
        aria-labelledby={`deck-tab-${tab}`}
        data-testid={`deck-panel-${tab}`}
      >
        {tab === 'cards' ? <DeckCards /> : <RulesView sections={rules} />}
      </div>
    </div>
  );
}
