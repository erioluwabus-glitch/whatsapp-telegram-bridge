// src/whatsapp.js
/**
 * WhatsApp bridge (Baileys) with Mongo persistence of auth files.
 *
 * Exports:
 *   - startWhatsApp(): Promise<sock>
 *   - attachTelegramBot(bot): void
 *
 * Behavior:
 *   - On startup: restore auth files from Mongo (Session with id 'baileys-auth-v1')
 *                 into a local directory (AUTH_DIR) and call useMultiFileAuthState(AUTH_DIR).
 *   - On creds.update: call saveCreds() then read AUTH_DIR files and save them to Mongo.
 *   - On messages.upsert: forward text messages to the configured Telegram group (telegramBotRef)
 *                         and persist mapping telegramMsgId -> waJid so replies can be routed back.
 *   - On shutdown (beforeExit/SIGTERM): persist auth files to Mongo.
 *
 * Requirements:
 *   - MONGO connected (this module assumes mongoose is already connected by index.js)
 *   - Session model available at src/models/Session.js
 *   - Mapping model available at src/models/Mapping.js
 */

import fs from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import logger from './logger.js';
import Session from './models/Session.js';
import Mapping from './models/Mapping.js';

const AUTH_DOC_ID = 'baileys-auth-v1';
const AUTH_DIR = process.env.BAILEYS_AUTH_DIR || './baileys_auth';

let telegramBotRef = null; // set by attachTelegramBot()
export function attachTelegramBot(bot) {
  telegramBotRef = bot;
}

/** Restore any saved auth files from Mongo into AUTH_DIR */
async function restoreAuthFilesFromMongo() {
  try {
    const doc = await Session.findOne({ id: AUTH_DOC_ID }).lean();
    if (!doc || !doc.files) {
      logger.info('No saved Baileys auth files found in Mongo; starting fresh.');
      return;
    }

    await fs.mkdir(AUTH_DIR, { recursive: true });

    const filesContainer = doc.files;

    // filesContainer might be:
    // - an object: { "creds.json": "{}", "state.json": "{}" }
    // - or an array: [ { filename: "creds.json", data: "..." }, ... ]
    if (Array.isArray(filesContainer)) {
      for (const item of filesContainer) {
        if (item && (item.filename || item.name) && item.data) {
          const filename = item.filename || item.name;
          await fs.writeFile(path.join(AUTH_DIR, filename), item.data, 'utf8');
        } else if (item && typeof item === 'object') {
          // last-resort: write each key inside the object item
          for (const k of Object.keys(item)) {
            await fs.writeFile(path.join(AUTH_DIR, k), String(item[k]), 'utf8');
          }
        }
      }
    } else if (typeof filesContainer === 'object') {
      for (const filename of Object.keys(filesContainer)) {
        const content = filesContainer[filename];
        await fs.writeFile(path.join(AUTH_DIR, filename), String(content), 'utf8');
      }
    } else {
      logger.warn('Stored session has unexpected shape; skipping restore.');
    }

    logger.info('Restored Baileys auth files from Mongo to ' + AUTH_DIR);
  } catch (err) {
    logger.warn({ err }, 'Failed to restore Baileys auth files from Mongo — starting fresh');
  }
}


    // doc.files is a Map-like object (stored as object); iterate keys
    for (const [filename, content] of Object.entries(Object.fromEntries(doc.files || []))) {
      const filePath = path.join(AUTH_DIR, filename);
      await fs.writeFile(filePath, content, 'utf8');
    }
    logger.info('Restored Baileys auth files from Mongo to', AUTH_DIR);
  } catch (err) {
    logger.warn({ err }, 'Failed to restore Baileys auth files from Mongo — starting fresh');
  }
}

/** Read files from AUTH_DIR and persist them into Mongo Session doc */
async function persistAuthFilesToMongo() {
  try {
    const exists = existsSync(AUTH_DIR);
    if (!exists) {
      logger.warn('Auth dir not found, nothing to persist');
      return;
    }
    const files = {};
    const items = await fs.readdir(AUTH_DIR).catch(() => []);
    for (const fname of items) {
      const full = path.join(AUTH_DIR, fname);
      const stat = await fs.stat(full);
      if (stat.isFile()) {
        const content = await fs.readFile(full, 'utf8');
        files[fname] = content;
      }
    }
    await Session.updateOne(
      { id: AUTH_DOC_ID },
      { id: AUTH_DOC_ID, files, updatedAt: new Date() },
      { upsert: true }
    );
    logger.info('Persisted Baileys auth files to Mongo (Session updated)');
  } catch (err) {
    logger.error({ err }, 'Failed to persist Baileys auth files to Mongo');
  }
}

/** Small helper to extract plain text from incoming WA message */
function extractTextFromMessage(msg) {
  if (!msg || !msg.message) return null;
  const m = msg.message;
  // common types
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  if (m.documentMessage?.fileName) return `[document] ${m.documentMessage.fileName}`;
  // fallback: return JSON string (small)
  try {
    return JSON.stringify(Object.keys(m)[0]);
  } catch {
    return null;
  }
}

