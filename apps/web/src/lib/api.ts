import {
  ApiRoute,
  CSRF_HEADER,
  errorBodySchema,
  healthResponseSchema,
  joinPrivateRoomRequestSchema,
  roomAdmissionSchema,
  roomTicketRequestSchema,
  sessionResponseSchema,
  type ErrorCode,
  type HealthResponse,
  type RoomAdmission,
  type SessionResponse,
} from '@cartignon/protocol';

/** Structural view of a zod schema, so this module does not depend on zod directly. */
export interface Parser<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

/** Client-side failure kinds in addition to the server's error codes. */
export type ApiFailure = ErrorCode | 'NETWORK' | 'INVALID_RESPONSE';

export class ApiError extends Error {
  readonly code: ApiFailure;
  readonly status: number | null;

  constructor(code: ApiFailure, status: number | null) {
    super(friendlyMessage(code));
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

const MESSAGES: Record<ApiFailure, string> = {
  BAD_REQUEST: 'The request was not accepted. Please check your input.',
  UNAUTHENTICATED: 'Your guest session has expired. Reload the page to start a new one.',
  FORBIDDEN: 'You are not allowed to do that.',
  NOT_FOUND: 'No room was found with that code.',
  CONFLICT: 'That conflicts with the current state. Please try again.',
  ROOM_FULL: 'That room is already full.',
  ROOM_EXPIRED: 'That room has expired. Ask for a new invite code.',
  RATE_LIMITED: 'Too many attempts. Please wait a moment and try again.',
  PAYLOAD_TOO_LARGE: 'The request was too large.',
  UNAVAILABLE: 'The server is restarting. Please try again in a moment.',
  INTERNAL: 'Something went wrong on the server. Please try again.',
  NETWORK: 'Cannot reach the server. Check your connection and try again.',
  INVALID_RESPONSE: 'The server sent an unexpected response.',
};

export function friendlyMessage(code: ApiFailure): string {
  return MESSAGES[code];
}

/** Fallback when an error response has no valid error body. */
export function codeFromStatus(status: number): ApiFailure {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 410:
      return 'ROOM_EXPIRED';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 429:
      return 'RATE_LIMITED';
    default:
      return status >= 500 ? 'INTERNAL' : 'INVALID_RESPONSE';
  }
}

/** Maps a non-2xx response to an error code: the validated body wins over the status code. */
export function errorCodeFromResponse(status: number, body: unknown): ApiFailure {
  const parsed = errorBodySchema.safeParse(body);
  return parsed.success ? parsed.data.error.code : codeFromStatus(status);
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Thin same-origin HTTP client. Never caches anything; the session lives only in the HttpOnly
 * cookie that the browser sends automatically.
 */
export class ApiClient {
  readonly #fetch: FetchLike;

  constructor(fetchFn: FetchLike = (input, init) => fetch(input, init)) {
    this.#fetch = fetchFn;
  }

  async #request<T>(
    method: 'GET' | 'POST',
    path: string,
    parser: Parser<T>,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (method === 'POST') headers[CSRF_HEADER] = '1';
    if (body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await this.#fetch(path, {
        method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApiError('NETWORK', null);
    }

    const json = await readJson(response).catch(() => undefined);
    if (!response.ok) {
      throw new ApiError(errorCodeFromResponse(response.status, json), response.status);
    }
    const parsed = parser.safeParse(json);
    if (!parsed.success) throw new ApiError('INVALID_RESPONSE', response.status);
    return parsed.data;
  }

  getSession(): Promise<SessionResponse> {
    return this.#request('GET', ApiRoute.Session, sessionResponseSchema);
  }

  createGuestSession(): Promise<SessionResponse> {
    return this.#request('POST', ApiRoute.GuestSession, sessionResponseSchema);
  }

  /** Returns the current session, creating a guest session when there is none. */
  async ensureSession(): Promise<SessionResponse> {
    try {
      return await this.getSession();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'UNAUTHENTICATED') {
        return this.createGuestSession();
      }
      throw error;
    }
  }

  createPrivateRoom(): Promise<RoomAdmission> {
    return this.#request('POST', ApiRoute.CreatePrivateRoom, roomAdmissionSchema);
  }

  joinPrivateRoom(code: string): Promise<RoomAdmission> {
    const request = joinPrivateRoomRequestSchema.safeParse({ code });
    if (!request.success) return Promise.reject(new ApiError('BAD_REQUEST', null));
    return this.#request('POST', ApiRoute.JoinPrivateRoom, roomAdmissionSchema, request.data);
  }

  /** A fresh single-use ticket for a room this player already sits in (used for rejoin). */
  getRoomTicket(roomId: string): Promise<RoomAdmission> {
    const request = roomTicketRequestSchema.safeParse({ roomId });
    if (!request.success) return Promise.reject(new ApiError('BAD_REQUEST', null));
    return this.#request('POST', ApiRoute.RoomTicket, roomAdmissionSchema, request.data);
  }

  /** `/readyz` answers 200 or 503 with the same body shape; both are a valid health reading. */
  async checkReady(): Promise<HealthResponse['status']> {
    try {
      const response = await this.#fetch(ApiRoute.Ready, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const parsed = healthResponseSchema.safeParse(await readJson(response));
      return parsed.success && response.ok ? parsed.data.status : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }
}
