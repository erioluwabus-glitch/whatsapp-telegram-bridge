console.log("🔍 Starting bridge...");
["MONGODB_URI", "TELEGRAM_TOKEN", "TELEGRAM_CHAT_ID", "WHATSAPP_ID"].forEach(v => {
  if (!process.env[v]) {
    console.error(`❌ Missing env var: ${v}`);
  } else {
    console.log(`✅ ${v} is set`);
  }
});

import mongoose from 'mongoose'
import logger from './logger.js'
import { startWhatsApp } from './whatsapp.js'
import { setupTelegram } from "./telegram.js";
import { startQueueWorker } from './queue.js'
import { startServer } from './server.js'
import { setupGracefulShutdown } from './graceful.js'
import express from "express";

// === 1. Connect to MongoDB Atlas ===
async function connectMongo() {
  const uri = process.env.MONGO_URI
  if (!uri) {
    logger.error('❌ Missing MONGO_URI env var')
    process.exit(1)
  }
  await mongoose.connect(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  logger.info('✅ Connected to MongoDB')
}

// === 2. Main app bootstrap ===
async function main() {
  try {
    await connectMongo()

    // start WhatsApp socket
    const waSock = await startWhatsApp() // returns WA connection
    logger.info('✅ WhatsApp connected')

    // start Telegram bot
    const { bot: telegramBot } = setupTelegram(waSock)
    logger.info('✅ Telegram bot ready')

    // start queue worker (retries + reliability)
    startQueueWorker({ waSock, telegramBot })
    logger.info('📦 Queue worker started')

    // start Express server (keep-alive, health, metrics)
    startServer()
    logger.info('🌐 Web server started')

    // graceful shutdown hooks
    setupGracefulShutdown({ waSock, mongoClient: mongoose.connection })
  } catch (err) {
    logger.error({ err }, '❌ Fatal error in main()')
    process.exit(1)
  }
}

export function startServer() {
  const app = express();
  const PORT = process.env.PORT || 10000;
  app.get("/", (req, res) => res.send("Bridge is running 🚀"));
  app.listen(PORT, () => console.log(`🌐 Server listening on ${PORT}`));
}

main()



