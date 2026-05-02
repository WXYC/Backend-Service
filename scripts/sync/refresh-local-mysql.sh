#!/bin/bash
#
# Refreshes the local wxycmusic MySQL clone from a fresh prod dump.
#
# The reconciliation monitor (scripts/sync/reconcile.ts) verifies
# Backend-Service PG events against this local clone in the reverse
# direction. Without periodic refresh the clone drifts and produces
# false NOT FOUND warnings for any row newer than the last snapshot.
#
# This script chains tubafrenzy's backup-database.sh (mysqldump over SSH)
# with a local DROP + CREATE + import. Suitable for cron / launchd:
#
#   */15 * * * * /path/to/refresh-local-mysql.sh >> /var/log/wxyc-refresh.log 2>&1
#
# Environment:
#   WXYC_DEV_ROOT     Root containing tubafrenzy + Backend-Service repos
#                     (default: parent of this script's repo)
#   MYSQL_LOCAL_USER  Local MySQL user (default: root)
#   MYSQL_LOCAL_PASS  Local MySQL password (default: empty)
#   MYSQL_LOCAL_DB    Local database name (default: wxycmusic)
#   DUMP_DIR          Where to write the .sql.gz file (default: /tmp)
#
# DB_PASSWORD must be exported (or in tubafrenzy/.env) for backup-database.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WXYC_DEV_ROOT="${WXYC_DEV_ROOT:-$(dirname "$REPO_ROOT")}"
TUBAFRENZY_DIR="$WXYC_DEV_ROOT/tubafrenzy"

MYSQL_LOCAL_USER="${MYSQL_LOCAL_USER:-root}"
MYSQL_LOCAL_PASS="${MYSQL_LOCAL_PASS:-}"
MYSQL_LOCAL_DB="${MYSQL_LOCAL_DB:-wxycmusic}"
DUMP_DIR="${DUMP_DIR:-/tmp}"

if [ ! -d "$TUBAFRENZY_DIR" ]; then
    echo "Error: tubafrenzy repo not found at $TUBAFRENZY_DIR" >&2
    echo "Set WXYC_DEV_ROOT to the directory containing tubafrenzy/." >&2
    exit 1
fi

if [ -f "$TUBAFRENZY_DIR/.env" ] && [ -z "${DB_PASSWORD:-}" ]; then
    set -a; source "$TUBAFRENZY_DIR/.env"; set +a
fi

mysql_args=(-u "$MYSQL_LOCAL_USER")
[ -n "$MYSQL_LOCAL_PASS" ] && mysql_args+=("-p$MYSQL_LOCAL_PASS")

ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }

echo "[$(ts)] Refreshing $MYSQL_LOCAL_DB from prod dump"

echo "[$(ts)] Step 1/3: dumping prod via SSH..."
cd "$TUBAFRENZY_DIR"
./scripts/deploy/backup-database.sh "$DUMP_DIR"
cd - >/dev/null

DUMP_FILE="$(ls -t "$DUMP_DIR"/wxycmusic-backup-*.sql.gz 2>/dev/null | head -1)"
if [ -z "$DUMP_FILE" ] || [ ! -s "$DUMP_FILE" ]; then
    echo "[$(ts)] Error: no dump file found in $DUMP_DIR" >&2
    exit 1
fi
echo "[$(ts)] Dump: $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1))"

echo "[$(ts)] Step 2/3: dropping and recreating $MYSQL_LOCAL_DB..."
mysql "${mysql_args[@]}" -e "
  DROP DATABASE IF EXISTS \`$MYSQL_LOCAL_DB\`;
  CREATE DATABASE \`$MYSQL_LOCAL_DB\` CHARACTER SET utf8 COLLATE utf8_unicode_ci;
"

echo "[$(ts)] Step 3/3: importing dump..."
gunzip -c "$DUMP_FILE" | mysql "${mysql_args[@]}" "$MYSQL_LOCAL_DB"

max_id=$(mysql "${mysql_args[@]}" -N -B -e "
  SELECT MAX(ID) FROM \`$MYSQL_LOCAL_DB\`.FLOWSHEET_ENTRY_PROD
")
last_write=$(mysql "${mysql_args[@]}" -N -B -e "
  SELECT FROM_UNIXTIME(MAX(TIME_CREATED)/1000)
  FROM \`$MYSQL_LOCAL_DB\`.FLOWSHEET_ENTRY_PROD
")

echo "[$(ts)] Done. FLOWSHEET_ENTRY_PROD max_id=$max_id last_write=$last_write"
