const { prisma } = require('./db');
const messenger = require('./messenger');
const { getPage, START_PAGE } = require('./flow');
const { getSession, hasSession, setPage, setData, setPendingPage, resetSession } = require('./sessionManager');
const { DateTime } = require('luxon');
const { ZONE, parseDate, dateOnly, formatDate, validCpf, normalizeName, reminderDate } = require('./validation');

const phoneQueues = new Map();
const completedEvents = new Set();

function serial(phone, task) {
  const previous = phoneQueues.get(phone) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  phoneQueues.set(phone, current);
  current.finally(() => { if (phoneQueues.get(phone) === current) phoneQueues.delete(phone); }).catch(() => {});
  return current;
}

function phoneFromJid(key) {
  for (const candidate of [key?.remoteJidAlt, key?.remoteJid]) {
    if (typeof candidate !== 'string' || (candidate.includes('@') && !/@(s\.whatsapp\.net|c\.us)$/.test(candidate))) continue;
    const phone = candidate.split('@')[0].replace(/\D/g, '');
    if (/^55\d{10,11}$/.test(phone)) return phone;
  }
  return null;
}

function extractMessageInfo(body) {
  if (!body || !['messages.upsert', 'send.message'].includes(String(body.event).toLowerCase())) return null;
  if (body.instance !== process.env.INSTANCE_NAME || !body.data?.key?.id) return null;
  const { key, message = {} } = body.data;
  const phone = phoneFromJid(key);
  if (!phone) return null;
  const text = message.conversation || message.extendedTextMessage?.text || null;
  const rawTimestamp = body.data.messageTimestamp || body.date_time;
  let timestamp = rawTimestamp ? new Date(/^\d+$/.test(String(rawTimestamp))
    ? Number(rawTimestamp) * (String(rawTimestamp).length <= 10 ? 1000 : 1)
    : rawTimestamp) : new Date();
  if (Number.isNaN(timestamp.getTime()) || timestamp > new Date()) timestamp = new Date();
  return { phone, messageId: String(key.id), fromMe: key.fromMe === true, text, timestamp, event: String(body.event).toLowerCase() };
}

function allowed(phone) {
  const configured = (process.env.ALLOWED_NUMBER || '').replace(/\D/g, '');
  return !configured || phone === configured;
}

function yesNo(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['1', 'sim'].includes(normalized)) return true;
  if (['2', 'não', 'nao'].includes(normalized)) return false;
  return null;
}

function summary(session) {
  const { cpf, nome, dataNascimento } = session.data;
  return `Confirma estes dados?\nNome: ${nome}\nNascimento: ${dataNascimento}\nCPF: ***.***.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
}

function existingSummary(patient) {
  const cpf = patient.cpf;
  return `Encontrei seu cadastro. Estes dados estão corretos?\nNome: ${patient.nome}\nNascimento: ${formatDate(patient.dataNascimento)}\nCPF: ***.***.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
}

async function pause(phone, when = new Date()) {
  const until = new Date(when.getTime() + 3600000);
  await prisma.controleConversa.upsert({
    where: { instancia_telefone: { instancia: process.env.INSTANCE_NAME, telefone: phone } },
    create: { instancia: process.env.INSTANCE_NAME, telefone: phone, pausadoAte: until },
    update: { pausadoAte: until },
  });
}

async function advanceToPage(phone, name) {
  const session = getSession(phone);
  setPendingPage(phone, name);
  if (name === 'Identificar Paciente') {
    const patient = await prisma.paciente.findUnique({ where: { telefone: phone } });
    session.data.patient = patient;
    return advanceToPage(phone, patient ? 'Confirmar Cadastro Existente' : 'Termos de Serviço');
  }
  const page = getPage(name);
  if (!page) throw new Error(`Página inexistente: ${name}`);
  let text = page.text;
  if (name === 'Termos de Serviço') await messenger.sendDocument(phone);
  if (name === 'Confirmar Cadastro Existente') text = existingSummary(session.data.patient);
  if (name === 'Confirmar Novo Cadastro') text = summary(session);
  if (name === 'Encerramento') await pause(phone);
  await messenger.sendText(phone, text, page.options, name);
  setPage(phone, name);
  session.pendingPage = null;
  if (page.inputType === 'auto' && page.nextPage && name !== 'Encerramento') {
    return advanceToPage(phone, page.nextPage);
  }
}

