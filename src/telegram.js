// src/telegram.js
import TelegramBot from 'node-telegram-bot-api';
import logger from './logger.js';

export async function setupTelegram({ token, chatId, app, webhookBaseUrl }) {
  if (!token) throw new Error('❌ TELEGRAM_TOKEN is missing in environment variables');
  if (!chatId) throw new Error('❌ TELEGRAM_CHAT_ID is missing in environment variables');

  const botToken = token;
  // If webhookBaseUrl is provided we use webhook mode (recommended on Render)
  if (webhookBaseUrl) {
    logger.info('🟦 Initializing Telegram (webhook mode)...');
    const bot = new TelegramBot(botToken, { polling: false });
    const webhookPath = `/telegram/${botToken}`;

    // Express endpoint for Telegram updates
    app.post(webhookPath, (req, res) => {
      try {
        bot.processUpdate(req.body);
        res.sendStatus(200);
      } catch (err) {
        logger.warn({ err }, 'Failed to process telegram webhook update');
        res.sendStatus(500);
      }
    });

    // register webhook with Telegram
    const webhookUrl = `${webhookBaseUrl}${webhookPath}`;
    await bot.setWebHook(webhookUrl);
    logger.info({ webhookPath, webhookUrl }, '✅ Telegram initialized (webhook mode, polling disabled)');
    return bot;
  } else {
    logger.info('🟦 Initializing Telegram (polling mode)...');
    const bot = new TelegramBot(botToken, { polling: true });
    logger.info('✅ Telegram (polling) ready');
    return bot;
  }
}
