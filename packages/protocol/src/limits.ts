/** Hard upper bound for one WebSocket message; enforced by the server transport. */
export const MAX_WS_MESSAGE_BYTES = 16 * 1024;

/** Upper bound for JSON HTTP request bodies. */
export const MAX_HTTP_BODY_BYTES = 8 * 1024;

/**
 * Invite-code alphabet: uppercase letters and digits without look-alikes (0/O, 1/I/L).
 * 31^6 ≈ 8.9e8 codes; enumeration is additionally rate limited server-side.
 */
export const INVITE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 6;
