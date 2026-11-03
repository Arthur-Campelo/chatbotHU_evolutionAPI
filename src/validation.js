const { DateTime } = require('luxon');

const ZONE = 'America/Campo_Grande';

function parseDate(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value).trim());
  if (!match) return null;
  const [, day, month, year] = match;
  const date = DateTime.fromObject({ year: Number(year), month: Number(month), day: Number(day) }, { zone: ZONE });
  return date.isValid && date.toFormat('dd/MM/yyyy') === value.trim() ? date : null;
}

function dateOnly(value) {
  return new Date(`${value.toISODate()}T00:00:00.000Z`);
}

function formatDate(value) {
  return DateTime.fromJSDate(value, { zone: 'utc' }).toFormat('dd/MM/yyyy');
}

function validCpf(value) {
  const cpf = String(value).replace(/\D/g, '');
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return null;
  for (let length = 9; length <= 10; length += 1) {
    const sum = [...cpf.slice(0, length)].reduce((total, digit, index) => total + Number(digit) * (length + 1 - index), 0);
    const remainder = (sum * 10) % 11;
    if (Number(cpf[length]) !== (remainder === 10 ? 0 : remainder)) return null;
  }
  return cpf;
}

function normalizeName(value) {
  const name = String(value).trim().replace(/\s+/g, ' ');
  return name.length >= 2 && name.length <= 150 ? name : null;
}

function reminderDate(value, now = DateTime.now().setZone(ZONE)) {
  const date = parseDate(value);
  if (!date) return { error: 'Data inválida. Use DD/MM/AAAA.' };
  if (date.toISODate() <= now.setZone(ZONE).toISODate()) {
    return { error: 'Lembrete dispensado: a data precisa ser posterior a hoje.' };
  }
  return {
    date: dateOnly(date),
    scheduledAt: date.set({ hour: 7, minute: 0 }).toUTC().toJSDate(),
    deadline: date.set({ hour: 7, minute: 5 }).toUTC().toJSDate(),
  };
}

module.exports = { ZONE, parseDate, dateOnly, formatDate, validCpf, normalizeName, reminderDate };
