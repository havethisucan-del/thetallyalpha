import type {
  ForfeitReason,
  GameAction,
  Outcome,
  ParseResult,
  RulesModule,
  Seat,
  TimeoutPlan,
  Validation,
} from '../rules.js';
import type { CardCatalog } from './cards.js';
import {
  applyMatchCommand,
  applyMatchTimeoutSkip,
  forfeitCartignonMatch,
  legalMatchCommands,
  startCartignonMatch,
  type CartignonMatchState,
  type ForfeitEndReason,
  type MatchEvent,
  type MatchResult,
} from './match.js';
import {
  buildCardTables,
  projectCartignonEvents,
  projectCartignonPrivate,
  projectCartignonPublic,
  type CartignonPrivateView,
  type CartignonPublicView,
} from './projection.js';
import {
  activeSeat,
  checkTimeoutSkip,
  createRoundContext,
  validateCommand,
  type RoundCommand,
} from './round.js';
import type { CardId } from './zones.js';

/**
 * R6: Cartignon as a `RulesModule` (ADR-0004 contract). Thin adapter over the match layer
 * (`startCartignonMatch`, `applyMatchCommand`); per-seat views and event redaction live in
 * projection.ts. Actions on the wire are `{ type, v: 1, payload }` where `type` is the
 * `RoundCommand` type and `payload` holds the command's other fields (`{}` when it has none).
 */

export const CARTIGNON_RULES_ID = 'cartignon';

/** Bump when rules behaviour changes in a way that makes stored snapshots incompatible. */
export const CARTIGNON_RULES_VERSION = '2';

/** Action schema version accepted by `parseAction`. */
export const CARTIGNON_ACTION_VERSION = 1;

/** Upper bound on `chooseSpellOption.selection` (the deck has 54 cards). */
export const MAX_SELECTION_LENGTH = 54;

const CARD_ID_PATTERN = /^c\d{2}$/;

const ACTION_TYPES: readonly string[] = [
  'playCreature',
  'nullify',
  'playSpell',
  'mulligan',
  'endTurn',
  'chooseSpellOption',
];

type CommandOf<T extends RoundCommand['type']> = Extract<RoundCommand, { type: T }>;
type PayloadOf<T extends RoundCommand['type']> = Omit<CommandOf<T>, 'type'>;

export type CartignonAction = {
  [T in RoundCommand['type']]: GameAction<T, PayloadOf<T>>;
}[RoundCommand['type']];

/**
 * R7: the internal turn-timeout skip (RD-163; `applyTimeoutSkip`). SERVER-ONLY: only
 * `timeoutAction` produces it. `parseCartignonAction` rejects the type as unknown (MALFORMED), and
 * `step` always parses first, so a client can never submit it; it is never in `legal` and the
 * protocol action/command schemas do not list it. `validateAction` / `applyAction` accept it only
 * for `stepTimeout`.
 */
export const CARTIGNON_TIMEOUT_SKIP = 'timeoutSkip';

export type CartignonTimeoutSkipAction = GameAction<
  typeof CARTIGNON_TIMEOUT_SKIP,
  Record<string, never>
>;

/** Everything the Cartignon rules module applies: client actions plus the internal skip. */
export type CartignonRulesAction = CartignonAction | CartignonTimeoutSkipAction;

const FORFEIT_END_REASONS: Readonly<Record<ForfeitReason, ForfeitEndReason>> = {
  turnTimeouts: 'forfeitTimeouts',
  timeoutAfterPause: 'forfeitTimeoutAfterPause',
};

/** 32-bit FNV-1a over UTF-16 code units, as 8 hex digits (fingerprint, not security). */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** `rulesVersion` for a catalog: a catalog change yields a new version (RULES_MISMATCH on resume). */
export function cartignonRulesVersion(catalog: CardCatalog): string {
  return `${CARTIGNON_RULES_VERSION}+cards.${fnv1a(JSON.stringify(catalog))}`;
}