async function savePatient(phone, session) {
  const { cpf, nome, dataNascimento, patient } = session.data;
  const data = { cpf, nome, dataNascimento: dateOnly(parseDate(dataNascimento)) };
  try {
    if (patient) {
      await prisma.paciente.update({ where: { id: patient.id }, data });
    } else {
      if (!session.data.termsAccepted) throw new Error('Aceite dos termos ausente');
      await prisma.paciente.create({ data: { ...data, telefone: phone } });
    }
    return true;
  } catch (error) {
    if (error.code !== 'P2002') throw error;
    const existing = await prisma.paciente.findUnique({ where: { telefone: phone } });
    if (existing?.cpf === cpf) return true;
    await messenger.sendText(phone, 'Este CPF precisa ser conferido pela atendente. Seu cadastro não foi alterado. Aguarde o contato da equipe.', null, 'CONFLITO_CPF');
    await pause(phone);
    setPage(phone, 'Encerramento');
    return false;
  }
}

async function handleUserInput(phone, text) {
  const session = getSession(phone);
  const value = String(text || '').trim();
  if (session.pendingPage) return advanceToPage(phone, session.pendingPage);
  if (!session.started || session.currentPage === 'Encerramento') {
    resetSession(phone).started = true;
    return advanceToPage(phone, START_PAGE);
  }
  const current = getPage(session.currentPage);
  if (!current) throw new Error(`Página atual inválida: ${session.currentPage}`);
  if (current.inputType === 'text_menu') {
    let index = /^\d+$/.test(value) ? Number(value) - 1 : -1;
    if (['Termos de Serviço', 'Confirmar Cadastro Existente', 'Confirmar Novo Cadastro'].includes(current.displayName)) {
      const answer = yesNo(value);
      if (answer !== null) index = answer ? 0 : 1;
    }
    const option = current.options?.[index];
    if (!option) {
      await messenger.sendText(phone, 'Não entendi sua escolha. Responda com o número de uma das opções apresentadas.', null, 'ERRO_OPCAO');
      return messenger.sendText(phone, current.text || (current.displayName === 'Confirmar Cadastro Existente' ? existingSummary(session.data.patient) : summary(session)), current.options);
    }
    if (current.displayName === 'Termos de Serviço') {
      if (index === 1) {
        await messenger.sendText(phone, 'Sem o aceite dos termos, encerramos este atendimento. Quando quiser começar novamente, envie uma mensagem.', null, 'RECUSA_TERMOS');
        resetSession(phone);
        return;
      }
      session.data.termsAccepted = true;
    }
    if (current.displayName === 'Confirmar Cadastro Existente' && index === 1) {
      session.data = { patient: session.data.patient, editing: true };
    }
    if (current.displayName === 'Confirmar Novo Cadastro') {
      if (index === 1) {
        session.data = { patient: session.data.patient, termsAccepted: session.data.termsAccepted, editing: true };
        return advanceToPage(phone, 'Solicitar CPF');
      }
      if (!await savePatient(phone, session)) return;
    }
    const next = current.transitions?.[option.id] || current.nextPage;
    if (!next) throw new Error(`Transição inexistente: ${current.displayName}`);
    return advanceToPage(phone, next);
  }
  if (current.inputType === 'text') {
    let normalized = value;
    if (current.validate === 'cpf') normalized = validCpf(value);
    if (current.saveAs === 'nome') normalized = normalizeName(value);
    if (current.validate === 'nascimento') {
      const date = parseDate(value);
      normalized = date && date.toISODate() <= DateTime.now().setZone(ZONE).toISODate() ? date.toFormat('dd/MM/yyyy') : null;
    }
    if (current.validate === 'data') normalized = parseDate(value)?.toFormat('dd/MM/yyyy');
    if (!normalized) {
      await messenger.sendText(phone, `Dado inválido. ${current.text}`, null, 'ERRO_CAMPO');
      return;
    }
    if (current.saveAs) setData(phone, current.saveAs, normalized);
    return advanceToPage(phone, current.nextPage);
  }
}

async function recordManual(phone, timestamp) {
  if (timestamp.getTime() < Date.now() - 3600000) return false;
  const key = { instancia_telefone: { instancia: process.env.INSTANCE_NAME, telefone: phone } };
  const current = await prisma.controleConversa.findUnique({ where: key });
  if (current?.ultimaRetomadaExplicita && timestamp <= current.ultimaRetomadaExplicita) return false;
  if (current?.ultimaIntervencaoManual && timestamp < current.ultimaIntervencaoManual) return false;
  const until = new Date(Math.max(current?.pausadoAte?.getTime() || 0, Date.now() + 3600000));
  await prisma.controleConversa.upsert({
    where: key,
    create: { instancia: process.env.INSTANCE_NAME, telefone: phone, ultimaIntervencaoManual: timestamp, pausadoAte: until },
    update: { ultimaIntervencaoManual: timestamp, pausadoAte: until },
  });
  return true;
}

