const { test } = require('node:test');
const assert = require('node:assert/strict');

const localTestUrl = process.env.TEST_DATABASE_URL;
const validLocalDb = /^postgresql:\/\/[^@]+@127\.0\.0\.1:55432\/ambulatorio_test$/.test(localTestUrl || '');

test('cadastro, retorno, mensagem manual e pausa com PostgreSQL local', { skip: !validLocalDb }, async () => {
  process.env.DATABASE_URL = localTestUrl;
  process.env.DIRECT_URL = localTestUrl;
  process.env.INSTANCE_NAME = 'ambulatorio-hu-test';
  process.env.ALLOWED_NUMBER = '';

  const { prisma } = require('../src/db');
  const api = require('../src/evolutionApi');
  const { processWebhookEvent, extractMessageInfo } = require('../src/webhookHandler');
  const { claimReminder, processReminder, tick } = require('../src/reminderWorker');
  const messenger = require('../src/messenger');
  const { resetSession, getSession, deleteSession, hasSession } = require('../src/sessionManager');
  const { DateTime } = require('luxon');
  const { ZONE } = require('../src/validation');

  let nextMessageId = 0;
  const sent = [];
  api.sendText = async (number, text) => {
    sent.push({ number, text });
    return { key: { id: `BOT-${++nextMessageId}` } };
  };
  api.sendDocument = async () => ({ key: { id: `BOT-${++nextMessageId}` } });

  await prisma.envioBot.deleteMany();
  await prisma.eventoProcessado.deleteMany();
  await prisma.controleConversa.deleteMany();
  await prisma.lembrete.deleteMany();
  await prisma.paciente.deleteMany();

  const phone = '5567999123456';
  let incoming = 0;
  async function event(text, fromMe = false, override = {}) {
    return processWebhookEvent({
      instance: process.env.INSTANCE_NAME,
      event: 'messages.upsert',
      data: {
        key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe, id: override.id || `IN-${++incoming}` },
        message: text == null ? { audioMessage: {} } : { conversation: text },
        messageTimestamp: override.timestamp || Math.floor(Date.now() / 1000),
      },
    });
  }

  try {
    assert.equal(extractMessageInfo({ event: 'messages.upsert', instance: process.env.INSTANCE_NAME, data: {} }), null);
    assert.equal(extractMessageInfo({ event: 'messages.upsert', instance: process.env.INSTANCE_NAME, data: { key: { id: 'LID', remoteJid: '123456789@lid' } } }), null);
    await event('Olá');
    assert.match(sent.at(-1).text, /escolhesse o idioma/);
    await event('1');
    await event('1');
    assert.equal(await prisma.paciente.count(), 0);
    await event('talvez');
    assert.equal(getSession(phone).currentPage, 'Termos de Serviço');
    assert.equal(await prisma.paciente.count(), 0);
    await event('não');
    assert.equal(await prisma.paciente.count(), 0);
    await event('Olá');
    await event('1');
    const originalDocument = api.sendDocument;
    api.sendDocument = async () => { throw Object.assign(new Error('PDF indisponível'), { response: { status: 500 } }); };
    const failedDocumentId = `IN-${++incoming}`;
    await assert.rejects(() => event('1', false, { id: failedDocumentId }), /PDF indisponível/);
    assert.equal(await prisma.paciente.count(), 0);
    assert.equal(getSession(phone).pendingPage, 'Termos de Serviço');
    api.sendDocument = originalDocument;
    await event('1', false, { id: failedDocumentId });
    await event('sim');
    assert.equal(await prisma.paciente.count(), 0);
    await event('529.982.247-25');
    await event('Paciente Teste');
    await event('01/01/1990');
    assert.equal(await prisma.paciente.count(), 0);
    await event('sim');
    assert.equal(await prisma.paciente.count(), 1);
    assert.equal(getSession(phone).currentPage, 'Menu Principal');

    resetSession(phone);
    await event('Olá');
    await event('1');
    await event('1');
    assert.equal(getSession(phone).currentPage, 'Confirmar Cadastro Existente');
    await event('sim');
    assert.equal(getSession(phone).currentPage, 'Menu Principal');

    resetSession(phone);
    await event('Olá');
    await event('1');
    await event('1');
    await event('não');
    await event('111.444.777-35');
    await event('Paciente Corrigido');
    await event('02/02/1991');
    assert.equal((await prisma.paciente.findUnique({ where: { telefone: phone } })).nome, 'Paciente Teste');
    await event('sim');
    assert.equal((await prisma.paciente.findUnique({ where: { telefone: phone } })).nome, 'Paciente Corrigido');

    const tomorrow = DateTime.now().setZone(ZONE).plus({ days: 3 }).toFormat('dd/MM/yyyy');
    await event(`dia:${tomorrow}`);
    assert.equal(await prisma.lembrete.count(), 0);
    const manualId = `IN-${++incoming}`;
    await event(`dia:${tomorrow}`, true, { id: manualId });
    assert.equal(await prisma.lembrete.count(), 1);
    const anotherDate = DateTime.now().setZone(ZONE).plus({ days: 4 }).toFormat('dd/MM/yyyy');
    await event(`dia:${anotherDate}`, true);
    assert.equal(await prisma.lembrete.count(), 2);
    await event(`dia:${tomorrow}`, true);
    assert.equal(await prisma.lembrete.count(), 2);
    await event(`dia:${tomorrow}`, true, { id: manualId });
    assert.equal(await prisma.lembrete.count(), 2);
    assert.equal((await prisma.envioBot.findMany({ where: { finalidade: 'CONFIRMACAO_LEMBRETE' } })).length, 2);
    const control = await prisma.controleConversa.findUnique({ where: { instancia_telefone: { instancia: process.env.INSTANCE_NAME, telefone: phone } } });
    assert.ok(control.pausadoAte > new Date());

    const bot = await prisma.envioBot.findFirst({ where: { finalidade: 'CONFIRMACAO_LEMBRETE' } });
    const pausedUntil = control.pausadoAte.getTime();
    await event('Lembrete programado', true, { id: bot.mensagemId });
    const unchanged = await prisma.controleConversa.findUnique({ where: { id: control.id } });
    assert.equal(unchanged.pausadoAte.getTime(), pausedUntil);

    await event('qualquer coisa');
    assert.equal(getSession(phone).currentPage, 'Menu Principal');
    await event('menu');
    assert.equal(getSession(phone).currentPage, 'Start');
    const resumed = await prisma.controleConversa.findUnique({ where: { id: control.id } });
    assert.equal(resumed.pausadoAte, null);
    await event('Mensagem antiga', true, { timestamp: Math.floor(Date.now() / 1000) - 120 });
    assert.equal((await prisma.controleConversa.findUnique({ where: { id: control.id } })).pausadoAte, null);

    await event('1');
    await event('1');
    await event('sim');
    await event('1');
    await event('Cardiologia');
    await event('Dra. Exemplo');
    const originalClosureSend = api.sendText;
    api.sendText = async (number, text) => {
      if (text.startsWith('Seu pedido foi encaminhado')) throw Object.assign(new Error('fechamento indisponível'), { response: { status: 429 } });
      return originalClosureSend(number, text);
    };
    const closureId = `IN-${++incoming}`;
    await assert.rejects(() => event('20/12/2027', false, { id: closureId }), /fechamento indisponível/);
    assert.equal(getSession(phone).pendingPage, 'Encerramento');
    api.sendText = originalClosureSend;
    await event('20/12/2027', false, { id: closureId });
    assert.equal(getSession(phone).currentPage, 'Encerramento');
    assert.match(sent.at(-1).text, /envie “menu” ou “reiniciar”/);
    const afterHandoff = await prisma.controleConversa.findUnique({ where: { id: control.id } });
    assert.ok(afterHandoff.pausadoAte > new Date());
    await new Promise((resolve) => setTimeout(resolve, 10));
    await event(null, true, { timestamp: Math.floor(Date.now() / 1000) + 2 });
    const afterManualMedia = await prisma.controleConversa.findUnique({ where: { id: control.id } });
    assert.ok(afterManualMedia.pausadoAte >= afterHandoff.pausadoAte);

    await prisma.controleConversa.update({ where: { id: control.id }, data: { pausadoAte: new Date(Date.now() - 1000) } });
    await event('Olá');
    assert.equal(getSession(phone).currentPage, 'Start');

    const patient = await prisma.paciente.findUnique({ where: { telefone: phone } });
    async function dueReminder(offsetDays, deadlineOffsetMs = 60000) {
      const date = DateTime.now().setZone(ZONE).plus({ days: offsetDays });
      return prisma.lembrete.create({ data: {
        pacienteId: patient.id,
        dataConsulta: new Date(`${date.toISODate()}T00:00:00.000Z`),
        programadoPara: new Date(Date.now() - 1000),
        limiteEnvio: new Date(Date.now() + deadlineOffsetMs),
      } });
    }
    const due = await dueReminder(10);
    const [claimed, concurrentClaim] = await Promise.all([claimReminder(), claimReminder()]);
    assert.equal(claimed?.id === due.id || concurrentClaim?.id === due.id, true);
    assert.equal(Boolean(claimed) && Boolean(concurrentClaim), false);
    await processReminder(claimed || concurrentClaim);
    assert.equal((await prisma.lembrete.findUnique({ where: { id: due.id } })).status, 'ENVIADO');

    const uncertain = await dueReminder(11);
    const originalSendText = api.sendText;
    api.sendText = async () => { throw new Error('timeout simulado'); };
    await processReminder(await claimReminder());
    assert.equal((await prisma.lembrete.findUnique({ where: { id: uncertain.id } })).status, 'INCERTO');
    assert.equal(await claimReminder(), null);
    api.sendText = originalSendText;
    await messenger.reconcileOutgoing({ phone, text: 'Olá! Este é um lembrete do Ambulatório HU: você tem consulta prevista para hoje. Confira os detalhes informados pela atendente nesta conversa.', messageId: 'BOT-ATRASADO' });
    assert.equal((await prisma.lembrete.findUnique({ where: { id: uncertain.id } })).status, 'ENVIADO');

    const expired = await dueReminder(12, -1000);
    await tick();
    assert.equal((await prisma.lembrete.findUnique({ where: { id: expired.id } })).status, 'EXPIRADO');

    await prisma.paciente.create({ data: { cpf: '52998224725', nome: 'Outro Paciente', dataNascimento: new Date('1992-01-01T00:00:00.000Z'), telefone: '5567999000000' } });
    resetSession(phone);
    await prisma.controleConversa.update({ where: { id: control.id }, data: { pausadoAte: null } });
    await event('Olá');
    await event('1');
    await event('1');
    await event('não');
    await event('529.982.247-25');
    await event('Nome Indevido');
    await event('03/03/1993');
    await event('sim');
    assert.equal((await prisma.paciente.findUnique({ where: { telefone: phone } })).nome, 'Paciente Corrigido');
    assert.equal((await prisma.paciente.findUnique({ where: { cpf: '52998224725' } })).telefone, '5567999000000');
    assert.equal(getSession(phone).currentPage, 'Encerramento');

    deleteSession(phone);
    await prisma.eventoProcessado.create({ data: { instancia: process.env.INSTANCE_NAME, mensagemId: 'ORPHAN', direcao: 'ENTRADA' } });
    await event('sim', false, { id: 'ORPHAN' });
    assert.equal(hasSession(phone), false);
  } finally {
    await prisma.$disconnect();
  }
});
