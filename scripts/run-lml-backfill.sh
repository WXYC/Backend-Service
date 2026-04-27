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
set -euo pipefail

if tmux has-session -t '$TMUX_SESSION' 2>/dev/null; then
  echo "tmux session '$TMUX_SESSION' is already running on EC2."
  echo "Use './run-lml-backfill.sh attach' to view it."
  exit 1
fi

if [ ! -f '$REMOTE_ENV_PATH' ]; then
  echo "Missing env file: $REMOTE_ENV_PATH" >&2
  exit 1
fi

AWS_REGION=\$(grep '^AWS_REGION=' '$REMOTE_ENV_PATH' | cut -d= -f2-)
AWS_ECR_URI=\$(grep '^AWS_ECR_URI=' '$REMOTE_ENV_PATH' | cut -d= -f2-)
LIBRARY_METADATA_URL=\$(grep '^LIBRARY_METADATA_URL=' '$REMOTE_ENV_PATH' | cut -d= -f2-)

if [ -z "\$AWS_REGION" ] || [ -z "\$AWS_ECR_URI" ]; then
  echo "AWS_REGION or AWS_ECR_URI missing from $REMOTE_ENV_PATH" >&2
  exit 1
fi
if [ -z "\$LIBRARY_METADATA_URL" ]; then
  echo "LIBRARY_METADATA_URL missing from $REMOTE_ENV_PATH" >&2
  echo "Set it with: gh workflow run set-ec2-env-var.yml -f key=LIBRARY_METADATA_URL" >&2
  exit 1
fi

echo "Logging into ECR (\$AWS_REGION)..."
aws ecr get-login-password --region "\$AWS_REGION" \\
  | docker login --username AWS --password-stdin "\$AWS_ECR_URI"

IMAGE="\$AWS_ECR_URI/$IMAGE_NAME:$IMAGE_TAG"
echo "Pulling \$IMAGE..."
docker pull "\$IMAGE"

LOG_FILE="\$HOME/lml-backfill-\$(date +%Y%m%d-%H%M%S).log"
echo "Starting tmux session '$TMUX_SESSION'. Log: \$LOG_FILE"

tmux new-session -d -s '$TMUX_SESSION' \\
  "docker run --rm --name $IMAGE_NAME --env-file '$REMOTE_ENV_PATH' \\
     '\$IMAGE' 2>&1 | tee '\$LOG_FILE'; echo; echo 'Job exited. Press enter.'; read"

echo
echo "Started. Inspect with:"
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
