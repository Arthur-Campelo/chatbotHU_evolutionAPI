require('dotenv').config();
const { prisma } = require('./db');
const messenger = require('./messenger');

const POLL_MS = 15000;
let running = false;

async function sendConfirmations() {
  await prisma.envioBot.updateMany({
    where: { finalidade: 'CONFIRMACAO_LEMBRETE', status: 'RESERVADO', iniciadoEm: { lt: new Date(Date.now() - 60000) } },
    data: { status: 'PREPARADO', iniciadoEm: null },
  });
  const pending = await prisma.envioBot.findMany({
    where: { finalidade: 'CONFIRMACAO_LEMBRETE', status: { in: ['PREPARADO', 'FALHOU'] }, tentativas: { lt: 3 } },
    take: 20,
    orderBy: { criadoEm: 'asc' },
  });
  for (const row of pending) {
    const claimed = await prisma.envioBot.updateMany({ where: { id: row.id, status: row.status }, data: { status: 'RESERVADO', iniciadoEm: new Date() } });
    if (!claimed.count) continue;
    const reminder = await prisma.lembrete.findUnique({ where: { id: row.referenciaId } });
    if (!reminder) {
      await prisma.envioBot.update({ where: { id: row.id }, data: { status: 'FALHOU' } });
      continue;
    }
    const { formatDate } = require('./validation');
    try {
      await messenger.sendPreparedText({ ...row, status: 'PREPARADO' }, `Lembrete programado para ${formatDate(reminder.dataConsulta)}, às 07:00.`);
    } catch (error) {
      if (!messenger.isRecoverableFailure(error) && error.response) {
        await prisma.envioBot.updateMany({ where: { id: row.id, status: 'FALHOU' }, data: { status: 'FALHA_FINAL' } });
      }
      console.error('[confirmacao] Envio falhou:', error.message);
    }
  }
}

async function expireAndReconcile() {
  await prisma.envioBot.updateMany({
    where: { status: 'ENVIANDO', iniciadoEm: { lt: new Date(Date.now() - 60000) } },
    data: { status: 'INCERTO', concluidoEm: new Date() },
  });
  await prisma.lembrete.updateMany({
    where: { status: { in: ['PENDENTE', 'FALHOU'] }, limiteEnvio: { lte: new Date() } },
    data: { status: 'EXPIRADO' },
  });
  await prisma.lembrete.updateMany({
    where: { status: 'ENVIANDO', reservadoAte: { lte: new Date() } },
    data: { status: 'INCERTO', erro: 'Processo interrompido durante o envio; conferir antes de reenviar.' },
  });
}

async function claimReminder() {
  const rows = await prisma.$queryRaw`
    UPDATE "Lembrete" SET status = 'ENVIANDO', "reservadoAte" = NOW() + INTERVAL '30 seconds', "atualizadoEm" = NOW()
    WHERE id = (
      SELECT id FROM "Lembrete"
      WHERE status IN ('PENDENTE', 'FALHOU')
        AND tentativas < 3
        AND "programadoPara" <= NOW()
        AND "limiteEnvio" > NOW()
        AND ("proximaTentativa" IS NULL OR "proximaTentativa" <= NOW())
      ORDER BY "programadoPara", id
      FOR UPDATE SKIP LOCKED LIMIT 1
    ) RETURNING *
  `;
  return rows[0] || null;
}

async function processReminder(reminder) {
  const patient = await prisma.paciente.findUnique({ where: { id: reminder.pacienteId } });
  if (!patient) {
    await prisma.lembrete.update({ where: { id: reminder.id }, data: { status: 'FALHOU', erro: 'Paciente não localizado' } });
    return;
  }
  let row = await prisma.envioBot.findUnique({
    where: { finalidade_referenciaId: { finalidade: 'LEMBRETE', referenciaId: reminder.id } },
  });
  if (row && row.status !== 'PREPARADO') {
    await prisma.lembrete.update({ where: { id: reminder.id }, data: { status: 'INCERTO', erro: 'Envio anterior necessita reconciliação' } });
    return;
  }
  if (!row) {
    row = await prisma.envioBot.create({
      data: { instancia: process.env.INSTANCE_NAME, telefone: patient.telefone, finalidade: 'LEMBRETE', referenciaId: reminder.id },
    });
  }
  await prisma.lembrete.update({ where: { id: reminder.id }, data: { tentativas: { increment: 1 }, envioId: row.id } });
  const text = 'Olá! Este é um lembrete do Ambulatório HU: você tem consulta prevista para hoje. Confira os detalhes informados pela atendente nesta conversa.';
  try {
    await messenger.sendPreparedText(row, text);
    await prisma.lembrete.update({ where: { id: reminder.id }, data: { status: 'ENVIADO', reservadoAte: null, erro: null } });
  } catch (error) {
    const outbound = await prisma.envioBot.findUnique({ where: { id: row.id } });
    const uncertain = outbound?.status === 'INCERTO';
    const recoverable = messenger.isRecoverableFailure(error);
    const attempts = reminder.tentativas + 1;
    const delay = attempts === 1 ? 30000 : 60000;
    await prisma.lembrete.update({
      where: { id: reminder.id },
      data: {
        status: uncertain ? 'INCERTO' : recoverable && attempts < 3 ? 'FALHOU' : 'FALHA_FINAL',
        proximaTentativa: uncertain || !recoverable || attempts >= 3 ? null : new Date(Date.now() + delay),
        reservadoAte: null,
        erro: uncertain ? 'Resultado do envio incerto; conferir manualmente.' : String(error.message).slice(0, 255),
      },
    });
    if (!uncertain && recoverable && attempts < 3) {
      await prisma.envioBot.update({ where: { id: row.id }, data: { status: 'PREPARADO', iniciadoEm: null, concluidoEm: null } });
    }
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    await expireAndReconcile();
    await sendConfirmations();
    for (let i = 0; i < 20; i += 1) {
      const reminder = await claimReminder();
      if (!reminder) break;
      await processReminder(reminder);
    }
  } catch (error) {
    console.error('[worker] Erro:', error.message);
  } finally {
    running = false;
  }
}

if (require.main === module) {
  tick();
  setInterval(tick, POLL_MS);
}

module.exports = { tick, claimReminder, processReminder };
