import type { ActionResultMessage, CartignonCommand } from '@cartignon/protocol';
import { useMemo, useState, type ReactNode } from 'react';
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
import { HandRow } from './HandRow';
import { OpponentChoosing } from './OpponentChoosing';
import { SeatBar, type AtkStanding } from './SeatBar';
import { SeatStack } from './Stacks';
import { TurnBanner } from './TurnBanner';

export type TablePalette = 'normal' | 'colorblind';

/** Display-only comparison of two shown ATK totals (the seat bars' "Leads" / "Tied" chip). */
function atkStanding(own: number, other: number): AtkStanding {
  if (own > other) return 'ahead';
  return own === other ? 'tied' : 'behind';
}

/** What this table sent last, and the result that was current when it was sent. */
interface SentAction {
  description: string;
  resultBefore: ActionResultMessage | null;
}

/**
 * Cartignon match table (R8b layout, R8c interactions; ADR-0011): portrait, mobile-first DOM
 * layout over a `TableModel`. It fills the height its parent gives it: the region with the
 * opponent bar, opponent stack + traps, center strip and own bar + stack scrolls internally; below
 * it a fixed dock keeps the result announcer, turn banner + clock, then either the choice sheet or
 * the hand row and action bar (thumb zone).
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
}: {
  model: TableModel;
  canAct: boolean;
  onCommand: (command: CartignonCommand) => void;
  /** The latest result of this seat's actions (`match:result`), for the live regions. */
  lastResult?: ActionResultMessage | null;
  /** Errors / outcome shown at the top of the scrolling area. */
  notices?: ReactNode;
  palette?: TablePalette;
  /** Narrated events (`narrateEvents`), oldest first; shown newest first below the own stack. */
  log?: readonly NarrationLine[];
  /** The rolling event log (oldest first); drives the modifier glow on stack cards. */
  eventLog?: readonly EventLogEntry[];
  /** Name shown on the opponent's seat bar (e.g. `Bot · L3 Skilled`). */
  opponentLabel?: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hiddenChoiceId, setHiddenChoiceId] = useState<number | null>(null);
  // A result that was already current when the table mounted (or before the last send) is not
  // announced again.
  const [sent, setSent] = useState<SentAction>(() => ({
    description: '',
    resultBefore: lastResult,
  }));

  const tokens = model.center.tokens;
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
      className="mx-auto flex min-h-0 w-full max-w-lg flex-1 flex-col md:max-w-2xl"
      data-palette={palette}
      data-testid="cartignon-table"
    >
      <div
        // scroll-padding-bottom keeps scrollIntoView (tutorial targets, focus) clear of the pinned
        // own seat below; both only apply on screens tall enough to pin it.
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain pb-2 [@media(min-height:640px)]:scroll-pb-56"
        data-testid="table-scroll"
      >
        {notices}
        <SeatBar
          area={model.opponent}
          name={opponentLabel}
          tokens={tokenCount(tokens, 'theirs')}
          onTurn={model.onTurn === 'theirs'}
          standing={atkStanding(model.opponent.atk, model.me.atk)}
        />
        <SeatStack area={model.opponent} glows={glows} />
        <CenterStrip center={model.center} />
        {/* The own seat bar + stack stick to the bottom of the scroll region (just above the
            dock) whenever their place is further down, so the own stack is always in full view;
            the center strip scrolls behind them. Not on short screens, where they would leave
            no room for the rest. */}
        <div
          className="flex flex-col gap-2 bg-paper pt-1 [@media(min-height:640px)]:sticky [@media(min-height:640px)]:bottom-0 [@media(min-height:640px)]:z-10"
          data-testid="mine-seat"
        >
          <SeatBar
            area={model.me}
            tokens={tokenCount(tokens, 'mine')}
            onTurn={model.onTurn === 'mine'}
            standing={atkStanding(model.me.atk, model.opponent.atk)}
          />
          <SeatStack area={model.me} glows={glows} />
        </div>
        {/* Below the own stack, so both stacks and the center stay on the first screen. */}
        <ActionLog lines={log} />
      </div>
      <div
        className="ink-line-t flex flex-none flex-col gap-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
        data-testid="table-dock"
      >
        <ActionAnnouncer announcement={announcement} messageKey={fresh?.actionId ?? null} />
        <TurnBanner text={turnBannerText(model)} myAction={model.myAction} clock={model.clock} />
        {model.opponentChoosing && <OpponentChoosing choice={model.opponentChoosing} />}
        {myChoice && (
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
        )}
        {!choiceOpen && (
          <>
            <HandRow
              hand={model.hand}
              selectedId={selected?.cardId ?? null}
              onTap={(cardId) => {
                setSelectedId((current) => tapHandCard(current, cardId));
              }}
            />
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
          </>
        )}
      </div>
    </div>
  );
}
