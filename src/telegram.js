// src/telegram.js
import TelegramBot from "node-telegram-bot-api";

let botInstance = null;

/**
 * Setup Telegram bot and bridge incoming messages to WhatsApp
 * @param {object} sock - WhatsApp Baileys socket
 */
export function setupTelegram(sock) {
  if (!process.env.TELEGRAM_TOKEN) {
    throw new Error("❌ TELEGRAM_TOKEN is missing in environment variables");
  }
  if (!process.env.TELEGRAM_CHAT_ID) {
    throw new Error("❌ TELEGRAM_CHAT_ID is missing in environment variables");
  }
  if (!process.env.WHATSAPP_ID) {
    throw new Error("❌ WHATSAPP_ID is missing in environment variables");
  }

  botInstance = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

  botInstance.on("message", async (msg) => {
    if (msg.chat.id.toString() !== process.env.TELEGRAM_CHAT_ID) {
      return; // ignore other chats
    }

    const text = msg.text?.trim();
    if (!text) return;

    console.log("📩 Telegram → WhatsApp:", text);

    try {
      await sock.sendMessage(process.env.WHATSAPP_ID, { text: `💬 From Telegram: ${text}` });
    } catch (err) {
      console.error("❌ Failed to send Telegram → WhatsApp", err);
    }
  });

  console.log("✅ Telegram bridge active");
  return botInstance;
}

export { botInstance as bot };
