import type { Seat } from '../rules.js';
import type { CardId } from './zones.js';

/**
 * Mid-resolution choices (ADR-0007 sections 2 and 4 "Pending choice", R4c-2).
 *
 * A spell handler is a step machine: its Primary either finishes or yields a `SpellChoiceRequest`
 * with a JSON-serialisable continuation `{ step, scratch }`; the handler's `resume` entry is later
 * called with the selected option ids. The spell layer answers a choice with exactly one legal
 * answer automatically (`autoSelection`), except kinds that hide their option count (RD-162,
 * `hidesOptionCount`); any other choice suspends the spell and the round layer
 * stores it as `RoundState.pendingChoice`. Pure helpers only; no state lives here.
 */

/** Any JSON value; used for continuation scratch data, which must survive `JSON.stringify`. */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * - keepDrawn: S-01 (RD-114), which of the looked-at cards to keep. HIDDEN: options and selection
 *   are visible to the choosing seat only.
 * - handCreature: S-05 / S-07 / S-09 / S-10 (RD-117), a creature from the caster's hand (hand
 *   cards are hidden; the selection becomes public when it is placed). RD-142: the option count is
 *   hidden from the other seat too (it would reveal hand contents).
 * - enemyCreature: S-11 / S-13 / S-17 / S-18, a creature on the opponent's stack (public).
 * - ownCreature: S-18, a creature on the caster's stack (public).
 * - handDiscard: S-13 (RD-110), cards of the caster's hand to discard. The options are hidden, the
 *   count is the public hand size; the selection becomes public in the graveyard.
 * - handToDeck: S-17 (RD-110), the surplus hand cards shuffled into the deck. HIDDEN like
 *   keepDrawn: options and selection are visible to the choosing seat only (count: hand size).
 */
export type ChoiceKind =
  'keepDrawn' | 'handCreature' | 'enemyCreature' | 'ownCreature' | 'handDiscard' | 'handToDeck';

/** RD-142: kinds whose option count would reveal hidden hand contents to the other seat. */
export function hidesOptionCount(kind: ChoiceKind): boolean {
  return kind === 'handCreature';
}

/** The continuation of a suspended handler (never exposed to either seat). */
export interface ChoiceContinuation {
  readonly step: string;
  readonly scratch: JsonValue;
}

/** What a handler yields: the choice and where to resume. */
export interface SpellChoiceRequest {
  readonly kind: ChoiceKind;
  readonly options: readonly CardId[];
  readonly min: number;
  readonly max: number;
  readonly step: string;
  readonly scratch: JsonValue;
}

/** The pending choice of a round (`RoundState.pendingChoice`). JSON-serialisable. */
export interface PendingChoice {
  /** Deterministic, increasing per round state (`RoundState.nextChoiceId`); no RNG. */
  readonly choiceId: number;
  /**
   * Who must answer (R4c-2: always the caster). R4c-5 (RD-160): for a spell played through S-19
   * that is the nested spell's caster, the S-19 caster's opponent, who may differ from the seat
   * whose turn it is (`RoundPhase.active`).
   */
  readonly seat: Seat;
  /** Catalog spell id, e.g. 'S-01'. */
  readonly spellId: string;
  /** The resolving spell instance (in no zone while the choice is pending, ADR-0007 section 2). */
  readonly cardId: CardId;
  readonly kind: ChoiceKind;
  readonly options: readonly CardId[];
  readonly min: number;
  readonly max: number;
  readonly continuation: ChoiceContinuation;
}

/** Programmer-error check on a yielded choice: distinct options, 0 <= min <= max, answerable. */
export function assertWellFormedChoice(request: SpellChoiceRequest): void {
  const { options, min, max } = request;
  if (new Set(options).size !== options.length) {
    throw new Error(`spell handler bug: duplicate options in choice ${request.step}`);
  }
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min) {
    throw new Error(`spell handler bug: invalid bounds [${min}, ${max}] in ${request.step}`);
  }
  // A handler skips a step it cannot carry out instead of yielding an unanswerable choice.
  if (options.length < min) {
    throw new Error(`spell handler bug: ${options.length} option(s) < min ${min}`);
  }
}

