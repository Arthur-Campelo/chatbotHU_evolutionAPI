const { prisma } = require('./db');
const evolutionApi = require('./evolutionApi');
const crypto = require('node:crypto');

const pendingByPhone = new Map();

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function isRecoverableFailure(error) {
  return error.response?.status === 429;
}

async function sendPrepared(row, kind, text, options) {
  const number = row.telefone;
  const content = kind === 'text' ? evolutionApi.menuText(text, options) : null;
  if (row.status !== 'PREPARADO') return { rowId: row.id, messageId: row.mensagemId };
  const task = (async () => {
    await prisma.envioBot.update({ where: { id: row.id }, data: { status: 'ENVIANDO', iniciadoEm: new Date(), conteudoHash: content ? hashText(content) : null, tentativas: { increment: 1 } } });
    try {
      const response = kind === 'document'
        ? await evolutionApi.sendDocument(number)
        : await evolutionApi.sendText(number, content);
      const messageId = response?.key?.id || null;
      await prisma.envioBot.update({
        where: { id: row.id },
        data: { status: 'ACEITO', mensagemId: messageId, concluidoEm: new Date() },
      });
      return { rowId: row.id, messageId };
    } catch (error) {
      const current = await prisma.envioBot.findUnique({ where: { id: row.id } });
      if (current.status === 'ACEITO') return { rowId: row.id, messageId: current.mensagemId };
      const ambiguous = !error.response;
      await prisma.envioBot.update({
        where: { id: row.id },
        data: { status: ambiguous ? 'INCERTO' : 'FALHOU', concluidoEm: new Date() },
      });
      throw error;
    }
  })();
  const pending = pendingByPhone.get(number) || new Set();
  pending.add(task);
  pendingByPhone.set(number, pending);
  try {
    return await task;
  } finally {
    pending.delete(task);
    if (!pending.size) pendingByPhone.delete(number);
  }
}

async function send(number, purpose, kind, text, options) {
  const content = kind === 'text' ? evolutionApi.menuText(text, options) : null;
  const row = await prisma.envioBot.create({
    data: { instancia: process.env.INSTANCE_NAME, telefone: number, finalidade: purpose, conteudoHash: content ? hashText(content) : null, status: 'PREPARADO' },
  });
  return sendPrepared(row, kind, text, options);
}

async function reconcileOutgoing(info) {
  const hash = info.text ? hashText(info.text) : null;
  const exact = await prisma.envioBot.findFirst({ where: { instancia: process.env.INSTANCE_NAME, mensagemId: info.messageId } });
  if (exact) return;
  const candidates = await prisma.envioBot.findMany({
    where: {
      instancia: process.env.INSTANCE_NAME,
      telefone: info.phone,
      ...(hash ? { conteudoHash: hash } : { finalidade: 'TERMOS' }),
      mensagemId: null,
      status: { in: ['ENVIANDO', 'INCERTO'] },
      criadoEm: { gte: new Date(Date.now() - 600000) },
    },
    take: 2,
  });
  if (candidates.length !== 1) return;
  const row = candidates[0];
  await prisma.envioBot.update({ where: { id: row.id }, data: { status: 'ACEITO', mensagemId: info.messageId, concluidoEm: new Date() } });
  if (row.finalidade === 'LEMBRETE' && row.referenciaId) {
    await prisma.lembrete.update({ where: { id: row.referenciaId }, data: { status: 'ENVIADO', reservadoAte: null, erro: null } });
  }
}

async function waitForOutgoing(number) {
  const pending = pendingByPhone.get(number);
  if (pending?.size) await Promise.allSettled([...pending]);
}

async function isBotMessage(instance, number, messageId) {
  if (!messageId) return true;
  await waitForOutgoing(number);
  const known = await prisma.envioBot.findFirst({ where: { instancia: instance, mensagemId: messageId } });
  if (known) return true;
  const unresolved = await prisma.envioBot.findFirst({
    where: {
      instancia: instance,
      telefone: number,
      status: { in: ['PREPARADO', 'ENVIANDO', 'INCERTO'] },
      criadoEm: { gte: new Date(Date.now() - 120000) },
    },
  });
  return Boolean(unresolved);
}

module.exports = {
  sendText: (number, text, options, purpose = 'FLUXO') => send(number, purpose, 'text', text, options),
  sendDocument: (number) => send(number, 'TERMOS', 'document'),
  sendPreparedText: (row, text) => sendPrepared(row, 'text', text),
  reconcileOutgoing,
  hashText,
  isRecoverableFailure,
  waitForOutgoing,
  isBotMessage,
};
