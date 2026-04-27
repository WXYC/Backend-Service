#!/bin/bash
#
# Starts (or attaches to) the flowsheet-lml-link-backfill one-shot job on
# EC2 inside a tmux session. The backfill iterates ~1.18M flowsheet rows
# where album_id IS NULL, calling LML once per row at the orchestrator's
# default throttle, so a full sweep takes ~1.5 days. Running it inside
# tmux means the SSH session can drop without killing the job.
#
# Resumability: re-running this script after a crash or stop is safe.
# Linked rows fall out of the backfill's WHERE filter on the next sweep,
# so the job picks up where it left off without a persistent cursor.
#
# Usage:
#   ./run-lml-backfill.sh start          # default — start a new session
#   ./run-lml-backfill.sh attach         # attach to an in-flight run
#   ./run-lml-backfill.sh status         # show tmux session + tail of log
#   ./run-lml-backfill.sh stop           # kill the tmux session (does NOT
#                                          stop the docker container)
#
# Environment:
#   REMOTE_ENV_PATH   Path to .env on EC2  (default: /home/ec2-user/.env)
#   IMAGE_TAG         ECR image tag        (default: latest)
#   SSH_HOST          SSH alias for EC2    (default: wxyc-ec2)
#   TMUX_SESSION      Remote session name  (default: lml-backfill)

set -euo pipefail

REMOTE_ENV_PATH="${REMOTE_ENV_PATH:-/home/ec2-user/.env}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
SSH_HOST="${SSH_HOST:-wxyc-ec2}"
TMUX_SESSION="${TMUX_SESSION:-lml-backfill}"
IMAGE_NAME="flowsheet-lml-link-backfill"

CMD="${1:-start}"

case "$CMD" in
  start)
    # Building the remote command in pieces for readability. The session
    # runs: ECR login -> pull -> docker run --rm with .env -> tee log.
    # `2>&1 | tee` captures both stdout and stderr to the log file while
    # also showing them on the tmux pane for live monitoring.
    ssh -o ConnectTimeout=10 "$SSH_HOST" bash <<EOF
set -uo pipefail
# Note: NOT using -e — we want to keep going past failed greps so we can
# emit useful errors. Each step checks its own exit code.

step() { echo "[run-lml-backfill] \$*"; }
fail() { echo "[run-lml-backfill] ERROR: \$*" >&2; exit 1; }

step "Connected to EC2."

if tmux has-session -t '$TMUX_SESSION' 2>/dev/null; then
  fail "tmux session '$TMUX_SESSION' is already running. Run './run-lml-backfill.sh attach'."
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
  [ -n "\$BACKEND_IMAGE" ] || fail "No running 'backend' container found. Set AWS_ECR_URI in .env (via set-ec2-env-var workflow once it's added to the secrets allowlist) or pass it as the IMAGE_REGISTRY env var."
  # Strip the trailing /<repo>:<tag> to get the registry URI.
  AWS_ECR_URI="\${BACKEND_IMAGE%/*}"
fi
if [ -z "\$AWS_REGION" ]; then
  # AWS ECR URIs are <account>.dkr.ecr.<region>.amazonaws.com.
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

LOG_FILE="\$HOME/lml-backfill-\$(date +%Y%m%d-%H%M%S).log"
step "Starting tmux session '$TMUX_SESSION'. Log: \$LOG_FILE"

tmux new-session -d -s '$TMUX_SESSION' \\
  "docker run --rm --name $IMAGE_NAME --env-file '$REMOTE_ENV_PATH' \\
     '\$IMAGE' 2>&1 | tee '\$LOG_FILE'; echo; echo 'Job exited. Press enter.'; read"

step "Started. Inspect with:"
echo "  ./run-lml-backfill.sh attach"
echo "  ./run-lml-backfill.sh status"
EOF
    ;;

  attach)
    # -t forces a TTY so tmux can take over the terminal.
    exec ssh -t "$SSH_HOST" "tmux attach -t '$TMUX_SESSION'"
    ;;

  status)
    ssh "$SSH_HOST" bash <<EOF
set -e
if tmux has-session -t '$TMUX_SESSION' 2>/dev/null; then
  echo "tmux session '$TMUX_SESSION': RUNNING"
else
  echo "tmux session '$TMUX_SESSION': not running"
fi

echo
echo "Container:"
docker ps --filter "name=$IMAGE_NAME" \\
  --format 'table {{.Names}}\t{{.Status}}\t{{.RunningFor}}' || true

echo
LATEST_LOG=\$(ls -t "\$HOME"/lml-backfill-*.log 2>/dev/null | head -1)
if [ -n "\$LATEST_LOG" ]; then
  echo "Tail of \$LATEST_LOG:"
  tail -20 "\$LATEST_LOG"
else
  echo "No log files found in \$HOME."
fi
EOF
    ;;

  stop)
    # Kills the tmux session. The docker container will be cleaned up by
    # --rm once it exits, but if you want to kill the running container
    # too, run `docker kill flowsheet-lml-link-backfill` on EC2.
    ssh "$SSH_HOST" "tmux kill-session -t '$TMUX_SESSION' 2>/dev/null \
      && echo 'Killed tmux session.' \
      || echo 'No tmux session to kill.'"
    echo "Note: this only stops the tmux pane. Run"
    echo "  ssh $SSH_HOST docker kill $IMAGE_NAME"
    echo "to also stop the running container."
    ;;

  *)
    echo "Unknown command: $CMD" >&2
    echo "Usage: $0 {start|attach|status|stop}" >&2
    exit 1
    ;;
esac
