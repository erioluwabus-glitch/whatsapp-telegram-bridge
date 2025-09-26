// src/index.js
import mongoose from "mongoose";
import logger from "./logger.js";
import { startWhatsApp } from "./whatsapp.js";
import { setupTelegram } from "./telegram.js";
import { startQueueWorker } from "./queue.js";
import { startServer } from "./server.js";
import { setupGracefulShutdown } from "./graceful.js";

async function main() {
  try {
    // 1. Connect DB
    await mongoose.connect(process.env.MONGO_URI);
    logger.info("✅ Connected to MongoDB");

    // 2. Start Telegram
    const telegramBot = setupTelegram();

    // 3. Start WhatsApp (pass telegramBot if needed)
    await startWhatsApp(telegramBot);

    // 4. Queue worker
    startQueueWorker();

    // 5. Web server
    startServer();

    // 6. Graceful shutdown
    setupGracefulShutdown();
  } catch (err) {
    logger.error({ err }, "❌ Fatal error in main()");
    process.exit(1);
  }
}

main();
