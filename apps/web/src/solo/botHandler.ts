import { decideFromRequest } from '@cartignon/ai';
import type { BotWorkerRequest, BotWorkerResponse } from './botProtocol';
import { soloRoundContext } from './rules';

/**
 * Answers one worker message (used by `bot.worker.ts`; pure apart from the bot's clock). Never
 * throws: a failure becomes an `error` response for the same id.
 */
export function handleBotMessage(message: BotWorkerRequest): BotWorkerResponse {
  try {
    return { id: message.id, response: decideFromRequest(soloRoundContext(), message.request) };
  } catch (error) {
    return { id: message.id, error: error instanceof Error ? error.message : String(error) };
  }
}
