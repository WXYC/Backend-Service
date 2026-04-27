#!/bin/bash
#
# Starts (or attaches to) the flowsheet-lml-link-backfill one-shot job on
# EC2 as a detached docker container. The backfill iterates ~1.18M
# flowsheet rows where album_id IS NULL, calling LML once per row at the
# orchestrator's default throttle, so a full sweep takes ~1.5 days.
# Detached docker (`docker run -d`) means the container survives the SSH
# session ending — no tmux needed (Amazon Linux doesn't ship it).
#
# Resumability: re-running this script after a crash or stop is safe.
# Linked rows fall out of the backfill's WHERE filter on the next sweep,
# so the job picks up where it left off without a persistent cursor.
#
# Usage:
#   ./run-lml-backfill.sh start          # default — start a new container
#   ./run-lml-backfill.sh attach         # follow logs (Ctrl-C to detach)
#   ./run-lml-backfill.sh status         # container state + last 20 log lines
#   ./run-lml-backfill.sh stop           # docker stop the container
#
# Environment:
#   REMOTE_ENV_PATH   Path to .env on EC2  (default: /home/ec2-user/.env)
#   IMAGE_TAG         ECR image tag        (default: latest)
#   SSH_HOST          SSH alias for EC2    (default: wxyc-ec2)

set -euo pipefail

REMOTE_ENV_PATH="${REMOTE_ENV_PATH:-/home/ec2-user/.env}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
SSH_HOST="${SSH_HOST:-wxyc-ec2}"
IMAGE_NAME="flowsheet-lml-link-backfill"

CMD="${1:-start}"

case "$CMD" in
  start)
    ssh -o ConnectTimeout=10 "$SSH_HOST" bash <<EOF
set -uo pipefail
# Note: NOT using -e — we want to keep going past failed greps so we can
# emit useful errors. Each step checks its own exit code.

step() { echo "[run-lml-backfill] \$*"; }
fail() { echo "[run-lml-backfill] ERROR: \$*" >&2; exit 1; }

step "Connected to EC2."

# Refuse to start if a container with the same name is already running;
# clean up an exited one so a fresh \`docker run\` can reuse the name.
if docker ps --format '{{.Names}}' | grep -qx '$IMAGE_NAME'; then
  fail "Container '$IMAGE_NAME' is already running. Run './run-lml-backfill.sh attach'."
fi
if docker ps -a --format '{{.Names}}' | grep -qx '$IMAGE_NAME'; then
  step "Removing previous exited container '$IMAGE_NAME'..."
  docker rm '$IMAGE_NAME' >/dev/null || fail "docker rm failed."
fi

[ -f '$REMOTE_ENV_PATH' ] || fail "Missing env file: $REMOTE_ENV_PATH"

# Extract a value from .env, returning empty if absent. Tolerant by design.
get_env() {
  grep "^\$1=" '$REMOTE_ENV_PATH' 2>/dev/null | head -1 | cut -d= -f2- || true
}

LIBRARY_METADATA_URL=\$(get_env LIBRARY_METADATA_URL)
[ -n "\$LIBRARY_METADATA_URL" ] || fail "LIBRARY_METADATA_URL missing from .env. Set it with: gh workflow run set-ec2-env-var.yml -f key=LIBRARY_METADATA_URL"

# AWS_REGION / AWS_ECR_URI aren't persisted to .env by the deploy workflow
# — they're GH secrets injected at deploy time. Recover them from the
# running backend container's image, which is always tagged with the full
# ECR URI (e.g. 123456.dkr.ecr.us-east-1.amazonaws.com/backend:abc1234).
AWS_REGION=\$(get_env AWS_REGION)
AWS_ECR_URI=\$(get_env AWS_ECR_URI)

