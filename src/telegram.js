// src/telegram.js
import TelegramBot from 'node-telegram-bot-api';
import Mapping from './models/Mapping.js';
import logger from './logger.js';

/**
 * setupTelegram(waSock)
 * - waSock: the Baileys socket returned from startWhatsApp
 *
 * Returns: TelegramBot instance
 */
export function setupTelegram(waSock) {
  if (!process.env.TELEGRAM_TOKEN) throw new Error('TELEGRAM_TOKEN missing');
  if (!process.env.TELEGRAM_CHAT_ID) throw new Error('TELEGRAM_CHAT_ID missing');

  const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

  bot.on('polling_error', (err) => logger.error({ err }, 'Telegram polling error'));

  bot.on('message', async (msg) => {
    try {
      const chatId = msg.chat.id.toString();
      if (chatId !== process.env.TELEGRAM_CHAT_ID.toString()) return; // only process configured group

      const text = msg.text?.trim();
      if (!text) return;

      logger.info({ chatId, text }, 'Telegram message received');

      if (msg.reply_to_message) {
        const originalId = msg.reply_to_message.message_id;
        const mapping = await Mapping.findOne({ telegramMsgId: originalId }).lean();
        if (mapping && waSock && waSock.sendMessage) {
          try {
            await waSock.sendMessage(mapping.waJid, { text });
            await bot.sendMessage(chatId, `✅ Reply sent to ${mapping.waJid}`);
            return;
          } catch (err) {
            logger.error({ err }, 'Failed to send reply to WhatsApp');
            await bot.sendMessage(chatId, '⚠️ Failed to forward reply to WhatsApp.');
            return;
          }
        } else {
          // fallback: if WHATSAPP_ID is set, send there; otherwise tell user mapping not found
          if (process.env.WHATSAPP_ID && waSock && waSock.sendMessage) {
            try {
              await waSock.sendMessage(process.env.WHATSAPP_ID, { text: `From Telegram (fallback): ${text}` });
              await bot.sendMessage(chatId, `✅ Reply forwarded to fallback WHATSAPP_ID`);
              return;
            } catch (err) {
              logger.error({ err }, 'Failed to send fallback reply to WhatsApp');
              await bot.sendMessage(chatId, '⚠️ Failed to forward to fallback WhatsApp ID.');
              return;
            }
          } else {
            await bot.sendMessage(chatId, '⚠️ Could not find mapping for that reply — reply to a forwarded message to send to that WhatsApp user.');
            return;
          }
        }
      } else {
        // non-reply messages: acknowledge and instruct
        await bot.sendMessage(chatId, '✅ Received — to send to a WhatsApp user, reply to a forwarded WhatsApp message.');
      }
    } catch (err) {
      logger.error({ err }, 'Error in Telegram message handler');
    }
  });

  logger.info('✅ Telegram bot ready');
  return bot;
}

export default setupTelegram;
