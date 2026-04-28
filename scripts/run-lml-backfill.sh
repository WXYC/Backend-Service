#!/bin/bash
#
# Starts (or attaches to) an LML-driven backfill one-shot job on EC2 as a
# detached docker container — optionally as N partitioned containers in
# parallel for an N-fold throughput speedup. The two callers in tree are
# `flowsheet-lml-link-backfill` (B-2.2; ~1.18M flowsheet rows) and
# `library-canonical-entity-backfill` (B-1.2; ~64K library rows). Both
# call LML once per row at the orchestrator's default throttle.
# Detached docker (`docker run -d`) means each container survives the SSH
# session ending — no tmux needed (Amazon Linux doesn't ship it).
#
# Resumability: re-running this script after a crash or stop is safe.
# Each backfill's WHERE filter sees only rows that haven't been resolved,
# so the job picks up where it left off without a persistent cursor. With
# partitioning, each partition independently resumes its own subset.
#
# Usage:
#   ./run-lml-backfill.sh start          # default — start B-2.2, single container
#   ./run-lml-backfill.sh attach         # follow logs of partition 0
#   ./run-lml-backfill.sh status         # all containers + last log lines each
#   ./run-lml-backfill.sh stop           # docker stop all partitions
#
#   # Run B-1.2 instead:
#   BACKFILL=library-canonical-entity-backfill ./scripts/run-lml-backfill.sh start
#
#   # Run B-2.2 with 4 partitions in parallel:
#   PARTITIONS=4 ./scripts/run-lml-backfill.sh start
#
#   # Attach to a specific partition (default = 0):
#   PARTITION=2 ./scripts/run-lml-backfill.sh attach
#
# Container naming:
#   PARTITIONS=1 (default) → container name = $IMAGE_NAME (no suffix)
#   PARTITIONS=N (>1)      → container names = $IMAGE_NAME-0..$IMAGE_NAME-(N-1)
#
# Environment:
#   BACKFILL          Job to run; doubles as the docker container name prefix
#                     and the ECR repo name. Must match a directory under
#                     jobs/ and an image in ECR.
#                     (default: flowsheet-lml-link-backfill)
#   PARTITIONS        Number of parallel containers (default: 1).
#   PARTITION         Which partition to attach to (default: 0).
#   REMOTE_ENV_PATH   Path to .env on EC2  (default: /home/ec2-user/.env)
#   IMAGE_TAG         ECR image tag        (default: latest)
#   SSH_HOST          SSH alias for EC2    (default: wxyc-ec2)

set -euo pipefail

REMOTE_ENV_PATH="${REMOTE_ENV_PATH:-/home/ec2-user/.env}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
SSH_HOST="${SSH_HOST:-wxyc-ec2}"
IMAGE_NAME="${BACKFILL:-flowsheet-lml-link-backfill}"
PARTITIONS="${PARTITIONS:-1}"
PARTITION="${PARTITION:-0}"

# Validate numeric env vars locally so the SSH'd bash never has to deal
# with a stray non-integer that would expand into something weird.
case "$PARTITIONS" in
  ''|*[!0-9]*) echo "PARTITIONS must be a positive integer (got '$PARTITIONS')" >&2; exit 1 ;;
esac
[ "$PARTITIONS" -ge 1 ] || { echo "PARTITIONS must be >= 1" >&2; exit 1; }
case "$PARTITION" in
  ''|*[!0-9]*) echo "PARTITION must be a non-negative integer (got '$PARTITION')" >&2; exit 1 ;;
esac
[ "$PARTITION" -lt "$PARTITIONS" ] || { echo "PARTITION ($PARTITION) must be < PARTITIONS ($PARTITIONS)" >&2; exit 1; }

CMD="${1:-start}"

# Container-naming helper. Single-container runs keep the bare image name
# so existing operator muscle memory ("attach to flowsheet-lml-link-backfill")
# continues to work. Partitioned runs append the index.
container_name_for_partition() {
  local idx="$1"
  if [ "$PARTITIONS" -eq 1 ]; then
    echo "$IMAGE_NAME"
  else
    echo "$IMAGE_NAME-$idx"
  fi
}

case "$CMD" in
  start)
    ssh -o ConnectTimeout=10 "$SSH_HOST" bash <<EOF
set -uo pipefail
# Note: NOT using -e — we want to keep going past failed greps so we can
# emit useful errors. Each step checks its own exit code.

step() { echo "[run-lml-backfill] \$*"; }
fail() { echo "[run-lml-backfill] ERROR: \$*" >&2; exit 1; }

step "Connected to EC2."

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