if [ -z "\$AWS_ECR_URI" ]; then
  step "AWS_ECR_URI not in .env; recovering from running 'backend' container."
  BACKEND_IMAGE=\$(docker inspect -f '{{.Config.Image}}' backend 2>/dev/null || true)
  [ -n "\$BACKEND_IMAGE" ] || fail "No running 'backend' container found. Set AWS_ECR_URI in .env or pass it via the recovery path."
  AWS_ECR_URI="\${BACKEND_IMAGE%/*}"
fi
if [ -z "\$AWS_REGION" ]; then
  AWS_REGION=\$(echo "\$AWS_ECR_URI" | awk -F. '{print \$4}')
  [ -n "\$AWS_REGION" ] || fail "Could not derive AWS_REGION from AWS_ECR_URI=\$AWS_ECR_URI"
fi

step "AWS_ECR_URI=\$AWS_ECR_URI region=\$AWS_REGION"
step "Logging into ECR..."
aws ecr get-login-password --region "\$AWS_REGION" \\
  | docker login --username AWS --password-stdin "\$AWS_ECR_URI" \\
  || fail "ECR login failed."

IMAGE="\$AWS_ECR_URI/$IMAGE_NAME:$IMAGE_TAG"
step "Pulling \$IMAGE..."
docker pull "\$IMAGE" || fail "docker pull failed for \$IMAGE"

step "Starting detached container '$IMAGE_NAME'..."
# -d: detached; container survives SSH disconnect. No --rm — we want the
# stopped container to stick around so post-mortem 'docker logs' works.
# Stdout/stderr are captured by docker's default json-file log driver,
# accessible via 'docker logs' (the 'attach' and 'status' subcommands).
# DB_STATEMENT_TIMEOUT_MS=300000 (5 min) overrides the .env default of 5s,
# which is right for HTTP request handlers but kills the backfill's batch
# SELECT on the unlinked-flowsheet predicate (a multi-million-row scan).
# See shared/database/src/client.ts for the per-caller-class rationale.
CONTAINER_ID=\$(docker run -d --name '$IMAGE_NAME' \\
  --env-file '$REMOTE_ENV_PATH' \\
  -e DB_STATEMENT_TIMEOUT_MS=300000 \\
  "\$IMAGE") \\
  || fail "docker run failed."

step "Started. Container ID: \${CONTAINER_ID:0:12}"
echo "Inspect with:"
echo "  ./run-lml-backfill.sh attach    # live tail (Ctrl-C to detach, doesn't stop the job)"
echo "  ./run-lml-backfill.sh status    # one-shot status + last 20 log lines"
echo "  ./run-lml-backfill.sh stop      # stop the container"
EOF
    ;;

  attach)
    # -t forces a TTY so Ctrl-C cleanly detaches docker logs without
    # killing the SSH session. The --since=0 keeps things tidy on first
    # attach; --follow streams new lines as they arrive.
    exec ssh -t "$SSH_HOST" "docker logs -f --tail 50 '$IMAGE_NAME'"
    ;;

  status)
    ssh "$SSH_HOST" bash <<EOF
set -uo pipefail
echo "Container:"
docker ps -a --filter "name=$IMAGE_NAME" \\
  --format 'table {{.Names}}\t{{.Status}}\t{{.RunningFor}}' \\
  || echo "  (not present)"

echo
echo "Last 20 log lines:"
docker logs --tail 20 '$IMAGE_NAME' 2>&1 || echo "  (no logs available)"
EOF
    ;;

  stop)
    ssh "$SSH_HOST" bash <<EOF
set -uo pipefail
if docker ps --format '{{.Names}}' | grep -qx '$IMAGE_NAME'; then
  echo "Stopping '$IMAGE_NAME'..."
  docker stop '$IMAGE_NAME'
else
  echo "Container '$IMAGE_NAME' is not running."
fi

# Leave the stopped container in place so post-mortem 'docker logs' works.
# 'start' will 'docker rm' it on the next run.
EOF
    ;;

  *)
    echo "Unknown command: $CMD" >&2
    echo "Usage: $0 {start|attach|status|stop}" >&2
    exit 1
    ;;
esac
