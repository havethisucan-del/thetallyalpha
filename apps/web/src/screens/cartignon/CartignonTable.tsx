import type { ActionResultMessage, CartignonCommand } from '@cartignon/protocol';
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { EventLogEntry } from '../../lib/cartignon';
import { selectedHandCard, tapHandCard } from '../../match/cartignon/interaction';
import {
  actionResultAnnouncement,
  commandDescription,
  tokenCount,
  turnBannerText,
} from '../../match/cartignon/labels';
import { modifierGlows } from '../../match/cartignon/modifierGlow';
import type { NarrationLine } from '../../match/cartignon/narration';
import type { TableModel } from '../../match/cartignon/tableModel';
import { ActionAnnouncer } from './ActionAnnouncer';
import { ActionLog } from './ActionLog';
import { ActionBar } from './ActionBar';
import { CenterStrip } from './CenterStrip';
import { ChoiceSheet } from './ChoiceSheet';
import { HandRow, handRows } from './HandRow';
import { LogToast } from './LogToast';
import { OpponentChoosing } from './OpponentChoosing';
import { OpponentHand } from './OpponentHand';
import { SeatBar, type AtkStanding } from './SeatBar';
import { SeatStack } from './Stacks';
import { TokenTrack } from './TokenTrack';
import { TurnBanner } from './TurnBanner';
import './table.css';

export type TablePalette = 'normal' | 'colorblind';

/** Display-only comparison of two shown ATK totals (the seat badges' "Leads" / "Tied" chip). */
function atkStanding(own: number, other: number): AtkStanding {
  if (own > other) return 'ahead';
  return own === other ? 'tied' : 'behind';
}

/** Hand size variables the field layout needs (table.css): cards, cards per row, two levels. */
function handFieldVars(count: number): CSSProperties {
  const { two, perRow } = handRows(count);
  return {
    '--hand-n': Math.max(count, 1),
    '--hand-n2': Math.max(perRow, 1),
    '--hand-two': two ? 1 : 0,
  } as CSSProperties;
}

/** What this table sent last, and the result that was current when it was sent. */
interface SentAction {
  description: string;
  resultBefore: ActionResultMessage | null;
}

/**
 * Cartignon match table (R8c interactions; ADR-0011) as a full-window "physical table"
 * (`table.css`): the opponent's hand (backs) fanned at the top, their stack above the middle
 * line, the graveyard, tokens and deck on the line, the own stack below it and the own hand fanned
 * at the bottom; won tokens sit in the holders' corners. Floating, unboxed extras: each seat's ATK
 * badge beside its stack, the action dock (turn pill, clock, commands) beside the own hand, a tiny
 * round counter top right, transient toasts for results and narration, and the full log behind
 * the corner menu (`logOpen`). A pending choice opens as a bottom sheet in place of the hand.
 * All data comes from the model; every action goes through `onCommand` (legal entries unchanged,
 * or a choice selection sent only on Confirm). Local UI state: the tapped hand card, whether the
 * choice sheet is hidden, and the last sent action (for announcements).
 */