async function manualMessage(info) {
  const { phone, text, timestamp } = info;
  if (!await recordManual(phone, timestamp)) return;
  const command = /^dia\s*:\s*(\d{2}\/\d{2}\/\d{4})\s*$/i.exec(String(text || '').trim());
  if (!command) return;
  const patient = await prisma.paciente.findUnique({ where: { telefone: phone } });
  if (!patient) return;
  const computed = reminderDate(command[1]);
  if (computed.error) {
    await messenger.sendText(phone, computed.error, null, 'ERRO_LEMBRETE');
    return;
  }
  const id = require('node:crypto').randomUUID();
  try {
    await prisma.$transaction(async (tx) => {
      await tx.lembrete.create({
        data: { id, pacienteId: patient.id, dataConsulta: computed.date, programadoPara: computed.scheduledAt, limiteEnvio: computed.deadline },
      });
      await tx.envioBot.create({
        data: { instancia: process.env.INSTANCE_NAME, telefone: phone, finalidade: 'CONFIRMACAO_LEMBRETE', referenciaId: id, status: 'PREPARADO' },
      });
    });
  } catch (error) {
    if (error.code === 'P2002') return;
    throw error;
  }
  const confirmation = await prisma.envioBot.findUnique({ where: { finalidade_referenciaId: { finalidade: 'CONFIRMACAO_LEMBRETE', referenciaId: id } } });
  const claimed = await prisma.envioBot.updateMany({ where: { id: confirmation.id, status: 'PREPARADO' }, data: { status: 'RESERVADO' } });
  if (claimed.count) await messenger.sendPreparedText({ ...confirmation, status: 'PREPARADO' }, `Lembrete programado para ${command[1]}, às 07:00.`);
}

async function processWebhookEvent(body) {
  const info = extractMessageInfo(body);
  if (!info || !allowed(info.phone)) return;
  return serial(info.phone, async () => {
    if (info.fromMe && info.event === 'send.message') await messenger.reconcileOutgoing(info);
    const key = { instancia_mensagemId_direcao: { instancia: process.env.INSTANCE_NAME, mensagemId: info.messageId, direcao: info.fromMe ? 'SAIDA' : 'ENTRADA' } };
    const eventKey = `${process.env.INSTANCE_NAME}:${info.messageId}:${info.fromMe ? 'SAIDA' : 'ENTRADA'}`;
    const old = await prisma.eventoProcessado.findUnique({ where: key });
    if (old?.status === 'CONCLUIDO') return;
    if (old && !info.fromMe && !hasSession(info.phone)) {
      await prisma.eventoProcessado.update({ where: key, data: { status: 'CONCLUIDO', concluidoEm: new Date() } });
      return;
    }
    if (completedEvents.has(eventKey)) {
      await prisma.eventoProcessado.update({ where: key, data: { status: 'CONCLUIDO', concluidoEm: new Date() } });
      return;
    }
    if (!old) {
      await prisma.eventoProcessado.create({ data: { instancia: process.env.INSTANCE_NAME, mensagemId: info.messageId, direcao: info.fromMe ? 'SAIDA' : 'ENTRADA' } });
    } else {
      await prisma.eventoProcessado.update({ where: key, data: { status: 'PROCESSANDO' } });
    }
    try {
      if (info.fromMe) {
        const bot = info.event === 'send.message' || await messenger.isBotMessage(process.env.INSTANCE_NAME, info.phone, info.messageId);
        if (!bot) await manualMessage(info);
      } else if (info.text) {
        const controlKey = { instancia_telefone: { instancia: process.env.INSTANCE_NAME, telefone: info.phone } };
        const control = await prisma.controleConversa.findUnique({ where: controlKey });
        if (getSession(info.phone).pendingPage) {
          await handleUserInput(info.phone, info.text);
        } else if (control?.pausadoAte && control.pausadoAte > new Date()) {
          if (/^(menu|reiniciar)$/i.test(info.text.trim())) {
            await prisma.controleConversa.update({ where: controlKey, data: { pausadoAte: null, ultimaRetomadaExplicita: new Date() } });
            resetSession(info.phone);
            await handleUserInput(info.phone, info.text);
          }
        } else {
          if (control?.pausadoAte) resetSession(info.phone);
          await handleUserInput(info.phone, info.text);
        }
      }
      completedEvents.add(eventKey);
      if (completedEvents.size > 10000) completedEvents.clear();
      await prisma.eventoProcessado.update({ where: key, data: { status: 'CONCLUIDO', concluidoEm: new Date() } });
    } catch (error) {
      await prisma.eventoProcessado.update({ where: key, data: { status: 'FALHOU' } });
      throw error;
    }
  });
}

module.exports = { processWebhookEvent, extractMessageInfo, phoneFromJid, handleUserInput, advanceToPage };
