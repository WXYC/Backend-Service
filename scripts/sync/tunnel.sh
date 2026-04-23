#!/bin/bash
#
# Opens and maintains an SSH tunnel to the RDS PostgreSQL instance.
#
# Uses autossh for automatic reconnection if available, falls back to
# plain ssh otherwise. The tunnel maps local port 15432 to RDS port 5432
# through the EC2 bastion host.
#
# Usage:
#   ./tunnel.sh          # Open tunnel in background
#   ./tunnel.sh --kill   # Kill existing tunnel
#
# Requires:
#   - SSH access via 'ssh wxyc-ec2' (configured in ~/.ssh/config)
#
# Environment:
#   TUNNEL_PORT        Local port (default: 15432)
#   REMOTE_ENV_PATH    Path to .env on EC2 (default: /home/ec2-user/.env)

set -euo pipefail

TUNNEL_PORT="${TUNNEL_PORT:-15432}"
REMOTE_ENV_PATH="${REMOTE_ENV_PATH:-/home/ec2-user/.env}"

kill_tunnel() {
    local pid
    pid=$(lsof -ti :"$TUNNEL_PORT" -sTCP:LISTEN 2>/dev/null || true)
    if [ -n "$pid" ]; then
        echo "Killing tunnel on port $TUNNEL_PORT (PID $pid)..."
        kill "$pid" 2>/dev/null || true
        sleep 1
    else
        echo "No tunnel running on port $TUNNEL_PORT."
    fi
}

if [ "${1:-}" = "--kill" ]; then
    kill_tunnel
    exit 0
fi

# Clean up stale tunnel
kill_tunnel

# Read RDS host from EC2's .env
echo "Reading RDS host from EC2..."
RDS_HOST=$(ssh wxyc-ec2 "grep '^DB_HOST=' '$REMOTE_ENV_PATH'" 2>/dev/null | cut -d= -f2) || true
if [ -z "$RDS_HOST" ]; then
    echo "Error: could not read DB_HOST from EC2's .env"
    exit 1
fi

echo "Opening tunnel: localhost:$TUNNEL_PORT → $RDS_HOST:5432 (via wxyc-ec2)"

if command -v autossh &>/dev/null; then
    autossh -M 0 -f -N \
        -o "ServerAliveInterval=30" \
        -o "ServerAliveCountMax=3" \
        -L "$TUNNEL_PORT:$RDS_HOST:5432" \
        wxyc-ec2
    echo "Tunnel opened with autossh (auto-reconnect enabled)."
else
    ssh -f -N \
        -o "ServerAliveInterval=30" \
        -o "ServerAliveCountMax=3" \
        -L "$TUNNEL_PORT:$RDS_HOST:5432" \
        wxyc-ec2
    echo "Tunnel opened with ssh (install autossh for auto-reconnect: brew install autossh)."
fi

echo "Tunnel PID: $(lsof -ti :"$TUNNEL_PORT" -sTCP:LISTEN 2>/dev/null || echo unknown)"
