import { describe, expect, it } from 'vitest';
import {
  markTutorial,
  readTutorialProgress,
  resetTutorial,
  shouldAutoStartTutorial,
  TUTORIAL_STORAGE_KEY,
  type ProgressStorage,
} from '../src/tutorial/progress';

/** ADR-0018 decision 6: `cartignon.tutorial` = {"v":1,"status":...}, every access guarded. */

class MemoryStorage implements ProgressStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

const throwing: ProgressStorage = {
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('QuotaExceededError');
  },
  removeItem() {
    throw new Error('SecurityError');
  },
};

describe('tutorial progress', () => {
  it('auto-starts until completed or skipped, and again after a reset', () => {
    const storage = new MemoryStorage();
    expect(shouldAutoStartTutorial(storage)).toBe(true);
    expect(markTutorial('completed', storage)).toBe(true);
    expect(storage.items.get(TUTORIAL_STORAGE_KEY)).toBe('{"v":1,"status":"completed"}');
    expect(shouldAutoStartTutorial(storage)).toBe(false);
    expect(resetTutorial(storage)).toBe(true);
    expect(shouldAutoStartTutorial(storage)).toBe(true);
    markTutorial('skipped', storage);
    expect(readTutorialProgress(storage)).toEqual({ v: 1, status: 'skipped' });
    expect(shouldAutoStartTutorial(storage)).toBe(false);
  });

  it('treats corrupt or foreign values as not done', () => {
    const storage = new MemoryStorage();
    for (const raw of [
      '{not json',
      'null',
      '"completed"',
      '{"v":2,"status":"completed"}',
      '{"v":1,"status":"maybe"}',
      '[]',
    ]) {
      storage.setItem(TUTORIAL_STORAGE_KEY, raw);
      expect(readTutorialProgress(storage), raw).toBeNull();
      expect(shouldAutoStartTutorial(storage)).toBe(true);
    }
  });

  it('never throws when storage throws or is missing', () => {
    expect(shouldAutoStartTutorial(throwing)).toBe(true);
    expect(markTutorial('completed', throwing)).toBe(false);
    expect(resetTutorial(throwing)).toBe(false);
    expect(shouldAutoStartTutorial(null)).toBe(true);
    expect(markTutorial('skipped', null)).toBe(false);
    expect(resetTutorial(null)).toBe(false);
  });
});
