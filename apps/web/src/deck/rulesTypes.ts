/**
 * Shape of the player-facing rulebook shown on the Deck screen (Rules tab). The content lives in
 * `rulesContent.ts`; the screen renders it without knowing the rules. Plain text only (no HTML,
 * no Markdown): emphasis comes from the block kind, not from markup inside strings.
 */

/** One block of a rules section. */
export type RulesBlock =
  /** A paragraph. */
  | { readonly kind: 'p'; readonly text: string }
  /** A bulleted list (`ordered` for steps that happen in sequence). */
  | { readonly kind: 'list'; readonly items: readonly string[]; readonly ordered?: boolean }
  /** A short highlighted rule or exception worth remembering. */
  | { readonly kind: 'note'; readonly text: string }
  /** A detail about one card, by catalog id (`C-A1` creature / `S-01` spell). */
  | { readonly kind: 'card'; readonly defId: string; readonly text: string };

/** A titled section; `subsections` nest one level deep at most. */
export interface RulesSection {
  /** Stable id, kebab-case, unique across the whole rulebook (used for anchors and tests). */
  readonly id: string;
  readonly title: string;
  readonly blocks: readonly RulesBlock[];
  readonly subsections?: readonly RulesSection[];
}
