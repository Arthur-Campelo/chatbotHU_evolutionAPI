const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
const { parseDate, validCpf, reminderDate, ZONE } = require('../src/validation');

test('CPF válido e dígitos verificadores', () => {
  assert.equal(validCpf('529.982.247-25'), '52998224725');
  assert.equal(validCpf('11111111111'), null);
  assert.equal(validCpf('52998224726'), null);
});

test('datas reais, ano bissexto e janela local de envio', () => {
  assert.equal(parseDate('31/02/2028'), null);
  assert.equal(parseDate('29/02/2028').toISODate(), '2028-02-29');
  assert.equal(parseDate('29/02/2027'), null);
  const now = DateTime.fromISO('2028-02-28T06:00:00', { zone: ZONE });
  const reminder = reminderDate('29/02/2028', now);
  assert.equal(DateTime.fromJSDate(reminder.scheduledAt, { zone: ZONE }).toFormat('HH:mm'), '07:00');
  assert.equal(DateTime.fromJSDate(reminder.deadline, { zone: ZONE }).toFormat('HH:mm'), '07:05');
  assert.ok(reminderDate('28/02/2028', now).error);
  assert.ok(reminderDate('27/02/2028', now).error);
});
