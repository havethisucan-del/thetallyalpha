/**
 * ADR-0018 decision 6: whether the tutorial still opens on the first Play click. Stored in
 * localStorage as `{"v":1,"status":"completed"|"skipped"}` (skipped counts as done). Every access
 * is wrapped in try/catch: storage may be missing, blocked or throw (private windows, previews).
 * Without working storage the tutorial is offered again; it never breaks the menu.
 */

export const TUTORIAL_STORAGE_KEY = 'cartignon.tutorial';

export type TutorialProgressStatus = 'completed' | 'skipped';

export interface TutorialProgress {
  readonly v: 1;
  readonly status: TutorialProgressStatus;
}

/** The storage methods used (tests pass a fake). */
export type ProgressStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): ProgressStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isProgress(value: unknown): value is TutorialProgress {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const status = record['status'];
  return record['v'] === 1 && (status === 'completed' || status === 'skipped');
}

/** The stored progress; null when absent, unreadable or not in the v1 shape. */
export function readTutorialProgress(
  storage: ProgressStorage | null = defaultStorage(),
): TutorialProgress | null {
  try {
    const raw = storage?.getItem(TUTORIAL_STORAGE_KEY) ?? null;
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isProgress(parsed) ? { v: 1, status: parsed.status } : null;
  } catch {
    return null;
  }
}

/** True until the tutorial was completed or skipped (also when storage cannot be read). */
export function shouldAutoStartTutorial(
  storage: ProgressStorage | null = defaultStorage(),
): boolean {
  return readTutorialProgress(storage) === null;
}

/** Records the outcome; false when it could not be stored. */
export function markTutorial(
  status: TutorialProgressStatus,
  storage: ProgressStorage | null = defaultStorage(),
): boolean {
  try {
    if (storage === null) return false;
    const value: TutorialProgress = { v: 1, status };
    storage.setItem(TUTORIAL_STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Forgets the outcome, so the tutorial opens automatically again; false on a storage error. */
export function resetTutorial(storage: ProgressStorage | null = defaultStorage()): boolean {
  try {
    if (storage === null) return false;
    storage.removeItem(TUTORIAL_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
