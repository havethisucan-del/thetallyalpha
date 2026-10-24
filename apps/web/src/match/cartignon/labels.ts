import type { ActionResultMessage, CartignonCommand } from '@cartignon/protocol';
import { CLOCK_WARN_MS, formatClock, type ClockReading } from './clock';
import { colorInfo } from './colors';
import type {
  LegalRef,
  LiveModifierView,
  MyChoice,
  OpponentChoice,
  RoundOutcomeView,
  RoundOverView,
  Side,
  SpellHint,
  TableCard,
  TableCenter,
  TableModel,
  TokenView,
} from './tableModel';

/**
 * Plain-text labels for the Cartignon table (R8b): accessible names and short display strings
 * derived from `TableModel` slices. Pure and renderer-neutral; no rules are computed here.
 */

type ModifierKind = LiveModifierView['kind'];
type PhaseKind = TableCenter['phaseKind'];

const MODIFIER_TEXT: Readonly<Record<ModifierKind, string>> = {
  buffSelf: 'Buff self',
  nerfEnemyLeader: 'Nerf enemy leader',
  linkUp: 'Link up',
  drawDeck: 'Draw from deck',
  drawGrave: 'Draw from graveyard',
};

const PHASE_TEXT: Readonly<Record<PhaseKind, string>> = {
  p1Base: 'Base',
  p2Opening: 'Opening',
  turn: 'Turn',
  roundOver: 'Round over',
};

export function modifierText(kind: ModifierKind): string {
  return MODIFIER_TEXT[kind];
}

export function phaseText(kind: PhaseKind): string {
  return PHASE_TEXT[kind];
}

/**
 * Accessible name of a face-up card, e.g. `Orange 3, ATK 4` (creature: color, level, ATK,
 * modifiers), `Spell Fireball` or `Card c05` when the public card table does not list it.
 */
export function cardAriaLabel(card: TableCard): string {
  const summary = card.summary;
  if (summary === null) return `Card ${card.cardId}`;
  if (summary.kind === 'spell') return summary.name ? `Spell ${summary.name}` : 'Spell';
  const info = colorInfo(summary.color);
  const mods =
    summary.modifiers.length > 0 ? `, ${summary.modifiers.map(modifierText).join(', ')}` : '';
  return `${info.label} ${summary.level}, ATK ${summary.atk}${mods}`;
}

/** Accessible name of a stack: who owns it, its size and the reading order. */
export function stackAriaLabel(side: Side, count: number): string {
  const owner = side === 'mine' ? 'Your stack' : 'Opponent stack';
  if (count === 0) return `${owner}, empty`;
  return `${owner}, ${count} ${count === 1 ? 'card' : 'cards'}, bottom to top`;
}

export function tokenOwnerText(side: Side | null): string {
  if (side === 'mine') return 'You';
  if (side === 'theirs') return 'Opp';
  return 'Free';
}

/** Accessible name of a color token, e.g. `Orange token, yours`. */
export function tokenAriaLabel(token: TokenView): string {
  const info = colorInfo(token.color);
  const owner =
    token.side === 'mine' ? 'yours' : token.side === 'theirs' ? "opponent's" : 'unclaimed';
  return `${info.label} token, ${owner}`;
}

export function tokenCount(tokens: readonly TokenView[], side: Side): number {
  return tokens.filter((token) => token.side === side).length;
}

/** Accessible name of a live modifier, e.g. `Your Buff self (c22)`. */
export function liveModifierText(modifier: LiveModifierView): string {
  const owner = modifier.side === 'mine' ? 'Your' : 'Opponent';
  return `${owner} ${modifierText(modifier.kind)} (${modifier.cardId})`;
}

type GlobalCommandType = 'mulligan' | 'endTurn';

const GLOBAL_COMMAND_TEXT: Readonly<Record<GlobalCommandType, string>> = {
  mulligan: 'Mulligan',
  endTurn: 'End turn',
};

/** Button text of a global (card-less) command; other commands fall back to their type. */
export function globalCommandText(command: CartignonCommand): string {
  return command.type in GLOBAL_COMMAND_TEXT
    ? GLOBAL_COMMAND_TEXT[command.type as GlobalCommandType]
    : command.type;
}

