/**
 * Defensive narrowing of the synthetic placeholder rules' `public` / `private` view parts, which
 * the protocol types as `unknown`. Rendering only: the client never computes rules.
 *
 * Hand-written guards instead of zod because zod is not a direct dependency of the web app.
 */

export type Seat = 0 | 1;

export interface SyntheticPublic {
  phase: string;
  activeSeat: Seat | null;
  counter: number;
  target: number;
  secretCounts: [number, number];
}

export interface SyntheticPrivate {
  seat: Seat;
  secrets: number[];
}

export const INCREMENT_AMOUNTS = [1, 2, 3] as const;
export type IncrementAmount = (typeof INCREMENT_AMOUNTS)[number];

const MAX_SECRETS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isCount(value: unknown): value is number {
  return isSafeInt(value) && value >= 0;
}

function isSeat(value: unknown): value is Seat {
  return value === 0 || value === 1;
}

export function parseSyntheticPublic(value: unknown): SyntheticPublic | null {
  if (!isRecord(value)) return null;
  const { phase, activeSeat, counter, target, secretCounts } = value;
  if (typeof phase !== 'string' || phase.length > 64) return null;
  if (activeSeat !== null && !isSeat(activeSeat)) return null;
  if (!isSafeInt(counter) || !isSafeInt(target)) return null;
  if (!Array.isArray(secretCounts) || secretCounts.length !== 2) return null;
  const [a, b] = secretCounts as unknown[];
  if (!isCount(a) || !isCount(b)) return null;
  return { phase, activeSeat, counter, target, secretCounts: [a, b] };
}

export function parseSyntheticPrivate(value: unknown): SyntheticPrivate | null {
  if (!isRecord(value)) return null;
  const { seat, secrets } = value;
  if (!isSeat(seat)) return null;
  if (!Array.isArray(secrets) || secrets.length > MAX_SECRETS) return null;
  const list = secrets as unknown[];
  if (!list.every(isSafeInt)) return null;
  return { seat, secrets: [...list] };
}

export function incrementAction(amount: IncrementAmount) {
  return { type: 'increment', v: 1, payload: { amount } } as const;
}
