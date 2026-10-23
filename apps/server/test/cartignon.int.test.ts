import { randomUUID } from 'node:crypto';
import { toCartignonAction, type RoundCommand } from '@cartignon/game-core';
import {
  actionResultMessageSchema,
  cartignonPrivateViewSchema,
  cartignonPublicViewSchema,
  cartignonSeatEventsSchema,
  ClientMessage,
  matchViewMessageSchema,
  ServerMessage,
  type ActionResultMessage,
  type CartignonPrivateView,
  type MatchViewMessage,
} from '@cartignon/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  closeAll,
  connect,
  newPlayer,
  startTestServer,
  waitFor,
  type Connection,
  type TestServer,
} from './helpers.js';

let t: TestServer;
const open: Connection[] = [];

beforeAll(async () => {
  t = await startTestServer({ env: { MATCH_RULES: 'cartignon' } });
});

afterEach(async () => {
  await closeAll(open);
});

afterAll(async () => {
  await t.stop();
});

/** A connection plus every raw WebSocket frame it received after joining. */
interface Wire {
  readonly conn: Connection;
  readonly frames: Buffer[];
}

async function join(admission: Parameters<typeof connect>[1]): Promise<Wire> {
  const conn = await connect(t.url, admission);
  open.push(conn);
  const frames: Buffer[] = [];
  const events = conn.room.connection.events;
  const original = events.onmessage;
  events.onmessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (data instanceof ArrayBuffer) frames.push(Buffer.from(data));
    else if (typeof data === 'string') frames.push(Buffer.from(data, 'utf8'));
    original?.(event);
  };
  return { conn, frames };
}

const views = (c: Connection): MatchViewMessage[] =>
  c.ofType<MatchViewMessage>(ServerMessage.View).map((v) => matchViewMessageSchema.parse(v));

function latest(c: Connection): MatchViewMessage {
  const all = views(c);
  const last = all[all.length - 1];
  if (last === undefined) throw new Error('no view yet');
  return last;
}

const privateOf = (view: MatchViewMessage): CartignonPrivateView =>
  cartignonPrivateViewSchema.parse(view.private);

/** Every view parses with the strict Cartignon schemas (envelope, public, private, events). */
function expectStrictViews(c: Connection): void {
  for (const view of views(c)) {
    expect(view.rulesId).toBe('cartignon');
    cartignonPublicViewSchema.parse(view.public);
    expect(privateOf(view).seat).toBe(view.seat);
    cartignonSeatEventsSchema.parse(view.events);
  }
}

async function act(
  c: Connection,
  action: unknown,
  expectedRevision: number,
): Promise<ActionResultMessage> {
  const actionId = randomUUID();
  c.room.send(ClientMessage.Action, { actionId, expectedRevision, action });
  let found: ActionResultMessage | undefined;
  await waitFor(() => {
    found = c
      .ofType<ActionResultMessage>(ServerMessage.ActionResult)
      .map((r) => actionResultMessageSchema.parse(r))
      .find((r) => r.actionId === actionId);
    return found !== undefined;
  }, 'action result');
  if (found === undefined) throw new Error('unreachable');
  return found;
}

/** Occurrences of `needle` in `haystack` (raw bytes). */
function count(haystack: Buffer, needle: Buffer): number {
  let n = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) n++;
  return n;
}

