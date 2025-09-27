// src/whatsapp.js
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import qrcode from 'qrcode';
import mongoose from 'mongoose';
import { makeWASocket, useMultiFileAuthState } from '@whiskeysockets/baileys';

// ---------- Models ----------
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
const AuthFile = mongoose.models.AuthFile || mongoose.model('AuthFile', AuthFileSchema);
const MessageMap = mongoose.models.MessageMap || mongoose.model('MessageMap', MessageMapSchema);

// ---------- Helpers ----------
async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
}
async function walkFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...await walkFiles(full));
    else files.push(full);
  }
  return files;
}
function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
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

// ---------- Mongo <-> Disk Persistence ----------
export async function restoreAuthFilesFromMongo(authDir = './baileys_auth') {
  const docs = await AuthFile.find({});
  if (!docs || docs.length === 0) {
    console.info('No saved Baileys auth in Mongo; starting fresh.');
    return false;
  }
  await ensureDir(authDir);
  for (const d of docs) {
    const p = path.join(authDir, d.path);
    await ensureDir(path.dirname(p));
    await fs.writeFile(p, Buffer.from(d.contentBase64, 'base64'));
  }
  console.info('Restored Baileys auth files from Mongo');
  return true;
}
export async function persistAuthFilesToMongo(authDir = './baileys_auth') {
  try {
    if (!fsSync.existsSync(authDir)) return;
    const files = await walkFiles(authDir);
    for (const f of files) {
      const rel = path.relative(authDir, f);
      const content = await fs.readFile(f);
      await AuthFile.updateOne(
        { path: rel },
        { path: rel, contentBase64: content.toString('base64'), updatedAt: new Date() },
        { upsert: true }
      );
    }
    console.info('✅ Persisted Baileys auth files to Mongo');
  } catch (err) {
    console.error('❌ Error persisting auth files:', err);
  }
}

// ---------- Telegram Helper ----------
async function telegramSendRaw(botToken, chatId, payload) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = Object.assign({ chat_id: chatId }, payload);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ---------- Main: WhatsApp Start ----------
export async function startWhatsApp(options = {}) {
  const {
    telegram = { token: process.env.TELEGRAM_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID },
    authDir = './baileys_auth',
    publicDir = './public',
    onReady = () => {},
  } = options;

  await ensureDir(authDir);
  await ensureDir(publicDir);

  await restoreAuthFilesFromMongo(authDir).catch(err =>
    console.warn('restoreAuthFilesFromMongo failed:', err)
  );

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['Render', 'Bridge', '1.0'],
  });

  // Persist auth updates
  sock.ev.on('creds.update', async () => {
    await saveCreds().catch(e => console.error('saveCreds failed', e));
    await persistAuthFilesToMongo(authDir);
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      const qrPath = path.join(publicDir, 'qr.png');
      await qrcode.toFile(qrPath, qr, { width: 640 });
      console.info(`📸 QR updated: open /qr.png on your server to scan`);
    }

    if (connection === 'open') {
      console.info('✅ WhatsApp connected');
      await persistAuthFilesToMongo(authDir);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.warn('⚠️ WA connection closed', code || '');
      if (code === 401 && process.env.WHATSAPP_NUMBER) {
        try {
          const pairingCode = await sock.requestPairingCode(process.env.WHATSAPP_NUMBER);
          console.info(`📲 OTP for ${process.env.WHATSAPP_NUMBER}: ${pairingCode}`);
        } catch (err) {
          console.error('❌ OTP request failed:', err);
        }
      }
    }
  });

  // Forward incoming WA → Telegram
  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;
    for (const msg of m.messages) {
      if (!msg.message || msg.key?.fromMe) continue;
      const waChatId = msg.key.remoteJid;
      const waMsgId = msg.key.id;
      const text = extractTextFromMessage(msg.message);
      if (!text) continue;

      const sender = msg.pushName || waChatId;
      const forwardText = `🟢 *From WhatsApp* — ${sender}\n\n${text}`;

      if (telegram?.token && telegram?.chatId) {
        const resp = await telegramSendRaw(telegram.token, telegram.chatId, {
          text: forwardText,
          parse_mode: 'Markdown',
        }).catch(e => ({ ok: false, error: e }));

        if (resp?.ok) {
          await MessageMap.create({
            waChatId,
            waMessageId: waMsgId,
            telegramChatId: String(telegram.chatId),
            telegramMessageId: resp.result.message_id,
          }).catch(err => console.error('MessageMap.create error', err));
        } else {
          await sock.sendMessage(waChatId, { text: `❌ Failed to forward to Telegram` });
        }
      }
    }
  });

  async function sendTextToJid(jid, text) {
    if (!jid) throw new Error('jid required');
    return sock.sendMessage(jid, { text });
  }

  async function handleTelegramUpdate(update) {
    const msg = update.message || update.edited_message;
    if (!msg?.reply_to_message?.message_id) return;
    const replyToId = msg.reply_to_message.message_id;
    const mapping = await MessageMap.findOne({
      telegramChatId: String(msg.chat?.id),
      telegramMessageId: replyToId,
    }).sort({ createdAt: -1 });

    if (!mapping) return;
    const replyText = msg.text || msg.caption || '';
    if (!replyText) return;
    await sendTextToJid(mapping.waChatId, `🟦 Reply from Telegram:\n\n${replyText}`);
  }

  onReady({ sock, sendTextToJid, handleTelegramUpdate });
  return { sock, sendTextToJid, handleTelegramUpdate, persistAuthFilesToMongo };
}