/**
 * Splits global commands for the action bar: `endTurn` is the primary (thumb-side) action, the
 * rest (Mulligan) stay secondary. Server order is kept within each group.
 */
export function splitGlobalCommands(commands: readonly LegalRef[]): {
  secondary: LegalRef[];
  primary: LegalRef[];
} {
  return {
    secondary: commands.filter((ref) => ref.command.type !== 'endTurn'),
    primary: commands.filter((ref) => ref.command.type === 'endTurn'),
  };
}

type CardCommand = Extract<CartignonCommand, { cardId: string }>;

const CARD_COMMAND_TEXT: Readonly<Record<CardCommand['type'], string>> = {
  playCreature: 'Play',
  nullify: 'Nullify',
  playSpell: 'Cast',
};

/** Button text of a card command (R8c), e.g. `Play`; other commands use `globalCommandText`. */
export function cardCommandText(command: CartignonCommand): string {
  return 'cardId' in command ? CARD_COMMAND_TEXT[command.type] : globalCommandText(command);
}

/**
 * Plain description of a command the player sent, for announcements, e.g. `Play Orange 3,
 * ATK 4`. `card` is the table card of the command's card when known.
 */
export function commandDescription(command: CartignonCommand, card: TableCard | null): string {
  if (command.type === 'chooseSpellOption') {
    const count = command.selection.length;
    return count === 0 ? 'Choice: nothing selected' : `Choice: ${count} selected`;
  }
  if (!('cardId' in command)) return globalCommandText(command);
  const name = card ? cardAriaLabel(card) : `card ${command.cardId}`;
  return `${CARD_COMMAND_TEXT[command.type]} ${name}`;
}

type ChoiceKind = MyChoice['kind'];

const CHOICE_KIND_TEXT: Readonly<Record<ChoiceKind, Readonly<Record<Side, string>>>> = {
  keepDrawn: { mine: 'Keep drawn cards', theirs: 'keep drawn cards' },
  handCreature: { mine: 'A creature from your hand', theirs: 'a creature from their hand' },
  enemyCreature: { mine: "An opponent's creature", theirs: 'one of your creatures' },
  ownCreature: { mine: 'One of your creatures', theirs: 'one of their creatures' },
  handDiscard: { mine: 'Cards to discard from your hand', theirs: 'cards to discard' },
  handToDeck: {
    mine: 'Hand cards to put into the deck',
    theirs: 'hand cards to put into the deck',
  },
};

/** What a pending choice asks for, from the chooser's (`mine`) or the other seat's view. */
export function choiceKindText(kind: ChoiceKind, side: Side): string {
  return CHOICE_KIND_TEXT[kind][side];
}

/** The allowed selection size, e.g. `Choose 1`, `Choose up to 2`, `Choose 1–3`. */
export function choiceRangeText(min: number, max: number): string {
  if (min === max) return `Choose ${min}`;
  if (min === 0) return `Choose up to ${max}`;
  return `Choose ${min}–${max}`;
}

/** Live counter of the choice sheet, e.g. `Choose 1–3 (2 selected)`. */
export function choiceCounterText(min: number, max: number, selected: number): string {
  return `${choiceRangeText(min, max)} (${selected} selected)`;
}

/**
 * Read-only description of the opponent's pending choice. The option count is shown only when the
 * view carries it, and never for `handCreature` (RD-142: it would reveal their hand).
 */
export function opponentChoosingText(choice: OpponentChoice): string {
  const range = choiceRangeText(choice.min, choice.max).replace(/^Choose/, 'choosing');
  const count =
    choice.optionCount !== null && choice.kind !== 'handCreature'
      ? ` of ${choice.optionCount} ${choice.optionCount === 1 ? 'option' : 'options'}`
      : '';
  return `Opponent is ${range}${count}: ${choiceKindText(choice.kind, 'theirs')}.`;
}