/**
 * Start the Baileys WhatsApp socket.
 * Returns the socket instance.
 */
export async function startWhatsApp() {
  // 1) restore auth files from Mongo (if any)
  await restoreAuthFilesFromMongo();

  // 2) useMultiFileAuthState will read/write files in AUTH_DIR
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // we'll log QR ourselves from connection.update
  });

  // when credentials change, Baileys expects saveCreds() to be called
  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds(); // writes local files in AUTH_DIR
      await persistAuthFilesToMongo(); // copy files into Mongo
    } catch (err) {
      logger.error({ err }, 'Error saving/persisting Baileys creds');
    }
  });

  // connection updates (qr, open, close, etc.)
  sock.ev.on('connection.update', async (update) => {
    try {
      logger.info({ update }, 'WA connection.update');

      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // log raw qr string (you can convert to an image via a public QR API)
        logger.info({ qr }, 'WA QR code (copy & render as QR image to scan)');
      }

      if (connection === 'open') {
        logger.info('✅ WhatsApp connected');
        // Persist auth files right after successful connection (credentials are present)
        await persistAuthFilesToMongo().catch((e) => logger.warn({ e }, 'persist after open failed'));
      }

      if (connection === 'close') {
        // try to inspect reason and reconnect unless logged out
        const code = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
        logger.warn({ code, lastDisconnect }, 'WhatsApp connection closed');
        const loggedOut = code === DisconnectReason.loggedOut || (lastDisconnect?.error && String(lastDisconnect.error).toLowerCase().includes('loggedout'));
        if (loggedOut) {
          logger.error('WhatsApp logged out — you will need to re-scan the QR manually.');
        } else {
          logger.info('Attempting reconnect in 5s...');
          setTimeout(() => startWhatsApp().catch((e) => logger.error({ e }, 'reconnect failed')), 5000);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in connection.update handler');
    }
  });

  // incoming messages — forward to Telegram group and persist mapping
  sock.ev.on('messages.upsert', async (upsert) => {
    try {
      const messages = upsert.messages || [];
      for (const m of messages) {
        // ignore status messages, ephemeral notifications, and messages from ourselves
        if (!m.message || m.key?.fromMe) continue;

        const senderJid = m.key.remoteJid;
        const text = extractTextFromMessage(m);

        if (!text) {
          logger.info({ senderJid }, 'Received non-text message (not forwarded as text)');
          // optionally you could download media and upload to Telegram — not handled here
          try {
            if (telegramBotRef) {
              const sent = await telegramBotRef.sendMessage(
                process.env.TELEGRAM_CHAT_ID,
                `📲 From WhatsApp (${senderJid}):\n[non-text message received]`
              );
              // store mapping for replies (so replies go to that WA sender)
              if (sent?.message_id) {
                await Mapping.updateOne(
                  { telegramMsgId: sent.message_id },
                  { telegramMsgId: sent.message_id, waJid: senderJid },
                  { upsert: true }
                );
              }
            } else {
              logger.warn('Telegram bot not attached; cannot forward non-text message');
            }
          } catch (err) {
            logger.error({ err }, 'Failed forwarding non-text to Telegram');
          }
          continue;
        }

        logger.info({ senderJid, text }, 'Incoming WhatsApp message');

        if (!telegramBotRef) {
          logger.warn('Telegram bot not attached; dropping forward for now');
          continue;
        }

        try {
          // send message to the Telegram group configured in env
          const sent = await telegramBotRef.sendMessage(process.env.TELEGRAM_CHAT_ID, `📲 From WhatsApp (${senderJid}):\n${text}`);

          // persist mapping telegramMsgId -> waJid
          if (sent?.message_id) {
            await Mapping.updateOne(
              { telegramMsgId: sent.message_id },
              { telegramMsgId: sent.message_id, waJid: senderJid, createdAt: new Date() },
              { upsert: true }
            );
          }

          // acknowledge the WA sender
          try {
            await sock.sendMessage(senderJid, { text: '✅ Message delivered to Telegram group' });
          } catch (ackErr) {
            logger.warn({ ackErr }, 'Failed to send delivery ack to WA sender');
          }
        } catch (err) {
          logger.error({ err }, 'Failed to forward WA -> Telegram');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in messages.upsert handler');
    }
  });

  // Persist current auth files periodically (in case something changed)
  const persistIntervalMs = 1000 * 30; // every 30 seconds
  const intervalHandle = setInterval(() => {
    persistAuthFilesToMongo().catch((e) => logger.debug({ e }, 'periodic persist failed'));
  }, persistIntervalMs);
  intervalHandle.unref?.();

  // persist on process exit signals
  const gracefulPersist = async () => {
    try {
      logger.info('Persisting Baileys auth files to Mongo before exit...');
      await persistAuthFilesToMongo();
    } catch (e) {
      logger.warn({ e }, 'persist on exit failed');
    }
  };
  process.once('beforeExit', gracefulPersist);
  process.once('SIGINT', async () => { await gracefulPersist(); process.exit(0); });
  process.once('SIGTERM', async () => { await gracefulPersist(); process.exit(0); });

  return sock;
}

export default startWhatsApp;

