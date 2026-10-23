import type { ActionMessage, ActionResultMessage, MatchViewMessage } from '@cartignon/protocol';
import { useMemo, useState, type ReactNode } from 'react';
import { ThemeToggle } from '../components/ThemeToggle';
import { alertClass, buttonClass, cardClass } from '../components/ui';
import type { BoardModel } from '../match/board';
import { LeaveConfirmDialog } from '../match/LeaveConfirmDialog';
import { shouldConfirmLeave } from '../match/leaveConfirm';
import { PhaserBoard } from '../match/PhaserBoard';
import type { MatchSnapshot } from '../net/matchSource';
import { commandToAction, rendererFor } from '../lib/cartignon';
import { narrateEvents } from '../match/cartignon/narration';
import { buildTableModel } from '../match/cartignon/tableModel';
import { useClock } from '../match/cartignon/useClock';
import {
  INCREMENT_AMOUNTS,
  parseSyntheticPrivate,
  parseSyntheticPublic,
  type IncrementAmount,
  type Seat,
} from '../lib/synthetic';
import { CartignonDebugView } from './CartignonDebugView';
import { CartignonTable } from './cartignon/CartignonTable';

interface MatchScreenProps {
  snapshot: MatchSnapshot;
  onIncrement: (amount: IncrementAmount) => void;
  onAction: (action: ActionMessage['action']) => void;
  onHome: () => void;
  /** Connection status bar; the full-viewport Cartignon layout shows it in its toolbar row. */
  statusBar?: ReactNode;
  /** Opponent name on the table (e.g. `Bot · L3 Skilled` in solo play); default "Opponent". */
  opponentLabel?: string;
  /**
   * Holds back the Cartignon outcome card (and the Leave button stays hidden once the match is
   * over): the tutorial coach narrates the match end itself and leads out with its own button.
   */
  hideOutcome?: boolean;
}

function outcomeText(view: MatchViewMessage): string | null {
  const outcome = view.outcome;
  if (!outcome) return null;
  if (outcome.result === 'draw') return 'Draw';
  return outcome.winner === view.seat ? 'You won' : 'Your opponent won';
}

function turnText(activeSeat: Seat | null, mySeat: Seat): string {
  if (activeSeat === null) return 'No active turn';
  return activeSeat === mySeat ? 'Your turn' : "Opponent's turn";
}

function resultText(result: ActionResultMessage): string {
  switch (result.status) {
    case 'accepted':
      return `Accepted (revision ${result.revision})`;
    case 'duplicate':
      return `Duplicate — already applied (revision ${result.revision})`;
    case 'rejected':
      return `Rejected: ${result.message}`;
  }
}

function UnreadableMatch({ onHome }: { onHome: () => void }) {
  return (
    <div className="flex flex-col items-start gap-4">
      <p role="alert" className={alertClass} data-testid="room-error">
        The match data from the server could not be read.
      </p>
      <button type="button" className={buttonClass.secondary} onClick={onHome}>
        Back to home
      </button>
    </div>
  );
}

function OutcomeCard({ outcome, onHome }: { outcome: string; onHome: () => void }) {
  return (
    <section className={cardClass} aria-labelledby="outcome-heading">
      <h2 id="outcome-heading" className="text-3xl leading-none" data-testid="outcome">
        {outcome}
      </h2>
      <button
        type="button"
        className={`${buttonClass.primary} mt-3`}
        onClick={onHome}
        data-testid="back-home"
      >
        Back to home
      </button>
    </section>
  );
}

/**
 * Picks the renderer for the view's rules: the synthetic counter board or the Cartignon table
 * (with the debug view behind a toggle).
 */
export function MatchScreen(props: MatchScreenProps) {
  const view = props.snapshot.view;
  const renderer = view ? rendererFor(view.rulesId) : 'synthetic';
  if (renderer === 'cartignon') return <CartignonMatchScreen {...props} />;
  if (renderer === 'unsupported') return <UnreadableMatch onHome={props.onHome} />;
  return <SyntheticMatchScreen {...props} />;
}

