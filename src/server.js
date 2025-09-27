// src/server.js
import express from "express";
import path from "path";
import qrcode from "qrcode";

export function startServer({ publicDir, port, adminSecret }) {
  const app = express();

  let latestQr = null; // store QR from WhatsApp

  // Route: home
  app.get("/", (req, res) => {
    res.send("✅ WhatsApp–Telegram bridge is live.");
  });

  // Route: QR (for pairing WhatsApp)
  app.get("/qr", async (req, res) => {
    if (!latestQr) {
      return res.status(503).send("❌ No QR generated yet. Wait for WhatsApp to request login.");
    }
    try {
      const qrImage = await qrcode.toDataURL(latestQr, { margin: 2, scale: 8 });
      const img = Buffer.from(qrImage.split(",")[1], "base64");
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(img);
    } catch (err) {
      res.status(500).send("Error generating QR: " + err.message);
    }
  });

  const server = app.listen(port, () => {
    console.log(`🌐 Web server started on port ${port} (public dir=${publicDir})`);
  });

  // Function for WhatsApp module to update QR
  function setLatestQr(qr) {
    latestQr = qr;
  }

  // Wire Telegram handler later
  let telegramHandler = null;
  app.post("/telegram/:token", express.json(), (req, res) => {
    if (telegramHandler) {
      telegramHandler(req, res);
    } else {
      res.status(503).send("Telegram handler not ready");
    }
  });

  return {
    app,
    server,
    setTelegramWebhookHandler: (handler) => {
      telegramHandler = handler;
    },
    setLatestQr, // expose this to whatsapp.js
  };
}
