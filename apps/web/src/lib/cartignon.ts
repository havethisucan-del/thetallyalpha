import {
  CARTIGNON_RULES_ID,
  cartignonActionSchema,
  cartignonPrivateViewSchema,
  cartignonPublicViewSchema,
  cartignonSeatEventsSchema,
  type CartignonAction,
  type CartignonCommand,
  type CartignonPrivateView,
  type CartignonPublicView,
  type CartignonSeatEvent,
  type MatchViewMessage,
} from '@cartignon/protocol';

/**
 * Cartignon debug-view helpers (R6): strict parsing of the view parts, action building from a
 * `legal` entry, choice validation and plain-text labels. Rendering only: the client never
 * computes rules; every action is either a server-listed `legal` entry or a choice selection the
 * server validates again.
 */

export interface CartignonViewParts {
  public: CartignonPublicView;
  private: CartignonPrivateView;
  events: CartignonSeatEvent[];
}

/** One rolling-log entry: an event with the revision whose step produced it. */
export interface EventLogEntry {
  key: string;
  revision: number;
  event: CartignonSeatEvent;
}

export const EVENT_LOG_LIMIT = 60;

/** Which renderer a view needs, by its `rulesId`. */
export type MatchRenderer = 'synthetic' | 'cartignon' | 'unsupported';

export function rendererFor(rulesId: string): MatchRenderer {
  if (rulesId === CARTIGNON_RULES_ID) return 'cartignon';
  if (rulesId === 'synthetic') return 'synthetic';
  return 'unsupported';
}

/** Strictly parses the Cartignon parts of a view; null if any part does not match the contract. */
export function parseCartignonView(
  view: Pick<MatchViewMessage, 'public' | 'private' | 'events'>,
): CartignonViewParts | null {
  const pub = cartignonPublicViewSchema.safeParse(view.public);
  const priv = cartignonPrivateViewSchema.safeParse(view.private);
  const events = cartignonSeatEventsSchema.safeParse(view.events);
  if (!pub.success || !priv.success || !events.success) return null;
  return { public: pub.data, private: priv.data, events: events.data };
}

/**
 * Appends a view's events to the rolling log (newest last, capped). Events are only appended for
 * a revision newer than the last one logged: a rejoin resends the current view with `events: []`
 * and an equal revision must never be logged twice.
 */
export function appendEventLog(
  log: readonly EventLogEntry[],
  revision: number,
  events: readonly CartignonSeatEvent[],
  limit = EVENT_LOG_LIMIT,
): EventLogEntry[] {
  const last = log.at(-1);
  if (events.length === 0 || (last !== undefined && revision <= last.revision)) return [...log];
  const added = events.map((event, index) => ({ key: `${revision}:${index}`, revision, event }));
  return [...log, ...added].slice(-limit);
}

/** Builds the wire action for a `legal` entry: `type` stays, the other fields become `payload`. */
export function commandToAction(command: CartignonCommand): CartignonAction {
  const { type, ...payload } = command;
  return cartignonActionSchema.parse({ type, v: 1, payload });
}

/** The selectable shape of a pending choice (the variant the choosing seat receives). */
export interface ChoiceWithOptions {
  choiceId: number;
  options: string[];
  min: number;
  max: number;
}

export function choiceWithOptions(priv: CartignonPrivateView): ChoiceWithOptions | null {
  const choice = priv.pendingChoiceView;
  if (!choice || !('options' in choice) || choice.seat !== priv.seat) return null;
  return { choiceId: choice.choiceId, options: choice.options, min: choice.min, max: choice.max };
}

/** Returns an error message for an invalid selection, or null when the selection may be sent. */
export function validateSelection(
  selection: readonly string[],
  choice: Pick<ChoiceWithOptions, 'options' | 'min' | 'max'>,
): string | null {
  if (new Set(selection).size !== selection.length) return 'A card was selected twice.';
  if (selection.some((id) => !choice.options.includes(id))) return 'Select only offered cards.';
  if (selection.length < choice.min) return `Select at least ${choice.min}.`;
  if (selection.length > choice.max) return `Select at most ${choice.max}.`;
  return null;
}

/** Toggles a card in a multi-select selection, keeping option order. */
export function toggleSelection(
  selection: readonly string[],
  cardId: string,
  options: readonly string[],
): string[] {
  const next = selection.includes(cardId)
    ? selection.filter((id) => id !== cardId)
    : [...selection, cardId];
  return options.filter((id) => next.includes(id));
}

export function chooseSpellOptionAction(choiceId: number, selection: string[]): CartignonAction {
  return commandToAction({ type: 'chooseSpellOption', choiceId, selection });
}

/** Human-readable card text from the public card table, e.g. `c05 orange L3 ATK 4`. */
export function cardLabel(pub: CartignonPublicView, cardId: string): string {
  const defId = pub.cardDefs[cardId];
  const def = defId === undefined ? undefined : pub.defs[defId];
  if (!def) return defId === undefined ? cardId : `${cardId} ${defId}`;
  if (def.kind === 'spell') return `${cardId} spell "${def.name}"`;
  const mods = def.modifiers.length > 0 ? ` [${def.modifiers.join(', ')}]` : '';
  return `${cardId} ${def.color} L${def.level} ATK ${def.atk}${mods}`;
}

export function commandLabel(command: CartignonCommand, pub: CartignonPublicView): string {
  switch (command.type) {
    case 'playCreature':
      return `Play creature ${cardLabel(pub, command.cardId)}`;
    case 'nullify':
      return `Nullify with ${cardLabel(pub, command.cardId)}`;
    case 'playSpell':
      return `Play spell ${cardLabel(pub, command.cardId)}`;
    case 'mulligan':
      return 'Mulligan';
    case 'endTurn':
      return 'End turn';
    case 'chooseSpellOption':
      return command.selection.length === 0
        ? `Choice ${command.choiceId}: select nothing`
        : `Choice ${command.choiceId}: ${command.selection.join(', ')}`;
  }
}

function fieldText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(fieldText).join(', ')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .map(([key, inner]) => `${key}: ${fieldText(inner)}`)
      .join(', ')}}`;
  }
  return String(value);
}

/** Plain debug text of an event: its type and fields. */
export function eventText(event: CartignonSeatEvent): string {
  const { type, ...fields } = event;
  const rest = Object.entries(fields)
    .map(([key, value]) => `${key}=${fieldText(value)}`)
    .join(' ');
  return rest ? `${type} ${rest}` : type;
}
