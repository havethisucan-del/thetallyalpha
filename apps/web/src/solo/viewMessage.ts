import {
  eventsFor,
  viewFor,
  type AnyRulesModule,
  type Seat,
  type Snapshot,
} from '@cartignon/game-core';
import type { MatchViewMessage } from '@cartignon/protocol';

/**
 * ADR-0017: the `match:view` message one seat would receive from the server for `snapshot`,
 * built locally for solo play. Mirrors the server's `sendView` (apps/server match-room.ts): only
 * the rules' projections for `seat`, `rawEvents` redacted with `eventsFor` (`undefined` = a
 * start view with `events: []`), and no clock (solo play has none). A unit test checks the result
 * against `matchViewMessageSchema`, so a protocol change cannot drift past it unnoticed.
 */
export function buildSeatViewMessage(
  rules: AnyRulesModule,
  snapshot: Snapshot,
  seat: Seat,
  matchId: string,
  rawEvents: readonly unknown[] | undefined,
): MatchViewMessage {
  const view = viewFor(rules, snapshot, seat);
  return {
    matchId,
    seat,
    revision: view.revision,
    rulesId: view.rulesId,
    rulesVersion: view.rulesVersion,
    phase: {
      id: view.phase.id,
      activeSeat: view.phase.activeSeat,
      turnSeat: view.phase.turnSeat,
    },
    public: view.public,
    private: view.private,
    events: rawEvents === undefined ? [] : [...eventsFor(rules, rawEvents, seat)],
    outcome: view.outcome,
    clock: null,
    cause: 'action',
  };
}
