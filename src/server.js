// src/server.js
import express from "express";
import path from "path";
import fs from "fs/promises";

export function startServer({ publicDir = "./public", port = process.env.PORT || 10000, adminSecret = process.env.ADMIN_SECRET } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));

  // static public folder (qr.png etc)
  app.use(express.static(publicDir));

  app.get("/health", (req, res) => res.json({ ok: true }));

  // placeholder for telegram handler (set by orchestrator)
  let telegramHandler = null;
  app.post("/telegram/:token", async (req, res) => {
    const tokenFromPath = req.params.token;
    if (process.env.TELEGRAM_TOKEN && tokenFromPath !== process.env.TELEGRAM_TOKEN) {
      return res.status(401).json({ ok: false, error: "invalid token path" });
    }
    if (!telegramHandler) return res.status(503).json({ ok: false, error: "telegram handler not configured" });
    try {
      await telegramHandler(req.body);
      return res.status(200).send("OK");
    } catch (err) {
      console.error("Telegram webhook handler error:", err);
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  // Admin endpoints (protected with ADMIN_SECRET)
  function checkAdmin(req, res) {
    if (!adminSecret) return res.status(403).json({ ok: false, error: "admin disabled" });
    const provided = req.query.secret || req.headers["x-admin-secret"];
    if (!provided || provided !== adminSecret) return res.status(401).json({ ok: false, error: "invalid admin secret" });
    return null;
  }

  // Clears local auth directory files (if present)
  app.post("/admin/clear-local-auth", async (req, res) => {
    const bad = checkAdmin(req, res);
    if (bad) return bad;
    const authDir = req.body?.authDir || "./baileys_auth";
    try {
      // remove auth dir entirely (render machine will recreate on startup if needed)
      await fs.rm(authDir, { recursive: true, force: true });
      console.info("Admin: local auth dir cleared:", authDir);
      return res.json({ ok: true, cleared: authDir });
    } catch (err) {
      console.error("Admin clear-local-auth error:", err);
      return res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // Trigger a controlled process exit so the platform restarts the service.
  app.post("/admin/restart", async (req, res) => {
    const bad = checkAdmin(req, res);
    if (bad) return bad;
    res.json({ ok: true, msg: "Process will exit now (supervisor should restart it)" });
    console.info("Admin: restarting process by request");
    // give response a moment
    setTimeout(() => process.exit(0), 250);
  });

  const server = app.listen(port, () => {
    console.info(`🌐 Web server started on port ${port} (public dir=${publicDir})`);
  });

  function setTelegramWebhookHandler(h) {
    telegramHandler = h;
    console.info("✅ Telegram webhook handler attached to server");
  }

  return { app, server, setTelegramWebhookHandler };
}
