import type { ServerResponse } from 'node:http';
import type { ErrorBody, ErrorCode } from '@cartignon/protocol';

/** An expected failure with a safe, client-facing message. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;

  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message: message.slice(0, 200) } };
}

export const DEFAULT_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  BAD_REQUEST: 'Bad request',
  UNAUTHENTICATED: 'Not signed in',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Not found',
  CONFLICT: 'Conflict',
  ROOM_FULL: 'Room is full',
  ROOM_EXPIRED: 'Room is no longer available',
  RATE_LIMITED: 'Too many requests, slow down',
  PAYLOAD_TOO_LARGE: 'Request body too large',
  UNAVAILABLE: 'Service temporarily unavailable',
  INTERNAL: 'Internal server error',
};

/** Writes an error body on a raw Node response (used outside Express). */
export function writeRawError(
  res: ServerResponse,
  status: number,
  code: ErrorCode,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(errorBody(code, DEFAULT_MESSAGES[code]));
  res.writeHead(status, {
    ...headers,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body).toString(),
    connection: 'close',
  });
  res.end(body);
}
