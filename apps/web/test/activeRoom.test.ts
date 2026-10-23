import type { RoomAdmission } from '@cartignon/protocol';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/api';
import {
  clearActiveRoom,
  loadActiveRoom,
  resumeActiveRoom,
  saveActiveRoom,
  type RoomStorage,
} from '../src/net/activeRoom';

function memoryStorage(): RoomStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

const admission: RoomAdmission = {
  roomId: 'room-1',
  code: 'ABCDEF',
  ticket: 'ticket-0123456789abcdef',
  ticketExpiresAt: '2026-01-01T00:00:00.000Z',
};

describe('active room record (resume after a page reload)', () => {
  it('stores only the room id, never the ticket', () => {
    const storage = memoryStorage();
    saveActiveRoom(admission, storage);
    expect([...storage.data.values()].join()).not.toContain(admission.ticket);
    expect(loadActiveRoom(storage)).toBe('room-1');
    clearActiveRoom(storage);
    expect(loadActiveRoom(storage)).toBeNull();
  });

  it('drops a corrupt record', () => {
    const storage = memoryStorage();
    storage.setItem('cartignon.activeRoom', '{not json');
    expect(loadActiveRoom(storage)).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it('works without storage and survives a throwing storage', () => {
    const throwing: RoomStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => {
      saveActiveRoom(admission, throwing);
    }).not.toThrow();
    expect(loadActiveRoom(throwing)).toBeNull();
    expect(loadActiveRoom(null)).toBeNull();
  });

  it('resumes with a fresh ticket for the remembered room', async () => {
    const storage = memoryStorage();
    saveActiveRoom(admission, storage);
    const asked: string[] = [];
    const result = await resumeActiveRoom(
      {
        getRoomTicket: (roomId) => {
          asked.push(roomId);
          return Promise.resolve({ ...admission, ticket: 'fresh-ticket-0123456789' });
        },
      },
      storage,
    );
    expect(asked).toEqual(['room-1']);
    expect(result?.ticket).toBe('fresh-ticket-0123456789');
  });

  it('does not call the server when nothing is remembered', async () => {
    const result = await resumeActiveRoom(
      { getRoomTicket: () => Promise.reject(new Error('must not be called')) },
      memoryStorage(),
    );
    expect(result).toBeNull();
  });

  it.each(['ROOM_EXPIRED', 'NOT_FOUND', 'FORBIDDEN'] as const)(
    'forgets the room on %s',
    async (code) => {
      const storage = memoryStorage();
      saveActiveRoom(admission, storage);
      const api = { getRoomTicket: () => Promise.reject(new ApiError(code, 410)) };
      expect(await resumeActiveRoom(api, storage)).toBeNull();
      expect(loadActiveRoom(storage)).toBeNull();
    },
  );

  it('keeps the room on a transient failure', async () => {
    const storage = memoryStorage();
    saveActiveRoom(admission, storage);
    const api = { getRoomTicket: () => Promise.reject(new ApiError('NETWORK', null)) };
    expect(await resumeActiveRoom(api, storage)).toBeNull();
    expect(loadActiveRoom(storage)).toBe('room-1');
  });
});
