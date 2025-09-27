// src/server.js
// Small Express server exposing:
//  - static public dir (so /qr.png works)
//  - POST /telegram/:token  (delegates to a handler set at runtime)
// Exports startServer(...) which returns { app, server, setTelegramWebhookHandler }

import express from "express";
import path from "path";

export function startServer({ publicDir = "./public", port = process.env.PORT || 10000 } = {}) {
  const app = express();
  app.disable("x-powered-by");

  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));

  // static public folder (qr.png, status pages)
  app.use(express.static(publicDir));

  // simple health
  app.get("/health", (req, res) => res.json({ ok: true }));

  // holder for handler (will be set by orchestrator once WA is ready)
  let telegramHandler = null;

  // The path Telegram will call is /telegram/:token (we check token against env for safety)
  app.post("/telegram/:token", async (req, res) => {
    const tokenFromPath = req.params.token;
    // verify token if env set, otherwise accept but warn
    if (process.env.TELEGRAM_TOKEN && tokenFromPath !== process.env.TELEGRAM_TOKEN) {
      console.warn("Telegram webhook invoked with mismatched token in path.");
      return res.status(401).json({ ok: false, error: "invalid token path" });
    }

    if (!telegramHandler) {
      // not ready yet
      return res.status(503).json({ ok: false, error: "telegram handler not configured" });
    }

    try {
      // delegate; handler expects the raw update object
      await telegramHandler(req.body);
      // reply quickly — nothing special required.
      return res.status(200).send("OK");
    } catch (err) {
      console.error("Telegram webhook handler error:", err);
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  // Start listening
  const server = app.listen(port, () => {
    console.info(`🌐 Web server started on port ${port} (public dir=${publicDir})`);
  });

  function setTelegramWebhookHandler(handler) {
    telegramHandler = handler;
    console.info("✅ Telegram webhook handler attached to server");
  }

  return { app, server, setTelegramWebhookHandler };
}