/** Readable reasons for the server's rejection codes; unknown codes use the server message. */
const REJECTION_TEXT: Readonly<Record<string, string>> = {
  END_TURN_NOT_ALLOWED: 'You cannot end the turn right now.',
  STALE_REVISION: 'The table changed before your action arrived. Check the table and try again.',
  NOT_YOUR_TURN: 'It is not your turn.',
  MATCH_FINISHED: 'The match is over.',
  MATCH_NOT_STARTED: 'The match has not started yet.',
  RULES_MISMATCH: 'This action does not belong to this match.',
  DUPLICATE_ACTION_ID: 'This action was already sent.',
  ILLEGAL: 'That move is not allowed right now.',
  // RD-173: in the P2 opening a card that can Nullify may only Nullify.
  NULLIFY_REQUIRED: 'This card can nullify, so Nullify is its only option.',
  // RD-175: a spell whose effect would do nothing cannot be cast.
  SPELL_NO_EFFECT: 'This spell would have no effect right now, so it cannot be cast.',
};

export interface Announcement {
  /** `assertive` for rejections (interrupts), `polite` for results. */
  politeness: 'polite' | 'assertive';
  text: string;
}

/**
 * Screen-reader announcement of an action result. `sent` describes the action this seat sent last
 * (`commandDescription`), or null when unknown (e.g. sent from the debug view).
 */
export function actionResultAnnouncement(
  result: ActionResultMessage,
  sent: string | null,
): Announcement {
  const what = sent ?? 'Action';
  switch (result.status) {
    case 'accepted':
      return { politeness: 'polite', text: `${what}: done.` };
    case 'duplicate':
      return { politeness: 'polite', text: `${what}: already applied.` };
    case 'rejected': {
      const reason = REJECTION_TEXT[result.code] ?? result.message;
      return { politeness: 'assertive', text: `${what}: rejected. ${reason}` };
    }
  }
}

/** Turn banner headline: who must act now. */
export function turnBannerText(
  model: Pick<TableModel, 'finished' | 'myAction' | 'myChoice' | 'activeSeat' | 'opponentChoosing'>,
): string {
  if (model.finished) return 'Match over';
  if (model.myAction) return model.myChoice ? 'Your choice' : 'Your turn';
  if (model.activeSeat === null) return 'Waiting';
  return model.opponentChoosing ? 'Opponent is choosing' : "Opponent's turn";
}

/** Clock display text: `m:ss`, or the pause budget while the clock's seat is disconnected. */
export function clockText(reading: ClockReading): string {
  if (reading.paused) return `Paused ${formatClock(reading.pauseLeftMs)}`;
  return formatClock(reading.remainingMs);
}

/** Whether the displayed value is in the warning range (turn/choice time, or pause budget). */
export function clockWarn(reading: ClockReading): boolean {
  return reading.paused ? reading.pauseLeftMs < CLOCK_WARN_MS : reading.warn;
}

/** Accessible name of the clock, e.g. `Your turn clock, 0:52 left`. */
export function clockAriaLabel(reading: ClockReading): string {
  const owner = reading.isMine ? 'Your' : 'Opponent';
  const kind = reading.mode === 'choice' ? 'choice clock' : 'turn clock';
  if (reading.paused) {
    return `${owner} ${kind} paused while disconnected, ${formatClock(reading.pauseLeftMs)} pause left`;
  }
  return `${owner} ${kind}, ${formatClock(reading.remainingMs)} left`;
}

/** Longest word (in characters) that still fits a card's name box at the normal size. */
export const SPELL_WORD_FIT = 8;

/**
 * Text size for a spell name on a card: `small` when a word is longer than `SPELL_WORD_FIT` or
 * the name is long overall, so names wrap between words instead of mid-word.
 */
export function spellNameSize(name: string): 'normal' | 'small' {
  const longestWord = Math.max(0, ...name.split(/[\s-]+/).map((word) => word.length));
  return longestWord > SPELL_WORD_FIT || name.length > 24 ? 'small' : 'normal';
}

/**
 * Which edges of a horizontal scroller hide more content (for decorative edge fades). A 1 px
 * tolerance absorbs sub-pixel scroll positions.
 */
export function scrollEdges(
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number,
): { start: boolean; end: boolean } {
  return {
    start: scrollLeft > 1,
    end: scrollLeft + clientWidth < scrollWidth - 1,
  };
}

// ---------------------------------------------------------------------------------------------
// Round results (RD-169: a single End Turn; ending it while behind loses the round)

function atkText(atk: readonly [number, number]): string {
  return `ATK ${atk[0]} vs ${atk[1]}`;
}