/** Slim 44px toolbar button for the full-viewport Cartignon layout. */
const toolbarButtonClass =
  'ink-line inline-flex min-h-target min-w-target items-center justify-center rounded-md ' +
  'bg-paper-raised px-3 text-lg leading-none text-ink transition-colors ' +
  'hover:bg-paper-sunken aria-pressed:bg-paper-sunken';

function CartignonMatchScreen({
  snapshot,
  statusBar,
  opponentLabel,
  hideOutcome = false,
  onAction,
  onHome,
}: MatchScreenProps) {
  const view = snapshot.view;
  const parts = snapshot.cartignon;
  const [showDebug, setShowDebug] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  // Hooks run before the early return below; the clock ticks only while it changes over time.
  const clock = useClock(snapshot.clock, snapshot.clockReceivedAt, view?.seat ?? null);
  if (!view || !parts) return <UnreadableMatch onHome={onHome} />;

  const finished = view.outcome !== null || snapshot.room?.phase === 'finished';
  const phase = finished ? 'finished' : (snapshot.room?.phase ?? 'active');
  const myTurn =
    !finished && snapshot.status === 'connected' && view.phase.activeSeat === view.seat;
  const outcome = outcomeText(view);
  const model = buildTableModel(view, parts, clock, view.seat);

  const notices = (
    <>
      {snapshot.error && (
        <p role="alert" className={alertClass} data-testid="room-error">
          {snapshot.error}
        </p>
      )}
      {outcome && !hideOutcome && <OutcomeCard outcome={outcome} onHome={onHome} />}
    </>
  );
  const showNotices = snapshot.error || (outcome && !hideOutcome);

  // Full-viewport layout (App gives this screen the remaining height): one slim toolbar row,
  // then either the table (internal scroll + fixed dock) or the scrolling debug view.
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-none items-center justify-between gap-2">
        <div className="min-w-0">
          {statusBar}
          <p className="sr-only">
            Phase:{' '}
            <span data-testid="phase" data-phase={phase}>
              {phase}
            </span>
          </p>
        </div>
        <div className="flex flex-none gap-2">
          <ThemeToggle />
          <button
            type="button"
            className={toolbarButtonClass}
            aria-pressed={showDebug}
            onClick={() => {
              setShowDebug((shown) => !shown);
            }}
            data-testid="debug-toggle"
          >
            Debug
          </button>
          {!outcome && (
            <button
              type="button"
              className={toolbarButtonClass}
              onClick={() => {
                if (shouldConfirmLeave(snapshot)) setConfirmLeave(true);
                else onHome();
              }}
              data-testid="leave-match"
            >
              Leave
            </button>
          )}
        </div>
      </div>
      <LeaveConfirmDialog
        open={confirmLeave && shouldConfirmLeave(snapshot)}
        onLeave={onHome}
        onStay={() => {
          setConfirmLeave(false);
        }}
      />

      {showDebug ? (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-4">
          {notices}
          <p className="text-sm text-ink-muted">
            Phase: <span className="font-semibold">{phase}</span>
            {' · '}
            <span data-testid="turn" data-my-turn={myTurn ? 'true' : 'false'}>
              {view.phase.activeSeat === null
                ? 'Nobody acts'
                : view.phase.activeSeat === view.seat
                  ? 'You act'
                  : 'Opponent acts'}
            </span>
          </p>
          <CartignonDebugView
            view={view}
            parts={parts}
            eventLog={snapshot.eventLog}
            lastResult={snapshot.lastResult}
            canAct={myTurn}
            onAction={onAction}
          />
        </div>
      ) : (
        <CartignonTable
          model={model}
          canAct={myTurn}
          lastResult={snapshot.lastResult}
          log={narrateEvents(snapshot.eventLog, parts.public, view.seat)}
          eventLog={snapshot.eventLog}
          notices={showNotices ? notices : null}
          {...(opponentLabel === undefined ? {} : { opponentLabel })}
          onCommand={(command) => {
            onAction(commandToAction(command));
          }}
        />
      )}
    </div>
  );
}

