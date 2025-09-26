// src/index.js
import mongoose from 'mongoose';
import logger from './logger.js';
import { startServer } from './server.js';
import { startQueueWorker } from './queue.js'; // safe placeholder in repo
import { setupGracefulShutdown } from './graceful.js';

const REQUIRED_ENVS = ['MONGO_URI', 'TELEGRAM_TOKEN', 'TELEGRAM_CHAT_ID', 'WHATSAPP_ID'];

function checkEnvVars() {
  logger.info('🔍 Checking required environment variables...');
  const missing = [];
  for (const v of REQUIRED_ENVS) {
    if (!process.env[v]) {
      logger.error(`❌ Missing env var: ${v}`);
      missing.push(v);
    } else {
      logger.info(`✅ ${v} is set`);
    }
  }
  return missing;
}

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled Rejection');
});
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught Exception');
});

(async function main() {
  try {
    // 1) quick env check
    const miss = checkEnvVars();
    if (miss.length) {
      logger.error('Startup abort: fill the missing environment variables listed above.');
      // exit with non-zero so Render shows failure
      process.exit(1);
    }

    // 2) Connect to MongoDB (don't pass deprecated options)
    logger.info('🟦 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    logger.info('✅ Connected to MongoDB');

    // 3) Start small HTTP server immediately so Render sees the port bound
    const server = startServer();

    // 4) Dynamically import telegram & whatsapp modules so we can adapt to their exported shapes
    logger.info('🟦 Loading telegram and whatsapp modules...');
    const telegramModule = await import('./telegram.js').catch((e) => {
      logger.error({ e }, 'Failed to import ./telegram.js');
      throw e;
    });
    const whatsappModule = await import('./whatsapp.js').catch((e) => {
      logger.error({ e }, 'Failed to import ./whatsapp.js');
      throw e;
    });

    // Resolve exported functions (support named/default variants)
    const setupTelegram = telegramModule.setupTelegram ?? telegramModule.default ?? telegramModule.createTelegramBot ?? null;
    const startWhatsApp = whatsappModule.startWhatsApp ?? whatsappModule.default ?? null;

    if (!startWhatsApp) {
      throw new Error('startWhatsApp() not exported from ./whatsapp.js — check your file.');
    }
    if (!setupTelegram) {
      throw new Error('setupTelegram() not exported from ./telegram.js — check your file.');
    }

    // 5) Create Telegram bot if setupTelegram can be invoked without a WA socket
    let telegramBot = null;
    try {
      if (setupTelegram.length === 0) {
        logger.info('⚙️ Calling setupTelegram() (no args)...');
        telegramBot = await setupTelegram();
        logger.info('✅ Telegram bot initialized (no-arg)');
      } else {
        // Function expects args (likely a WA socket). We'll initialize after WA socket is ready.
        logger.info('⚙️ setupTelegram expects arguments; will attach WA socket after it is ready.');
      }
    } catch (err) {
      logger.error({ err }, 'Error while calling setupTelegram()');
      throw err;
    }

    // 6) Start WhatsApp: pass telegramBot if startWhatsApp supports it; otherwise it will ignore extra args
    logger.info('🟦 Starting WhatsApp socket...');
    let waSock = null;
    try {
      // pass the telegramBot (may be null) — many implementations accept it or ignore it
      waSock = await startWhatsApp(telegramBot);
      logger.info('✅ WhatsApp socket started');
    } catch (err) {
      logger.error({ err }, 'Failed to start WhatsApp socket');
      throw err;
    }

    // 7) If setupTelegram expected the WA socket (arity > 0) and we didn't call it earlier, call it now
    try {
      if (!telegramBot && setupTelegram.length > 0) {
        logger.info('⚙️ Attaching WA socket to Telegram setup...');
        // some implementations accept the sock and return the bot instance
        telegramBot = await setupTelegram(waSock);
        logger.info('✅ Telegram bot initialized (attached to WA socket)');
      }
    } catch (err) {
      logger.error({ err }, 'Failed to attach WA socket to telegram bot');
      throw err;
    }

    // 8) Start queue worker and other background services, passing both references
    logger.info('🟦 Starting queue worker...');
    const queueHandle = startQueueWorker
      ? startQueueWorker({ waSock, telegramBot })
      : { stop: async () => {} };

    // 9) Wire graceful shutdown (close WA, DB, stop queue)
    setupGracefulShutdown({
      waSock,
      mongooseConn: mongoose.connection,
      queueStopFn: (queueHandle && (queueHandle.stop || queueHandle)) || (async () => {})
    });

    logger.info('🚀 Bridge started successfully — ready to forward messages.');
    logger.info('📣 Watch Render logs for Baileys QR (if first run) or "WhatsApp connected" message.');

  } catch (err) {
    // fatal startup error
    logger.error({ err }, '❌ Fatal error in main()');
    // give logs a moment to flush
    /* eslint-disable no-process-exit */
    process.exit(1);
  }
})();
