// src/server.js
import express from 'express';
import logger from './logger.js';

/**
 * startServer - starts a tiny HTTP server so Render sees a bound port.
 * Returns the node http.Server instance so callers can close it on shutdown.
 */
export function startServer(port = process.env.PORT || 10000) {
  const app = express();

  // Basic endpoints
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

  return server;
}
