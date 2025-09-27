// src/index.js
import mongoose from "mongoose";
import { startServer } from "./server.js";
import { startWhatsApp } from "./whatsapp.js";
import fetch from "node-fetch"; // not required on Node 18+, but harmless if present

// simple logger (you can replace with your logger module)
const logger = {
  info: (...args) => console.log(JSON.stringify({ level: "info", time: new Date().toISOString(), msg: args.join(" ") })),
  warn: (...args) => console.warn(JSON.stringify({ level: "warn", time: new Date().toISOString(), msg: args.join(" ") })),
  error: (...args) => console.error(JSON.stringify({ level: "error", time: new Date().toISOString(), msg: args.join(" ") })),
};

async function main() {
  logger.info("🔍 Checking required environment variables...");
  if (!process.env.MONGO_URI) {
    logger.error("❌ MONGO_URI missing — aborting");
    process.exit(1);
  }

  const PUBLIC_DIR = process.env.PUBLIC_DIR || "./public";
  const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || "./baileys_auth";
  const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
  const ADMIN_SECRET = process.env.ADMIN_SECRET || null;

  // start web server early
  const { app, server, setTelegramWebhookHandler } = startServer({ publicDir: PUBLIC_DIR, port: PORT, adminSecret: ADMIN_SECRET });

  // connect to mongo
  logger.info("🟦 Connecting to MongoDB...");
  await mongoose.connect(process.env.MONGO_URI);
  logger.info("✅ Connected to MongoDB");

  //  WA (will restore auth from Mongo if present)
    // start WA (will restore auth from Mongo if present)
  const wa = await startWhatsApp({
    telegram: { token: process.env.TELEGRAM_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID },
    authDir: AUTH_DIR,
    publicDir: PUBLIC_DIR,
    // NEW: give whatsapp-specific options (browser + version + maxReconnectAttempts)
    whatsappOptions: {
      browser: ['Chrome', 'Windows', '10'],        // present as a normal browser
      version: [2, 2413, 12],                      // reasonable WA web version array
      maxReconnectAttempts: 5                      // try reconnect 5x before clearing
    },
    onReady: ({ handleTelegramUpdate }) => {
      // wire Telegram webhook handler into server
      setTelegramWebhookHandler(handleTelegramUpdate);
      logger.info("✅ Telegram webhook handler attached to server (will forward Telegram replies to WhatsApp)");
    },
  });


  // If you provided WEBHOOK_BASE_URL, set it in Telegram so Telegram calls your /telegram/<TOKEN> endpoint
  if (process.env.WEBHOOK_BASE_URL && process.env.TELEGRAM_TOKEN) {
    const base = String(process.env.WEBHOOK_BASE_URL).replace(/\/$/, "");
    const webhookUrl = `${base}/telegram/${process.env.TELEGRAM_TOKEN}`;
    try {
      const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: webhookUrl, allowed_updates: ["message", "edited_message"] }),
      });
      const data = await res.json();
      if (data?.ok) {
        logger.info("✅ Telegram webhook set successfully", webhookUrl);
      } else {
        logger.warn("⚠️ Telegram setWebhook response:", JSON.stringify(data));
      }
    } catch (err) {
      logger.warn("Failed to set Telegram webhook:", err);
      logger.info(`Manual webhook URL (set in BotFather or Telegram API): ${webhookUrl}`);
    }
  } else {
    logger.info("WEBHOOK_BASE_URL not set — skipping automatic Telegram webhook registration.");
  }

  logger.info("🚀 Bridge started successfully — ready to forward messages.");
}

// start
main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});