describe('cartignon match', () => {
  it('strict per-seat views, hidden hands, stale/turn/illegal rejections and events', async () => {
    const host = await newPlayer(t.url);
    const guest = await newPlayer(t.url);
    const created = await host.agent.createRoom();
    const joined = await guest.agent.joinRoom(created.code ?? '');
    const wires: [Wire, Wire] = [await join(created), await join(joined)];
    const [a, b] = wires.map((w) => w.conn) as [Connection, Connection];
    await waitFor(() => a.ofType('welcome').length === 1 && b.ofType('welcome').length === 1);
    for (const c of [a, b]) c.room.send(ClientMessage.Ready, { ready: true });
    await waitFor(() => views(a).length === 1 && views(b).length === 1, 'initial views');

    for (const [seat, c] of [a, b].entries()) {
      const view = latest(c);
      expect(view.seat).toBe(seat);
      expect(view.revision).toBe(0);
      expect(view.rulesVersion).toMatch(/^2\+cards\./);
      expect(view.events).toEqual([]);
    }
    expectStrictViews(a);
    expectStrictViews(b);

    const actingSeat = latest(a).phase.activeSeat;
    if (actingSeat === null) throw new Error('nobody is active at the start');
    const acting = actingSeat === 0 ? a : b;
    const waiting = actingSeat === 0 ? b : a;
    const actingPrivate = privateOf(latest(acting));
    const waitingPrivate = privateOf(latest(waiting));
    expect(actingPrivate.legal.length).toBeGreaterThan(0);
    expect(waitingPrivate.legal).toEqual([]);
    const legal = actingPrivate.legal[0] as RoundCommand;
    const legalAction = toCartignonAction(legal);

    // Stale: acting on a revision the client has not seen.
    expect(await act(acting, legalAction, 1)).toMatchObject({
      status: 'rejected',
      code: 'STALE_REVISION',
    });
    // Out of turn.
    expect(await act(waiting, { type: 'endTurn', v: 1, payload: {} }, 0)).toMatchObject({
      status: 'rejected',
      code: 'NOT_YOUR_TURN',
    });
    // Illegal: a card in neither hand (the rejection message names it, so it must not be one
    // of the hidden cards checked below).
    const inHands = new Set([...actingPrivate.hand, ...waitingPrivate.hand]);
    const cardDefs = cartignonPublicViewSchema.parse(latest(acting).public).cardDefs;
    const foreignCard = Object.keys(cardDefs).find((id) => !inHands.has(id));
    if (foreignCard === undefined) throw new Error('every card is in a hand');
    const illegal = await act(
      acting,
      { type: 'playCreature', v: 1, payload: { cardId: foreignCard } },
      0,
    );
    expect(illegal).toMatchObject({ status: 'rejected', code: 'ILLEGAL' });
    expect(illegal.status === 'rejected' ? illegal.reason : undefined).toMatch(/^[A-Z_]+$/);
    expect(latest(acting).revision).toBe(0);

    // One legal command is accepted and both seats get the new view with their events.
    expect(await act(acting, legalAction, 0)).toMatchObject({ status: 'accepted', revision: 1 });
    await waitFor(() => latest(a).revision === 1 && latest(b).revision === 1, 'revision 1');
    expectStrictViews(a);
    expectStrictViews(b);
    expect(latest(a).events.length).toBeGreaterThan(0);
    expect(latest(b).events.length).toBeGreaterThan(0);

    // Hidden information: cards that stayed in A's hand in every view A received never reach
    // B. Card ids are public catalog identifiers (`public.cardDefs` lists all 54), so each view
    // legitimately carries each id exactly once, as a `cardDefs` key.
    const handsOfA = views(a).map((v) => privateOf(v).hand);
    const hidden = (handsOfA[0] ?? []).filter((id) => handsOfA.every((hand) => hand.includes(id)));
    expect(hidden.length).toBeGreaterThan(0);
    const framesOfB = wires[1].frames;
    expect(framesOfB.length).toBeGreaterThan(0);
    const viewsOfB = views(b).length;
    // Everything B decoded (all message types and the synchronized state), minus cardDefs keys.
    const decodedOfB = JSON.stringify(
      [...b.received.map((r) => r.message), b.state()],
      (key, value: unknown) => (key === 'cardDefs' ? null : value),
    );
    for (const id of hidden) {
      // Raw: msgpack encodes a 3-character string as 0xa3 + its bytes, so this counts the id as
      // a whole string value or key in every frame B received (not UUID substrings).
      const token = Buffer.concat([Buffer.from([0xa3]), Buffer.from(id, 'utf8')]);
      const rawHits = framesOfB.reduce((sum, frame) => sum + count(frame, token), 0);
      expect(rawHits, `card ${id} in B's raw frames`).toBe(viewsOfB);
      // Decoded: not even inside longer text (word boundary, so UUIDs do not match).
      expect(decodedOfB, `card ${id} in B's messages`).not.toMatch(
        new RegExp(String.raw`\b${id}\b`),
      );
      // Positive control: the same scan does find the card in A's own frames (its hand).
      const ownHits = wires[0].frames.reduce((sum, frame) => sum + count(frame, token), 0);
      expect(ownHits).toBeGreaterThan(views(a).length);
    }
  });
});
