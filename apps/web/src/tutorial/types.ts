import type { CartignonMatchPreset, Seat } from '@cartignon/game-core';
import type { CartignonSeatEvent } from '@cartignon/protocol';

/**
 * ADR-0018: the tutorial is data. A script names cards by `defId` (never by instance id), so a
 * catalog reorder only changes the resolved ids, not the script. `buildTutorial` resolves it.
 */

/** A command in the script, with cards named by `defId`. */
export type ScriptCommand =
  | { readonly type: 'playCreature'; readonly defId: string }
  | { readonly type: 'playSpell'; readonly defId: string }
  | { readonly type: 'nullify'; readonly defId: string }
  | { readonly type: 'mulligan' }
  | { readonly type: 'endTurn' };

/** A seat event the coach waits for (`type`, optionally the event's `seat`). */
export interface EventMatch {
  readonly type: CartignonSeatEvent['type'];
  readonly seat?: Seat;
}

/**
 * How a step is completed:
 * - `continue`: the player presses Continue (nothing on the table is playable);
 * - `command`: the player sends exactly this command (the only legal entry shown);
 * - `event`: the coach waits for a seat event; the scripted bot moves only during such steps.
 */
export type StepGate =
  | { readonly kind: 'continue' }
  | { readonly kind: 'command'; readonly command: ScriptCommand }
  | { readonly kind: 'event'; readonly match: EventMatch };

/** The four lesson sections, in their mandatory order (user, 2026-10-23). */
export type TutorialSection = 'card' | 'flow' | 'combat' | 'goal';

export const SECTION_TITLES: Readonly<Record<TutorialSection, string>> = {
  card: 'The card',
  flow: 'Game flow',
  combat: 'Combat',
  goal: 'The goal',
};

/**
 * Highlight targets, resolved by `targets.ts` over existing `data-testid` / `data-card-id`
 * attributes. `card:<defId>` is one card instance wherever it is on the table.
 */
export type TargetId =
  | 'my-stack'
  | 'their-stack'
  | 'my-atk'
  | 'their-atk'
  | 'hand'
  | 'end-turn'
  | 'mulligan'
  | 'card-actions'
  | 'token-track'
  | 'center-strip'
  | 'turn-banner'
  | 'piles'
  | `card:${string}`;

/** The part of a minion face a zoom step points at (`.minion-atk`, `.minion-lvl`, ...). */
export type MinionPart = 'atk' | 'level' | 'colour' | 'modifiers';

/** The part of a spell face an anatomy step points at (`.spell-cond`, `.spell-pri`, ...). */
export type SpellPart = 'condition' | 'primary' | 'secondary';

export interface TutorialStep {
  readonly id: string;
  readonly section: TutorialSection;
  /** Plain English, at most `MAX_STEP_TEXT` characters. */
  readonly text: string;
  readonly targets?: readonly TargetId[];
  /**
   * Card steps: this card is enlarged in place on the table (lifted out of the hand fan) with
   * `part` emphasised on its face. The card is also a highlight target.
   */
  readonly zoom?: { readonly defId: string; readonly part: MinionPart };
  /**
   * Spell steps: the full spell face (Condition / Primary / Secondary) in the coach panel, with
   * `part` emphasised. A hand card is too small to show the spell text in place.
   */
  readonly anatomy?: { readonly defId: string; readonly part: SpellPart };
  readonly gate: StepGate;
}

export interface PreludeMove {
  readonly seat: Seat;
  readonly command: ScriptCommand;
}

export interface TutorialScript {
  readonly version: 1;
  /** 32 lowercase hex chars (16 bytes): the engine seed. The scripted moves use no randomness. */
  readonly engineSeed: string;
  /** The deal, with cards named by `defId`. */
  readonly preset: CartignonMatchPreset;
  /** Real commands applied with `step()` before the tutorial starts (the battle in progress). */
  readonly prelude: readonly PreludeMove[];
  /**
   * The Mulligan the script makes `seat` play, and the cards it must draw (in hand order). The
   * Mulligan's shuffle is random, so `buildTutorial` orders the deck for it: see
   * `orderDeckForMulligan`. It must be the first random step of the match (nothing before it may
   * draw from the graveyard or shuffle), and `seat` must not play a card before it.
   */
  readonly mulliganDraw?: { readonly seat: Seat; readonly defIds: readonly string[] };
  /** The scripted bot's moves, in order (seat 1). */
  readonly botMoves: readonly ScriptCommand[];
  readonly steps: readonly TutorialStep[];
}

/** Coach text limit (characters). */
export const MAX_STEP_TEXT = 140;

export type TutorialStatus = 'running' | 'finished' | 'skipped';

/** What the coach panel renders (a stable object per change, for `useSyncExternalStore`). */
export interface TutorialState {
  readonly status: TutorialStatus;
  /** Index into `steps`; equals `steps.length - 1` once finished. */
  readonly index: number;
  readonly step: TutorialStep;
  readonly total: number;
  /** The scripted bot left the script: gating is off and the bot plays as L1 (free play). */
  readonly offScript: boolean;
}
