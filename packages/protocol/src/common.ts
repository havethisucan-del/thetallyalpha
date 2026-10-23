import { z } from 'zod';
import { INVITE_CODE_ALPHABET, INVITE_CODE_LENGTH } from './limits.js';

export const inviteCodeSchema = z
  .string()
  .length(INVITE_CODE_LENGTH)
  .regex(new RegExp(`^[${INVITE_CODE_ALPHABET}]+$`), 'Invalid invite code');

/** Client-generated idempotency key for an action (UUID). */
export const actionIdSchema = z.uuid();

export const seatSchema = z.union([z.literal(0), z.literal(1)]);

/** Stable machine-readable error codes. Messages are safe for display and never leak internals. */
export const errorCodeSchema = z.enum([
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'ROOM_FULL',
  'ROOM_EXPIRED',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  /** Server is shutting down or a dependency is down (HTTP 503). */
  'UNAVAILABLE',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorBodySchema = z.strictObject({
  error: z.strictObject({
    code: errorCodeSchema,
    message: z.string().max(200),
  }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;
