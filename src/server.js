// src/server.js
import express from 'express';
import logger from './logger.js';

export function startServer(port = process.env.PORT || 3000) {
  const app = express();
  app.get('/', (req, res) => res.send('✅ WhatsApp ↔ Telegram Bridge is running'));
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.listen(port, () => logger.info(`HTTP server listening on ${port}`));
}
