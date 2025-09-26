import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys'
import * as Boom from '@hapi/boom'
import mongoose from 'mongoose'
import Session from './models/Session.js'
import Mapping from './models/Mapping.js'

export async function startWhatsApp(telegramBot) {
  // ✅ Ensure MongoDB is connected
  if (!mongoose.connection.readyState) {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    })
    console.log('✅ MongoDB connected for session + mapping storage')
  }

  // ✅ Setup Baileys auth state
  const { state, saveCreds } = await useMultiFileAuthState('./baileys_auth')

  // Load saved creds from DB if they exist
  const dbSession = await Session.findOne({ id: 'whatsapp-session' })
  if (dbSession) {
    Object.assign(state.creds, dbSession.data)
    console.log('🔄 Loaded WhatsApp creds from MongoDB')
  }

  const sock = makeWASocket({
    printQRInTerminal: true,
    auth: state
  })

  // ✅ Save creds into MongoDB whenever they update
  sock.ev.on('creds.update', async () => {
    await Session.findOneAndUpdate(
      { id: 'whatsapp-session' },
      { data: state.creds },
      { upsert: true }
    )
    console.log('💾 WhatsApp session saved to MongoDB')
  })

  // ✅ Handle connection status
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update
    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom.Boom)?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      console.log('WhatsApp disconnected, reconnect?', shouldReconnect)
      if (shouldReconnect) startWhatsApp(telegramBot)
    } else if (connection === 'open') {
      console.log('✅ WhatsApp connected!')
    }
  })

  // ✅ Handle incoming WA messages
  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0]
    if (!msg.key.fromMe && m.type === 'notify') {
      const text =
        msg.message?.conversation || msg.message?.extendedTextMessage?.text
      if (text) {
        console.log(`📥 New WA message: ${text}`)

        try {
          // Forward to Telegram group
          const chatId = process.env.TELEGRAM_GROUP_ID
          const sent = await telegramBot.sendMessage(
            chatId,
            `From WhatsApp (${msg.key.remoteJid}):\n${text}`
          )

          // ✅ Save mapping in MongoDB (TG msgId ↔ WA sender JID)
          await Mapping.findOneAndUpdate(
            { telegramMsgId: sent.message_id },
            { waJid: msg.key.remoteJid },
            { upsert: true }
          )
          console.log(
            `💾 Mapping saved: TG ${sent.message_id} ↔ WA ${msg.key.remoteJid}`
          )

          // Acknowledge delivery on WA
          await sock.sendMessage(msg.key.remoteJid, {
            text: '✅ Message delivered to Telegram group'
          })
        } catch (err) {
          console.error('❌ Failed to forward WA → TG', err)
        }
      }
    }
  })

  return sock
}
