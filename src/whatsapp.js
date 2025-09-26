// src/whatsapp.js
import fs from 'fs/promises';
import path from 'path';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import logger from './logger.js';
import Session from './models/Session.js';
import Mapping from './models/Mapping.js';

const AUTH_DIR = './baileys_auth';

let telegramBotRef = null; // will be attached from index.js after telegram bot is ready
export function attachTelegramBot(bot) {
  telegramBotRef = bot;
}

async function ensureAuthDirFromMongo() {
  try {
    const doc = await Session.findOne({ id: 'whatsapp-session' }).lean();
    if (!doc || !doc.files) return;
    await fs.mkdir(AUTH_DIR, { recursive: true });
    for (const [filename, content] of Object.entries(Object.fromEntries(doc.files || []))) {
      await fs.writeFile(path.join(AUTH_DIR, filename), content, 'utf8');
    }
    logger.info({ dir: AUTH_DIR }, 'Restored Baileys auth files from Mongo');
  } catch (err) {
    logger.warn({ err }, 'Could not restore auth files from Mongo (starting fresh)');
  }
}

async function persistAuthDirToMongo() {
  try {
    const files = {};
    const entries = await fs.readdir(AUTH_DIR).catch(() => []);
    for (const f of entries) {
      const c = await fs.readFile(path.join(AUTH_DIR, f), 'utf8');
      files[f] = c;
    }
    await Session.findOneAndUpdate(
      { id: 'whatsapp-session' },
      { id: 'whatsapp-session', files, updatedAt: new Date() },
      { upsert: true }
    );
    logger.info('Saved Baileys auth files to Mongo');
  } catch (err) {
    logger.error({ err }, 'Failed to persist Baileys auth files to Mongo');
  }
}

export async function startWhatsApp() {
  await ensureAuthDirFromMongo();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true // will cause QR data in connection.update events
  });

  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds(); // writes to AUTH_DIR
      await persistAuthDirToMongo();
    } catch (err) {
      logger.error({ err }, 'Error saving creds');
    }
  });

  sock.ev.on('connection.update', (update) => {
    logger.info({ update }, 'WA connection.update');
    const { connection, qr, lastDisconnect } = update;
    if (qr) {
      // logs the raw QR string (you can convert to PNG via a QR API)
      logger.info({ qr }, 'WA QR code (copy & render as QR image to scan)');
    }
    if (connection === 'open') {
      logger.info('✅ WhatsApp connected');
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      logger.info({ statusCode, shouldReconnect }, 'WA connection closed');
      if (shouldReconnect) setTimeout(() => startWhatsApp(), 5000);
      else logger.warn('WA logged out — need to re-scan QR');
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages?.[0];
      if (!msg || msg.key?.fromMe) return;

      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || null;
      const senderJid = msg.key.remoteJid;
      if (!text) return;

      logger.info({ senderJid, text }, 'Incoming WA message');
      if (!telegramBotRef) {
        logger.warn('Telegram bot not attached yet — dropping forwarding for now');
        return;
      }

      // forward to Telegram group
      try {
        const sent = await telegramBotRef.sendMessage(process.env.TELEGRAM_CHAT_ID, `From WhatsApp (${senderJid}):\n${text}`);
        // Persist mapping: telegramMsgId -> waJid
        await Mapping.findOneAndUpdate(
          { telegramMsgId: sent.message_id },
          { waJid: senderJid },
          { upsert: true }
        );
        // Acknowledge back to WA sender
        await sock.sendMessage(senderJid, { text: '✅ Message delivered to Telegram group' });
      } catch (err) {
        logger.error({ err }, 'Failed to forward WA -> TG');
      }
    } catch (err) {
      logger.error({ err }, 'Error in messages.upsert handler');
    }
  });

  // Persist auth before exit
  process.on('beforeExit', async () => {
    try { await persistAuthDirToMongo(); } catch (e) { /* ignore */ }
  });

  return sock;
}

export default startWhatsApp;
