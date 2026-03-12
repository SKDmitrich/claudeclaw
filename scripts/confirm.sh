#!/usr/bin/env bash
# confirm.sh -- ask user for confirmation via Telegram, wait for response
#
# Usage: ./scripts/confirm.sh "Создать 10 файлов в Obsidian?"
# Exit codes: 0 = approved, 1 = rejected, 2 = timeout, 3 = answered (check response)
#
# Optional env: CONFIRM_TIMEOUT (seconds, default 300 = 5 min)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${PROJECT_ROOT}/.env"
DB_PATH="${PROJECT_ROOT}/store/claudeclaw.db"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: .env not found at $ENV_FILE" >&2
  exit 1
fi

# Parse .env
BOT_TOKEN=""
CHAT_ID=""
while IFS='=' read -r key value; do
  [[ "$key" =~ ^# ]] && continue
  [[ -z "$key" ]] && continue
  key="${key// /}"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  if [[ "$key" == "TELEGRAM_BOT_TOKEN" ]]; then BOT_TOKEN="$value"; fi
  if [[ "$key" == "ALLOWED_CHAT_ID" ]]; then CHAT_ID="$value"; fi
done < "$ENV_FILE"

if [[ -z "$BOT_TOKEN" || -z "$CHAT_ID" ]]; then
  echo "Error: TELEGRAM_BOT_TOKEN or ALLOWED_CHAT_ID not set" >&2
  exit 1
fi

QUESTION="${1:-}"
if [[ -z "$QUESTION" ]]; then
  echo "Usage: $0 \"Your question\"" >&2
  exit 1
fi

TIMEOUT="${CONFIRM_TIMEOUT:-300}"
CONFIRM_ID="conf_$(date +%s)_$$"

# Insert confirmation into SQLite
sqlite3 "$DB_PATH" "INSERT INTO confirmations (id, chat_id, question, status, created_at) VALUES ('${CONFIRM_ID}', '${CHAT_ID}', '$(echo "$QUESTION" | sed "s/'/''/g")', 'pending', $(date +%s%3N));"

# Send message with inline keyboard
KEYBOARD='{"inline_keyboard":[[{"text":"✅ Да","callback_data":"confirm:'"$CONFIRM_ID"'"},{"text":"❌ Нет","callback_data":"reject:'"$CONFIRM_ID"'"}]]}'

curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d "{
    \"chat_id\": \"${CHAT_ID}\",
    \"text\": \"🔔 Подтверждение:\n\n${QUESTION}\n\nОтветь кнопкой, текстом или голосом.\",
    \"reply_markup\": ${KEYBOARD}
  }" > /dev/null

# Poll for response
ELAPSED=0
while [[ $ELAPSED -lt $TIMEOUT ]]; do
  STATUS=$(sqlite3 "$DB_PATH" "SELECT status FROM confirmations WHERE id = '${CONFIRM_ID}';")

  case "$STATUS" in
    approved)
      RESPONSE=$(sqlite3 "$DB_PATH" "SELECT response FROM confirmations WHERE id = '${CONFIRM_ID}';")
      echo "${RESPONSE:-approved}"
      exit 0
      ;;
    rejected)
      RESPONSE=$(sqlite3 "$DB_PATH" "SELECT response FROM confirmations WHERE id = '${CONFIRM_ID}';")
      echo "${RESPONSE:-rejected}"
      exit 1
      ;;
    answered)
      RESPONSE=$(sqlite3 "$DB_PATH" "SELECT response FROM confirmations WHERE id = '${CONFIRM_ID}';")
      echo "$RESPONSE"
      exit 3
      ;;
  esac

  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

# Timeout -- clean up
sqlite3 "$DB_PATH" "UPDATE confirmations SET status = 'rejected' WHERE id = '${CONFIRM_ID}';"
echo "timeout"
exit 2
