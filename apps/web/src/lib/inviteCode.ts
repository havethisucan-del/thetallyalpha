import { INVITE_CODE_LENGTH, inviteCodeSchema } from '@cartignon/protocol';

/** Normalizes input as typed: uppercase, no whitespace, capped at the code length. */
export function normalizeInviteCodeInput(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase().slice(0, INVITE_CODE_LENGTH);
}

export function isValidInviteCode(code: string): boolean {
  return inviteCodeSchema.safeParse(code).success;
}
