import type { BotWorkerRequest, BotWorkerResponse } from './botProtocol';
import { handleBotMessage } from './botHandler';

/**
 * ADR-0017: the solo bot as a module Web Worker. Builds the round context once (on the first
 * request) and answers each `{ id, request }` with `{ id, response }` or `{ id, error }`.
 *
 * The scope is typed structurally so this file also type-checks under the DOM lib (the test
 * project includes all of `src`).
 */
interface BotWorkerScope {
  addEventListener(type: 'message', listener: (event: { data: BotWorkerRequest }) => void): void;
  postMessage(message: BotWorkerResponse): void;
}

const scope = globalThis as unknown as BotWorkerScope;

scope.addEventListener('message', (event) => {
  scope.postMessage(handleBotMessage(event.data));
});
