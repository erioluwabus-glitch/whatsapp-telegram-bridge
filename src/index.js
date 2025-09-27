// src/index.js
import mongoose from "mongoose";
import { startServer } from "./server.js";
import { createTelegram } from "./telegram.js";
import { startWhatsApp } from "./whatsapp.js"; // your existing WA module (must return handleTelegramUpdate)
import logger from "./logger.js"; // or replace with console

const ENV = process.env;

async function main() {
  logger?.info?.("🔍 Checking required environment variables...");
  if (!ENV.MONGO_URI) throw new Error("❌ MONGO_URI is required");
  if (!ENV.TELEGRAM_TOKEN) logger?.warn?.("⚠️ TELEGRAM_TOKEN not set; Telegram will be disabled.");

  const PORT = ENV.PORT ? Number(ENV.PORT) : 10000;
  const PUBLIC_DIR = ENV.PUBLIC_DIR || "./public";

  // start server early so webhook endpoint exists before we ask Telegram to set it
  const { app, server, setTelegramWebhookHandler } = startServer({ publicDir: PUBLIC_DIR, port: PORT });

  // connect mongo
  logger?.info?.("🟦 Connecting to MongoDB...");
  await mongoose.connect(ENV.MONGO_URI);
  logger?.info?.("✅ Connected to MongoDB");

  // Telegram helper (no external library)
  const telegram = createTelegram({ token: ENV.TELEGRAM_TOKEN, chatId: ENV.TELEGRAM_CHAT_ID });

  // Start WhatsApp module. The WA module should expose a function that when called returns
  // an object including handleTelegramUpdate (the function that expects a Telegram update object).
  // In your existing whatsapp.js you already implemented `handleTelegramUpdate(update)`.
  const wa = await startWhatsApp({
    // pass options if your startWhatsApp supports them
  });

  // wait until we have the handler for Telegram replies -> WhatsApp
  if (!wa?.handleTelegramUpdate) {
    logger?.warn?.("⚠️ startWhatsApp did not return handleTelegramUpdate. Ensure whatsapp.js exports/returns it.");
  } else {
    // attach the handler into server via our telegram wrapper
    const webhookHandler = telegram.createWebhookHandler(async (update) => {
      // Optionally do pre-processing here then pass to WA handler
      try {
        await wa.handleTelegramUpdate(update);
      } catch (err) {
        console.error("Error in WA handleTelegramUpdate:", err);
        throw err;
      }
    });

    setTelegramWebhookHandler(webhookHandler);

    // If WEBHOOK_BASE_URL present, set webhook on Telegram
    if (ENV.WEBHOOK_BASE_URL) {
      try {
        await telegram.setWebhook(ENV.WEBHOOK_BASE_URL);
        logger?.info?.("✅ Telegram webhook configured:", `${ENV.WEBHOOK_BASE_URL.replace(/\/$/, "")}/telegram/${telegram.token}`);
      } catch (err) {
        logger?.warn?.("Failed to set Telegram webhook (see logs). You can set it manually to:", `${ENV.WEBHOOK_BASE_URL.replace(/\/$/, "")}/telegram/${telegram.token}`);
      }
    } else {
      logger?.info?.("ℹ️ WEBHOOK_BASE_URL not set — webhook not registered automatically. Use polling disabled mode or manually set webhook to /telegram/<TOKEN>.");
    }
  }

  logger?.info?.("🚀 Bridge started successfully — ready to forward messages.");
}

main().catch((err) => {
  console.error("❌ Fatal error starting app", err);
  process.exit(1);
});
