import { describe, expect, it } from 'vitest';
import { isValidInviteCode, normalizeInviteCodeInput } from '../src/lib/inviteCode';
import { readRoomState } from '../src/lib/roomState';
import { parseSyntheticPrivate, parseSyntheticPublic } from '../src/lib/synthetic';
import { rejoinDelayMs, shouldAcceptView } from '../src/lib/views';

const matchId = '0b6f6f5e-6a4c-4c1e-9f0a-2d6a4a3c1b2e';
const otherMatch = '1c7a7a6f-7b5d-4d2f-8a1b-3e7b5b4d2c3f';

describe('view revision ordering', () => {
  it('accepts the first view and newer or equal revisions', () => {
    expect(shouldAcceptView(null, { matchId, revision: 0 })).toBe(true);
    expect(shouldAcceptView({ matchId, revision: 3 }, { matchId, revision: 4 })).toBe(true);
    expect(shouldAcceptView({ matchId, revision: 3 }, { matchId, revision: 3 })).toBe(true);
  });

  it('drops stale revisions of the same match', () => {
    expect(shouldAcceptView({ matchId, revision: 5 }, { matchId, revision: 4 })).toBe(false);
  });

  it('accepts any revision of a different match', () => {
    expect(shouldAcceptView({ matchId, revision: 5 }, { matchId: otherMatch, revision: 0 })).toBe(
      true,
    );
  });
});

describe('rejoin backoff', () => {
  it('doubles and is capped', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => rejoinDelayMs(n))).toEqual([
      500, 1000, 2000, 4000, 8000, 8000,
    ]);
  });
});

describe('invite code input', () => {
  it('uppercases, strips whitespace and caps the length', () => {
    expect(normalizeInviteCodeInput(' abc 234x')).toBe('ABC234');
  });

  it('validates with the protocol schema', () => {
    expect(isValidInviteCode('ABC234')).toBe(true);
    expect(isValidInviteCode('ABC23')).toBe(false);
    expect(isValidInviteCode('ABC230')).toBe(false); // 0 is not in the alphabet
  });
});

describe('synthetic view narrowing', () => {
  const pub = { phase: 'play', activeSeat: 0, counter: 3, target: 10, secretCounts: [2, 1] };

  it('accepts well-formed parts', () => {
    expect(parseSyntheticPublic(pub)).toEqual(pub);
    expect(parseSyntheticPublic({ ...pub, activeSeat: null })?.activeSeat).toBeNull();
    expect(parseSyntheticPrivate({ seat: 1, secrets: [4, 7] })).toEqual({
      seat: 1,
      secrets: [4, 7],
    });
  });

  it('rejects malformed parts', () => {
    expect(parseSyntheticPublic(null)).toBeNull();
    expect(parseSyntheticPublic({ ...pub, activeSeat: 2 })).toBeNull();
    expect(parseSyntheticPublic({ ...pub, counter: '3' })).toBeNull();
    expect(parseSyntheticPublic({ ...pub, secretCounts: [1] })).toBeNull();
    expect(parseSyntheticPublic({ ...pub, secretCounts: [1, -1] })).toBeNull();
    expect(parseSyntheticPrivate({ seat: 0, secrets: [1.5] })).toBeNull();
    expect(parseSyntheticPrivate({ seat: 0 })).toBeNull();
  });
});

describe('room state snapshot', () => {
  const seat = { displayName: 'Ana', ready: true, connected: true };

  it('copies a map-backed state into a plain snapshot', () => {
    const players = new Map([['0', seat]]);
    const snapshot = readRoomState({ phase: 'lobby', code: 'ABC234', players });
    expect(snapshot).toEqual({ phase: 'lobby', code: 'ABC234', seats: [seat, null] });
    expect(snapshot?.seats[0]).not.toBe(seat);
  });

  it('rejects states that do not match the contract', () => {
    expect(readRoomState(undefined)).toBeNull();
    expect(readRoomState({ phase: 'weird', code: 'X', players: new Map() })).toBeNull();
    expect(
      readRoomState({ phase: 'lobby', code: 'X', players: new Map([['1', { displayName: 1 }]]) }),
    ).toBeNull();
  });
});
