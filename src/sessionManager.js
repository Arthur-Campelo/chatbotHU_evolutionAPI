/**
 * sessionManager.js
 * -----------------------------------------------------------------------
 * Sistema simples de estado de sessão EM MEMÓRIA, mapeando o remoteJid do
 * usuário para a página atual do fluxo e os dados coletados até o momento.
 *
 * Os dados provisórios são deliberadamente perdidos ao reiniciar o processo.
 * Apenas pacientes confirmados, pausas e lembretes ficam no PostgreSQL.
 * -----------------------------------------------------------------------
 */

const { START_PAGE } = require('./flow');

/** @type {Map<string, { currentPage: string, data: Record<string, any>, updatedAt: number }>} */
const sessions = new Map();

function createSession(remoteJid) {
  const session = {
    currentPage: START_PAGE,
    data: {},
    started: false,
    pendingPage: null,
    updatedAt: Date.now(),
  };
  sessions.set(remoteJid, session);
  return session;
}

function getSession(remoteJid) {
  return sessions.get(remoteJid) || createSession(remoteJid);
}

function hasSession(remoteJid) {
  return sessions.has(remoteJid);
}

function setPage(remoteJid, pageName) {
  const session = getSession(remoteJid);
  session.currentPage = pageName;
  session.updatedAt = Date.now();
  sessions.set(remoteJid, session);
  return session;
}

function setPendingPage(remoteJid, pageName) {
  const session = getSession(remoteJid);
  session.pendingPage = pageName;
  return session;
}

function setData(remoteJid, key, value) {
  const session = getSession(remoteJid);
  session.data[key] = value;
  session.updatedAt = Date.now();
  sessions.set(remoteJid, session);
  return session;
}

function resetSession(remoteJid) {
  return createSession(remoteJid);
}

function deleteSession(remoteJid) {
  sessions.delete(remoteJid);
}

module.exports = {
  getSession,
  hasSession,
  createSession,
  setPage,
  setPendingPage,
  setData,
  resetSession,
  deleteSession,
};
