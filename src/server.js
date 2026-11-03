require('dotenv').config();
const crypto = require('node:crypto');
const express = require('express');
const { processWebhookEvent } = require('./webhookHandler');

const app = express();
app.use((req, _res, next) => { if (req.method === 'POST' && req.path === '/webhook') console.log('[webhook] POST recebido'); next(); });
app.use(express.json({ limit: '5mb' }));

function validSecret(received) {
  const expected = process.env.WEBHOOK_SECRET;
  if (!expected || typeof received !== 'string') return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.get('/', (_req, res) => res.json({ status: 'ok', service: 'ambulatorio-hu-chatbot' }));

app.post('/webhook', async (req, res) => {
  if (!validSecret(req.get('x-webhook-secret'))) {
    if (process.env.DEBUG_WEBHOOK === '1') console.warn('[webhook-debug] HTTP 401: cabeçalho secreto ausente ou incorreto');
    return res.sendStatus(401);
  }
  if (process.env.DEBUG_WEBHOOK === '1') {
    const event = String(req.body?.event || '').slice(0, 40).replace(/[^a-zA-Z_.-]/g, '?');
    console.info('[webhook-debug] recebido', { event, instanciaCorreta: req.body?.instance === process.env.INSTANCE_NAME });
  }
  try {
    await processWebhookEvent(req.body);
    return res.sendStatus(200);
  } catch (error) {
    console.error('[webhook] Falha:', error.message);
    return res.sendStatus(503);
  }
});

if (require.main === module) {
  if (!process.env.WEBHOOK_SECRET || !process.env.INSTANCE_NAME) {
    throw new Error('Defina WEBHOOK_SECRET e INSTANCE_NAME antes de iniciar o bot.');
  }
  app.listen(process.env.PORT || 3000, () => console.log(`Servidor do chatbot rodando na porta ${process.env.PORT || 3000}`));
}

module.exports = { app, validSecret };
