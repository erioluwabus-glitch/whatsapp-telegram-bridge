// src/index.js
import mongoose from 'mongoose';
import logger from './logger.js';
import { startServer } from './server.js';
import { startQueueWorker } from './queue.js';
import { setupGracefulShutdown } from './graceful.js';

const REQUIRED_ENVS = ['MONGO_URI', 'TELEGRAM_TOKEN', 'TELEGRAM_CHAT_ID']; // removed WHATSAPP_ID

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
    const miss = checkEnvVars();
    if (miss.length) {
      logger.error('Startup abort: fill the missing environment variables listed above.');
      process.exit(1);
    }

    logger.info('🟦 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    logger.info('✅ Connected to MongoDB');

    // start server (bind port quickly)
    const server = startServer();

    // import modules
    const whatsappModule = await import('./whatsapp.js');
    const telegramModule = await import('./telegram.js');

    const startWhatsApp = whatsappModule.startWhatsApp ?? whatsappModule.default ?? null;
    const setupTelegram = telegramModule.setupTelegram ?? telegramModule.default ?? null;

    if (!startWhatsApp) throw new Error('startWhatsApp() not exported from ./whatsapp.js');
    if (!setupTelegram) throw new Error('setupTelegram() not exported from ./telegram.js');

    // 1) start WhatsApp socket first (which will restore session files from Mongo)
    logger.info('🟦 Starting WhatsApp socket...');
    const waSock = await startWhatsApp();
    logger.info('✅ WhatsApp socket started');

    // 2) create Telegram bot and attach WA socket to it
    logger.info('🟦 Creating Telegram bot and wiring to WA socket...');
    const telegramBot = await setupTelegram(waSock);

    // 3) attach the telegram bot to whatsapp module so WA->TG forwarding works
    if (whatsappModule.attachTelegramBot) {
      whatsappModule.attachTelegramBot(telegramBot);
      logger.info('✅ Telegram bot attached to WhatsApp module');
    }

    // 4) background worker & graceful shutdown
    const queueHandle = startQueueWorker ? startQueueWorker({ waSock, telegramBot }) : { stop: async () => {} };
    setupGracefulShutdown({ waSock, mongooseConn: mongoose.connection, queueStopFn: queueHandle.stop });

    logger.info('🚀 Bridge started successfully — ready to forward messages.');
  } catch (err) {
    logger.error({ err }, '❌ Fatal error in main()');
    process.exit(1);
  }
})();
