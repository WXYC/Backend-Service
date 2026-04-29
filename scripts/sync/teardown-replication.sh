#!/bin/bash
#
# Tears down PostgreSQL logical replication: drops the local subscription,
# drops orphaned replication slots on RDS, and kills the SSH tunnel.
#
# Usage:
#   ./teardown-replication.sh
#
# Environment:
#   TUNNEL_PORT        Local tunnel port (default: 15432)
#   LOCAL_DB_HOST      Local PostgreSQL host (default: localhost)
#   LOCAL_DB_PORT      Local PostgreSQL port (default: 5432)
#   LOCAL_DB_NAME      Local database name (default: wxyc_db)
#   LOCAL_DB_USER      Local database user (default: postgres)
#   LOCAL_DB_PASSWORD   Local database password (default: empty)
#   REMOTE_ENV_PATH    Path to .env on EC2 (default: /home/ec2-user/.env)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

TUNNEL_PORT="${TUNNEL_PORT:-15432}"
LOCAL_DB_HOST="${LOCAL_DB_HOST:-localhost}"
LOCAL_DB_PORT="${LOCAL_DB_PORT:-5432}"
LOCAL_DB_NAME="${LOCAL_DB_NAME:-wxyc_db}"
LOCAL_DB_USER="${LOCAL_DB_USER:-postgres}"
LOCAL_DB_PASSWORD="${LOCAL_DB_PASSWORD:-}"
REMOTE_ENV_PATH="${REMOTE_ENV_PATH:-/home/ec2-user/.env}"

# --- Drop subscription ---

echo "Dropping subscription..."
PGPASSWORD="$LOCAL_DB_PASSWORD" psql -h "$LOCAL_DB_HOST" -p "$LOCAL_DB_PORT" -U "$LOCAL_DB_USER" -d "$LOCAL_DB_NAME" -c "
DROP SUBSCRIPTION IF EXISTS local_sync;
" 2>&1

echo "Subscription dropped."

# --- Drop orphaned replication slots on RDS ---

echo ""
echo "Checking for orphaned replication slots on RDS..."

# Ensure tunnel is open so we can reach RDS
if ! lsof -ti :"$TUNNEL_PORT" -sTCP:LISTEN &>/dev/null; then
    echo "Opening SSH tunnel for RDS cleanup..."
    "$SCRIPT_DIR/tunnel.sh"
fi

# Read RDS credentials
ENV_OUTPUT=$(ssh wxyc-ec2 "grep -E '^DB_(HOST|PORT|USERNAME|PASSWORD|NAME)=' '$REMOTE_ENV_PATH'" 2>/dev/null) || true
parse_env_var() { echo "$ENV_OUTPUT" | grep "^$1=" | head -1 | cut -d= -f2-; }
RDS_USER=$(parse_env_var DB_USERNAME)
RDS_PASS=$(parse_env_var DB_PASSWORD)
RDS_NAME=$(parse_env_var DB_NAME)

if [ -n "$RDS_USER" ] && [ -n "$RDS_PASS" ] && [ -n "$RDS_NAME" ]; then
    SLOT_EXISTS=$(PGPASSWORD="$RDS_PASS" psql -h localhost -p "$TUNNEL_PORT" -U "$RDS_USER" -d "$RDS_NAME" -tAc \
        "SELECT 1 FROM pg_replication_slots WHERE slot_name = 'local_sync' AND NOT active;" 2>/dev/null)

    if [ "$SLOT_EXISTS" = "1" ]; then
        echo "  Found inactive local_sync slot. Dropping..."
        PGPASSWORD="$RDS_PASS" psql -h localhost -p "$TUNNEL_PORT" -U "$RDS_USER" -d "$RDS_NAME" -c \
            "SELECT pg_drop_replication_slot('local_sync');"
        echo "  Dropped."
    else
        echo "  No local_sync slot to clean up."
    fi
else
    echo "  Warning: could not read RDS credentials — skipping slot cleanup on publisher."
fi

# --- Kill tunnel ---

"$SCRIPT_DIR/tunnel.sh" --kill

echo "Teardown complete."
