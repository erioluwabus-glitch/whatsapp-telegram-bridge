// src/server.js
import express from 'express';
import path from 'path';
import bodyParser from 'body-parser';

/**
 * startServer(opts)
 * opts:
 *   - port (default 10000)
 *   - telegramToken (process.env.TELEGRAM_TOKEN)
 *   - telegramWebhookHandler: async function(update) -> handles incoming Telegram updates
 *
 * Usage:
 *   startServer({ telegramWebhookHandler: whatsappApi.handleTelegramUpdate });
 */
export function startServer(opts = {}) {
  const port = opts.port || process.env.PORT || 10000;
  const telegramToken = opts.telegramToken || process.env.TELEGRAM_TOKEN;
  const webhookBase = process.env.WEBHOOK_BASE_URL || null;

  const app = express();

  // serve public static files (qr.png)
  const publicDir = path.resolve('./public');
  app.use(express.static(publicDir));

  // health
  app.get('/', (req, res) => res.send('✅ WhatsApp-Telegram Bridge running'));

  // Telegram webhook endpoint: POST /telegram/<BOT_TOKEN>
  app.post('/telegram/:token', bodyParser.json(), async (req, res) => {
    try {
      const token = req.params.token;
      if (!telegramToken || token !== telegramToken) {
        return res.status(403).send('forbidden');
      }
      // forward the update to the provided handler
      if (opts.telegramWebhookHandler) {
        // don't await long-running processing (respond quickly)
        opts.telegramWebhookHandler(req.body).catch(err => {
          console.error('telegramWebhookHandler error:', err);
        });
      }
      return res.status(200).send('ok');
    } catch (err) {
      console.error('Telegram webhook error:', err);
      return res.status(500).send('error');
    }
  });

  // convenience endpoint: redirect /qr to actual png if present
  app.get('/qr', (req, res) => {
    if (fsSync.existsSync(path.join(publicDir, 'qr.png'))) {
      return res.redirect('/qr.png');
    }
    return res.status(404).send('no QR available');
  });

  app.listen(port, () => {
    console.info(`🌐 Web server started on port ${port}`);
    if (webhookBase && telegramToken) {
      const webhookUrl = `${webhookBase.replace(/\/$/, '')}/telegram/${telegramToken}`;
      console.info('Telegram webhook should be set to:', webhookUrl);
      console.info('If you use the node-telegram-bot-api library, disable polling and use the webhook endpoint above.');
    } else {
      console.info('WEBHOOK_BASE_URL or TELEGRAM_TOKEN not set; telegram webhook not auto-announced.');
    }
  });

  return app;
}
