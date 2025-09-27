// src/whatsapp.js
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import qrcode from "qrcode";
import mongoose from "mongoose";
import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys";

// Mongoose models for storing auth files & message mapping
const AuthFileSchema = new mongoose.Schema({
  path: { type: String, required: true, unique: true },
  contentBase64: { type: String, required: true },
  updatedAt: { type: Date, default: Date.now },
});
const MessageMapSchema = new mongoose.Schema({
  waChatId: String,
  waMessageId: String,
  telegramChatId: String,
  telegramMessageId: Number,
  createdAt: { type: Date, default: Date.now },
});
const AuthFile = mongoose.models.AuthFile || mongoose.model("AuthFile", AuthFileSchema);
const MessageMap = mongoose.models.MessageMap || mongoose.model("MessageMap", MessageMapSchema);

// Helpers
async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
}
async function walkFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...(await walkFiles(full)));
    else files.push(full);
  }
  return files;
}
function extractTextFromMessage(msg) {
  if (!msg) return null;
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
  if (msg.imageMessage?.caption) return msg.imageMessage.caption;
  if (msg.documentMessage?.caption) return msg.documentMessage.caption;
  if (msg.videoMessage?.caption) return msg.videoMessage.caption;
  return null;
}

// Mongo <-> disk persistence
export async function restoreAuthFilesFromMongo(authDir = "./baileys_auth") {
  const docs = await AuthFile.find({});
  if (!docs || docs.length === 0) {
    console.info("No saved Baileys auth files found in Mongo; starting fresh.");
    return false;
  }
  await ensureDir(authDir);
  for (const d of docs) {
    const p = path.join(authDir, d.path);
    await ensureDir(path.dirname(p));
    await fs.writeFile(p, Buffer.from(d.contentBase64, "base64"));
  }
  console.info("Restored Baileys auth files from Mongo");
  return true;
}

export async function persistAuthFilesToMongo(authDir = "./baileys_auth") {
  try {
    if (!fsSync.existsSync(authDir)) return;
    const files = await walkFiles(authDir);
    for (const f of files) {
      const rel = path.relative(authDir, f);
      const content = await fs.readFile(f);
      await AuthFile.updateOne(
        { path: rel },
        { path: rel, contentBase64: content.toString("base64"), updatedAt: new Date() },
        { upsert: true }
      );
    }
    console.info("Persisted Baileys auth files to Mongo (Session updated)");
  } catch (err) {
    console.error("Error persisting auth files to Mongo:", err);
  }
}

export async function clearAuthFromMongoAndDisk(authDir = "./baileys_auth") {
  try {
    await AuthFile.deleteMany({});
  } catch (err) {
    console.warn("clearAuth: failed to delete auth docs from Mongo:", err);
  }
  try {
    await fs.rm(authDir, { recursive: true, force: true });
  } catch (err) {
    console.warn("clearAuth: failed to remove local auth dir:", err);
  }
  console.info("Cleared auth files from Mongo and disk");
}

