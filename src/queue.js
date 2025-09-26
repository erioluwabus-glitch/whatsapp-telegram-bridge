// src/queue.js
import logger from './logger.js';

/**
 * startQueueWorker - lightweight in-memory worker
 * (This implementation is intentionally minimal:
 *  it just exists so imports succeed. You can replace with
 *  a Mongo-backed persistent queue later.)
 *
 * @param {{ waSock: any, telegramBot: any, pollInterval?: number }} opts
 */
export function startQueueWorker({ waSock, telegramBot, pollInterval = 2000 } = {}) {
  logger.info('Queue worker started (no-op placeholder).');
  // Return a stop function so graceful shutdown can call it if needed
  function stop() {
    logger.info('Queue worker stopped.');
    return Promise.resolve();
  }
  return { stop };
}
