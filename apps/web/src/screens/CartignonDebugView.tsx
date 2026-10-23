import type { ActionMessage, ActionResultMessage, MatchViewMessage } from '@cartignon/protocol';
import { useState } from 'react';
import { alertClass, buttonClass, cardClass } from '../components/ui';
import {
  cardLabel,
  choiceWithOptions,
  chooseSpellOptionAction,
  commandLabel,
  commandToAction,
  eventText,
  toggleSelection,
  validateSelection,
  type CartignonViewParts,
  type ChoiceWithOptions,
  type EventLogEntry,
} from '../lib/cartignon';
import type { Seat } from '../lib/synthetic';

/**
 * Minimal text/debug view of a Cartignon match (R6). Not the game UI (R8): it shows the
 * authorized view as plain text and offers one button per server-listed legal command.
 */

interface CartignonDebugViewProps {
  view: MatchViewMessage;
  parts: CartignonViewParts;
  eventLog: readonly EventLogEntry[];
  lastResult: ActionResultMessage | null;
  canAct: boolean;
  onAction: (action: ActionMessage['action']) => void;
}

const sectionTitle = 'mb-2 text-base font-semibold';
const listClass = 'flex flex-col gap-1 font-mono text-sm';
const mutedClass = 'text-sm text-ink-muted';

function seatName(seat: Seat | null, mySeat: Seat): string {
  if (seat === null) return 'none';
  return seat === mySeat ? `seat ${seat} (you)` : `seat ${seat} (opponent)`;
}

function CardList({
  ids,
  parts,
  testId,
}: {
  ids: string[];
  parts: CartignonViewParts;
  testId: string;
}) {
  if (ids.length === 0) return <p className={mutedClass}>Empty</p>;
  return (
    <ol className={listClass} data-testid={testId}>
      {ids.map((id) => (
        <li key={id}>{cardLabel(parts.public, id)}</li>
      ))}
    </ol>
  );
}

