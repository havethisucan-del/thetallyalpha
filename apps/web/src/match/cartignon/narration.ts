import type { CartignonPublicView, CartignonSeatEvent } from '@cartignon/protocol';
import type { EventLogEntry } from '../../lib/cartignon';
import type { Seat } from '../../lib/synthetic';
import { colorInfo } from './colors';
import { roundOutcomeText, roundOverText } from './labels';
import { otherSeat, outcomeView, tableCard, type Side } from './tableModel';

/**
 * Action log narration (table): turns the rolling event log into short sentences from this
 * seat's perspective, e.g. `You cast "Grave Bargain" (primary effect): you drew 0 of 2 from the
 * graveyard (graveyard empty); opponent drew 1 from the deck.` Pure; it only re-words events.
 * The opponent's drawn cards are never named: their `cardsDrawn` carries only a count, and ids
 * are used only for this seat's own draws.
 */

export interface NarrationLine {
  key: string;
  revision: number;
  /** Who did it (`null` for table-wide events such as a round result). */
  actor: Side | null;
  text: string;
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

class Narrator {
  readonly lines: NarrationLine[] = [];
  /** The spell sentence still collecting its draw clauses. */
  #spell: { line: NarrationLine; head: string; clauses: string[] } | null = null;
  /** This seat's last own draw (ids), named in the next draw clause. */
  #ownDraw: string[] = [];

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
    const line = { key: entry.key, revision: entry.revision, actor, text };
    this.lines.push(line);
    return line;
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
        this.#spell = {
          line: this.#push(entry, this.#side(event.seat), `${head}.`),
          head,
          clauses: [],
        };
        return;
      }
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
        const text = this.#simple(event);
        if (text !== null) this.#push(entry, this.#actor(event), text);
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