/** The wire action for a round command (e.g. to send an entry of `legal`). */
export function toCartignonAction(command: RoundCommand): CartignonAction {
  switch (command.type) {
    case 'playCreature':
    case 'nullify':
    case 'playSpell':
      return { type: command.type, v: 1, payload: { cardId: command.cardId } };
    case 'mulligan':
    case 'endTurn':
      return { type: command.type, v: 1, payload: {} };
    case 'chooseSpellOption':
      return {
        type: 'chooseSpellOption',
        v: 1,
        payload: { choiceId: command.choiceId, selection: [...command.selection] },
      };
  }
}

/** The round command an (already parsed) action stands for. */
export function toRoundCommand(action: CartignonAction): RoundCommand {
  switch (action.type) {
    case 'playCreature':
    case 'nullify':
    case 'playSpell':
      return { type: action.type, cardId: action.payload.cardId };
    case 'mulligan':
    case 'endTurn':
      return { type: action.type };
    case 'chooseSpellOption':
      return {
        type: 'chooseSpellOption',
        choiceId: action.payload.choiceId,
        selection: [...action.payload.selection],
      };
  }
}

function malformed(message: string): ParseResult<CartignonAction> {
  return { ok: false, code: 'MALFORMED', message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}

function isCardId(value: unknown): value is CardId {
  return typeof value === 'string' && CARD_ID_PATTERN.test(value);
}

/** Strict, hand-written action parser (game-core has no runtime dependencies). */
export function parseCartignonAction(input: GameAction): ParseResult<CartignonAction> {
  const raw: unknown = input;
  if (!isPlainObject(raw) || !hasExactKeys(raw, ['type', 'v', 'payload'])) {
    return malformed('Action must be { type, v, payload }');
  }
  const { type, v, payload } = raw;
  if (typeof type !== 'string') return malformed('Action type must be a string');
  if (!ACTION_TYPES.includes(type)) return malformed('Unknown action type');
  if (v !== CARTIGNON_ACTION_VERSION) {
    return { ok: false, code: 'UNSUPPORTED_VERSION', message: 'Unsupported action version' };
  }
  if (!isPlainObject(payload)) return malformed('Payload must be an object');
  switch (type) {
    case 'playCreature':
    case 'nullify':
    case 'playSpell': {
      if (!hasExactKeys(payload, ['cardId'])) return malformed('Payload must be { cardId }');
      const cardId = payload['cardId'];
      if (!isCardId(cardId)) return malformed('cardId must look like c01');
      return { ok: true, value: { type, v: 1, payload: { cardId } } };
    }
    case 'mulligan':
    case 'endTurn':
      if (!hasExactKeys(payload, [])) return malformed('Payload must be {}');
      return { ok: true, value: { type, v: 1, payload: {} } };
    default: {
      if (!hasExactKeys(payload, ['choiceId', 'selection'])) {
        return malformed('Payload must be { choiceId, selection }');
      }
      const choiceId = payload['choiceId'];
      const selection = payload['selection'];
      if (typeof choiceId !== 'number' || !Number.isSafeInteger(choiceId) || choiceId < 0) {
        return malformed('choiceId must be a non-negative integer');
      }
      if (!Array.isArray(selection) || selection.length > MAX_SELECTION_LENGTH) {
        return malformed(`selection must be an array of at most ${MAX_SELECTION_LENGTH} card ids`);
      }
      const ids: CardId[] = [];
      for (const id of selection as unknown[]) {
        if (!isCardId(id)) return malformed('selection must contain card ids');
        ids.push(id);
      }
      return {
        ok: true,
        value: { type: 'chooseSpellOption', v: 1, payload: { choiceId, selection: ids } },
      };
    }
  }
}

export type CartignonRules = RulesModule<
  CartignonMatchState,
  CartignonRulesAction,
  CartignonPublicView,
  CartignonPrivateView,
  MatchEvent
>;

/**
 * Builds the Cartignon rules module for `catalog`. The round context is built once here, so an
 * invalid catalog throws `InvalidCatalogError` at construction (server start), not mid-match.
 */
export function createCartignonRules(catalog: CardCatalog): CartignonRules {
  const ctx = createRoundContext(catalog);
  const tables = buildCardTables(catalog);
  return {
    rulesId: CARTIGNON_RULES_ID,
    rulesVersion: cartignonRulesVersion(catalog),

    createInitialState(_setup, rng) {
      const started = startCartignonMatch(catalog, rng);
      if (!started.ok) throw new Error(`cartignon match did not start: ${started.code}`);
      return started.state;
    },

    parseAction: parseCartignonAction,

    validateAction(state, seat, action): Validation {
      if (state.status.kind === 'matchOver') {
        return { ok: false, code: 'ILLEGAL', message: 'The match is over', reason: 'MATCH_OVER' };
      }
      const check =
        action.type === CARTIGNON_TIMEOUT_SKIP
          ? checkTimeoutSkip(ctx, state.round, seat)
          : validateCommand(ctx, state.round, seat, toRoundCommand(action));
      if (check.ok) return { ok: true };
      if (check.code === 'NOT_YOUR_TURN') {
        return { ok: false, code: 'NOT_YOUR_TURN', message: check.message, reason: check.code };
      }
      return { ok: false, code: 'ILLEGAL', message: check.message, reason: check.code };
    },

    applyAction(state, seat, action, rng) {
      const result: MatchResult =
        action.type === CARTIGNON_TIMEOUT_SKIP
          ? applyMatchTimeoutSkip(ctx, state, seat, rng)
          : applyMatchCommand(ctx, state, seat, toRoundCommand(action), rng);
      if (!result.ok) {
        // validateAction passed, so this is a broken invariant, not a rule violation.
        throw new Error(`cartignon: validated command rejected (${result.code})`);
      }
      return { state: result.state, events: result.events };
    },

    getPhase(state) {
      if (state.status.kind === 'matchOver') {
        return { id: 'matchOver', activeSeat: null, turnSeat: null, turnKey: null };
      }
      const round = state.round;
      const phase = round.phase;
      const acting = activeSeat(round);
      return {
        id: round.pendingChoice === undefined ? phase.kind : 'choosing',
        activeSeat: acting,
        turnSeat: phase.kind === 'roundOver' ? null : phase.active,
        // R7: round number + turn number of the round (a nested choice keeps the turn's key).
        turnKey: acting === null ? null : `${state.roundNumber}.${round.turnNumber}`,
      };
    },

    projectPublic(state) {
      return projectCartignonPublic(ctx, tables, state);
    },

    projectPrivate(state, seat: Seat) {
      return projectCartignonPrivate(ctx, state, seat);
    },

    projectEvents(events, seat) {
      return projectCartignonEvents(events, seat);
    },

    resolveOutcome(state): Outcome | null {
      const status = state.status;
      if (status.kind !== 'matchOver') return null;
      return status.winner === null
        ? { result: 'draw', reason: status.reason }
        : { result: 'winner', winner: status.winner, reason: status.reason };
    },

    timeoutAction(state, seat): TimeoutPlan<CartignonRulesAction> {
      if (state.status.kind === 'matchOver') return { kind: 'none' };
      const round = state.round;
      if (activeSeat(round) !== seat) return { kind: 'none' };
      const legal = legalMatchCommands(ctx, state, seat);
      if (round.pendingChoice !== undefined) {
        // RD-164 / RD-165: the first legal selection (a server answer at the deadline; RD-162
        // concerns engine auto-answers, so this applies to `handCreature` too).
        const first = legal[0];
        if (first === undefined)
          throw new Error('cartignon: pending choice without a legal answer');
        return { kind: 'answer', action: toCartignonAction(first) };
      }
      // RD-33 / RD-169: the turn is skipped exactly like End Turn where it is legal (everywhere
      // except a P1 Base step with a possible Base Minion or Mulligan), otherwise the internal skip
      // (RD-163, see `checkTimeoutSkip`).
      if (legal.some((c) => c.type === 'endTurn')) {
        return { kind: 'skip', action: { type: 'endTurn', v: 1, payload: {} } };
      }
      const skip = checkTimeoutSkip(ctx, round, seat);
      if (!skip.ok) throw new Error(`cartignon: no timeout skip available (${skip.code})`);
      return { kind: 'skip', action: { type: CARTIGNON_TIMEOUT_SKIP, v: 1, payload: {} } };
    },

    forfeit(state, loser, reason) {
      const result = forfeitCartignonMatch(state, loser, FORFEIT_END_REASONS[reason]);
      if (!result.ok) throw new Error(`cartignon: forfeit rejected (${result.code})`);
      return { state: result.state, events: result.events };
    },
  };
}
