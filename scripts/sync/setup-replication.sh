#!/bin/bash
#
# Sets up PostgreSQL logical replication from production RDS to a local
# PostgreSQL instance.
#
# This script:
#   1. Opens an SSH tunnel to RDS (if not already open)
#   2. Ensures the local database schema exists (via Drizzle migrations)
#   3. Creates the publication on RDS (if it doesn't exist)
#   4. Creates a subscription on the local database
#
# The subscription copies all existing data (copy_data=true) and then
# streams ongoing changes in real time. If the tunnel drops, the
# replication slot retains WAL until the subscriber reconnects.
#
# Prerequisites:
#   - RDS parameter group: rds.logical_replication = 1 (requires instance restart)
#   - rds_replication role granted to the RDS user
#   - SSH access via 'ssh wxyc-ec2'
#   - Local PostgreSQL running (npm run db:start)
#   - pg_dump / psql installed (brew install libpq)
#
# Usage:
#   ./setup-replication.sh
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
BACKEND_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

TUNNEL_PORT="${TUNNEL_PORT:-15432}"
LOCAL_DB_HOST="${LOCAL_DB_HOST:-localhost}"
LOCAL_DB_PORT="${LOCAL_DB_PORT:-5432}"
LOCAL_DB_NAME="${LOCAL_DB_NAME:-wxyc_db}"
LOCAL_DB_USER="${LOCAL_DB_USER:-postgres}"
LOCAL_DB_PASSWORD="${LOCAL_DB_PASSWORD:-}"
REMOTE_ENV_PATH="${REMOTE_ENV_PATH:-/home/ec2-user/.env}"

# --- Step 1: Ensure tunnel is open ---

if lsof -ti :"$TUNNEL_PORT" -sTCP:LISTEN &>/dev/null; then
    echo "SSH tunnel already open on port $TUNNEL_PORT."
else
    echo "Opening SSH tunnel..."
    "$SCRIPT_DIR/tunnel.sh"
fi

# --- Step 2: Read RDS credentials ---

echo "Reading RDS credentials from EC2..."
ENV_OUTPUT=$(ssh wxyc-ec2 "grep -E '^DB_(HOST|PORT|USERNAME|PASSWORD|NAME)=' '$REMOTE_ENV_PATH'" 2>/dev/null) || true

parse_env_var() {
    echo "$ENV_OUTPUT" | grep "^$1=" | head -1 | cut -d= -f2-
}

RDS_HOST=$(parse_env_var DB_HOST)
RDS_PORT=$(parse_env_var DB_PORT)
RDS_USER=$(parse_env_var DB_USERNAME)
RDS_PASS=$(parse_env_var DB_PASSWORD)
RDS_NAME=$(parse_env_var DB_NAME)
RDS_PORT="${RDS_PORT:-5432}"

if [ -z "$RDS_HOST" ] || [ -z "$RDS_USER" ] || [ -z "$RDS_PASS" ]; then
    echo "Error: could not read RDS credentials from EC2"
    exit 1
fi

echo "  RDS: $RDS_USER@$RDS_HOST:$RDS_PORT/$RDS_NAME"
echo "  Local: $LOCAL_DB_USER@$LOCAL_DB_HOST:$LOCAL_DB_PORT/$LOCAL_DB_NAME"

# --- Step 3: Verify wal_level on RDS ---

echo ""
echo "Checking RDS wal_level..."
WAL_LEVEL=$(PGPASSWORD="$RDS_PASS" psql -h localhost -p "$TUNNEL_PORT" -U "$RDS_USER" -d "$RDS_NAME" -tAc "SHOW wal_level;" 2>/dev/null)

if [ "$WAL_LEVEL" != "logical" ]; then
    echo ""
    echo "ERROR: wal_level is '$WAL_LEVEL', needs to be 'logical'."
    echo ""
    echo "To fix this in the AWS console:"
    echo "  1. Go to RDS → Parameter Groups"
    echo "  2. Create or modify a parameter group for PostgreSQL 14"
    echo "  3. Set rds.logical_replication = 1"
    echo "  4. Apply the parameter group to your RDS instance"
    echo "  5. Reboot the instance"
    echo ""
    echo "After the reboot, re-run this script."
    exit 1
