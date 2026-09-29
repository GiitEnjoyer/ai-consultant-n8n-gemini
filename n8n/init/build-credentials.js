#!/usr/bin/env node
/**
 * Формирует файл учётных данных n8n из переменных окружения (.env),
 * чтобы проект запускался одной командой без ручной настройки в интерфейсе.
 * Файл импортируется командой `n8n import:credentials`, после чего удаляется;
 * в базе n8n данные хранятся зашифрованными ключом N8N_ENCRYPTION_KEY.
 *
 * Идентификаторы совпадают с указанными в JSON рабочих процессов.
 */
'use strict';

const fs = require('fs');

const out = process.argv[2] || '/tmp/credentials.json';
const env = process.env;
const credentials = [];
const skipped = [];

credentials.push({
  id: 'credPostgresKvrt',
  name: 'Postgres (chat memory)',
  type: 'postgres',
  data: {
    host: env.DB_POSTGRESDB_HOST || 'postgres',
    port: Number(env.DB_POSTGRESDB_PORT || 5432),
    database: env.DB_POSTGRESDB_DATABASE || 'n8n',
    user: env.DB_POSTGRESDB_USER || 'n8n',
    password: env.DB_POSTGRESDB_PASSWORD || '',
    ssl: 'disable',
  },
});

if (env.GEMINI_API_KEY) {
  credentials.push({
    id: 'credGeminiKvarta',
    name: 'Gemini API (free tier)',
    type: 'googlePalmApi',
    data: {
      host: env.GEMINI_API_HOST || 'https://generativelanguage.googleapis.com',
      apiKey: env.GEMINI_API_KEY,
    },
  });
} else {
  skipped.push('GEMINI_API_KEY — консультант не сможет отвечать');
}

if (env.TELEGRAM_BOT_TOKEN) {
  credentials.push({
    id: 'credTelegramKvrt',
    name: 'Telegram bot (manager alerts)',
    type: 'telegramApi',
    data: {
      accessToken: env.TELEGRAM_BOT_TOKEN,
      baseUrl: env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org',
    },
  });
} else {
  skipped.push('TELEGRAM_BOT_TOKEN — уведомления менеджеру отключены');
}

const saPath = env.GOOGLE_SERVICE_ACCOUNT_FILE || '/secrets/google-service-account.json';
if (fs.existsSync(saPath)) {
  const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));
  credentials.push({
    id: 'credGSheetsKvrta',
    name: 'Google Sheets (service account)',
    type: 'googleApi',
    data: { email: sa.client_email, privateKey: sa.private_key, region: 'global' },
  });
} else {
  skipped.push(`${saPath} не найден — запись заявок в Google Sheets отключена`);
}

fs.writeFileSync(out, JSON.stringify(credentials), { mode: 0o600 });
console.log(`[init] Подготовлено учётных данных: ${credentials.length}`);
for (const s of skipped) console.log(`[init] Пропущено: ${s}`);
