#!/bin/sh
# Однократная инициализация n8n перед запуском основного контейнера:
# 1) импорт учётных данных из .env (выполняется при каждом запуске, чтобы
#    изменения ключей в .env применялись без ручных действий);
# 2) импорт и публикация рабочих процессов (только при первом запуске или
#    при FORCE_WORKFLOW_IMPORT=true, чтобы не затирать правки из интерфейса).
set -eu

CREDS=/tmp/credentials.json
WORKFLOWS_DIR=${WORKFLOWS_DIR:-/workflows}
IDS="KvartaErrorAlert KvartaCreateLead KvartaChatAgent1"

node /init/build-credentials.js "$CREDS"
n8n import:credentials --input="$CREDS"
rm -f "$CREDS"

if [ "${FORCE_WORKFLOW_IMPORT:-false}" = "true" ] || ! n8n list:workflow --onlyId 2>/dev/null | grep -q KvartaChatAgent1; then
  echo "[init] Импорт рабочих процессов из $WORKFLOWS_DIR"
  n8n import:workflow --separate --input="$WORKFLOWS_DIR"
  for id in $IDS; do
    n8n publish:workflow --id="$id"
  done
else
  echo "[init] Рабочие процессы уже импортированы, пропуск (FORCE_WORKFLOW_IMPORT=true для повторного импорта)"
fi

echo "[init] Готово"
