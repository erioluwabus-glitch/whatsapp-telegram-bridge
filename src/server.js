// src/server.js
import express from 'express';
import bodyParser from 'body-parser';
import logger from './logger.js';

export function startServer() {
  const app = express();
  app.use(bodyParser.json({ limit: '5mb' }));

  app.get('/health', (req, res) => res.json({ ok: true }));
  // Telegram webhook endpoint will be mounted by telegram module using app.post(...)

  const port = parseInt(process.env.PORT || '10000', 10);
  const server = app.listen(port, () =>
    logger.info({ port }, '🌐 Web server started on port ' + port)
  );
  return { app, server };
}
