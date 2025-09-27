// src/whatsapp.js
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import qrcode from "qrcode";
import mongoose from "mongoose";
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';

// ---------- Mongoose models ----------
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

// ---------- Helpers ----------
async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
}
async function walkFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...(await walkFiles(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}
function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
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

// ---------- Mongo <-> disk auth persistence ----------
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

// remove auth from Mongo + local dir
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

// ---------- Telegram raw send helper ----------
async function telegramSendRaw(botToken, chatId, payload) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = Object.assign({ chat_id: chatId }, payload);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ---------- Main: startWhatsApp ----------
/**
 * startWhatsApp(options)
 * options:
 *   - telegram: { token, chatId }
 *   - authDir, publicDir
 *   - onReady callback
 */
export async function startWhatsApp({ authDir = './baileys_auth', publicDir = './public', telegram = {}, onReady = () => {}, whatsappOptions = {} }) {
  // ensure publicDir exists
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  // Use provided options or sane defaults
  const browser = whatsappOptions.browser || ['Chrome', 'Windows', '10'];
  const version = whatsappOptions.version || [2, 2413, 12];
  const maxReconnectAttempts = whatsappOptions.maxReconnectAttempts || 5;

  let reconnectAttempts = 0;

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser,
    version,
  });

  // persist credentials
  sock.ev.on('creds.update', saveCreds);

  // helper to write QR to public/qr.png
  async function writeQr(qr) {
    try {
      const qrPath = path.join(publicDir, 'qr.png');
      await qrcode.toFile(qrPath, qr, { width: 300 });
      console.log('WA QR updated ->', qrPath);
    } catch (e) {
      console.error('Failed to write QR file', e);
    }
  }

  // connection updates
  sock.ev.on('connection.update', async (update) => {
    // QR provided
    if (update.qr) await writeQr(update.qr);

    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      reconnectAttempts = 0;
      console.log('WhatsApp connected (open).');
      // expose handler for Telegram wiring once connected
      if (onReady) {
        // pass any helper(s) needed by your telegram adapter. For example:
        onReady({ handleTelegramUpdate: (u) => {/* implement or call your telegram handler */} });
      }
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.warn('WhatsApp connection closed', code);

      // If code is 401 => session invalid
      if (code === 401) {
        reconnectAttempts++;
        if (reconnectAttempts <= maxReconnectAttempts) {
          const backoff = reconnectAttempts * 2000;
          console.warn(`401 received — attempt reconnect #${reconnectAttempts} in ${backoff}ms`);
          setTimeout(() => {
            // try to re-establish connection by re-creating socket (let Node GC old)
            startWhatsApp({ authDir, publicDir, telegram, onReady, whatsappOptions });
          }, backoff);
          return;
        } else {
          console.error('Persistent 401 after reconnect attempts. *Do not auto-clear auth*. Please clear session in MongoDB Atlas (or allow me to do it for you) and then re-deploy / re-run to generate a fresh QR.');
          // signal for manual intervention: do NOT automatically clear data here (safer).
          return;
        }
      }

      // other closes: Baileys will attempt auto-reconnect internally; log it.
      console.warn('Connection closed (non-401). Baileys will auto-reconnect when possible.');
    }
  });

  // persist on creds.update
  sock.ev.on("creds.update", async () => {
    try {
      await saveCreds();
    } catch (e) {
      console.error("saveCreds() failed", e);
    }
    try {
      await persistAuthFilesToMongo(authDir);
    } catch (e) {
      console.error("persistAuthFilesToMongo failed", e);
    }
  });

  // On connection updates
  sock.ev.on("connection.update", async (update) => {
    try {
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        const qrPath = path.join(publicDir, "qr.png");
        await qrcode.toFile(qrPath, qr, { width: 640 }).catch((err) => console.error("qrcode.toFile error:", err));
        const qh = sha256(qr);
        console.info("WA QR updated -> public/qr.png (open your service URL /qr.png)");
      }

      if (connection === "open") {
        console.info("✅ WhatsApp connected");
        // persist auth now that we're open
        await persistAuthFilesToMongo(authDir);
      }

      if (connection === "close") {
        const status = lastDisconnect?.error?.output?.statusCode;
        console.warn("WhatsApp connection closed", status || lastDisconnect?.error || "");
        // if 401: re-login required
        if (status === 401) {
          console.error("❌ WhatsApp session invalid (401). Clearing auth and exiting so the supervisor restarts cleanly.");
          // clear all saved auth (so next start will produce QR)
          try {
            await clearAuthFromMongoAndDisk(authDir);
          } catch (e) {
            console.error("Failed to clear auth:", e);
          }
          // exit so Render / the process manager restarts with a clean state
          setTimeout(() => process.exit(1), 300);
        } else {
          // other closes: let Baileys reconnect automatically; we persisted on creds.update & open
          console.info("Connection closed (non-401). Waiting for automatic reconnect by Baileys.");
        }
      }
    } catch (err) {
      console.error("connection.update handler error:", err);
    }
  });

  // incoming WA messages: forward to Telegram if configured
  sock.ev.on("messages.upsert", async (m) => {
    try {
      if (m.type !== "notify") return;
      for (const msg of m.messages) {
        if (!msg.message) continue;
        if (msg.key?.fromMe) continue;

        const waChatId = msg.key.remoteJid;
        const waMsgId = msg.key.id;
        const text = extractTextFromMessage(msg.message);
        if (!text) {
          console.info("Received non-text message — skipping.");
          continue;
        }
        const sender = msg.pushName || waChatId;
        const forwardText = `🟢 *From WhatsApp* — ${sender}\n\n${text}`;

        if (telegram?.token && telegram?.chatId) {
          const resp = await telegramSendRaw(telegram.token, telegram.chatId, { text: forwardText, parse_mode: "Markdown" }).catch((e) => ({ ok: false, error: e }));
          if (resp?.ok) {
            await MessageMap.create({
              waChatId,
              waMessageId: waMsgId,
              telegramChatId: String(telegram.chatId),
              telegramMessageId: resp.result.message_id,
            }).catch((err) => console.error("MessageMap.create error", err));

            await sock.sendMessage(waChatId, { text: `✅ Your message was forwarded to the Telegram group (msg id ${resp.result.message_id}).` }, { quoted: msg }).catch(() => {});
          } else {
            console.error("Telegram send failed", resp);
            await sock.sendMessage(waChatId, { text: `❌ Failed to forward to Telegram: ${String(resp?.error || resp)}` }, { quoted: msg }).catch(() => {});
          }
        } else {
          await sock.sendMessage(waChatId, { text: "⚠️ Bridge is not configured with Telegram token/chat ID." }, { quoted: msg }).catch(() => {});
        }
      }
    } catch (err) {
      console.error("messages.upsert handler error:", err);
    }
  });

  // handler to receive Telegram updates (server will call this by POST)
  async function handleTelegramUpdate(update) {
    try {
      if (!update) return;
      const msg = update.message || update.edited_message;
      if (!msg) return;

      if (msg.reply_to_message && msg.reply_to_message.message_id) {
        const replyToId = msg.reply_to_message.message_id;
        const mapping = await MessageMap.findOne({ 
          telegramChatId: String(msg.chat?.id), 
          telegramMessageId: replyToId 
        }).sort({ createdAt: -1 });

        if (!mapping) {
          console.info("No mapping found for telegram reply -> not a WA-forwarded message.");
          return;
        }

        const replyText = msg.text || msg.caption || "";
        if (!replyText) return;

        await sock.sendMessage(mapping.waChatId, { text: `🟦 Reply from Telegram:\n\n${replyText}` });

        const botToken = process.env.TELEGRAM_TOKEN;
        if (botToken) {
          await telegramSendRaw(botToken, msg.chat.id, { 
            text: `✅ Delivered reply to WhatsApp (to ${mapping.waChatId})`, 
            reply_to_message_id: msg.message_id 
          });
        }
      }
    } catch (err) {
      console.error("handleTelegramUpdate error:", err);
    }
  }

  // expose a tiny helper so external admin code can persist immediately
  async function persistNow() {
    try {
      await persistAuthFilesToMongo(authDir);
    } catch (e) {
      console.warn("persistNow failed:", e);
    }
  }

  // call orchestrator hook (index.js wires this to Telegram)
  onReady({ 
    sock, 
    sendTextToJid: async (jid, text) => sock.sendMessage(jid, { text }), 
    handleTelegramUpdate, 
    persistAuthFilesToMongo: persistNow 
  });

  // ✅ return once, at the end
  return { 
    sock, 
    handleTelegramUpdate, 
    persistAuthFilesToMongo: persistNow, 
    clearAuthFromMongoAndDisk 
  };
}
