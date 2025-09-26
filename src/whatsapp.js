// src/whatsapp.js
import fs from 'fs/promises'
import path from 'path'
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import logger from './logger.js'
import Session from './models/Session.js'
import Mapping from './models/Mapping.js'

const AUTH_DIR = './baileys_auth' // folder Baileys will use; ephemeral on Render but we persist contents to Mongo

async function ensureAuthDirFromMongo() {
  try {
    const doc = await Session.findOne({ id: 'whatsapp-session' })
    if (!doc || !doc.files) return
    // ensure directory exists
    await fs.mkdir(AUTH_DIR, { recursive: true })
    // write each file back to the auth dir
    const entries = Object.entries(doc.files)
    for (const [filename, content] of entries) {
      const filePath = path.join(AUTH_DIR, filename)
      await fs.writeFile(filePath, content, 'utf8')
    }
    logger.info('Restored Baileys auth files from Mongo to', AUTH_DIR)
  } catch (err) {
    logger.warn({ err }, 'Could not restore auth files from Mongo (starting fresh)')
  }
}

async function persistAuthDirToMongo() {
  try {
    // read all files in auth dir
    const files = await fs.readdir(AUTH_DIR)
    const data = {}
    for (const file of files) {
      const content = await fs.readFile(path.join(AUTH_DIR, file), 'utf8')
      data[file] = content
    }
    await Session.findOneAndUpdate(
      { id: 'whatsapp-session' },
      { id: 'whatsapp-session', files: data, updatedAt: new Date() },
      { upsert: true }
    )
    logger.info('Saved Baileys auth files to Mongo (session persisted)')
  } catch (err) {
    logger.error({ err }, 'Failed to persist auth files to Mongo')
  }
}

export async function startWhatsApp(tgBot, TELEGRAM_GROUP_ID) {
  // Attempt to restore auth files from Mongo into AUTH_DIR before initializing
  await ensureAuthDirFromMongo()

  // use Baileys multi-file auth state pointed at AUTH_DIR
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  // create socket with the loaded state (if any)
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true
  })

  // Whenever Baileys updates creds, save via saveCreds(), then persist folder to Mongo
  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds() // writes to AUTH_DIR
      await persistAuthDirToMongo()
    } catch (err) {
      logger.error({ err }, 'Error saving credentials')
    }
  })

  // connection lifecycle
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update
    logger.info({ update }, 'WA connection.update')
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      logger.info({ statusCode, shouldReconnect }, 'WA connection closed')
      if (shouldReconnect) {
        setTimeout(() => startWhatsApp(tgBot, TELEGRAM_GROUP_ID), 5000)
      } else {
        logger.warn('WA logged out — need to rescan QR to re-authenticate')
      }
    } else if (connection === 'open') {
      logger.info('✅ WhatsApp connection opened')
    }
  })

  // messages.upsert handler: forward to Telegram group, store mapping, ack WA sender
  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages?.[0]
      if (!msg || msg.key?.fromMe) return

      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text
      if (!text) return

      const senderJid = msg.key.remoteJid
      logger.info({ senderJid, text }, 'Incoming WA message')

      // forward to Telegram group
      try {
        const sent = await tgBot.sendMessage(TELEGRAM_GROUP_ID, `From WhatsApp (${senderJid}):\n${text}`)
        // Save mapping: telegram message id -> waJid
        await Mapping.findOneAndUpdate(
          { telegramMsgId: sent.message_id },
          { waJid: senderJid },
          { upsert: true }
        )
        // Acknowledge on WA
        await sock.sendMessage(senderJid, { text: '✅ Message delivered to Telegram group' })
      } catch (err) {
        logger.error({ err }, 'Failed to forward WA -> TG')
      }
    } catch (err) {
      logger.error({ err }, 'Error in messages.upsert')
    }
  })

  // also persist auth on process exit to minimize lost updates (best-effort)
  process.on('beforeExit', async () => {
    try { await persistAuthDirToMongo() } catch (e) { /* ignore */ }
  })

  return sock
}
