import { useState } from 'react';
import { CardView } from '../screens/cartignon/CardView';
import { catalogCard, catalogCardName } from './catalog';
import type { RulesBlock, RulesSection } from './rulesTypes';

/**
 * Deck screen, Rules tab: renders the rulebook data (`RulesSection[]`) as long-form text. Section
 * titles are h2 (subsections h3), paragraphs and lists as is, a note as a line set off by the ink
 * rule on its left (no box), a card detail as a line led by the card's catalog name. The name is a
 * toggle that shows the card itself under the line, with the table's enlarged preview on hover,
 * focus or tap. A short contents list at the top jumps to each section. Lines stay within ~65ch.
 */

/** Anchor id of a section heading. */
export function rulesAnchor(id: string): string {
  return `rules-${id}`;
}

function CardLine({ defId, text }: { defId: string; text: string }) {
  const [open, setOpen] = useState(false);
  const card = catalogCard(defId);
  const name = catalogCardName(defId);
  return (
    <div className="flex flex-col gap-2" data-testid="rules-card" data-def-id={defId}>
      <p>
        {card ? (
          <button
            type="button"
            className="font-bold underline decoration-1 underline-offset-2 hover:text-rubric"
            aria-expanded={open}
            onClick={() => {
              setOpen((value) => !value);
            }}
          >
            {name}
          </button>
        ) : (
          <span className="font-bold">{name}</span>
        )}{' '}
        {text}
      </p>
      {card && open && (
        <div className="[--card-h:calc(var(--card-w)*1.4125)] [--card-w:88px]">
          <CardView card={card} focusable tapPreview />
        </div>
      )}
    </div>
  );
}

function Block({ block }: { block: RulesBlock }) {
  switch (block.kind) {
    case 'p':
      return <p>{block.text}</p>;
    case 'list': {
      const items = block.items.map((item, index) => (
        // Rule lists may repeat an item, so the index is part of the key.
        <li key={`${index}-${item}`}>{item}</li>
      ));
      return block.ordered ? (
        <ol className="list-decimal pl-6">{items}</ol>
      ) : (
        <ul className="list-disc pl-6">{items}</ul>
      );
    }
    case 'note':
      return (
        <p
          className="border-l-(length:--line-width) border-line pl-3 italic"
          data-testid="rules-note"
        >
          {block.text}
        </p>
      );
    case 'card':
      return <CardLine defId={block.defId} text={block.text} />;
  }
}

function Section({ section, depth }: { section: RulesSection; depth: 2 | 3 }) {
  const Heading = depth === 2 ? 'h2' : 'h3';
  return (
    <section
      aria-labelledby={rulesAnchor(section.id)}
      className="flex flex-col gap-3"
      data-testid={`rules-section-${section.id}`}
    >
      <Heading
        id={rulesAnchor(section.id)}
        className={`scroll-mt-4 leading-none ${depth === 2 ? 'text-3xl' : 'text-2xl'}`}
      >
        {section.title}
      </Heading>
      {section.blocks.map((block, index) => (
        // Blocks have no ids of their own; their order is fixed content.
        <Block key={index} block={block} />
      ))}
      {section.subsections?.map((sub) => (
        <Section key={sub.id} section={sub} depth={3} />
      ))}
    </section>
  );
}

export function RulesView({ sections }: { sections: readonly RulesSection[] }) {
  return (
    <div className="flex max-w-[65ch] flex-col gap-8 text-lg leading-snug" data-testid="rules">
      <nav aria-label="Rules contents">
        <ol className="flex flex-col gap-1">
          {sections.map((section) => (
            <li key={section.id}>
              <a
                href={`#${rulesAnchor(section.id)}`}
                className="underline decoration-1 underline-offset-2 hover:text-rubric"
              >
                {section.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      {sections.map((section) => (
        <Section key={section.id} section={section} depth={2} />
      ))}
    </div>
  );
}
