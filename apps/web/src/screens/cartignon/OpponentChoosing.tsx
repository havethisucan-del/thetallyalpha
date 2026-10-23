import { opponentChoosingText } from '../../match/cartignon/labels';
import type { OpponentChoice } from '../../match/cartignon/tableModel';

/**
 * Read-only indicator while the opponent answers a pending choice (R8c, RD-142): what they are
 * choosing and how many, with the option count only when the view carries it (never for
 * `handCreature`). No controls; the turn banner already announces "Opponent is choosing".
 */
export function OpponentChoosing({ choice }: { choice: OpponentChoice }) {
  return (
    <p
      className="ink-line rounded-md border-dashed px-3 py-2 text-sm text-ink"
      data-testid="opponent-choosing"
      data-kind={choice.kind}
    >
      {opponentChoosingText(choice)}
    </p>
  );
}