export function CartignonTable({
  model,
  canAct,
  onCommand,
  lastResult = null,
  notices = null,
  palette = 'normal',
  log = [],
  eventLog = [],
  opponentLabel = 'Opponent',
  logOpen = false,
  onCloseLog,
}: {
  model: TableModel;
  canAct: boolean;
  onCommand: (command: CartignonCommand) => void;
  /** The latest result of this seat's actions (`match:result`), for the live regions. */
  lastResult?: ActionResultMessage | null;
  /** Errors / outcome, shown over the middle of the table. */
  notices?: ReactNode;
  palette?: TablePalette;
  /** Narrated events (`narrateEvents`), oldest first; the log panel shows them newest first. */
  log?: readonly NarrationLine[];
  /** The rolling event log (oldest first); drives the modifier glow on stack cards. */
  eventLog?: readonly EventLogEntry[];
  /** Name shown under the opponent's hand (e.g. `Bot · L3 Skilled`). */
  opponentLabel?: string;
  /** The full action log panel is open (toggled from the corner menu). */
  logOpen?: boolean;
  onCloseLog?: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hiddenChoiceId, setHiddenChoiceId] = useState<number | null>(null);
  // A result that was already current when the table mounted (or before the last send) is not
  // announced again.
  const [sent, setSent] = useState<SentAction>(() => ({
    description: '',
    resultBefore: lastResult,
  }));

  const center = model.center;
  const tokens = center.tokens;
  const glows = useMemo(
    () =>
      modifierGlows(
        eventLog.map((entry) => entry.event),
        model.center.liveModifiers,
        [...model.opponent.stack, ...model.me.stack],
      ),
    [eventLog, model.center.liveModifiers, model.opponent.stack, model.me.stack],
  );
  const myChoice = model.myChoice;
  const choiceOpen = myChoice !== null && hiddenChoiceId !== myChoice.choiceId;
  // A stale id (card played or gone) simply selects nothing.
  const selected = selectedHandCard(model.hand, selectedId);
  // Turn cue: the hand of the seat that acts glows.
  const theyAct =
    !model.myAction &&
    !model.finished &&
    (model.opponentChoosing !== null || model.onTurn === 'theirs');

  const send = (command: CartignonCommand) => {
    const card =
      'cardId' in command
        ? (model.hand.find((entry) => entry.cardId === command.cardId) ?? null)
        : null;
    setSent({ description: commandDescription(command, card), resultBefore: lastResult });
    setSelectedId(null);
    onCommand(command);
  };

  const fresh = lastResult !== null && lastResult !== sent.resultBefore ? lastResult : null;
  const announcement = fresh
    ? actionResultAnnouncement(fresh, sent.description === '' ? null : sent.description)
    : null;

  return (
    <div
      className="ct-field"
      style={handFieldVars(model.hand.length)}
      data-palette={palette}
      data-testid="cartignon-table"
    >
      {/* No box of its own (the table no longer scrolls): the board in reading order. */}
      <div className="contents" data-testid="table-scroll">
        <OpponentHand area={model.opponent} name={opponentLabel} active={theyAct} />
        <div className="ct-seat" data-side="theirs" data-testid="theirs-seat">
          <SeatStack area={model.opponent} glows={glows} />
          <SeatBar
            area={model.opponent}
            name={opponentLabel}
            tokens={tokenCount(tokens, 'theirs')}
            onTurn={model.onTurn === 'theirs'}
            standing={atkStanding(model.opponent.atk, model.me.atk)}
          />
        </div>
        <CenterStrip center={center} />
        <TokenTrack tokens={tokens} />
        <div className="ct-seat" data-side="mine" data-testid="mine-seat">
          <SeatStack area={model.me} glows={glows} />
          <SeatBar
            area={model.me}
            tokens={tokenCount(tokens, 'mine')}
            onTurn={model.onTurn === 'mine'}
            standing={atkStanding(model.me.atk, model.opponent.atk)}
          />
        </div>
      </div>

      {!choiceOpen && (
        <HandRow
          hand={model.hand}
          selectedId={selected?.cardId ?? null}
          active={model.myAction}
          onTap={(cardId) => {
            setSelectedId((current) => tapHandCard(current, cardId));
          }}
        />
      )}
      {myChoice && (
        <div className="ct-sheet" hidden={!choiceOpen}>
          <ChoiceSheet
            // A new choice starts with an empty selection.
            key={myChoice.choiceId}
            choice={myChoice}
            hidden={!choiceOpen}
            canAct={canAct}
            onConfirm={(selection) => {
              send({ type: 'chooseSpellOption', choiceId: myChoice.choiceId, selection });
            }}
            onHide={() => {
              setHiddenChoiceId(myChoice.choiceId);
            }}
          />
        </div>
      )}

      <div className="ct-dock" data-testid="table-dock">
        <TurnBanner text={turnBannerText(model)} myAction={model.myAction} clock={model.clock} />
        {model.opponentChoosing && <OpponentChoosing choice={model.opponentChoosing} />}
        {!choiceOpen && (
          <ActionBar
            commands={model.globalCommands}
            selectedCard={selected}
            myChoice={myChoice}
            choiceOpen={choiceOpen}
            canAct={canAct}
            onCommand={send}
            onClearSelection={() => {
              setSelectedId(null);
            }}
            onOpenChoice={() => {
              setHiddenChoiceId(null);
            }}
          />
        )}
      </div>

      <p className="ct-round text-sm leading-none text-ink-muted tabular-nums">
        <span className="sr-only">Round </span>
        <span aria-hidden="true">R</span>
        <span data-testid="table-round">
          {center.round}
          {center.finalRound ? ' (final)' : ''}
        </span>
        <span className="sr-only">, turn </span>
        <span aria-hidden="true"> · T</span>
        {center.turn}
      </p>

      <div className="ct-toasts">
        <ActionAnnouncer announcement={announcement} messageKey={fresh?.actionId ?? null} />
        <LogToast line={log.at(-1) ?? null} />
      </div>

      {notices && <div className="ct-notices">{notices}</div>}

      <div className="ct-log" hidden={!logOpen} data-testid="log-panel">
        <ActionLog lines={log} />
        {onCloseLog && (
          <button
            type="button"
            className="ink-line absolute top-1 right-1 min-h-target min-w-target rounded-md bg-paper-raised px-2 text-sm"
            onClick={onCloseLog}
            data-testid="log-close"
          >
            Close
          </button>
        )}
      </div>
    </div>
  );
}
