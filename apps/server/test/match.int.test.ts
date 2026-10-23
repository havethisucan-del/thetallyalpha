import { randomUUID } from 'node:crypto';
import {
  actionResultMessageSchema,
  errorBodySchema,
  ClientMessage,
  matchViewMessageSchema,
  MAX_WS_MESSAGE_BYTES,
  serverErrorMessageSchema,
  ServerMessage,
  type ActionResultMessage,
  type MatchViewMessage,
  type RoomAdmission,
  type ServerErrorMessage,
  type SessionResponse,
} from '@cartignon/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  closeAll,
  connect,
  newPlayer,
  startTestServer,
  waitFor,
  type Agent,
  type Connection,
  type TestServer,
} from './helpers.js';

let t: TestServer;
const open: Connection[] = [];

beforeAll(async () => {
  // These tests rely on the synthetic counter rules (Cartignon: cartignon.int.test.ts).
  t = await startTestServer({ env: { MATCH_RULES: 'synthetic' } });
});

afterEach(async () => {
  await closeAll(open);
});

afterAll(async () => {
  await t.stop();
});

interface Side {
  readonly agent: Agent;
  readonly me: SessionResponse;
  conn: Connection;
}

interface Table {
  readonly created: RoomAdmission;
  readonly seats: [Side, Side];
}

async function track(promise: Promise<Connection>): Promise<Connection> {
  const connection = await promise;
  open.push(connection);
  return connection;
}

async function lobby(): Promise<Table> {
  const host = await newPlayer(t.url);
  const guest = await newPlayer(t.url);
  const created = await host.agent.createRoom();
  const joined = await guest.agent.joinRoom(created.code ?? '');
  const a = await track(connect(t.url, created));
  const b = await track(connect(t.url, joined));
  await waitFor(() => a.ofType('welcome').length === 1 && b.ofType('welcome').length === 1);
  return {
    created,
    seats: [
      { ...host, conn: a },
      { ...guest, conn: b },
    ],
  };
}

const views = (c: Connection) =>
  c.ofType<MatchViewMessage>(ServerMessage.View).map((v) => matchViewMessageSchema.parse(v));
const results = (c: Connection) =>
  c
    .ofType<ActionResultMessage>(ServerMessage.ActionResult)
    .map((r) => actionResultMessageSchema.parse(r));
const errors = (c: Connection) =>
  c.ofType<ServerErrorMessage>(ServerMessage.Error).map((e) => serverErrorMessageSchema.parse(e));

/** Round trip: every reply to messages sent before this has arrived once it resolves. */
async function barrier(c: Connection): Promise<void> {
  const before = errors(c).length;
  c.room.send('barrier', {});
  await waitFor(() => errors(c).length > before, 'barrier');
}

async function started(): Promise<Table> {
  const table = await lobby();
  for (const side of table.seats) side.conn.room.send(ClientMessage.Ready, { ready: true });
  await waitFor(() => table.seats.every((s) => views(s.conn).length === 1), 'initial views');
  return table;
}

function latest(c: Connection): MatchViewMessage {
  const all = views(c);
  const last = all[all.length - 1];
  if (last === undefined) throw new Error('no view yet');
  return last;
}

function action(amount = 1, actionId: string = randomUUID()) {
  return { actionId, action: { type: 'increment', v: 1, payload: { amount } } };
}

/** The revision of the connection's latest view (0 before the match starts). */
function revisionOf(c: Connection): number {
  const all = views(c);
  return all[all.length - 1]?.revision ?? 0;
}

/** Sends an action acting on the latest view (unless `expectedRevision` is given). */
async function act(
  c: Connection,
  message: ReturnType<typeof action> & { expectedRevision?: number },
): Promise<ActionResultMessage> {
  c.room.send(ClientMessage.Action, { expectedRevision: revisionOf(c), ...message });
  let found: ActionResultMessage | undefined;
  await waitFor(() => {
    found = results(c).find((r) => r.actionId === message.actionId);
    return found !== undefined;
  }, 'action result');
  if (found === undefined) throw new Error('unreachable');
  return found;
}

function activeSide(table: Table): Side {
  const seat = latest(table.seats[0].conn).phase.activeSeat;
  if (seat === null) throw new Error('nobody is active');
  return table.seats[seat];
}

/** Every `secrets` array anywhere in a value. */
function secretsIn(value: unknown, found: unknown[][] = []): unknown[][] {
  if (Array.isArray(value)) value.forEach((v) => secretsIn(v, found));
  else if (typeof value === 'object' && value !== null) {
    for (const [key, v] of Object.entries(value)) {
      if (key === 'secrets' && Array.isArray(v)) found.push(v as unknown[]);
      else secretsIn(v, found);
    }
  }
  return found;
}

