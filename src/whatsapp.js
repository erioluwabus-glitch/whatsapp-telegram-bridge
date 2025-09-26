// src/whatsapp.js
import makeWASocket, { DisconnectReason } from '@whiskeysockets/baileys'
import logger from './logger.js'
import Session from './models/Session.js'
import Mapping from './models/Mapping.js'

export async function startWhatsApp(tgBot, TELEGRAM_GROUP_ID) {
  // Load saved session (if any)
  let saved = null
  try {
    saved = await Session.findOne({ id: 'whatsapp-session' })
    if (saved) logger.info('Loaded saved WhatsApp session from Mongo')
  } catch (e) {
    logger.warn({ e }, 'Error reading Session from Mongo (continuing without saved creds)')
  }

  const auth = saved?.data || undefined

  const sock = makeWASocket({
    auth,
    printQRInTerminal: true
  })

  // Persist credentials when they update
  sock.ev.on('creds.update', async () => {
    try {
      // Attempt to read credentials from known locations on the socket
      const creds = (sock.authState && sock.authState.creds) || (sock.auth && sock.auth.creds) || {}
      await Session.findOneAndUpdate(
        { id: 'whatsapp-session' },
        { data: creds, updatedAt: new Date() },
        { upsert: true }
      )
      logger.info('Saved WhatsApp session to Mongo')
    } catch (err) {
      logger.error({ err }, 'Failed to save WhatsApp session to Mongo')
    }
  })

  // Connection/reconnect handling
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update
    logger.info({ update }, 'WA connection.update')

    if (connection === 'close') {
      // Use plain JS optional chaining to get the status code
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      logger.info({ statusCode, shouldReconnect }, 'WA connection closed')
      if (shouldReconnect) {
        setTimeout(() => startWhatsApp(tgBot, TELEGRAM_GROUP_ID), 5000)
      } else {
        logger.warn('WA logged out — recreate session by scanning QR again')
      }
    } else if (connection === 'open') {
      logger.info('✅ WhatsApp connection opened')
    }
  })

  // Incoming message handling
  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages?.[0]
      if (!msg || msg.key?.fromMe) return

      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text
      if (!text) return

      const senderJid = msg.key.remoteJid
      logger.info({ senderJid, text }, 'Incoming WA message')

      // Forward to Telegram group
      try {
        const sent = await tgBot.sendMessage(TELEGRAM_GROUP_ID, `From WhatsApp (${senderJid}):\n${text}`)
        // Save mapping: telegramMsgId -> waJid
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

  return sock
}
