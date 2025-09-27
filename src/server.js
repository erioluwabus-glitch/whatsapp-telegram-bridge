// src/server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import bodyParser from "body-parser";
import logger from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function startServer({ telegramWebhookHandler } = {}) {
  const app = express();

  // ✅ Body parsers
  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: true }));

  // ✅ Serve static public dir (like qr.png, assets)
  const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, "../public");
  app.use(express.static(PUBLIC_DIR));

  // ✅ Health check
  app.get("/healthz", (req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
  });

  // ✅ QR endpoint (if qr.png exists in PUBLIC_DIR)
  app.get("/qr.png", (req, res) => {
    const qrPath = path.join(PUBLIC_DIR, "qr.png");
    res.sendFile(qrPath, (err) => {
      if (err) {
        logger.warn("QR not yet available, refresh after generating...");
        res.status(404).send("QR not yet generated — check logs or retry.");
      }
    });
  });

  // ✅ Telegram webhook
  app.post("/telegram/:token", async (req, res) => {
    const { token } = req.params;

    if (!process.env.TELEGRAM_BOT_TOKEN || token !== process.env.TELEGRAM_BOT_TOKEN) {
      logger.warn("Unauthorized Telegram webhook call");
      return res.status(401).send("Unauthorized");
    }

    if (!telegramWebhookHandler) {
      logger.warn("Telegram webhook handler not yet attached");
      return res.status(503).send("Handler not ready");
    }

    try {
      await telegramWebhookHandler(req.body);
      res.sendStatus(200);
    } catch (err) {
      logger.error("Telegram webhook handler failed:", err);
      res.sendStatus(500);
    }
  });

  // ✅ Start HTTP server
  const PORT = process.env.PORT || 10000;
  app.listen(PORT, () => {
    logger.info(`🌐 Server listening on port ${PORT}`);
    logger.info(`📸 QR available at http://localhost:${PORT}/qr.png`);
  });

  return app;
}
