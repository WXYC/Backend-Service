#!/bin/bash
# Flowsheet Cut-Over Script
#
# One-time migration: dumps FLOWSHEET_RADIO_SHOW_PROD and FLOWSHEET_ENTRY_PROD
# from the legacy MySQL server via SSH, then runs the flowsheet ETL in --replace
# mode (truncate + bulk load in a single transaction).
#
# Usage:
#   ./scripts/flowsheet-cutover.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DUMP_FILE="$(mktemp /tmp/flowsheet_dump_XXXXXX.sql)"

fail() {
  echo "❌ $1" >&2
  exit 1
}

info() {
  echo "── $1"
}

cleanup() {
  rm -f "$DUMP_FILE"
}
trap cleanup EXIT

# ── 1. Check .env ─────────────────────────────────────────────────

ENV_FILE="$PROJECT_ROOT/.env"
if [ ! -f "$ENV_FILE" ]; then
  fail ".env file not found at $ENV_FILE."
fi

parse_env_var() {
  grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-
}

DOTENVX="npx dotenvx run --quiet -f $ENV_FILE --"

# ── 2. Validate required env vars ────────────────────────────────

MISSING=()
for var in DB_HOST DB_NAME DB_USERNAME SSH_HOST SSH_USERNAME SSH_PASSWORD REMOTE_DB_USER REMOTE_DB_PASSWORD REMOTE_DB_NAME; do
  val="$(parse_env_var "$var")"
  if [ -z "$val" ]; then
    MISSING+=("$var")
  fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
  fail "Missing required variables in .env: ${MISSING[*]}"
fi

SSH_HOST="$(parse_env_var SSH_HOST)"
SSH_USERNAME="$(parse_env_var SSH_USERNAME)"
SSH_PASSWORD="$(parse_env_var SSH_PASSWORD)"
REMOTE_DB_USER="$(parse_env_var REMOTE_DB_USER)"
REMOTE_DB_PASSWORD="$(parse_env_var REMOTE_DB_PASSWORD)"
REMOTE_DB_NAME="$(parse_env_var REMOTE_DB_NAME)"
REMOTE_DB_HOST="$(parse_env_var REMOTE_DB_HOST)"
REMOTE_DB_HOST="${REMOTE_DB_HOST:-localhost}"
REMOTE_DB_PORT="$(parse_env_var REMOTE_DB_PORT)"
REMOTE_DB_PORT="${REMOTE_DB_PORT:-3306}"

info "Legacy MySQL: $SSH_HOST -> $REMOTE_DB_HOST:$REMOTE_DB_PORT/$REMOTE_DB_NAME"

# ── 3. Generate MySQL dump via SSH ────────────────────────────────

info "Generating MySQL dump from legacy server..."

MYSQLDUMP_CMD="MYSQL_PWD='$REMOTE_DB_PASSWORD' mysqldump -u $REMOTE_DB_USER -h $REMOTE_DB_HOST -P $REMOTE_DB_PORT --protocol=TCP --skip-ssl --skip-lock-tables --single-transaction $REMOTE_DB_NAME FLOWSHEET_RADIO_SHOW_PROD FLOWSHEET_ENTRY_PROD"

sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no "$SSH_USERNAME@$SSH_HOST" "$MYSQLDUMP_CMD" > "$DUMP_FILE" 2>/dev/null

DUMP_SIZE=$(du -h "$DUMP_FILE" | cut -f1)
info "Dump complete: $DUMP_SIZE"

if [ ! -s "$DUMP_FILE" ]; then
  fail "Dump file is empty. Check SSH and MySQL credentials."
fi

# ── 4. Build and run ETL with --replace ───────────────────────────

info "Building flowsheet ETL..."
npm run build --workspace=@wxyc/flowsheet-etl --silent 2>/dev/null

info "Running flowsheet ETL (--replace: truncate + bulk load in one transaction)..."
echo ""
$DOTENVX npm start --workspace=@wxyc/flowsheet-etl -- "$DUMP_FILE" --replace
echo ""

info "Cut-over complete. The incremental ETL cron will pick up from here."
