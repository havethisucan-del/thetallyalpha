import type { BotRequest, BotResponse } from '@cartignon/ai';

/** Main thread -> bot worker: one decision request (structured-cloneable). */
export interface BotWorkerRequest {
  readonly id: number;
  readonly request: BotRequest;
}

/** Bot worker -> main thread: the answer to the request with the same `id`. */
export type BotWorkerResponse =
  | { readonly id: number; readonly response: BotResponse }
  | { readonly id: number; readonly error: string };

/** Something that answers bot requests: the worker client or the inline fallback. */
export interface BotTransport {
  decide(request: BotRequest): Promise<BotResponse>;
  /** Stops the bot; pending and later requests reject. */
  dispose(): void;
}
