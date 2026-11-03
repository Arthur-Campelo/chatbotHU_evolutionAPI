const axios = require('axios');
const fs = require('node:fs/promises');
const path = require('node:path');

const api = axios.create({
  baseURL: process.env.EVOLUTION_API_URL,
  headers: { apikey: process.env.EVOLUTION_API_KEY },
  timeout: 15000,
});

function menuText(text, options) {
  return options?.length
    ? `${text}\n${options.map((option, index) => `${index + 1} - ${option.title}`).join('\n')}`
    : text;
}

async function sendText(number, text) {
  const { data } = await api.post(`/message/sendText/${process.env.INSTANCE_NAME}`, { number, text });
  return data;
}

async function sendDocument(number) {
  const documentPath = path.resolve(process.env.TERMS_PDF_PATH || path.join(__dirname, '..', 'assets', 'termos-demonstrativos.pdf'));
  const media = (await fs.readFile(documentPath)).toString('base64');
  const { data } = await api.post(`/message/sendMedia/${process.env.INSTANCE_NAME}`, {
    number,
    mediatype: 'document',
    mimetype: 'application/pdf',
    caption: 'Termos de uso e privacidade - documento demonstrativo',
    fileName: path.basename(documentPath),
    media,
  });
  return data;
}

module.exports = { sendText, sendDocument, menuText };
