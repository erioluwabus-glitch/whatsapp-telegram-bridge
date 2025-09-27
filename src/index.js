// src/index.js
/**
 * Orchestrator: start server, Mongo, WhatsApp (Baileys) and wire Telegram webhook.
 * Node: uses ES modules and top-level await.
 */

import mongoose from 'mongoose';
import { startServer } from './server.js';
import { startWhatsApp } from './whatsapp.js';

const ENV = process.env;

/* --------- Simple logger (replace with your logger module if you have one) --------- */
const logger = {
  info: (...args) => console.log(JSON.stringify({ level: 'info', time: new Date().toISOString(), msg: args.join(' ') })),
  warn: (...args) => console.warn(JSON.stringify({ level: 'warn', time: new Date().toISOString(), msg: args.join(' ') })),
  error: (...args) => console.error(JSON.stringify({ level: 'error', time: new Date().toISOString(), msg: args.join(' ') })),
  debug: (...args) => console.debug(JSON.stringify({ level: 'debug', time: new Date().toISOString(), msg: args.join(' ') })),
};

/* --------- Environment checks --------- */
logger.info('🔍 Checking required environment variables...');
if (!ENV.MONGO_URI) {
  logger.error('❌ MONGO_URI is not set — aborting startup.');
  process.exit(1);
}

if (!ENV.TELEGRAM_TOKEN || !ENV.TELEGRAM_CHAT_ID) {
  logger.warn('⚠️ TELEGRAM_TOKEN or TELEGRAM_CHAT_ID missing — Telegram forwarding will be disabled until these are set.');
}

const PORT = ENV.PORT ? Number(ENV.PORT) : 10000;
const WEBHOOK_BASE_URL = ENV.WEBHOOK_BASE_URL || null;
const AUTH_DIR = ENV.WHATSAPP_AUTH_DIR || './baileys_auth';
const PUBLIC_DIR = ENV.PUBLIC_DIR || './public';

/* --------- webhook options object (we'll fill handler after WA ready) --------- */
const webhookOptions = {
  telegramWebhookHandler: null, // will be set below when WhatsApp module is ready
  telegramToken: ENV.TELEGRAM_TOKEN,
  port: PORT,
};

/* --------- Start server (exposes /qr.png and Telegram webhook POST) --------- */
let serverApp;
try {
  serverApp = startServer(webhookOptions);
  logger.info(`🌐 Web server started (public dir=${PUBLIC_DIR})`);
} catch (err) {
  logger.error('Failed to start server:', err);
  process.exit(1);
}

/* --------- Connect to MongoDB --------- */
logger.info('🟦 Connecting to MongoDB...');
try {
  // mongoose.connect returns a promise
  await mongoose.connect(ENV.MONGO_URI);
  logger.info('✅ Connected to MongoDB');
} catch (err) {
  logger.error('❌ Could not connect to MongoDB:', err);
  process.exit(1);
}

/* --------- Helper: set Telegram webhook (optional) --------- */
async function setTelegramWebhookIfNeeded() {
  if (!ENV.TELEGRAM_TOKEN) return;
  if (!WEBHOOK_BASE_URL) {
    logger.warn('WEBHOOK_BASE_URL not set; skipping automatic Telegram webhook registration.');
    return;
  }
  try {
    const webhookUrl = `${WEBHOOK_BASE_URL.replace(/\/$/, '')}/telegram/${ENV.TELEGRAM_TOKEN}`;
    const setWebhookUrl = `https://api.telegram.org/bot${ENV.TELEGRAM_TOKEN}/setWebhook`;
    const res = await fetch(setWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    });
    const data = await res.json();
    if (data && data.ok) {
      logger.info('✅ Telegram webhook set successfully', webhookUrl);
    } else {
      logger.warn('⚠️ Telegram setWebhook response:', JSON.stringify(data));
    }
  } catch (err) {
    logger.error('Failed to set Telegram webhook:', err);
  }
}

/* --------- Start WhatsApp (Baileys) and wire telegram webhook handler --------- */
let whatsappApi = null;
try {
  whatsappApi = await startWhatsApp({
    telegram: { token: ENV.TELEGRAM_TOKEN, chatId: ENV.TELEGRAM_CHAT_ID },
    authDir: AUTH_DIR,
    publicDir: PUBLIC_DIR,
    onReady: ({ handleTelegramUpdate, sock, persistAuthFilesToMongo }) => {
      // wire the webhook handler into the serverOptions object referenced by startServer
      webhookOptions.telegramWebhookHandler = handleTelegramUpdate;
      logger.info('✅ Telegram webhook handler attached to server (will forward Telegram replies to WhatsApp)');

      // set webhook immediately if WEBHOOK_BASE_URL present
      // (call asynchronously; don't block the onReady)
      setTelegramWebhookIfNeeded().catch(e => logger.warn('setTelegramWebhookIfNeeded failed', e));

      // Optionally persist auth once we see the socket open
      // (startWhatsApp already persists on creds.update; we keep this for extra safety)
      sock.ev.on('connection.update', async (u) => {
        if (u.connection === 'open') {
          try {
            await persistAuthFilesToMongo();
          } catch (e) {
            logger.warn('persistAuthFilesToMongo failed:', e);
          }
        }
      });
    },
  });

  logger.info('🚀 startWhatsApp returned successfully (bridge is initializing)');
} catch (err) {
  logger.error('❌ Failed to start WhatsApp module:', err);
  // allow process to stay alive in case of QR generation etc — but exit if fatal
  process.exit(1);
}

/* --------- Final ready log & QR hint --------- */
logger.info('🚀 Bridge started successfully — ready to forward messages.');
logger.info('ℹ️ If this is the first time, open: /qr.png (e.g. https://<your-render>.onrender.com/qr.png) and scan from WhatsApp -> Linked devices -> Link a device');

/* --------- Graceful shutdown --------- */
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`🛑 Caught ${signal} - shutting down gracefully...`);

  try {
    if (whatsappApi?.persistAuthFilesToMongo) {
      await whatsappApi.persistAuthFilesToMongo().catch(e => logger.warn('persistAuthFilesToMongo error during shutdown', e));
      logger.info('✅ Persisted auth files to Mongo');
    }
  } catch (e) {
    logger.warn('Error while persisting auth data:', e);
  }

  try {
    await mongoose.disconnect();
    logger.info('✅ Disconnected from MongoDB');
  } catch (e) {
    logger.warn('Error disconnecting mongoose:', e);
  }

  // give some time for outstanding logs / http responses
  setTimeout(() => {
    logger.info('Process exit (0)');
    process.exit(0);
  }, 800);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', err);
  gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', reason);
});

/* --------- Export nothing; this file is the app entrypoint --------- */
