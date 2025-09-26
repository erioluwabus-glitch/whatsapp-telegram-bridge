// src/telegram.js
import TelegramBot from 'node-telegram-bot-api';
import Mapping from './models/Mapping.js';
import logger from './logger.js';

let bot = null;

/**
 * initTelegram - create bot instance (webhook mode; polling: false)
 * returns the bot instance (used for setWebHook and processUpdate).
 */
export function initTelegram() {
  if (!process.env.TELEGRAM_TOKEN) throw new Error('TELEGRAM_TOKEN missing');
  if (!process.env.TELEGRAM_CHAT_ID) throw new Error('TELEGRAM_CHAT_ID missing');

  bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: false });

  // keep a minimal error listener
  bot.on('polling_error', (err) => {
    logger.error({ err }, 'Telegram polling error (should not happen in webhook mode)');
  });

  logger.info('✅ Telegram initialized (webhook mode, polling disabled)');
  return bot;
}

/**
 * registerHandlers - wire Telegram -> WhatsApp reply behavior.
 * waSock is the Baileys socket returned from startWhatsApp().
 */
export function registerHandlers(waSock) {
  if (!bot) throw new Error('initTelegram() must be called before registerHandlers()');

  bot.on('message', async (msg) => {
    try {
      const chatId = msg.chat.id?.toString();
      if (chatId !== process.env.TELEGRAM_CHAT_ID?.toString()) return; // ignore other chats

      const text = msg.text?.trim();
      if (!text) return;

      logger.info({ chatId, text }, 'Telegram message received');

      // Handle replies: map to WA JID via Mapping collection
      if (msg.reply_to_message) {
        const originalId = msg.reply_to_message.message_id;
        const mapping = await Mapping.findOne({ telegramMsgId: originalId }).lean();

        if (mapping && waSock && waSock.sendMessage) {
          try {
            await waSock.sendMessage(mapping.waJid, { text });
            await bot.sendMessage(chatId, `✅ Reply forwarded to ${mapping.waJid}`);
            return;
          } catch (err) {
            logger.error({ err }, 'Failed to send reply to WhatsApp');
            await bot.sendMessage(chatId, '⚠️ Failed to forward reply to WhatsApp.');
            return;
          }
        }

        // fallback to optional WHATSAPP_ID if mapping not found
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
        }

        await bot.sendMessage(chatId, '⚠️ Could not find mapping for that reply — reply to a forwarded WhatsApp message to send to that user.');
        return;
      }

      // Non-reply messages: instruct user
      await bot.sendMessage(chatId, '✅ Received — to reply to a WhatsApp sender, reply to the forwarded message from WhatsApp in this group.');
    } catch (err) {
      logger.error({ err }, 'Error in Telegram message handler');
    }
  });
}

/**
 * Convenience: processUpdate when Telegram posts to webhook
 */
export async function processUpdate(update) {
  if (!bot) throw new Error('initTelegram() must be called before processUpdate()');
  // node-telegram-bot-api will emit events after processUpdate()
  return bot.processUpdate(update);
}

export default { initTelegram, registerHandlers, processUpdate };
