// src/whatsapp.js
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import qrcode from 'qrcode';
import { makeWASocket, useMultiFileAuthState } from '@whiskeysockets/baileys';
import mongoose from 'mongoose';

// ---------- Models (create if not present) ----------
const AuthFileSchema = new mongoose.Schema({
  path: { type: String, required: true, unique: true },
  contentBase64: { type: String, required: true },
  updatedAt: { type: Date, default: Date.now },
});
const MessageMapSchema = new mongoose.Schema({
  waChatId: String,        // e.g. '123456789@s.whatsapp.net'
  waMessageId: String,     // message.key.id
  telegramChatId: String,  // group id as string
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
    if (e.isDirectory()) {
      files.push(...await walkFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}
function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}
function extractTextFromMessage(msg) {
  if (!msg) return null;
  // common text locations in Baileys message object
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
  if (msg.imageMessage?.caption) return msg.imageMessage.caption;
  if (msg.documentMessage?.caption) return msg.documentMessage.caption;
  if (msg.videoMessage?.caption) return msg.videoMessage.caption;
  return null;
}

// ---------- Mongo <-> disk auth persistence ----------
export async function restoreAuthFilesFromMongo(authDir = './baileys_auth') {
  const docs = await AuthFile.find({});
  if (!docs || docs.length === 0) {
    console.info('No saved Baileys auth files found in Mongo; starting fresh.');
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
    console.info('Persisted Baileys auth files to Mongo (Session updated)');
  } catch (err) {
    console.error('Error persisting auth files to Mongo:', err);
  }
}

// ---------- Telegram send helper (simple) ----------
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

// ---------- Main: startWhatsApp ----------
/**
 * startWhatsApp(options)
 * options:
 *   - telegram: { token, chatId }  (chatId is the GROUP to forward into)
 *   - authDir (optional)
 *   - publicDir (optional) where qr.png will be written
 *   - onReady callback (optional)
 *
 * returns { sock, sendTextToJid, handleTelegramUpdate }  -- keep the socket API accessible
 */
export async function startWhatsApp(options = {}) {
  const {
    telegram = { token: process.env.TELEGRAM_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID },
    authDir = './baileys_auth',
    publicDir = './public',
    onReady = () => {},
  } = options;

  if (!telegram.token || !telegram.chatId) {
    console.warn('Telegram token/chatId missing. Telegram forwarding will be disabled until envs are set.');
  }

  // ensure directories
  await ensureDir(authDir);
  await ensureDir(publicDir);

  // restore auth files from mongo first (so useMultiFileAuthState will pick them up)
  await restoreAuthFilesFromMongo(authDir).catch(err => {
    console.warn('restoreAuthFilesFromMongo failed:', err);
  });

  // use file auth (Baileys will create many files under authDir)
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    // browser: ['Render', 'Bridge', '1.0'],
  });

  // track last QR hash so we don't spam email every tiny change
  let lastQrHash = null;
  let lastQrEmailSentHash = null;

  // persist creds to mongo each time creds.update fires (and also call saveCreds)
  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();
    } catch (e) {
      console.error('saveCreds() failed', e);
    }
    try {
      await persistAuthFilesToMongo(authDir);
    } catch (e) {
      console.error('persistAuthFilesToMongo failed', e);
    }
  });

  sock.ev.on('connection.update', async (update) => {
    try {
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        // create qr.png and a tiny metadata file with the QR hash
        const qrPath = path.join(publicDir, 'qr.png');
        await qrcode.toFile(qrPath, qr, { width: 640 }).catch(err => {
          console.error('qrcode.toFile error:', err);
        });
        const qh = sha256(qr);
        lastQrHash = qh;
        console.info('WA QR updated -> public/qr.png (open your service URL /qr.png)');
        // optional: send an email once per new QR if SMTP configured
        if (process.env.QR_NOTIFY_EMAIL === '1' && qh !== lastQrEmailSentHash) {
          lastQrEmailSentHash = qh;
          // fire-and-forget: email sending function implemented below (optional)
          if (process.env.SMTP_HOST && process.env.EMAIL_TO) {
            sendQrEmail(`${process.env.WEBHOOK_BASE_URL || process.env.WEBHOOK_BASE_URL || ''}/qr.png`)
              .catch(err => console.error('sendQrEmail failed:', err));
          }
        }
      }

      if (connection === 'open') {
        console.info('✅ WhatsApp connected');
        // persist auth files to mongo so future restarts don't require QR.
        await persistAuthFilesToMongo(authDir);
      }

      if (connection === 'close') {
        console.warn('WhatsApp connection closed', lastDisconnect?.error || '');
        // Baileys usually reconnects automatically; if you want you can handle specific disconnect reasons
      }
    } catch (err) {
      console.error('connection.update handler error:', err);
    }
  });

  // handle incoming WA messages and forward to Telegram
  sock.ev.on('messages.upsert', async (m) => {
    try {
      if (m.type !== 'notify') return;
      for (const msg of m.messages) {
        if (!msg.message) continue;
        // ignore messages from me
        if (msg.key?.fromMe) continue;

        const waChatId = msg.key.remoteJid;
        const waMsgId = msg.key.id;
        const text = extractTextFromMessage(msg.message);

        if (!text) {
          // not handling media etc in this simple example
          console.info('Received non-text message — skipping (extend if you want media handling).');
          continue;
        }

        const sender = (msg.pushName || waChatId);
        const forwardText = `🟢 *From WhatsApp* — ${sender}\n\n${text}`;

        if (telegram?.token && telegram?.chatId) {
          const resp = await telegramSendRaw(telegram.token, telegram.chatId, { text: forwardText, parse_mode: 'Markdown' })
            .catch(e => ({ ok: false, error: e }));

          if (resp?.ok) {
            // persist a mapping (so Telegram replies can be routed back)
            await MessageMap.create({
              waChatId,
              waMessageId: waMsgId,
              telegramChatId: String(telegram.chatId),
              telegramMessageId: resp.result.message_id,
            }).catch(err => console.error('MessageMap.create error', err));

            // send acknowledgement back to WA sender
            await sock.sendMessage(waChatId, {
              text: `✅ Your message was forwarded to the Telegram group (msg id ${resp.result.message_id}).`,
            }, { quoted: msg }).catch(e => console.error('ack send failed', e));
          } else {
            console.error('Telegram send failed', resp);
            // notify sender of failure
            await sock.sendMessage(waChatId, {
              text: `❌ Failed to forward to Telegram: ${String(resp?.error || resp)}`,
            }, { quoted: msg }).catch(() => {});
          }
        } else {
          // Telegram not configured
          await sock.sendMessage(waChatId, { text: '⚠️ Bridge is not configured with Telegram token/chat ID.' }, { quoted: msg }).catch(() => {});
        }
      }
    } catch (err) {
      console.error('messages.upsert handler error:', err);
    }
  });

  // helper: send text to a jid
  async function sendTextToJid(jid, text) {
    if (!jid) throw new Error('jid required');
    return sock.sendMessage(jid, { text });
  }

  // Handler for Telegram webhook updates (exported) - call from server when POST comes
  // Expect Telegram update JSON
  async function handleTelegramUpdate(update) {
    try {
      if (!update) return;
      const msg = update.message || update.edited_message;
      if (!msg) return;

      // only handle replies that reply_to_message (i.e., someone replies to forwarded WA message)
      if (msg.reply_to_message && msg.reply_to_message.message_id) {
        const replyToId = msg.reply_to_message.message_id;
        // find mapping
        const mapping = await MessageMap.findOne({ telegramChatId: String(msg.chat?.id), telegramMessageId: replyToId }).sort({ createdAt: -1 });
        if (!mapping) {
          console.info('No mapping found for telegram reply -> not a WA-forwarded message.');
          return;
        }

        // get reply text
        const replyText = msg.text || msg.caption || '';
        if (!replyText) return;

        // send to WA
        await sendTextToJid(mapping.waChatId, `🟦 Reply from Telegram:\n\n${replyText}`);
        // acknowledgement in Telegram (reply to the reply)
        const botToken = process.env.TELEGRAM_TOKEN;
        if (botToken) {
          await telegramSendRaw(botToken, msg.chat.id, { text: `✅ Delivered reply to WhatsApp (to ${mapping.waChatId})`, reply_to_message_id: msg.message_id });
        }
      } else {
        // not a reply - optionally allow manual send to a WA number (not implemented here)
        console.debug('Telegram update received (not a reply) — ignoring.');
      }

    } catch (err) {
      console.error('handleTelegramUpdate error:', err);
    }
  }

  // optional: email QR link (very small, uses nodemailer). Only used if SMTP envs are present.
  async function sendQrEmail(qrUrl) {
    if (!process.env.SMTP_HOST) {
      throw new Error('SMTP_HOST not set');
    }
    // lazy require nodemailer so the package is optional
    const nodemailer = await import('nodemailer').then(m => m.default);
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: (process.env.SMTP_SECURE === '1' || process.env.SMTP_PORT === '465'),
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    const mailOpts = {
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
      to: process.env.EMAIL_TO,
      subject: 'Bridge QR (scan to link WhatsApp)',
      html: `Open this on your phone and scan: <a href="${qrUrl}">${qrUrl}</a><br/><img src="${qrUrl}" style="max-width:320px"/>`,
    };
    await transporter.sendMail(mailOpts);
    console.info('QR email sent to', process.env.EMAIL_TO);
  }

  // done, call onReady
  onReady({ sock, sendTextToJid, handleTelegramUpdate });

  return { sock, sendTextToJid, handleTelegramUpdate, persistAuthFilesToMongo };
}
