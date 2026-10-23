import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { clipboardWriter, randomUuid } from '../src/lib/secureContext';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A crypto without randomUUID, like a browser page served over plain http on a LAN address. */
const insecureCrypto = {
  getRandomValues: <T extends ArrayBufferView | null>(array: T): T =>
    webcrypto.getRandomValues(array as Uint8Array) as unknown as T,
};

describe('randomUuid', () => {
  it('uses crypto.randomUUID when it exists', () => {
    const randomUUID = vi.fn(() => '00000000-0000-4000-8000-000000000000');
    expect(randomUuid({ ...insecureCrypto, randomUUID })).toBe(
      '00000000-0000-4000-8000-000000000000',
    );
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it('falls back to getRandomValues and returns distinct version 4 UUIDs', () => {
    const ids = new Set(Array.from({ length: 200 }, () => randomUuid(insecureCrypto)));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });

  it('sets the version and variant bits on all-ones and all-zero input', () => {
    const fill = (value: number) => ({
      getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
        (array as unknown as Uint8Array).fill(value);
        return array;
      },
    });
    expect(randomUuid(fill(0xff))).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(randomUuid(fill(0x00))).toBe('00000000-0000-4000-8000-000000000000');
  });
});

describe('clipboardWriter', () => {
  it('returns null when navigator or navigator.clipboard is missing', () => {
    expect(clipboardWriter(null)).toBeNull();
    expect(clipboardWriter({})).toBeNull();
    expect(clipboardWriter({ clipboard: undefined })).toBeNull();
  });

  it('writes through navigator.clipboard when present', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const write = clipboardWriter({ clipboard: { writeText } });
    expect(write).not.toBeNull();
    await write?.('ABC123');
    expect(writeText).toHaveBeenCalledWith('ABC123');
  });

  it('passes a rejected write through to the caller', async () => {
    const write = clipboardWriter({
      clipboard: { writeText: () => Promise.reject(new Error('denied')) },
    });
    await expect(write?.('ABC123')).rejects.toThrow('denied');
  });
});
