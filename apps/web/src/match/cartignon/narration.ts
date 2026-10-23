import type { CartignonPublicView, CartignonSeatEvent } from '@cartignon/protocol';
import type { EventLogEntry } from '../../lib/cartignon';
import type { Seat } from '../../lib/synthetic';
import { colorInfo } from './colors';
import { roundOutcomeText, roundOverText } from './labels';
import { modifierLabel } from './minionArt';
import { spellText } from './spellArt';
import { otherSeat, outcomeView, tableCard, type Side } from './tableModel';

type ModifierKind = Extract<CartignonSeatEvent, { type: 'modifierLive' }>['kind'];

/**
 * Action log narration (table): turns the rolling event log into short sentences from this
 * seat's perspective, e.g. `You cast "Grave Bargain" (primary effect): you drew 0 of 2 from the
 * graveyard (graveyard empty); opponent drew 1 from the deck.` Pure; it only re-words events.
 * The opponent's drawn cards are never named: their `cardsDrawn` carries only a count, and ids
 * are used only for this seat's own draws.
 */

/**
 * The turn a line happened in, for grouping the history: the round's turn number and who was on
 * turn, or `'end'` for the round result lines (after `roundOver`, before the next round).
 */
export type NarrationTurn = { number: number; side: Side } | 'end';

export interface NarrationLine {
  key: string;
  revision: number;
  /** Who did it (`null` for table-wide events such as a round result). */
  actor: Side | null;
  text: string;
  /**
   * What the action triggered, shown only in the detailed history (2026-10-23): the spell's
   * Condition verdict and the effect that fired, modifier activations and silencing. Absent when
   * nothing followed.
   */
  details?: string[];
  /** The turn this happened in (absent when the log does not reach back to that turn's start). */
  turn?: NarrationTurn;
  /** This line opens a round (`roundStarted`): the history starts a new round group here. */
  startsRound?: true;
}

/** How many sentences the table keeps (the event log itself keeps `EVENT_LOG_LIMIT` events). */
export const NARRATION_LIMIT = 30;

type DrawFrom = 'deck' | 'graveyard';

const SPELL_DRAW_REASONS = new Set(['spellDeck', 'spellGraveyard']);
const MODIFIER_DRAW_FROM: Readonly<Record<string, DrawFrom>> = {
  modifierDeck: 'deck',
  modifierGraveyard: 'graveyard',
};

/** Short card name for sentences: `Orange 3 (ATK 4)`, `"Grave Bargain"`, or the id. */
export function narrationCardName(pub: CartignonPublicView, cardId: string): string {
  const summary = tableCard(pub, cardId).summary;
  if (summary === null) return `card ${cardId}`;
  if (summary.kind === 'spell') return `"${summary.name}"`;
  const info = colorInfo(summary.color);
  return `${info.label} ${summary.level} (ATK ${summary.atk})`;
}

