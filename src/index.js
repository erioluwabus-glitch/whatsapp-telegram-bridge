// src/index.js
import mongoose from 'mongoose';
import logger from './logger.js';
import { createServer } from './server.js';
import { startQueueWorker } from './queue.js';
import { setupGracefulShutdown } from './graceful.js';

const REQUIRED_ENVS = ['MONGO_URI', 'TELEGRAM_TOKEN', 'TELEGRAM_CHAT_ID', 'WEBHOOK_BASE_URL'];

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
    const missing = checkEnvVars();
    if (missing.length) {
      logger.error('Startup abort: fill the missing environment variables listed above.');
      process.exit(1);
    }

    logger.info('🟦 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    logger.info('✅ Connected to MongoDB');

    // 1) start web server and get express app
    const { app, server } = createServer();
    logger.info('🌐 Server ready to host Telegram webhook endpoint');

    // 2) import our modules
    const whatsappModule = await import('./whatsapp.js');
    const telegramModule = await import('./telegram.js');

    const startWhatsApp = whatsappModule.startWhatsApp ?? whatsappModule.default ?? null;
    const initTelegram = telegramModule.initTelegram ?? telegramModule.default?.initTelegram ?? null;
    const registerTelegramHandlers = telegramModule.registerHandlers ?? telegramModule.default?.registerHandlers ?? null;
    const processTelegramUpdate = telegramModule.processUpdate ?? telegramModule.default?.processUpdate ?? null;

    if (!startWhatsApp) throw new Error('startWhatsApp() not exported from ./whatsapp.js');
    if (!initTelegram || !registerTelegramHandlers || !processTelegramUpdate)
      throw new Error('telegram.js must export initTelegram, registerHandlers, and processUpdate');

    // 3) init Telegram (webhook-mode)
    logger.info('🟦 Initializing Telegram (webhook mode)...');
    const bot = initTelegram();

    // 4) register webhook HTTP endpoint (Telegram will POST here)
    const webhookPath = `/telegram/${process.env.TELEGRAM_TOKEN}`;
    app.post(webhookPath, async (req, res) => {
      try {
        await processTelegramUpdate(req.body);
        res.sendStatus(200);
      } catch (err) {
        logger.error({ err }, 'Error processing Telegram webhook update');
        res.status(500).send('error');
      }
    });
    logger.info({ webhookPath }, '✅ Telegram webhook endpoint registered');

    // 5) set webhook at Telegram to point to your Render URL
    const webhookUrl = `${process.env.WEBHOOK_BASE_URL.replace(/\/$/, '')}${webhookPath}`;
    try {
      await bot.setWebHook(webhookUrl);
      logger.info({ webhookUrl }, '✅ Telegram webhook set successfully');
    } catch (err) {
      logger.error({ err, webhookUrl }, '❌ Failed to set Telegram webhook');
      // Fatal — do not continue if webhook couldn't be set (prevents fallback conflicts).
      throw err;
    }

    // 6) start WhatsApp socket (it will restore / persist auth files to Mongo)
    logger.info('🟦 Starting WhatsApp socket...');
    // Start WA and get socket
    const waSock = await startWhatsApp();
    logger.info('✅ WhatsApp socket started');

    // 7) register telegram handlers (now that waSock exists)
    registerTelegramHandlers(waSock);
    logger.info('✅ Telegram handlers registered (Telegram -> WhatsApp replies)');

    // 8) attach telegram bot in whatsapp module if provided (keeps WA->TG forwarding working)
    if (whatsappModule.attachTelegramBot) {
      whatsappModule.attachTelegramBot(bot);
      logger.info('✅ Telegram bot attached to WhatsApp module');
    }

    // 9) start queue worker and setup graceful shutdown
    const queueHandle = startQueueWorker ? startQueueWorker({ waSock, telegramBot: bot }) : { stop: async () => {} };
    setupGracefulShutdown({ waSock, mongooseConn: mongoose.connection, queueStopFn: queueHandle.stop });

    logger.info('🚀 Bridge started successfully — ready to forward messages.');
  } catch (err) {
    logger.error({ err }, '❌ Fatal error in main()');
    process.exit(1);
  }
})();
