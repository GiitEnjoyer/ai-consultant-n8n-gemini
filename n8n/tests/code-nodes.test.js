/**
 * Модульные тесты JavaScript-кода из узлов Code рабочих процессов n8n.
 * Код извлекается прямо из JSON-файлов workflow, поэтому тестируется ровно то,
 * что будет импортировано в n8n. Окружение n8n ($input, $execution, $, DateTime)
 * подменяется заглушками.
 *
 * Запуск: cd n8n && npm install && npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DateTime } = require('luxon');

const load = (file) => require(path.join(__dirname, '..', 'workflows', file));
const chatWf = load('01_site_chat_agent.json');
const leadWf = load('02_create_lead.json');
const errWf = load('03_error_alert.json');

function codeOf(wf, nodeName) {
  const node = wf.nodes.find((n) => n.name === nodeName);
  assert.ok(node, `узел «${nodeName}» не найден`);
  return node.parameters.jsCode;
}

/** Выполняет код узла Code с заглушками окружения n8n. */
function runCode(code, { input = {}, nodes = {}, executionId = '1001' } = {}) {
  const $input = { first: () => ({ json: input }) };
  const $ = (name) => ({ first: () => ({ json: nodes[name] ?? {} }) });
  const $execution = { id: executionId };
  const fn = new Function('$input', '$', '$execution', 'DateTime', code);
  return fn($input, $, $execution, DateTime).map((item) => item.json);
}

// ---------------------------------------------------------------- 01 чат

test('проверка запроса: корректное сообщение', () => {
  const [out] = runCode(codeOf(chatWf, 'Проверка запроса'), {
    input: { body: { sessionId: 'abc-12345678', message: '  Сколько   стоит ремонт? ', page: '/prices' } },
  });
  assert.equal(out.valid, true);
  assert.equal(out.chatInput, 'Сколько стоит ремонт?');
  assert.equal(out.page, '/prices');
});

test('проверка запроса: пустое сообщение и плохой sessionId', () => {
  const [out] = runCode(codeOf(chatWf, 'Проверка запроса'), {
    input: { body: { sessionId: 'x; drop table', message: '   ' } },
  });
  assert.equal(out.valid, false);
  assert.match(out.error, /sessionId/);
  assert.match(out.error, /Пустое/);
});

test('проверка запроса: слишком длинное сообщение отклоняется', () => {
  const [out] = runCode(codeOf(chatWf, 'Проверка запроса'), {
    input: { body: { sessionId: 'abc-12345678', message: 'а'.repeat(1001) } },
  });
  assert.equal(out.valid, false);
});

test('формирование ответа: Markdown убирается', () => {
  const [out] = runCode(codeOf(chatWf, 'Формирование ответа'), {
    input: { output: '## Цены\n**Капитальный** ремонт:\n- от 9 000 ₽/м²' },
    nodes: { 'Проверка запроса': { sessionId: 's-1' } },
  });
  assert.equal(out.reply, 'Цены\nКапитальный ремонт:\n— от 9 000 ₽/м²');
  assert.equal(out.sessionId, 's-1');
});

test('резервный ответ: лимит 429 и прочие ошибки различаются', () => {
  const code = codeOf(chatWf, 'Резервный ответ');
  const nodes = { 'Проверка запроса': { sessionId: 's-1' } };
  const [limited] = runCode(code, { input: { error: { message: '[429 Too Many Requests] Resource exhausted' } }, nodes });
  const [down] = runCode(code, { input: { error: { message: 'connect ECONNREFUSED generativelanguage' } }, nodes });
  assert.match(limited.reply, /через минуту/);
  assert.match(down.reply, /временно недоступен/);
  assert.equal(down.degraded, true);
});

// ---------------------------------------------------------------- 02 заявка

const normalize = (lead) => runCode(codeOf(leadWf, 'Нормализация заявки'), { input: lead, executionId: '77' })[0];

for (const [raw, expected] of [
  ['8 (921) 123-45-67', '+79211234567'],
  ['+7 999 000 11 22', '+79990001122'],
  ['9210001122', '+79210001122'],
]) {
  test(`заявка: телефон «${raw}» приводится к ${expected}`, () => {
    const out = normalize({ name: 'Иван', phone: raw, request: 'капремонт' });
    assert.equal(out.valid, true);
    assert.equal(out.phone, expected);
  });
}

for (const raw of ['123-45-67', '+380 44 123 4567', '']) {
  test(`заявка: телефон «${raw}» отклоняется`, () => {
    const out = normalize({ name: 'Иван', phone: raw });
    assert.equal(out.valid, false);
    assert.match(out.errors.join(), /Телефон/);
  });
}

test('заявка: номер содержит ID запуска, HTML в тексте экранируется', () => {
  const out = normalize({ name: 'Иван <b>', phone: '89211234567', request: '<script>alert(1)</script>' });
  assert.match(out.leadId, /^L-\d{6}-77$/);
  assert.ok(!out.telegramText.includes('<script>'));
  assert.ok(out.telegramText.includes('&lt;script&gt;'));
});

test('заявка: пустое имя отклоняется', () => {
  assert.equal(normalize({ name: ' ', phone: '89211234567' }).valid, false);
});

test('итог заявки: ok, если сохранено хотя бы в одном канале', () => {
  const code = codeOf(leadWf, 'Результат: заявка создана');
  const lead = { 'Нормализация заявки': { leadId: 'L-1' } };
  const [sheetFailed] = runCode(code, { input: {}, nodes: { ...lead, 'Запись в Google Sheets': { error: 'x' } } });
  assert.equal(sheetFailed.status, 'ok');
  assert.equal(sheetFailed.savedToSheet, false);
  const [bothFailed] = runCode(code, {
    input: { error: 'telegram down' },
    nodes: { ...lead, 'Запись в Google Sheets': { error: 'x' } },
  });
  assert.equal(bothFailed.status, 'error');
});

// ---------------------------------------------------------------- 03 ошибки

test('уведомление об ошибке: экранирование и обрезка', () => {
  const [out] = runCode(codeOf(errWf, 'Текст уведомления'), {
    input: {
      workflow: { name: 'Кварта <test>' },
      execution: { lastNodeExecuted: 'Gemini', error: { message: 'x'.repeat(2000) }, url: 'http://n8n/e/1' },
    },
  });
  assert.match(out.text, /Кварта &lt;test&gt;/);
  assert.ok(out.text.length < 800);
});

// ---------------------------------------------------------------- структура

test('все ссылки на под-процессы и учётные данные согласованы', () => {
  const tool = chatWf.nodes.find((n) => n.name === 'create_lead');
  assert.equal(tool.parameters.workflowId.value, leadWf.id);
  assert.equal(chatWf.settings.errorWorkflow, errWf.id);
  for (const wf of [chatWf, leadWf, errWf]) {
    for (const [from, conn] of Object.entries(wf.connections)) {
      assert.ok(wf.nodes.some((n) => n.name === from), `${wf.name}: нет узла ${from}`);
      for (const outputs of Object.values(conn)) {
        for (const target of outputs.flat()) {
          assert.ok(wf.nodes.some((n) => n.name === target.node), `${wf.name}: нет узла ${target.node}`);
        }
      }
    }
  }
});
