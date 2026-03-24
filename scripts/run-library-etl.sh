#!/bin/bash
# Library ETL Runner Script
# Usage: ./scripts/run-library-etl.sh
#
# Validates the environment, ensures the database is reachable,
# builds the job if needed, and runs it.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
JOB_DIR="$PROJECT_ROOT/jobs/library-etl"

# ── Helper ──────────────────────────────────────────────────────────

fail() {
  echo "❌ $1" >&2
  exit 1
}

info() {
  echo "── $1"
}

# ── 1. Check .env ───────────────────────────────────────────────────

ENV_FILE="$PROJECT_ROOT/.env"
if [ ! -f "$ENV_FILE" ]; then
  fail ".env file not found at $ENV_FILE. Copy .env.example and fill in your values."
fi

# Parse a var from .env (handles simple KEY=value lines; dotenvx handles the real loading)
parse_env_var() {
  grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-
}

DOTENVX="npx dotenvx run --quiet -f $ENV_FILE --"

# ── 2. Validate required env vars ──────────────────────────────────

MISSING=()
for var in DB_HOST DB_NAME DB_USERNAME; do
  val="$(parse_env_var "$var")"
  if [ -z "$val" ]; then
    MISSING+=("$var")
  fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
  fail "Missing required environment variables in .env: ${MISSING[*]}"
fi

DB_HOST="$(parse_env_var DB_HOST)"
DB_PORT="$(parse_env_var DB_PORT)"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="$(parse_env_var DB_NAME)"

info "Target database: $DB_HOST:$DB_PORT/$DB_NAME"

# ── 3. Check SSH vars (legacy server access) ───────────────────────

SSH_MISSING=()
for var in SSH_HOST SSH_USERNAME SSH_PASSWORD REMOTE_DB_HOST REMOTE_DB_USER REMOTE_DB_PASSWORD REMOTE_DB_NAME; do
  val="$(parse_env_var "$var")"
  if [ -z "$val" ]; then
    SSH_MISSING+=("$var")
  fi
done

if [ ${#SSH_MISSING[@]} -gt 0 ]; then
  echo "⚠️  Missing legacy server variables in .env: ${SSH_MISSING[*]}"
  echo "   The job will fail when it tries to connect to the legacy MySQL database."
  echo ""
fi

# ── 4. Check Docker + database container ────────────────────────────

if [ "$DB_HOST" = "localhost" ] || [ "$DB_HOST" = "127.0.0.1" ]; then
  if ! docker info &>/dev/null 2>&1; then
    info "Docker is not running. Starting Docker Desktop..."
    open -a Docker
    # Wait for the daemon to become responsive
    DOCKER_RETRIES=30
    for i in $(seq 1 $DOCKER_RETRIES); do
      if docker info &>/dev/null 2>&1; then
        break
      fi
      if [ "$i" -eq "$DOCKER_RETRIES" ]; then
        fail "Docker did not start after ${DOCKER_RETRIES}s. Start Docker Desktop manually and try again."
      fi
      printf "   Waiting for Docker daemon... (%d/%d)\r" "$i" "$DOCKER_RETRIES"
      sleep 1
    done
    echo ""
    info "Docker is running"
  fi

  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'dev_env-db-1'; then
    info "Database container is not running. Starting it..."
    npm run db:start
  fi

  info "Docker database container is running"
fi

# ── 5. Verify database connectivity ────────────────────────────────

# Use a lightweight Node check so we don't need psql installed
DB_USERNAME="$(parse_env_var DB_USERNAME)"
DB_PASSWORD="$(parse_env_var DB_PASSWORD)"

DB_CHECK=$(DB_HOST="$DB_HOST" DB_PORT="$DB_PORT" DB_NAME="$DB_NAME" \
  DB_USERNAME="$DB_USERNAME" DB_PASSWORD="$DB_PASSWORD" \
  node --input-type=module -e '
import postgres from "postgres";
const sql = postgres({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  connect_timeout: 5,
  max: 1,
});
try {
  await sql`SELECT 1`;
  console.log("ok");
  await sql.end();
} catch (e) {
  console.error(e.message);
  await sql.end();
  process.exit(1);
}
' 2>&1) || true

if [ "$DB_CHECK" != "ok" ]; then
  echo ""
  echo "❌ Cannot connect to database at $DB_HOST:$DB_PORT/$DB_NAME"
  echo "   Error: $DB_CHECK"
  echo ""
  if [ "$DB_HOST" = "localhost" ] || [ "$DB_HOST" = "127.0.0.1" ]; then
    echo "   The Docker container is running but the database may not exist."
    echo "   Try removing the volume and reinitializing:"
    echo ""
    echo "     docker compose -f dev_env/docker-compose.yml --profile dev down -v"
    echo "     npm run db:start"
  fi
  exit 1
fi

info "Database connection verified"

# ── 6. Build if needed ──────────────────────────────────────────────

if [ ! -f "$JOB_DIR/dist/job.js" ]; then
  info "Building library-etl job..."
  npm run build --workspace=@wxyc/library-etl
else
  # Rebuild if source is newer than the built output
  if [ "$JOB_DIR/job.ts" -nt "$JOB_DIR/dist/job.js" ]; then
    info "Source changed, rebuilding..."
    npm run build --workspace=@wxyc/library-etl
  fi
fi

# ── 7. Run ──────────────────────────────────────────────────────────

info "Running library-etl job..."
echo ""
$DOTENVX npm start --workspace=@wxyc/library-etl