function cardsCount(count: number): string {
  return `${count} ${count === 1 ? 'card' : 'cards'}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A modifier in history sentences: its kind plus the printed amount, e.g. `Buff +30 ATK`. */
function modifierPhrase(kind: ModifierKind): string {
  switch (kind) {
    case 'buffSelf':
      return `Buff ${modifierLabel(kind)}`;
    case 'nerfEnemyLeader':
      return `Nerf ${modifierLabel(kind)} on the enemy Leading card`;
    default:
      return modifierLabel(kind);
  }
}

class Narrator {
  readonly lines: NarrationLine[] = [];
  /** The spell sentence still collecting its draw clauses. */
  #spell: { line: NarrationLine; head: string; clauses: string[] } | null = null;
  /** This seat's last own draw (ids), named in the next draw clause. */
  #ownDraw: string[] = [];
  /** The turn in progress (from `turnStarted`; `'end'` after `roundOver`). */
  #turn: NarrationTurn | undefined;
  /** The last line pushed; what follows in the same step is added to its `details`. */
  #anchor: NarrationLine | null = null;

  readonly pub: CartignonPublicView;
  readonly mySeat: Seat;

  constructor(pub: CartignonPublicView, mySeat: Seat) {
    this.pub = pub;
    this.mySeat = mySeat;
  }

  #side(seat: Seat): Side {
    return seat === this.mySeat ? 'mine' : 'theirs';
  }

  /** `you` / `opponent` (lower case; capitalize at sentence start). */
  #who(seat: Seat): string {
    return seat === this.mySeat ? 'you' : 'opponent';
  }

  #whose(seat: Seat): string {
    return seat === this.mySeat ? 'your' : "opponent's";
  }

  #name(cardId: string): string {
    return narrationCardName(this.pub, cardId);
  }

  #push(entry: EventLogEntry, actor: Side | null, text: string): NarrationLine {
    const line: NarrationLine = { key: entry.key, revision: entry.revision, actor, text };
    if (this.#turn !== undefined) line.turn = this.#turn;
    this.lines.push(line);
    this.#anchor = line;
    return line;
  }

  /**
   * Adds a detail to the line of the same step (the play or cast that caused it). Without one,
   * `standalone` decides whether it becomes its own line (an activation does; a silencing alone,
   * e.g. at round cleanup, is noise).
   */
  #detail(entry: EventLogEntry, actor: Side | null, text: string, standalone: boolean): void {
    const anchor = this.#anchor;
    if (anchor !== null && anchor.revision === entry.revision) {
      (anchor.details ??= []).push(text);
      return;
    }
    if (standalone) this.#push(entry, actor, text);
  }

  #modifierDetail(
    entry: EventLogEntry,
    event: Extract<CartignonSeatEvent, { type: 'modifierLive' | 'modifierSilenced' }>,
  ): void {
    const card = `${this.#whose(event.seat)} ${this.#name(event.cardId)}`;
    const what = modifierPhrase(event.kind);
    if (event.type === 'modifierLive') {
      this.#detail(entry, this.#side(event.seat), `Activated: ${card} — ${what}.`, true);
    } else {
      this.#detail(entry, this.#side(event.seat), `Silenced: ${card} — ${what}.`, false);
    }
  }

  closeSpell(): void {
    const spell = this.#spell;
    if (!spell) return;
    spell.line.text =
      spell.clauses.length > 0 ? `${spell.head}: ${spell.clauses.join('; ')}.` : `${spell.head}.`;
    this.#spell = null;
  }

  #drawClause(seat: Seat, from: DrawFrom, requested: number, drawn: number): string {
    const amount = drawn === requested ? cardsCount(drawn) : `${drawn} of ${requested}`;
    let clause = `${this.#who(seat)} drew ${amount} from the ${from}`;
    if (drawn < requested) clause += drawn === 0 ? ` (${from} empty)` : ` (${from} ran out)`;
    if (seat === this.mySeat && this.#ownDraw.length > 0) {
      clause += ` — ${this.#ownDraw.map((id) => this.#name(id)).join(', ')}`;
    }
    this.#ownDraw = [];
    return clause;
  }

  #roundOver(event: Extract<CartignonSeatEvent, { type: 'roundOver' }>): string {
    const mine = event.atk[this.mySeat];
    const theirs = event.atk[otherSeat(this.mySeat)];
    return roundOverText({
      reason: event.reason,
      endedBy: this.#side(event.seat),
      // RD-169: in P1's Base step only P1 can end the turn, so the ender is P1.
      iAmP1: event.seat === this.mySeat,
      atk: [mine, theirs],
    });
  }

  add(entry: EventLogEntry): void {
    const event = entry.event;
    if (this.#spell && this.#spell.line.revision !== entry.revision) this.closeSpell();
    switch (event.type) {
      case 'spellPlayed': {
        this.closeSpell();
        const via =
          event.playedVia === undefined
            ? ''
            : ` through ${this.#whose(otherSeat(event.seat))} ${this.#name(event.playedVia)}`;
        const head = `${capitalize(this.#who(event.seat))} cast ${this.#name(event.cardId)}${via} (${event.branch} effect)`;
        const line = this.#push(entry, this.#side(event.seat), `${head}.`);
        // Condition verdict and the printed effect that fired (catalog text, no rule logic).
        const printed = spellText(tableCard(this.pub, event.cardId).defId);
        const effect = printed ? ` — ${printed[event.branch]}` : '';
        line.details = [
          event.branch === 'primary'
            ? `Condition met: Primary fired${effect}`
            : `Condition not met: Secondary fired${effect}`,
        ];
        this.#spell = { line, head, clauses: [] };
        return;
      }
      case 'turnStarted':
        this.closeSpell();
        this.#turn = { number: event.turnNumber, side: this.#side(event.seat) };
        return;
      case 'modifierLive':
      case 'modifierSilenced':
        this.#modifierDetail(entry, event);
        return;
      case 'modifierCopied':
        this.#detail(
          entry,
          this.#side(event.seat),
          `${capitalize(this.#who(event.seat))} copied the ${modifierPhrase(event.kind)} of ${this.#name(event.sourceCardId)}.`,
          true,
        );
        return;
      case 'spellResolved':
      case 'turnEnded':
        this.closeSpell();
        if (event.type === 'turnEnded') {
          const ender =
            event.seat === this.mySeat ? 'You ended your turn.' : 'Opponent ended their turn.';
          this.#push(entry, this.#side(event.seat), ender);
        }
        return;
      case 'cardsDrawn': {
        const ids = 'cardIds' in event && event.seat === this.mySeat ? event.cardIds : [];
        const count = 'cardIds' in event ? event.cardIds.length : event.count;
        if (SPELL_DRAW_REASONS.has(event.reason)) {
          // Named (own draws only) in the following `spellDrawResolved`.
          this.#ownDraw = ids;
          return;
        }
        const from = MODIFIER_DRAW_FROM[event.reason];
        if (from === undefined) return; // deals / refills: covered by the round lines
        // RD-123: a creature modifier draw always requests 1.
        this.#ownDraw = ids;
        const clause = this.#drawClause(event.seat, from, 1, count);
        this.#push(entry, this.#side(event.seat), `${capitalize(clause)} (creature effect).`);
        return;
      }
      case 'spellDrawResolved': {
        const clause = this.#drawClause(event.seat, event.from, event.requested, event.drawn);
        if (this.#spell) this.#spell.clauses.push(clause);
        else this.#push(entry, this.#side(event.seat), `${capitalize(clause)}.`);
        return;
      }
      default: {
        // Grouping: a new round has no turn yet; the result lines form the round's end group.
        if (event.type === 'roundStarted') this.#turn = undefined;
        if (event.type === 'roundOver') this.#turn = 'end';
        const text = this.#simple(event);
        if (text === null) return;
        const line = this.#push(entry, this.#actor(event), text);
        if (event.type === 'roundStarted') line.startsRound = true;
      }
    }
  }

  #actor(event: CartignonSeatEvent): Side | null {
    if (event.type === 'tokenChanged') return this.#side(event.change.seat);
    return 'seat' in event ? this.#side(event.seat) : null;
  }

  #simple(event: CartignonSeatEvent): string | null {
    switch (event.type) {
      case 'roundStarted':
        return event.p1 === this.mySeat
          ? 'New round: you are P1 and play the Base.'
          : 'New round: opponent is P1 and plays the Base.';
      case 'creaturePlayed': {
        const where =
          event.role === 'stack' ? `onto ${this.#whose(event.seat)} stack` : 'as the Base';
        return `${capitalize(this.#who(event.seat))} played ${this.#name(event.cardId)} ${where}.`;
      }
      case 'nullified':
        return `${capitalize(this.#who(event.seat))} nullified ${this.#name(event.nullifiedCardId)} with ${this.#name(event.cardId)}.`;
      case 'mulliganed':
        return `${capitalize(this.#who(event.seat))} took a mulligan: returned ${cardsCount(event.returned)}, drew ${event.drawnCount}.`;
      case 'roundOver':
        return this.#roundOver(event);
      case 'roundResolved': {
        const view = outcomeView(event.outcome, this.mySeat);
        return view === null ? null : roundOutcomeText(view);
      }
      case 'tieBreakStarted':
        return `Tie-break: ATK ${event.atk[this.mySeat]} vs ${event.atk[otherSeat(this.mySeat)]}, both draw until a creature.`;
      case 'tieBreakDeckOut':
        return 'The deck ran out during the tie-break.';
      case 'tokenChanged': {
        const { seat, color, kind } = event.change;
        const token = `${colorInfo(color).label} token`;
        const who = capitalize(this.#who(seat));
        if (kind === 'awarded') return `${who} won the ${token}.`;
        if (kind === 'stolen')
          return `${who} took the ${token} from ${this.#who(otherSeat(seat))}.`;
        return `${who} kept the ${token}.`;
      }
      case 'trapArmed':
        return `${capitalize(this.#who(event.seat))} armed the trap ${this.#name(event.cardId)}.`;
      case 'trapTriggered':
        return `${capitalize(this.#whose(event.seat))} trap ${this.#name(event.cardId)} triggered (${event.outcome}).`;
      case 'trapLapsed':
        return `${capitalize(this.#whose(event.seat))} trap ${this.#name(event.cardId)} lapsed.`;
      case 'controlTaken':
        return `${capitalize(this.#who(event.seat))} took control of ${this.#name(event.cardId)}.`;
      case 'creatureRemoved': {
        const to =
          event.to.zone === 'hand' ? `${this.#whose(event.to.seat)} hand` : `the ${event.to.zone}`;
        return `${this.#name(event.cardId)} left ${this.#whose(event.seat)} stack to ${to}.`;
      }
      case 'stacksSwapped':
        return 'The stacks were swapped.';
      case 'cardsDiscarded':
        return `${capitalize(this.#who(event.seat))} discarded ${event.cardIds.map((id) => this.#name(id)).join(', ')}.`;
      case 'handCardsReturned': {
        const count = 'cardIds' in event ? event.cardIds.length : event.count;
        return `${capitalize(this.#who(event.seat))} put ${cardsCount(count)} from hand into the deck.`;
      }
      case 'deckExhausted':
        return 'The deck is nearly empty: this is the final round.';
      case 'matchOver':
        if (event.winner === null) return 'Match over: draw.';
        return event.winner === this.mySeat ? 'Match over: you won.' : 'Match over: opponent won.';
      default:
        return null;
    }
  }
}

/**
 * Narrates the event log (oldest first) into at most `limit` sentences, oldest first. A spell's
 * draws (`spellDrawResolved`, same step) are folded into the spell's sentence.
 */
export function narrateEvents(
  entries: readonly EventLogEntry[],
  pub: CartignonPublicView,
  mySeat: Seat,
  limit = NARRATION_LIMIT,
): NarrationLine[] {
  const narrator = new Narrator(pub, mySeat);
  for (const entry of entries) narrator.add(entry);
  narrator.closeSpell();
  return narrator.lines.slice(-limit);
}
