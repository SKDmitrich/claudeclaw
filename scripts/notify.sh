#!/usr/bin/env bash
# notify.sh — send a message to Telegram from shell scripts
# Usage: ./scripts/notify.sh "Your message here"
#
# Reads TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_ID from .env in the project root

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${PROJECT_ROOT}/.env"

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

if [[ -z "$BOT_TOKEN" ]]; then
  echo "Error: TELEGRAM_BOT_TOKEN not set in .env" >&2
  exit 1
fi

if [[ -z "$CHAT_ID" ]]; then
  echo "Error: ALLOWED_CHAT_ID not set in .env" >&2
  exit 1
fi

MESSAGE="${1:-}"
if [[ -z "$MESSAGE" ]]; then
  echo "Usage: $0 \"Your message\"" >&2
  exit 1
fi

curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\": \"${CHAT_ID}\", \"text\": $(echo "$MESSAGE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')}" \
  > /dev/null

echo "Sent."