describe('match start', () => {
  it('concurrent and repeated Ready starts the match exactly once', async () => {
    const table = await lobby();
    const [a, b] = table.seats.map((s) => s.conn) as [Connection, Connection];
    for (let i = 0; i < 5; i++) {
      a.room.send(ClientMessage.Ready, { ready: true });
      b.room.send(ClientMessage.Ready, { ready: true });
    }
    await waitFor(() => views(a).length >= 1 && views(b).length >= 1, 'views');
    await barrier(a);
    await barrier(b);
    expect(views(a)).toHaveLength(1);
    expect(views(b)).toHaveLength(1);
    const [va, vb] = [latest(a), latest(b)];
    expect(va.seat).toBe(0);
    expect(vb.seat).toBe(1);
    expect(va.revision).toBe(0);
    expect(vb.revision).toBe(0);
    expect(va.matchId).toBe(vb.matchId);
    expect(va.rulesVersion).toBe('1');
    expect(va.outcome).toBeNull();
    // Ready messages processed after the start are ignored silently: the only errors are
    // the two barrier replies.
    expect([...errors(a), ...errors(b)].map((e) => e.code)).toEqual(['BAD_REQUEST', 'BAD_REQUEST']);
    await waitFor(() => a.state()['phase'] === 'active' && b.state()['phase'] === 'active');
    expect(t.server.registry.get(table.created.roomId)?.phase).toBe('active');
  });

  it('a match does not start until both seats are ready and leaving resets ready', async () => {
    const table = await lobby();
    const [a, b] = table.seats.map((s) => s.conn) as [Connection, Connection];
    a.room.send(ClientMessage.Ready, { ready: true });
    await waitFor(() => {
      const players = b.state()['players'] as Record<string, { ready: boolean }>;
      return players['0']?.ready === true;
    }, 'seat 0 ready');
    await barrier(a);
    expect(views(a)).toHaveLength(0);

    await a.room.leave();
    await waitFor(() => {
      const players = b.state()['players'] as Record<
        string,
        { ready: boolean; connected: boolean }
      >;
      return players['0']?.connected === false && !players['0'].ready;
    }, 'seat 0 reset');
    b.room.send(ClientMessage.Ready, { ready: true });
    await barrier(b);
    expect(views(b)).toHaveLength(0);
    expect(b.state()['phase']).toBe('lobby');
  });
});

