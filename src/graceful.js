// src/graceful.js
import logger from './logger.js';

export function setupGracefulShutdown({ waSock, mongooseConn, queueStopFn } = {}) {
  async function shutdown(sig) {
    logger.info({ sig }, 'Shutting down gracefully...');
    try {
      if (queueStopFn) {
        try { await queueStopFn(); } catch (e) { logger.warn({ e }, 'Error stopping queue'); }
      }
      if (waSock?.close) {
        try { await waSock.close(); } catch (e) { logger.warn({ e }, 'Error closing WA socket'); }
      }
      if (mongooseConn?.close) {
        try { await mongooseConn.close(); } catch (e) { logger.warn({ e }, 'Error closing mongoose'); }
      }
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
    } finally {
      process.exit(0);
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'uncaughtException');
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (err) => {
    logger.error({ err }, 'unhandledRejection');
  });
}
