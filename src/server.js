// src/server.js
import express from "express";
import path from "path";
import fs from "fs";

export function startServer({ publicDir = "./public", port = 10000, adminSecret = null } = {}) {
  const app = express();
  app.use(express.json());

  // ensure publicDir exists
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

  let latestQr = null;
  let telegramHandler = null;

  app.get("/", (req, res) => {
    res.send("✅ WhatsApp–Telegram bridge is live.");
  });

  // serve QR image if it exists in public/qr.png, otherwise 503
  app.get("/qr", (req, res) => {
    const qrFile = path.join(publicDir, "qr.png");
    if (fs.existsSync(qrFile)) {
      return res.sendFile(qrFile);
    }
    if (latestQr) {
      // If for some reason file isn't present but latest QR string exists, return a small message
      return res.status(200).type("text/plain").send("QR string present but png not found; wait a second");
    }
    return res.status(503).send("❌ No QR generated yet. Wait for WhatsApp to request login.");
  });

  // Telegram webhook endpoint; the app will call setTelegramWebhookHandler(handler) to wire handler
  app.post("/telegram/:token", async (req, res) => {
    if (!telegramHandler) return res.status(503).send({ ok: false, error: "Telegram handler not ready" });
    try {
      // handler expects the update object
      await telegramHandler(req.body);
      res.send({ ok: true });
    } catch (err) {
      console.error("Telegram handler failed:", err);
      res.status(500).send({ ok: false, error: String(err) });
    }
  });

  function setTelegramWebhookHandler(handler) {
    telegramHandler = handler;
  }

  function setLatestQr(qr) {
    latestQr = qr;
  }

  const server = app.listen(port, () => {
    console.log(`🌐 Web server started on port ${port} (public dir=${publicDir})`);
  });

  return { app, server, setTelegramWebhookHandler, setLatestQr };
}
