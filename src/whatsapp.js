// src/whatsapp.js
import fs from 'fs/promises';
import path from 'path';
import mongoose from 'mongoose';
import logger from './logger.js';
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';

const AUTH_DIR = process.env.BAILEYS_AUTH_DIR || './baileys_auth';
const AUTH_DOC_ID = 'baileys-auth-v1';
const SESSIONS_COLLECTION = 'sessions'; // we store creds in this collection

async function restoreAuthFilesFromMongo() {
  try {
    const col = mongoose.connection.db.collection(SESSIONS_COLLECTION);
    const doc = await col.findOne({ id: AUTH_DOC_ID });
    if (!doc || !doc.files) {
      logger.info('No saved Baileys auth files found in Mongo; starting fresh.');
      return;
    }

    await fs.mkdir(AUTH_DIR, { recursive: true });

    const filesContainer = doc.files;

    if (Array.isArray(filesContainer)) {
      // array of { filename, data } or similar
      for (const item of filesContainer) {
        if (!item) continue;
        if (item.filename && item.data) {
          await fs.writeFile(path.join(AUTH_DIR, item.filename), String(item.data), 'utf8');
        } else if (typeof item === 'object') {
          for (const k of Object.keys(item)) {
            await fs.writeFile(path.join(AUTH_DIR, k), String(item[k]), 'utf8');
          }
        }
      }
    } else if (filesContainer && typeof filesContainer === 'object') {
      // object map: { "creds.json": "...", ... }
      for (const filename of Object.keys(filesContainer)) {
        const content = filesContainer[filename];
        await fs.writeFile(path.join(AUTH_DIR, filename), String(content), 'utf8');
      }
    } else {
      logger.warn('Stored Baileys session has unexpected shape; skipping restore.');
    }

    logger.info({ authDir: AUTH_DIR }, 'Restored Baileys auth files from Mongo');
  } catch (err) {
    logger.warn({ err }, 'Failed to restore Baileys auth files from Mongo — starting fresh');
  }
}

async function persistAuthFilesToMongo() {
  try {
    await fs.mkdir(AUTH_DIR, { recursive: true });
    const files = {};
    const names = await fs.readdir(AUTH_DIR);
    for (const f of names) {
      const full = path.join(AUTH_DIR, f);
      const stat = await fs.stat(full);
      if (!stat.isFile()) continue;
      const content = await fs.readFile(full, 'utf8');
      files[f] = content;
    }
    const col = mongoose.connection.db.collection(SESSIONS_COLLECTION);
    await col.updateOne({ id: AUTH_DOC_ID }, { $set: { files } }, { upsert: true });
    logger.info('Persisted Baileys auth files to Mongo (Session updated)');
  } catch (err) {
    logger.warn({ err }, 'Failed to persist Baileys auth files to Mongo');
  }
}

/**
 * startWhatsApp(options)
 * options: { telegramBot, telegramChatId }
 */
export async function startWhatsApp({ telegramBot, telegramChatId }) {
  try {
    // 1) try restore saved files to disk (so useMultiFileAuthState can load them)
    await restoreAuthFilesFromMongo();

    // 2) initialize baileys auth state from the auth folder
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    // 3) get latest version and create socket
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 2204, 2] }));
    const sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false
    });

    // When baileys tells us to save credentials, persist to both file system and Mongo
    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
      } catch (e) {
        // saveCreds sometimes throws if no-op
      }
      // persist a copy to Mongo so Render restarts can restore the exact auth files
      await persistAuthFilesToMongo();
    });

    sock.ev.on('connection.update', (update) => {
      logger.info({ update }, 'WA connection.update');
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        // log QR string (Render logs) — copy & render into QR image to scan if needed
        logger.info({ qr }, 'WA connection.update'); // screenshot this value
      }
      if (connection === 'open') {
        logger.info('✅ WhatsApp connected');
      }
      if (connection === 'close') {
        // sample handling: log and let library attempt reconnect
        const reason = (lastDisconnect && lastDisconnect.error) ? lastDisconnect.error : null;
        logger.warn({ reason }, 'WA closed connection');
      }
    });

    // forward incoming messages to Telegram group
    sock.ev.on('messages.upsert', async (m) => {
      try {
        const messages = m.messages ?? [];
        for (const message of messages) {
          if (!message.message || message.key?.fromMe) continue;
          const from = message.key.remoteJid || 'unknown';
          // simple text extraction; expand if you need attachments
          const text = message.message.conversation
            || message.message?.extendedTextMessage?.text
            || '<non-text message>';
          const prefix = `📩 From WhatsApp: ${from}\n`;
          if (telegramBot && telegramChatId) {
            await telegramBot.sendMessage(telegramChatId, prefix + text);
            // Optionally: save mapping messageId -> WA sender in Mongo for replies
          } else {
            logger.info('no telegram bot/chat configured - skipping forward');
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Failed handling incoming WA messages');
      }
    });

    // return socket so other modules can use it if needed
    return sock;
  } catch (err) {
    logger.error({ err }, 'Failed to start WhatsApp module');
    throw err;
  }
}