/**
 * ADR-0007 section 4: the only legal selection when there is exactly one, else null. With n
 * options and sizes in [min, min(max, n)], exactly one subset is legal iff that range is a single
 * size and that size is 0 (empty selection) or n (all options).
 */
export function autoSelection(request: SpellChoiceRequest): readonly CardId[] | null {
  const n = request.options.length;
  const top = Math.min(request.max, n);
  if (top !== request.min) return null;
  if (request.min === 0) return [];
  if (request.min === n) return [...request.options];
  return null;
}

/** True when `selection` is a duplicate-free subset of `options` with a size in [min, max]. */
export function isValidSelection(
  choice: Pick<PendingChoice, 'options' | 'min' | 'max'>,
  selection: readonly CardId[],
): boolean {
  const raw: unknown = selection; // Untrusted input shape.
  if (!Array.isArray(raw)) return false;
  if (selection.length < choice.min || selection.length > choice.max) return false;
  if (new Set(selection).size !== selection.length) return false;
  return selection.every((id) => choice.options.includes(id));
}

/**
 * The most selections `legalCommands` lists for one pending choice. Multi-select kinds
 * (`handToDeck`, S-17) can have C(n, k) legal answers (C(20, 10) = 184,756), so the command list
 * is a bounded, deterministic prefix of `enumerateSelections`; `isValidSelection` stays the
 * authority on what `chooseSpellOption` accepts.
 */
export const MAX_LISTED_SELECTIONS = 64;

/**
 * Legal selections in a deterministic order: by size ascending, then lexicographically by option
 * index (options order). For min = max = 1 this is one selection per option. At most `limit`
 * entries are produced (generation stops early, so the cost is bounded by `limit`, not by the
 * number of legal selections); every entry is valid, so the first one is always a legal answer.
 */
export function enumerateSelections(
  choice: Pick<PendingChoice, 'options' | 'min' | 'max'>,
  limit = Number.POSITIVE_INFINITY,
): CardId[][] {
  const { options } = choice;
  const out: CardId[][] = [];
  const pick = (start: number, size: number, acc: CardId[]): void => {
    if (out.length >= limit) return;
    if (acc.length === size) {
      out.push([...acc]);
      return;
    }
    // Only start indices that still leave enough options to complete the selection.
    const last = options.length - (size - acc.length);
    for (let i = start; i <= last && out.length < limit; i++) {
      acc.push(options[i] as CardId);
      pick(i + 1, size, acc);
      acc.pop();
    }
  };
  for (let size = choice.min; size <= Math.min(choice.max, options.length); size++) {
    if (out.length >= limit) break;
    pick(0, size, []);
  }
  return out;
}

/** What `seat` may see of the pending choice (RD-114; the continuation is never exposed). */
export type PendingChoiceView =
  | {
      readonly choiceId: number;
      readonly seat: Seat;
      readonly kind: ChoiceKind;
      readonly spellId: string;
      readonly options: readonly CardId[];
      readonly min: number;
      readonly max: number;
    }
  | {
      readonly seat: Seat;
      readonly kind: ChoiceKind;
      readonly spellId: string;
      /** RD-142: absent for kinds that hide it (`hidesOptionCount`, i.e. `handCreature`). */
      readonly optionCount?: number;
      readonly min: number;
      readonly max: number;
    };

/**
 * Per-seat projection of a pending choice (RD-114, RD-142): null when there is none; the choosing
 * seat gets the option ids, the other seat `{ seat, kind, spellId, min, max }` plus
 * `optionCount` unless the kind hides it (`handCreature`). The continuation is never exposed.
 */
export function projectPendingChoice(
  pending: PendingChoice | undefined,
  seat: Seat,
): PendingChoiceView | null {
  if (pending === undefined) return null;
  const { choiceId, kind, spellId, options, min, max } = pending;
  if (seat === pending.seat) {
    return { choiceId, seat: pending.seat, kind, spellId, options: [...options], min, max };
  }
  if (hidesOptionCount(kind)) return { seat: pending.seat, kind, spellId, min, max };
  return { seat: pending.seat, kind, spellId, optionCount: options.length, min, max };
}
