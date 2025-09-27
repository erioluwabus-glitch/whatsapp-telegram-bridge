// src/index.js
import express from "express";
import { startWhatsApp } from "./wa.js";
import { setupTelegram } from "./telegram.js";

const app = express();
const PORT = process.env.PORT || 10000;

let wa; // global reference for WhatsApp session

// Start WhatsApp once
async function init() {
  try {
    console.info("🔍 Checking required environment variables...");

    wa = await startWhatsApp({
      mongoUri: process.env.MONGO_URI,
      telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
      publicUrl: process.env.PUBLIC_URL,
    });

    console.info("🚀 WhatsApp bridge initialized.");
  } catch (err) {
    console.error("❌ Failed to start WhatsApp:", err);
    process.exit(1);
  }
}

init();

// ===== EXPRESS SERVER ===== //
app.use(express.static("public")); // serve /public dir

// QR endpoint
app.get("/qr", async (req, res) => {
  try {
    if (!wa || !wa.getQR) {
      return res.send("❌ WhatsApp not ready yet.");
    }
    const qr = await wa.getQR();
    if (!qr) return res.send("❌ No QR generated yet. Wait for WhatsApp to request login.");
    res.type("png");
    res.send(qr);
  } catch (err) {
    console.error("QR error:", err);
    res.status(500).send("❌ Failed to generate QR");
  }
});

// Telegram webhook
setupTelegram(app, wa);

app.listen(PORT, () => {
  console.log(`🌐 Web server started on port ${PORT} (public dir=./public)`);
});
