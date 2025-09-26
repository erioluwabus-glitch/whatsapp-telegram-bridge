// src/server.js
import express from 'express';
import logger from './logger.js';

export function createServer(port = process.env.PORT || 10000) {
  const app = express();

  // Accept JSON bodies (Telegram sends JSON)
  app.use(express.json({ limit: '5mb' }));

  app.get('/', (req, res) => res.send('✅ WhatsApp ↔ Telegram Bridge is running'));
  app.get('/health', (req, res) =>
    res.json({
      ok: true,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    })
  );

  const server = app.listen(port, () => {
    logger.info(`🌐 Web server started on port ${port}`);
  });

  server.on('error', (err) => {
    logger.error({ err }, 'HTTP server error');
  });

  return { app, server };
}