fi

echo "  wal_level = logical ✓"

# --- Step 4: Create publication on RDS (if it doesn't exist) ---

echo ""
echo "Creating publication on RDS..."
PGPASSWORD="$RDS_PASS" psql -h localhost -p "$TUNNEL_PORT" -U "$RDS_USER" -d "$RDS_NAME" <<'SQL'
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'wxyc_cdc') THEN
        EXECUTE 'CREATE PUBLICATION wxyc_cdc FOR ALL TABLES';
        RAISE NOTICE 'Publication wxyc_cdc created.';
    ELSE
        RAISE NOTICE 'Publication wxyc_cdc already exists.';
    END IF;
END $$;
SQL

# --- Step 5: Ensure local schema exists ---

echo ""
echo "Ensuring local schema exists (running Drizzle migrations)..."
cd "$BACKEND_DIR"
if [ -f "dev_env/init-db.mjs" ]; then
    DB_HOST="$LOCAL_DB_HOST" DB_PORT="$LOCAL_DB_PORT" DB_NAME="$LOCAL_DB_NAME" \
    DB_USERNAME="$LOCAL_DB_USER" DB_PASSWORD="$LOCAL_DB_PASSWORD" \
    SKIP_SEED=true node dev_env/init-db.mjs 2>&1 | tail -5
else
    echo "Warning: init-db.mjs not found, assuming schema exists."
fi

# --- Step 6: Create subscription on local database ---

echo ""
echo "Creating subscription on local database..."

# Build the connection string for the subscription (points to tunnel, not RDS directly)
CONN_STRING="host=localhost port=$TUNNEL_PORT dbname=$RDS_NAME user=$RDS_USER password=$RDS_PASS"

# Check if subscription already exists (CREATE SUBSCRIPTION cannot run inside DO blocks)
SUB_EXISTS=$(PGPASSWORD="$LOCAL_DB_PASSWORD" psql -h "$LOCAL_DB_HOST" -p "$LOCAL_DB_PORT" -U "$LOCAL_DB_USER" -d "$LOCAL_DB_NAME" -tAc "SELECT 1 FROM pg_subscription WHERE subname = 'local_sync';" 2>/dev/null)

if [ "$SUB_EXISTS" = "1" ]; then
    echo "Subscription local_sync already exists."
else
    PGPASSWORD="$LOCAL_DB_PASSWORD" psql -h "$LOCAL_DB_HOST" -p "$LOCAL_DB_PORT" -U "$LOCAL_DB_USER" -d "$LOCAL_DB_NAME" -c \
        "CREATE SUBSCRIPTION local_sync CONNECTION '$CONN_STRING' PUBLICATION wxyc_cdc WITH (copy_data = true);"
    echo "Subscription local_sync created. Initial data copy starting..."
fi

# --- Step 7: Show replication status ---

echo ""
echo "Replication status:"
PGPASSWORD="$LOCAL_DB_PASSWORD" psql -h "$LOCAL_DB_HOST" -p "$LOCAL_DB_PORT" -U "$LOCAL_DB_USER" -d "$LOCAL_DB_NAME" -c "
SELECT subname, subenabled, subconninfo
FROM pg_subscription
WHERE subname = 'local_sync';
"

echo ""
echo "To monitor initial sync progress:"
echo "  PGPASSWORD='$LOCAL_DB_PASSWORD' psql -h $LOCAL_DB_HOST -p $LOCAL_DB_PORT -U $LOCAL_DB_USER -d $LOCAL_DB_NAME \\"
echo "    -c \"SELECT * FROM pg_stat_subscription;\""
echo ""
echo "Done. The tunnel must remain open for replication to stream."
echo "Kill it with: $SCRIPT_DIR/tunnel.sh --kill"