describe('match play', () => {
  it('each client receives only its own private data through a full match', async () => {
    const table = await started();
    let revision = 0;
    while (latest(table.seats[0].conn).outcome === null) {
      const side = activeSide(table);
      const result = await act(side.conn, action(1));
      expect(result).toMatchObject({ status: 'accepted', revision: revision + 1 });
      revision += 1;
      await waitFor(
        () => table.seats.every((s) => latest(s.conn).revision === revision),
        'views at new revision',
      );
    }
    expect(revision).toBe(10); // target 10, +1 per action

    for (const [index, side] of table.seats.entries()) {
      const mine = views(side.conn);
      expect(mine.every((v) => v.seat === index)).toBe(true);
      expect(mine.every((v) => (v.private as { seat: number }).seat === index)).toBe(true);
      const finalSecrets = (latest(side.conn).private as { secrets: number[] }).secrets;
      expect(finalSecrets.length).toBe(5);

      // Every secrets array this client ever received is a prefix of its own secrets.
      const transcript = [...side.conn.received.map((r) => r.message), side.conn.state()];
      for (const secrets of secretsIn(transcript)) {
        expect(finalSecrets.slice(0, secrets.length)).toEqual(secrets);
      }
      const text = JSON.stringify(transcript);
      const opponent = table.seats[index === 0 ? 1 : 0];
      const opponentSecrets = (latest(opponent.conn).private as { secrets: number[] }).secrets;
      expect(text).not.toContain(JSON.stringify(opponentSecrets));
      for (const s of table.seats) expect(text).not.toContain(s.me.player.playerId);
      expect(JSON.stringify(side.conn.state())).not.toContain('secrets');
    }

    const outcome = latest(table.seats[0].conn).outcome;
    expect(outcome).toMatchObject({ result: 'winner', reason: 'target-reached' });
    await waitFor(() => table.seats[0].conn.state()['phase'] === 'finished', 'finished phase');
    expect(await act(table.seats[0].conn, action(1))).toMatchObject({
      status: 'rejected',
      code: 'MATCH_FINISHED',
    });
  });

  it('a duplicate actionId executes once and reports the original revision', async () => {
    const table = await started();
    const side = activeSide(table);
    const other = table.seats[0] === side ? table.seats[1] : table.seats[0];
    const message = action(2);
    expect(await act(side.conn, message)).toMatchObject({ status: 'accepted', revision: 1 });
    await waitFor(() => views(other.conn).length === 2, 'opponent view');

    // The id check runs before the revision check: a retry with its original (now stale)
    // revision is still reported as a duplicate.
    const before = results(side.conn).length;
    side.conn.room.send(ClientMessage.Action, { ...message, expectedRevision: 0 });
    side.conn.room.send(ClientMessage.Action, { ...message, expectedRevision: 0 });
    await waitFor(() => results(side.conn).length === before + 2, 'duplicate results');
    for (const r of results(side.conn).slice(before)) {
      expect(r).toEqual({ status: 'duplicate', actionId: message.actionId, revision: 1 });
    }
    await barrier(other.conn);
    await barrier(side.conn);
    expect(views(other.conn)).toHaveLength(2);
    expect(views(side.conn)).toHaveLength(2);
    expect(latest(side.conn).revision).toBe(1);
    expect((latest(side.conn).public as { counter: number }).counter).toBe(2);
  });

  it('an action before the start is MATCH_NOT_STARTED', async () => {
    const table = await lobby();
    expect(await act(table.seats[0].conn, action(1))).toMatchObject({
      status: 'rejected',
      code: 'MATCH_NOT_STARTED',
    });
    expect(table.seats[0].conn.state()['phase']).toBe('lobby');
  });

  it('reusing the other seat’s actionId is DUPLICATE_ACTION_ID and runs nothing', async () => {
    const table = await started();
    const side = activeSide(table);
    const other = table.seats[0] === side ? table.seats[1] : table.seats[0];
    const message = action(1);
    expect(await act(side.conn, message)).toMatchObject({ status: 'accepted', revision: 1 });
    // It is now the other seat's turn, so only the id check can refuse this.
    expect(await act(other.conn, message)).toMatchObject({
      status: 'rejected',
      code: 'DUPLICATE_ACTION_ID',
    });
    await barrier(side.conn);
    expect(latest(side.conn).revision).toBe(1);
    expect(latest(other.conn).revision).toBe(1);
  });

  it('rule rejections: not your turn, malformed payload, unsupported version', async () => {
    const table = await started();
    const side = activeSide(table);
    const other = table.seats[0] === side ? table.seats[1] : table.seats[0];
    expect(await act(other.conn, action(1))).toMatchObject({
      status: 'rejected',
      code: 'NOT_YOUR_TURN',
    });
    expect(await act(side.conn, action(9))).toMatchObject({
      status: 'rejected',
      code: 'MALFORMED',
    });
    const v2 = {
      actionId: randomUUID(),
      action: { type: 'increment', v: 2, payload: { amount: 1 } },
    };
    expect(await act(side.conn, v2)).toMatchObject({
      status: 'rejected',
      code: 'UNSUPPORTED_VERSION',
    });
    expect(await act(side.conn, { ...action(1), expectedRevision: 1 })).toMatchObject({
      status: 'rejected',
      code: 'STALE_REVISION',
    });
    expect(latest(side.conn).revision).toBe(0);
  });

  it('an action on an old view is STALE_REVISION and changes nothing', async () => {
    const table = await started();
    const side = activeSide(table);
    expect(await act(side.conn, action(1))).toMatchObject({ status: 'accepted', revision: 1 });
    const next = activeSide(table);
    await waitFor(() => latest(next.conn).revision === 1, 'view at revision 1');
    expect(await act(next.conn, { ...action(1), expectedRevision: 0 })).toMatchObject({
      status: 'rejected',
      code: 'STALE_REVISION',
    });
    await barrier(next.conn);
    expect(latest(next.conn).revision).toBe(1);
    expect(latest(next.conn).events).toEqual([]);
  });
});

