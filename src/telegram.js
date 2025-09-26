// src/telegram.js
import TelegramBot from "node-telegram-bot-api";

export function setupTelegram() {
  if (!process.env.TELEGRAM_TOKEN) {
    throw new Error("⚠️ TELEGRAM_TOKEN is missing in environment variables");
  }

  // Create bot instance
  const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

  // Handle messages
  bot.on("message", (msg) => {
    console.log("📩 Telegram message:", msg.text);
    bot.sendMessage(msg.chat.id, `You said: ${msg.text}`);
  });

  console.log("✅ Telegram bot started");
  return bot;
}
