// src/index.js
/**
 * App orchestrator: Mongo, WhatsApp (Baileys), Telegram, Web server.
 * Supports QR login & OTP fallback (8-digit code).
 */

import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { makeWASocket, useMongoAuthState } from "@whiskeysockets/baileys";

import { startServer } from "./server.js";
import { setupTelegram } from "./telegram.js";
import { setupGracefulShutdown } from "./graceful.js";
import logger from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, "../public");

// helper: write OTP into public dir so it can be fetched at /otp.txt
async function writeOtpFile(code) {
  try {
    const filePath = path.join(PUBLIC_DIR, "otp.txt");
    fs.writeFileSync(filePath, code, "utf-8");
    logger.info(`📂 OTP code written to ${filePath} (also available at /otp.txt)`);
  } catch (err) {
    logger.error("❌ Failed to write OTP file", err);
  }
}

async function startWhatsApp() {
  logger.info("🚀 Starting WhatsApp bridge...");

  // ✅ MongoDB-backed auth state
  const { state, saveCreds } = await useMongoAuthState(
    mongoose.connection.db,
    "wa_sessions"
  );

  const sock = makeWASocket({
    auth: state,
    browser: ["Windows", "Chrome", "118.0.5993.117"],
    version: [2, 3000, 1010000000],
    printQRInTerminal: true, // for local dev
  });

  sock.ev.on("creds.update", saveCreds);

  // ✅ Handle connection lifecycle
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info("📸 QR code generated. Open /qr.png on your server and scan it.");
    }

    if (connection === "open") {
      logger.info("✅ WhatsApp connected successfully.");
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== 401;

      if (shouldReconnect) {
        logger.warn("⚠️ Connection closed. Retrying...");
        startWhatsApp();
      } else {
        logger.error("❌ Session invalid. Clearing and requiring re-login.");

        // ✅ OTP fallback
        if (process.env.WHATSAPP_NUMBER) {
          try {
            const code = await sock.requestPairingCode(
              process.env.WHATSAPP_NUMBER
            );
            logger.info(
              `📲 OTP pairing code for ${process.env.WHATSAPP_NUMBER}: ${code}`
            );
            logger.info("Enter this 8-digit code in WhatsApp → Linked devices.");
            await writeOtpFile(code); // save for web access
          } catch (err) {
            logger.error("❌ Failed to request OTP code", err);
          }
        }
      }
    }
  });

  return sock;
}

async function startApp() {
  logger.info("🔍 Checking required environment variables...");

  if (!process.env.MONGO_URI) throw new Error("❌ MONGO_URI is required");
  if (!process.env.TELEGRAM_BOT_TOKEN)
    throw new Error("❌ TELEGRAM_BOT_TOKEN is required");

  // ✅ Connect Mongo
  logger.info("🟦 Connecting to MongoDB...");
  await mongoose.connect(process.env.MONGO_URI);
  logger.info("✅ Connected to MongoDB");

  // ✅ Start services
  await startWhatsApp();
  await setupTelegram();
  await startServer();

  // ✅ Graceful shutdown
  setupGracefulShutdown();
}

startApp().catch((err) => {
  logger.error("❌ Fatal error starting app", err);
  process.exit(1);
});