// Main start function
export async function startWhatsApp({ authDir = "./baileys_auth", publicDir = "./public", telegram = {}, onReady = () => {}, whatsappOptions = {}, setLatestQr = undefined } = {}) {
  // ensure public dir exists
  if (!fsSync.existsSync(publicDir)) fsSync.mkdirSync(publicDir, { recursive: true });

  // restore existing auth from Mongo into authDir (optional)
  try {
    await restoreAuthFilesFromMongo(authDir);
  } catch (e) {
    console.warn("restoreAuthFilesFromMongo failed:", e);
  }

  // create auth state
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  // sensible defaults
  const browser = whatsappOptions.browser || ["Chrome", "Windows", "10"];
  const version = whatsappOptions.version || [2, 2413, 12];
  const maxReconnectAttempts = whatsappOptions.maxReconnectAttempts || 5;
  let reconnectAttempts = 0;

  // helper to write QR to public/qr.png
  async function writeQr(qr) {
    try {
      const qrPath = path.join(publicDir, "qr.png");
      await qrcode.toFile(qrPath, qr, { width: 400 });
      console.info("WA QR updated -> public/qr.png (open your service URL /qr)");
    } catch (e) {
      console.error("Failed to write QR file:", e);
    }
  }

  // make socket
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser,
    version,
  });

  // persist credentials to auth state files
  sock.ev.on("creds.update", saveCreds);

  // whenever creds.update happens, persist to Mongo as well
  sock.ev.on("creds.update", async () => {
    try {
      await persistAuthFilesToMongo(authDir);
    } catch (e) {
      console.error("persistAuthFilesToMongo failed:", e);
    }
  });

  // connection updates
  sock.ev.on("connection.update", async (update) => {
    try {
      if (update.qr) {
        // write PNG and inform server
        await writeQr(update.qr);
        if (typeof setLatestQr === "function") {
          try {
            setLatestQr(update.qr);
            console.info("setLatestQr: updated server QR");
          } catch (e) {
            console.warn("setLatestQr failed:", e);
          }
        }
      }

      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        reconnectAttempts = 0;
        console.info("✅ WhatsApp connected");
        // persist auth once open
        await persistAuthFilesToMongo(authDir);
        // notify orchestrator
        onReady({ sock, handleTelegramUpdate, persistAuthFilesToMongo: async () => persistAuthFilesToMongo(authDir) });
      }

      if (connection === "close") {
        const status = lastDisconnect?.error?.output?.statusCode;
        console.warn("WhatsApp connection closed", status || lastDisconnect?.error || "");
        if (status === 401) {
          // session invalid — try a few reconnects, then require manual intervention
          reconnectAttempts++;
          if (reconnectAttempts <= maxReconnectAttempts) {
            const backoff = reconnectAttempts * 2000;
            console.warn(`401 received — will attempt reconnect #${reconnectAttempts} in ${backoff}ms`);
            setTimeout(() => {
              // re-create connection by re-calling startWhatsApp from your orchestrator if you prefer;
              // Here we let the process stay alive and rely on supervisor to restart if needed.
            }, backoff);
          } else {
            console.error("❌ Persistent 401 — session invalid. Please clear auth in Mongo and re-scan the QR.");
            // do not auto-clear here to avoid loops; operator should clear via Atlas or call exported function clearAuthFromMongoAndDisk
          }
        } else {
          console.info("Connection closed (non-401). Waiting for automatic reconnect by Baileys.");
        }
      }
    } catch (err) {
      console.error("connection.update handler error:", err);
    }
  });

  // messages.upsert -> forward to Telegram (if configured)
  sock.ev.on("messages.upsert", async (m) => {
    try {
      if (m.type !== "notify") return;
      for (const msg of m.messages) {
        if (!msg.message) continue;
        if (msg.key?.fromMe) continue;

        const waChatId = msg.key.remoteJid;
        const waMsgId = msg.key.id;
        const text = extractTextFromMessage(msg.message);
        if (!text) continue;

        const sender = msg.pushName || waChatId;
        const forwardText = `🟢 *From WhatsApp* — ${sender}\n\n${text}`;

        if (telegram?.token && telegram?.chatId) {
          try {
            const res = await fetch(`https://api.telegram.org/bot${telegram.token}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: telegram.chatId, text: forwardText, parse_mode: "Markdown" }),
            });
            const data = await res.json();
            if (data?.ok) {
              await MessageMap.create({
                waChatId,
                waMessageId: waMsgId,
                telegramChatId: String(telegram.chatId),
                telegramMessageId: data.result.message_id,
              }).catch((err) => console.error("MessageMap.create error", err));
              await sock.sendMessage(waChatId, { text: `✅ Your message was forwarded to the Telegram group (msg id ${data.result.message_id}).` }, { quoted: msg }).catch(() => {});
            } else {
              console.error("Telegram send failed", data);
              await sock.sendMessage(waChatId, { text: `❌ Failed to forward to Telegram: ${JSON.stringify(data)}` }, { quoted: msg }).catch(() => {});
            }
          } catch (e) {
            console.error("Telegram send error", e);
          }
        } else {
          await sock.sendMessage(waChatId, { text: "⚠️ Bridge is not configured with Telegram token/chat ID." }, { quoted: msg }).catch(() => {});
        }
      }
    } catch (err) {
      console.error("messages.upsert handler error:", err);
    }
  });

  // Telegram -> WhatsApp reply handling function (the server will call this)
  async function handleTelegramUpdate(update) {
    try {
      if (!update) return;
      const msg = update.message || update.edited_message;
      if (!msg) return;

      if (msg.reply_to_message && msg.reply_to_message.message_id) {
        const replyToId = msg.reply_to_message.message_id;
        const mapping = await MessageMap.findOne({ telegramChatId: String(msg.chat?.id), telegramMessageId: replyToId }).sort({ createdAt: -1 });
        if (!mapping) {
          console.info("No mapping found for telegram reply -> not a WA-forwarded message.");
          return;
        }

        const replyText = msg.text || msg.caption || "";
        if (!replyText) return;

        await sock.sendMessage(mapping.waChatId, { text: `🟦 Reply from Telegram:\n\n${replyText}` });

        const botToken = process.env.TELEGRAM_TOKEN;
        if (botToken) {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: msg.chat.id, text: `✅ Delivered reply to WhatsApp (to ${mapping.waChatId})`, reply_to_message_id: msg.message_id }),
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.error("handleTelegramUpdate error:", err);
    }
  }

  // helper: manually persist auth to Mongo
  async function persistNow() {
    try {
      await persistAuthFilesToMongo(authDir);
    } catch (e) {
      console.warn("persistNow failed:", e);
    }
  }

  // call onReady (orchestrator may wire the telegram handler)
  // onReady is called when the connection opens inside connection.update above,
  // but we also expose onReady in the returned object if caller wants immediate wiring.
  return {
    sock,
    handleTelegramUpdate,
    persistAuthFilesToMongo: persistNow,
    clearAuthFromMongoAndDisk,
  };
}