function ChoiceForm({
  choice,
  parts,
  canAct,
  onAction,
}: {
  choice: ChoiceWithOptions;
  parts: CartignonViewParts;
  canAct: boolean;
  onAction: CartignonDebugViewProps['onAction'];
}) {
  const [selection, setSelection] = useState<string[]>([]);
  const single = choice.min === 1 && choice.max === 1;
  const problem = validateSelection(selection, choice);
  const name = `choice-${choice.choiceId}`;

  return (
    <form
      className={cardClass}
      aria-labelledby="choice-heading"
      data-testid="choice-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (problem === null && canAct)
          onAction(chooseSpellOptionAction(choice.choiceId, selection));
      }}
    >
      <fieldset>
        <legend id="choice-heading" className={sectionTitle}>
          Pending choice {choice.choiceId}: select {choice.min} to {choice.max}
        </legend>
        {choice.options.length === 0 ? (
          <p className={mutedClass}>No cards offered.</p>
        ) : (
          <ul className={listClass}>
            {choice.options.map((id) => (
              <li key={id}>
                <label className="inline-flex min-h-11 items-center gap-2">
                  <input
                    type={single ? 'radio' : 'checkbox'}
                    name={name}
                    value={id}
                    checked={selection.includes(id)}
                    onChange={() => {
                      setSelection(single ? [id] : toggleSelection(selection, id, choice.options));
                    }}
                  />
                  {cardLabel(parts.public, id)}
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      <p className="mt-2 text-sm" aria-live="polite" data-testid="choice-problem">
        {problem ?? `${selection.length} selected`}
      </p>
      <button
        type="submit"
        className={`${buttonClass.primary} mt-2`}
        disabled={!canAct || problem !== null}
        data-testid="choice-submit"
      >
        Confirm choice
      </button>
    </form>
  );
}

export function CartignonDebugView({
  view,
  parts,
  eventLog,
  lastResult,
  canAct,
  onAction,
}: CartignonDebugViewProps) {
  const pub = parts.public;
  const priv = parts.private;
  const me = view.seat;
  const choice = choiceWithOptions(priv);
  const tokens = Object.entries(pub.match.tokens);
  const rejection = lastResult?.status === 'rejected' ? lastResult : null;

  return (
    <div className="flex flex-col gap-4" data-testid="cartignon-debug">
      <section className={cardClass} aria-labelledby="status-heading">
        <h2 id="status-heading" className={sectionTitle}>
          Status
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt>Round</dt>
          <dd data-testid="round">
            {pub.match.roundNumber}
            {pub.match.finalRound ? ' (final)' : ''} · turn {pub.round.turnNumber} · replays{' '}
            {pub.match.replays}
          </dd>
          <dt>Phase</dt>
          <dd data-testid="cartignon-phase">
            {view.phase.id} ({pub.round.phase.kind})
          </dd>
          <dt>Acting seat</dt>
          <dd data-testid="acting-seat">{seatName(view.phase.activeSeat, me)}</dd>
          <dt>Turn seat</dt>
          <dd>{seatName(view.phase.turnSeat, me)}</dd>
          <dt>P1 this round</dt>
          <dd>{seatName(pub.round.p1, me)}</dd>
          <dt>Tokens</dt>
          <dd className="font-mono">
            {tokens
              .map(([color, holder]) => `${color}:${holder === null ? '-' : holder}`)
              .join(' ')}
          </dd>
          <dt>Counts</dt>
          <dd>
            hands {pub.handCounts[0]}/{pub.handCounts[1]} · deck {pub.deckCount} · graveyard{' '}
            {pub.graveyardCount}
          </dd>
          <dt>Status</dt>
          <dd>
            {pub.match.status.kind === 'matchOver'
              ? `match over (${pub.match.status.reason}), winner ${seatName(pub.match.status.winner, me)}`
              : 'playing'}
          </dd>
        </dl>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        {([0, 1] as const).map((seat) => (
          <section key={seat} className={cardClass} aria-labelledby={`stack-${seat}-heading`}>
            <h2 id={`stack-${seat}-heading`} className={sectionTitle}>
              Stack of {seatName(seat, me)} · ATK {pub.atk[seat]}
            </h2>
            <CardList ids={pub.board.stacks[seat]} parts={parts} testId={`stack-${seat}`} />
          </section>
        ))}
      </div>

      <section className={cardClass} aria-labelledby="hand-heading">
        <h2 id="hand-heading" className={sectionTitle}>
          Your hand ({priv.hand.length})
        </h2>
        <CardList ids={priv.hand} parts={parts} testId="my-hand" />
        {priv.lookingAt && (
          <>
            <h3 className="mt-3 text-sm font-semibold">Looking at</h3>
            <CardList ids={priv.lookingAt} parts={parts} testId="looking-at" />
          </>
        )}
      </section>

      <section className={cardClass} aria-labelledby="traps-heading">
        <h2 id="traps-heading" className={sectionTitle}>
          Armed traps
        </h2>
        {pub.board.armedTraps.length === 0 ? (
          <p className={mutedClass}>None</p>
        ) : (
          <ul className={listClass}>
            {pub.board.armedTraps.map((trap) => (
              <li key={trap.cardId}>
                {cardLabel(pub, trap.cardId)} · {trap.spellId} · {seatName(trap.seat, me)}
                {trap.dormant ? ' · dormant' : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      {choice && (
        <ChoiceForm
          // A new choice (or revision) starts with an empty selection.
          key={`${choice.choiceId}:${view.revision}`}
          choice={choice}
          parts={parts}
          canAct={canAct}
          onAction={onAction}
        />
      )}

      <section className={cardClass} aria-labelledby="legal-heading">
        <h2 id="legal-heading" className={sectionTitle}>
          Legal actions ({priv.legal.length})
        </h2>
        {priv.legal.length === 0 ? (
          <p className={mutedClass}>
            Nothing to do: waiting for {seatName(view.phase.activeSeat, me)}.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2" data-testid="legal-actions">
            {priv.legal.map((command, index) => (
              <button
                // Legal entries are a server-ordered list without ids of their own.
                key={index}
                type="button"
                className={buttonClass.secondary}
                disabled={!canAct}
                onClick={() => {
                  onAction(commandToAction(command));
                }}
                data-testid={`legal-${index}`}
              >
                {commandLabel(command, pub)}
              </button>
            ))}
          </div>
        )}
        <p className="mt-3 text-sm" role="status" data-testid="action-result">
          {lastResult ? `Last action: ${lastResult.status}` : ''}
        </p>
        {rejection && (
          <p className={`${alertClass} mt-2`} data-testid="rejection">
            Rejected: {rejection.message}
            {rejection.reason ? ` (reason: ${rejection.reason})` : ''}
          </p>
        )}
      </section>

      <section className={cardClass} aria-labelledby="events-heading">
        <h2 id="events-heading" className={sectionTitle}>
          Events (latest {eventLog.length})
        </h2>
        {eventLog.length === 0 ? (
          <p className={mutedClass}>No events yet.</p>
        ) : (
          <ol
            className={`${listClass} max-h-72 overflow-y-auto`}
            data-testid="event-log"
            tabIndex={0}
            aria-label="Event log, newest first"
          >
            {[...eventLog].reverse().map((entry) => (
              <li key={entry.key}>
                r{entry.revision} {eventText(entry.event)}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
