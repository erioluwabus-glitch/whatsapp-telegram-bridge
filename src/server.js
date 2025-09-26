// src/server.js
import express from 'express';
import logger from './logger.js';

export function startServer(port = process.env.PORT || 10000) {
  const app = express();

  app.get('/', (req, res) => res.send('✅ WhatsApp ↔ Telegram Bridge is running'));
  app.get('/health', (req, res) => res.json({ ok: true }));

  const server = app.listen(port, () => {
    logger.info(`🌐 Web server started on port ${port}`);
  });

  // return server instance in case caller wants to close it later
  return server;
}