function SyntheticMatchScreen({ snapshot, onIncrement, onHome }: MatchScreenProps) {
  const view = snapshot.view;
  const pub = useMemo(() => (view ? parseSyntheticPublic(view.public) : null), [view]);
  const priv = useMemo(() => (view ? parseSyntheticPrivate(view.private) : null), [view]);

  const board: BoardModel | null = useMemo(() => {
    if (!view || !pub) return null;
    return {
      counter: pub.counter,
      target: pub.target,
      turnLabel: outcomeText(view) ?? turnText(view.phase.activeSeat, view.seat),
      secretCounts: pub.secretCounts,
      mySeat: view.seat,
      statusLabel: view.outcome ? 'Match finished' : `Phase: ${view.phase.id}`,
    };
  }, [view, pub]);

  if (!view) {
    return (
      <div className="flex flex-col gap-4">
        <p data-testid="phase" data-phase={snapshot.room?.phase ?? 'unknown'}>
          Waiting for the match to start…
        </p>
        {snapshot.error && (
          <p role="alert" className={alertClass} data-testid="room-error">
            {snapshot.error}
          </p>
        )}
      </div>
    );
  }

  if (!pub || !priv || !board) return <UnreadableMatch onHome={onHome} />;

  const finished = view.outcome !== null || snapshot.room?.phase === 'finished';
  const phase = finished ? 'finished' : (snapshot.room?.phase ?? 'active');
  const myTurn =
    !finished && snapshot.status === 'connected' && view.phase.activeSeat === view.seat;
  const outcome = outcomeText(view);
  const summary =
    `Counter ${pub.counter} of ${pub.target}. ${board.turnLabel}. ` +
    `You hold ${pub.secretCounts[view.seat]} secrets, ` +
    `your opponent ${pub.secretCounts[view.seat === 0 ? 1 : 0]}.`;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-muted">
        Phase:{' '}
        <span className="font-semibold" data-testid="phase" data-phase={phase}>
          {phase}
        </span>
        {' · '}
        <span data-testid="turn" data-my-turn={myTurn ? 'true' : 'false'}>
          {turnText(view.phase.activeSeat, view.seat)}
        </span>
      </p>

      <PhaserBoard model={board} summary={summary} />

      {snapshot.error && (
        <p role="alert" className={alertClass} data-testid="room-error">
          {snapshot.error}
        </p>
      )}

      {outcome && <OutcomeCard outcome={outcome} onHome={onHome} />}

      <section className={cardClass} aria-labelledby="actions-heading">
        <h2 id="actions-heading" className="mb-3 text-base font-semibold">
          Increment the counter
        </h2>
        <div className="flex flex-wrap gap-3">
          {INCREMENT_AMOUNTS.map((amount) => (
            <button
              key={amount}
              type="button"
              className={buttonClass.primary}
              disabled={!myTurn}
              onClick={() => {
                onIncrement(amount);
              }}
              data-testid={`increment-${amount}`}
            >
              +{amount}
            </button>
          ))}
        </div>
        <p className="mt-3 text-sm" role="status" data-testid="action-result">
          {snapshot.lastResult ? `Last action: ${resultText(snapshot.lastResult)}` : ''}
        </p>
      </section>

      <section className={cardClass} aria-labelledby="secrets-heading">
        <h2 id="secrets-heading" className="mb-2 text-base font-semibold">
          Your secrets
        </h2>
        {priv.secrets.length === 0 ? (
          <p className="text-sm text-ink-muted">None</p>
        ) : (
          <ul className="flex flex-wrap gap-2" data-testid="my-secrets">
            {priv.secrets.map((secret, index) => (
              <li
                // Secrets have no identity of their own; position is the only stable key.
                key={index}
                className="ink-line rounded px-2 py-1"
              >
                {secret}
              </li>
            ))}
          </ul>
        )}
      </section>

      {!outcome && (
        <div>
          <button type="button" className={buttonClass.secondary} onClick={onHome}>
            Leave match
          </button>
        </div>
      )}
    </div>
  );
}
