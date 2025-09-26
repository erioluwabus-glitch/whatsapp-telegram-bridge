import TelegramBot from 'node-telegram-bot-api'
import Mapping from './models/Mapping.js'

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true })

export function setupTelegram(bot, waSock) {
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString()
    if (chatId === process.env.TELEGRAM_GROUP_ID) {
      const text = msg.text

      // ✅ If Telegram user is replying to a WA-forwarded message
      if (msg.reply_to_message) {
        const originalId = msg.reply_to_message.message_id
        const mapping = await Mapping.findOne({ telegramMsgId: originalId })

        if (mapping) {
          try {
            await waSock.sendMessage(mapping.waJid, { text })
            await bot.sendMessage(chatId, `✅ Reply sent to ${mapping.waJid}`)
          } catch (err) {
            console.error('❌ Failed to send reply to WA', err)
            await bot.sendMessage(chatId, '⚠️ Failed to send reply to WhatsApp.')
          }
          return
        }
      }

      // ✅ If not a reply, send to default WA number
      if (text) {
        const targetJid = process.env.DEFAULT_WA_NUMBER + '@s.whatsapp.net'
        try {
          await waSock.sendMessage(targetJid, { text })
          await bot.sendMessage(chatId, `✅ Sent to WhatsApp default: ${text}`)
        } catch (err) {
          console.error('❌ Failed to send to default WA number', err)
          await bot.sendMessage(chatId, '⚠️ Failed to send message to WhatsApp.')
        }
      }
    }
  })
}

export default bot
