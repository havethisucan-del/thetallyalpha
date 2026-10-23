import { schema, t, type SchemaType } from '@colyseus/schema';

/**
 * Synchronized room state. Field names mirror `PublicRoomState` / `PublicSeatState` from
 * @cartignon/protocol exactly. Display data only: no identities, no hidden game data.
 */
export const PlayerState = schema(
  {
    displayName: t.string(),
    ready: t.boolean(),
    connected: t.boolean(),
  },
  'PlayerState',
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const MatchRoomState = schema(
  {
    phase: t.string(),
    code: t.string(),
    /** Keyed by seat as a string: '0' | '1'. */
    players: t.map(PlayerState),
  },
  'MatchRoomState',
);
export type MatchRoomState = SchemaType<typeof MatchRoomState>;