# Spawn one container per partition. PARTITION_COUNT is the same for all;
# PARTITION_INDEX varies. The orchestrator's loadBatch uses these env vars
# to filter rows by 'id % count = index', so the partitions touch disjoint
# subsets and finish in roughly the same wall time.
PARTITIONS=$PARTITIONS
for IDX in \$(seq 0 \$((PARTITIONS - 1))); do
  if [ "\$PARTITIONS" -eq 1 ]; then
    NAME='$IMAGE_NAME'
  else
    NAME="$IMAGE_NAME-\$IDX"
  fi

  # Refuse to start if a container with that name is already running;
  # clean up an exited one so a fresh 'docker run' can reuse the name.
  if docker ps --format '{{.Names}}' | grep -qx "\$NAME"; then
    fail "Container '\$NAME' is already running. Stop it first."
  fi
  if docker ps -a --format '{{.Names}}' | grep -qx "\$NAME"; then
    step "Removing previous exited container '\$NAME'..."
    docker rm "\$NAME" >/dev/null || fail "docker rm \$NAME failed."
  fi

  step "Starting detached container '\$NAME' (PARTITION_INDEX=\$IDX/\$PARTITIONS)..."
  # -d: detached; container survives SSH disconnect. No --rm — we want the
  # stopped container to stick around so post-mortem 'docker logs' works.
  # DB_STATEMENT_TIMEOUT_MS=300000 (5 min) overrides the .env default of 5s,
  # which is right for HTTP request handlers but kills the backfill's batch
  # SELECT on the unlinked-flowsheet predicate (a multi-million-row scan).
  CONTAINER_ID=\$(docker run -d --name "\$NAME" \\
    --env-file '$REMOTE_ENV_PATH' \\
    -e DB_STATEMENT_TIMEOUT_MS=300000 \\
    -e PARTITION_INDEX=\$IDX \\
    -e PARTITION_COUNT=\$PARTITIONS \\
    "\$IMAGE") \\
    || fail "docker run \$NAME failed."
  step "  Started '\$NAME'. Container ID: \${CONTAINER_ID:0:12}"
done

step "All \$PARTITIONS partition(s) started."
echo "Inspect with:"
echo "  BACKFILL=$IMAGE_NAME PARTITIONS=$PARTITIONS ./run-lml-backfill.sh status    # all partitions + tails"
echo "  BACKFILL=$IMAGE_NAME PARTITIONS=$PARTITIONS PARTITION=0 ./run-lml-backfill.sh attach    # follow one"
echo "  BACKFILL=$IMAGE_NAME PARTITIONS=$PARTITIONS ./run-lml-backfill.sh stop      # stop all partitions"
EOF
    ;;

  attach)
    NAME=$(container_name_for_partition "$PARTITION")
    # -t forces a TTY so Ctrl-C cleanly detaches docker logs without
    # killing the SSH session. --tail 50 keeps things tidy on first attach.
    exec ssh -t "$SSH_HOST" "docker logs -f --tail 50 '$NAME'"
    ;;

  status)
    # Filter by container-name prefix. Bare $IMAGE_NAME catches both the
    # single-container case and all '$IMAGE_NAME-N' partitions.
    ssh "$SSH_HOST" bash <<EOF
set -uo pipefail
echo "Containers (prefix '$IMAGE_NAME'):"
docker ps -a --filter "name=$IMAGE_NAME" \\
  --format 'table {{.Names}}\t{{.Status}}\t{{.RunningFor}}' \\
  || echo "  (none present)"

# Per-container last 5 log lines. Walk the names so each gets its own header.
NAMES=\$(docker ps -a --filter "name=$IMAGE_NAME" --format '{{.Names}}' | sort)
if [ -n "\$NAMES" ]; then
  for n in \$NAMES; do
    echo
    echo "--- \$n (last 5) ---"
    docker logs --tail 5 "\$n" 2>&1 || echo "  (no logs)"
  done
fi
EOF
    ;;

  stop)
    ssh "$SSH_HOST" bash <<EOF
set -uo pipefail
NAMES=\$(docker ps --filter "name=$IMAGE_NAME" --format '{{.Names}}' | sort)
if [ -z "\$NAMES" ]; then
  echo "No running containers matching prefix '$IMAGE_NAME'."
  exit 0
fi
for n in \$NAMES; do
  echo "Stopping '\$n'..."
  docker stop "\$n"
done

# Leave stopped containers in place so post-mortem 'docker logs' works.
# 'start' will 'docker rm' them on the next run.
EOF
    ;;

  *)
    echo "Unknown command: $CMD" >&2
    echo "Usage: $0 {start|attach|status|stop}" >&2
    exit 1
    ;;
esac
