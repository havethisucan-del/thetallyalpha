import { decideFromRequest, type BotRequest, type BotResponse } from '@cartignon/ai';
import type { BotTransport, BotWorkerRequest, BotWorkerResponse } from './botProtocol';
import { soloRoundContext } from './rules';

/**
 * ADR-0017 decision 2: the solo bot runs in a module Web Worker; when a Worker cannot be created
 * (or fails to load) it runs inline on the main thread instead.
 */

class DisposedError extends Error {
  constructor() {
    super('the bot was stopped');
    this.name = 'DisposedError';
  }
}

/** Runs `decideFromRequest` on the main thread (fallback and tests). */
export function createInlineBot(): BotTransport {
  let disposed = false;
  return {
    decide(request) {
      // A microtask, so the caller's state settles before the (possibly long) search runs.
      return Promise.resolve().then(() => {
        if (disposed) throw new DisposedError();
        return decideFromRequest(soloRoundContext(), request);
      });
    },
    dispose() {
      disposed = true;
    },
  };
}

interface Pending {
  request: BotRequest;
  resolve: (response: BotResponse) => void;
  reject: (error: Error) => void;
}

class WorkerBot implements BotTransport {
  #worker: Worker | null;
  readonly #inline = createInlineBot();
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #disposed = false;

  constructor(worker: Worker) {
    this.#worker = worker;
    worker.addEventListener('message', (event: MessageEvent<BotWorkerResponse>) => {
      const data = event.data;
      const pending = this.#pending.get(data.id);
      if (!pending) return;
      this.#pending.delete(data.id);
      if ('response' in data) pending.resolve(data.response);
      else pending.reject(new Error(data.error));
    });
    // The worker script failed to load or crashed: answer everything inline from now on.
    worker.addEventListener('error', () => {
      this.#fallBackToInline();
    });
  }

  decide(request: BotRequest): Promise<BotResponse> {
    if (this.#disposed) return Promise.reject(new DisposedError());
    const worker = this.#worker;
    if (!worker) return this.#inline.decide(request);
    return new Promise<BotResponse>((resolve, reject) => {
      const id = this.#nextId++;
      this.#pending.set(id, { request, resolve, reject });
      const message: BotWorkerRequest = { id, request };
      worker.postMessage(message);
    });
  }

  dispose(): void {
    this.#disposed = true;
    this.#worker?.terminate();
    this.#worker = null;
    this.#inline.dispose();
    for (const pending of this.#pending.values()) pending.reject(new DisposedError());
    this.#pending.clear();
  }

  #fallBackToInline(): void {
    this.#worker?.terminate();
    this.#worker = null;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) {
      this.#inline.decide(entry.request).then(entry.resolve, entry.reject);
    }
  }
}

/** The bot worker, or the inline bot when this environment cannot create a module worker. */
export function createBotClient(): BotTransport {
  try {
    const worker = new Worker(new URL('./bot.worker.ts', import.meta.url), { type: 'module' });
    return new WorkerBot(worker);
  } catch {
    return createInlineBot();
  }
}
