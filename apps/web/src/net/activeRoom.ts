import type { RoomAdmission } from '@cartignon/protocol';
import { ApiError, type ApiClient } from '../lib/api';

/**
 * Remembers the room this tab is in, so a page reload (F5, a mobile browser discarding and
 * restoring the tab, devtools device emulation, a dev-server full reload) resumes the match
 * instead of dropping the player on the home screen. The server keeps the seat across a drop and
 * hands out a fresh ticket for it, so only the room id is stored — never a ticket.
 *
 * Per tab (sessionStorage): another tab of the same guest does not take over this seat.
 */
const STORAGE_KEY = 'cartignon.activeRoom';

/** The subset of `Storage` used here (lets tests supply a fake). */
export type RoomStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): RoomStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null; // blocked storage (privacy settings) throws on access
  }
}

export function saveActiveRoom(
  admission: Pick<RoomAdmission, 'roomId'>,
  storage: RoomStorage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({ roomId: admission.roomId }));
  } catch {
    // Best effort: without storage a reload simply returns to the home screen.
  }
}

export function clearActiveRoom(storage: RoomStorage | null = defaultStorage()): void {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // ignored, see saveActiveRoom
  }
}

export function loadActiveRoom(storage: RoomStorage | null = defaultStorage()): string | null {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const roomId = (parsed as { roomId?: unknown } | null)?.roomId;
    if (typeof roomId === 'string' && roomId.length > 0 && roomId.length <= 64) return roomId;
  } catch {
    // corrupt value: fall through and drop it
  }
  clearActiveRoom(storage);
  return null;
}

/**
 * Asks for a fresh ticket to the remembered room. Resolves null when there is nothing to resume
 * or the room can no longer be entered (expired, gone, no seat): the record is then dropped.
 * Transient failures (network, rate limit) keep the record so a later reload can try again.
 */
export async function resumeActiveRoom(
  api: Pick<ApiClient, 'getRoomTicket'>,
  storage: RoomStorage | null = defaultStorage(),
): Promise<RoomAdmission | null> {
  const roomId = loadActiveRoom(storage);
  if (roomId === null) return null;
  try {
    return await api.getRoomTicket(roomId);
  } catch (error) {
    const transient =
      error instanceof ApiError &&
      (error.code === 'NETWORK' || error.code === 'RATE_LIMITED' || error.code === 'UNAVAILABLE');
    if (!transient) clearActiveRoom(storage);
    return null;
  }
}