/** Plain explanation of why the round just ended, e.g. `You ended the turn while behind …`. */
export function roundOverText(over: RoundOverView): string {
  switch (over.reason) {
    case 'opponentAhead':
      return over.endedBy === 'mine'
        ? `You ended the turn while behind (${atkText(over.atk)}) — your opponent wins the round.`
        : `Your opponent ended the turn while behind (${atkText(over.atk)}) — you win the round.`;
    case 'equalStall':
      return over.endedBy === 'mine'
        ? `Tie: you ended the turn at equal ATK without playing (${atkText(over.atk)}) — a tie-break decides the round.`
        : `Tie: your opponent ended the turn at equal ATK without playing (${atkText(over.atk)}) — a tie-break decides the round.`;
    case 'p1NoBase':
      return over.iAmP1
        ? 'You (P1) had no Base creature to play — the round is a draw.'
        : 'Your opponent (P1) had no Base creature to play — the round is a draw.';
  }
}

/** Plain text of a resolved round (`match.lastOutcome`), e.g. `You won the round: …`. */
export function roundOutcomeText(outcome: RoundOutcomeView): string {
  const atk = atkText(outcome.atk);
  if (outcome.kind === 'win') {
    const who = outcome.winner === 'mine' ? 'You won the round' : 'Your opponent won the round';
    if (outcome.decidedBy === 'opponentAhead') {
      const loser = outcome.winner === 'mine' ? 'your opponent' : 'you';
      return `${who}: ${loser} ended the turn while behind (${atk}).`;
    }
    return `${who} on the tie-break (${atk}).`;
  }
  return outcome.reason === 'p1NoBase'
    ? 'The round was a draw: P1 had no Base creature to play.'
    : `The round was a draw: the deck ran out during the tie-break (${atk}).`;
}

// ---------------------------------------------------------------------------------------------
// Spell hints (RD-171, `private.spellHints`; shown as given, no client rule logic)

const SPELL_REASON_TEXT: Readonly<Record<string, string>> = {
  NOT_YOUR_TURN: 'It is not your turn.',
  NOT_ALLOWED_IN_PHASE: 'Spells cannot be cast in this phase.',
  CHOICE_PENDING: 'A choice must be answered first.',
  SPELL_NOT_SUPPORTED: 'This spell is not available yet.',
  MATCH_OVER: 'The match is over.',
  ROUND_OVER: 'The round is over.',
  CARD_REPLAY_LOCKED: 'This card cannot be played again this turn.',
  // RD-175: the effect that would fire has nothing to act on (no Leading creature, empty pile).
  SPELL_NO_EFFECT:
    'Its effect would do nothing right now (no Leading creature to target, or no card to draw).',
};

/** Readable text of a spell-hint rejection code; unknown codes are shown as they are. */
export function spellReasonText(reason: string | null): string {
  if (reason === null) return 'Cannot be cast now.';
  return SPELL_REASON_TEXT[reason] ?? `Cannot be cast now (${reason}).`;
}

/** Short badge text: `Primary` / `Secondary`, or `Unavailable` when the spell cannot be played. */
export function spellHintBadge(hint: SpellHint): string {
  if (hint.branch === 'primary') return 'Primary';
  if (hint.branch === 'secondary') return 'Secondary';
  return 'Unavailable';
}

/**
 * Full hint sentence (tooltip + accessible name suffix), e.g. `Cast now: primary effect.` or
 * `Would fire its secondary effect. Not castable now: It is not your turn.`
 */
export function spellHintText(hint: SpellHint): string {
  const effect =
    hint.branch === null
      ? 'This spell cannot be played yet.'
      : `${hint.castable ? 'Cast now' : 'On this board'}: ${hint.branch} effect.`;
  if (hint.castable || hint.branch === null) return effect;
  return `${effect} Not castable now: ${spellReasonText(hint.reason)}`;
}

// ---------------------------------------------------------------------------------------------
// Shared piles (RD-170)

function cardsText(count: number): string {
  return `${count} ${count === 1 ? 'card' : 'cards'}`;
}

/** Tooltip / accessible text of the shared deck, e.g. `Deck: 21 cards`. */
export function deckPileText(count: number): string {
  return `Deck: ${cardsText(count)}`;
}

/** Tooltip / accessible text of the shared graveyard, e.g. `Graveyard: 5 cards`. */
export function graveyardPileText(count: number): string {
  return `Graveyard: ${cardsText(count)}`;
}
