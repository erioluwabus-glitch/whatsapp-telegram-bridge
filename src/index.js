// src/index.js
import 'dotenv/config';
import mongoose from 'mongoose';
import logger from './logger.js';
import { startServer } from './server.js';
import { setupTelegram } from './telegram.js';
import { startWhatsApp } from './whatsapp.js';

async function checkEnv() {
  const required = ['MONGO_URI', 'TELEGRAM_TOKEN', 'TELEGRAM_CHAT_ID', 'WEBHOOK_BASE_URL'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    logger.error({ missing }, 'Startup abort: fill the missing environment variables listed above.');
    process.exit(1);
  }
}

async function main() {
  try {
    logger.info('🔍 Checking required environment variables...');
    await checkEnv();

    logger.info('🟦 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI, {});

    logger.info('✅ Connected to MongoDB');

    // start web server
    const { app, server } = startServer();

    // setup Telegram in webhook mode (preferred on Render)
    const telegramBot = await setupTelegram({
      token: process.env.TELEGRAM_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID,
      app,
      webhookBaseUrl: process.env.WEBHOOK_BASE_URL
    });

    // attach whatsapp module
    await startWhatsApp({ telegramBot, telegramChatId: process.env.TELEGRAM_CHAT_ID });

    logger.info('🚀 Bridge started successfully — ready to forward messages.');
    
    // graceful shutdown
    const shutdown = async () => {
      logger.info('Shutting down...');
      try {
        await mongoose.disconnect();
        server.close(() => logger.info('HTTP server closed'));
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'Error during shutdown');
        process.exit(1);
      }
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } catch (err) {
    logger.error({ err }, '❌ Fatal error in main()');
    process.exit(1);
  }
}

main();
