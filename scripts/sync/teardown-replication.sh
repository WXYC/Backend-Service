#!/bin/bash
#
# Tears down PostgreSQL logical replication: drops the local subscription
# and kills the SSH tunnel.
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

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

TUNNEL_PORT="${TUNNEL_PORT:-15432}"
LOCAL_DB_HOST="${LOCAL_DB_HOST:-localhost}"
LOCAL_DB_PORT="${LOCAL_DB_PORT:-5432}"
LOCAL_DB_NAME="${LOCAL_DB_NAME:-wxyc_db}"
LOCAL_DB_USER="${LOCAL_DB_USER:-postgres}"
LOCAL_DB_PASSWORD="${LOCAL_DB_PASSWORD:-}"

# --- Drop subscription ---

echo "Dropping subscription..."
PGPASSWORD="$LOCAL_DB_PASSWORD" psql -h "$LOCAL_DB_HOST" -p "$LOCAL_DB_PORT" -U "$LOCAL_DB_USER" -d "$LOCAL_DB_NAME" -c "
DROP SUBSCRIPTION IF EXISTS local_sync;
" 2>&1

echo "Subscription dropped."

# --- Kill tunnel ---

"$SCRIPT_DIR/tunnel.sh" --kill

echo "Teardown complete."