describe('robustness', () => {
  it('malformed and oversized messages are rejected and the room survives', async () => {
    const table = await started();
    const side = activeSide(table);
    const other = table.seats[0] === side ? table.seats[1] : table.seats[0];
    const c = side.conn;
    const before = errors(c).length;
    c.room.send(ClientMessage.Action, { actionId: 'not-a-uuid', action: {} });
    c.room.send(ClientMessage.Action, 'garbage');
    c.room.send(ClientMessage.Ready, { ready: 'yes' });
    c.room.send('unknown:type', { x: 1 });
    await waitFor(() => errors(c).length === before + 4, 'error replies');
    expect(
      errors(c)
        .slice(before)
        .every((e) => e.code !== 'INTERNAL'),
    ).toBe(true);
    expect(
      errors(c)
        .slice(before, before + 2)
        .map((e) => e.code),
    ).toEqual(['BAD_REQUEST', 'BAD_REQUEST']);
    expect(c.room.connection.isOpen).toBe(true);

    // Over the transport cap: the socket is closed, nothing else is affected.
    const closed = new Promise<number>((resolve) => {
      other.conn.room.onLeave((code: number) => {
        resolve(code);
      });
    });
    other.conn.room.send(ClientMessage.Action, { blob: 'x'.repeat(MAX_WS_MESSAGE_BYTES + 1) });
    expect(await closed).toBe(1009);
    await waitFor(() => {
      const players = c.state()['players'] as Record<string, { connected: boolean }>;
      return Object.values(players).filter((p) => p.connected).length === 1;
    }, 'offender disconnected');

    expect(await act(c, action(1))).toMatchObject({ status: 'accepted', revision: 1 });
  });

  it('rejoin with a new ticket keeps the seat and delivers the current view', async () => {
    const table = await started();
    const first = activeSide(table);
    expect(await act(first.conn, action(1))).toMatchObject({ status: 'accepted', revision: 1 });
    const second = activeSide(table);
    expect(second).not.toBe(first);
    expect(await act(second.conn, action(1))).toMatchObject({ status: 'accepted', revision: 2 });

    const leaver = table.seats[1];
    const stayer = table.seats[0];
    await leaver.conn.room.leave();
    await waitFor(() => {
      const players = stayer.conn.state()['players'] as Record<string, { connected: boolean }>;
      return players['1']?.connected === false;
    }, 'leaver shown as disconnected');
    expect(stayer.conn.state()['phase']).toBe('active');

    const admission = await leaver.agent.ticket(table.created.roomId);
    expect(admission.code).toBe(table.created.code);
    const back = await track(connect(t.url, admission));
    await waitFor(() => back.ofType('welcome').length === 1 && views(back).length === 1, 'rejoin');
    expect(back.ofType(ServerMessage.Welcome)).toEqual([{ seat: 1 }]);
    const view = latest(back);
    expect(view.seat).toBe(1);
    expect(view.revision).toBe(2);
    expect(view.matchId).toBe(latest(stayer.conn).matchId);
    expect(view.private).toEqual(latest(leaver.conn).private);
    await waitFor(() => {
      const players = stayer.conn.state()['players'] as Record<string, { connected: boolean }>;
      return players['1']?.connected === true;
    }, 'leaver shown as connected again');

    // Joining by code after the start still works for a seated player.
    const byCode = await leaver.agent.joinRoom(table.created.code ?? '');
    expect(byCode.roomId).toBe(table.created.roomId);
    // ...while anyone else is told the room is no longer joinable.
    const outsider = await newPlayer(t.url);
    const late = await outsider.agent.post('/api/rooms/private/join', { code: table.created.code });
    expect(late.status).toBe(410);
  });
});

// Must stay last in this file: it shuts the server down (afterAll's stop() is idempotent).
describe('graceful shutdown', () => {
  it('drains (503 UNAVAILABLE), then disconnects clients with SERVER_SHUTDOWN and closes', async () => {
    const table = await started();
    const codes = table.seats.map(
      (s) =>
        new Promise<number>((resolve) => {
          s.conn.room.onLeave((code: number) => {
            resolve(code);
          });
        }),
    );
    const outsider = await newPlayer(t.url);
    const [host] = table.seats;
    const stopping = Promise.all([t.server.shutdown({ drainMs: 1_000 }), t.server.shutdown()]);

    // During the drain window the server still answers, but admits nobody new.
    const ready = await host.agent.get('/readyz');
    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({ status: 'unavailable' });
    const refusals = await Promise.all([
      outsider.agent.post('/api/rooms/private'),
      outsider.agent.post('/api/rooms/private/join', { code: table.created.code }),
      host.agent.post('/api/rooms/ticket', { roomId: table.created.roomId }),
    ]);
    for (const res of refusals) {
      expect(res.status).toBe(503);
      expect(errorBodySchema.parse(res.body).error.code).toBe('UNAVAILABLE');
    }

    await stopping;
    expect(await Promise.all(codes)).toEqual([4001, 4001]); // Colyseus CloseCode.SERVER_SHUTDOWN
    expect(t.server.registry.liveRoomCount).toBe(0);
    await expect(fetch(`${t.url}/healthz`)).rejects.toThrow();
  });
});
