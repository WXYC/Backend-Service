#!/bin/bash
# CI Environment Setup Script
# Usage: ./scripts/ci-env.sh [--full]
#
# Options:
#   --full    Enable rate limiting and create default admin user for full test suite

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Parse arguments
FULL_MODE=false
for arg in "$@"; do
  case $arg in
    --full)
      FULL_MODE=true
      shift
      ;;
  esac
done

# Build the Docker images
npm run ci:build

# Set up compose command with environment
COMPOSE_CMD="docker compose -f $PROJECT_ROOT/dev_env/docker-compose.yml --env-file $PROJECT_ROOT/.env --profile ci"

if [ "$FULL_MODE" = true ]; then
  echo "Starting CI environment with full test configuration..."
  echo "  - Rate limiting: ENABLED"

  # Export rate limiting for Docker Compose
  export TEST_RATE_LIMITING=true

  # Only enable default admin user if credentials are configured
  # (needed for admin ban tests)
  if [ -n "$DEFAULT_USER_EMAIL" ] && [ -n "$DEFAULT_USER_USERNAME" ] && [ -n "$DEFAULT_USER_PASSWORD" ]; then
    echo "  - Default admin user: ENABLED"
    export CREATE_DEFAULT_USER=TRUE
  else
    echo "  - Default admin user: DISABLED (credentials not configured)"
    echo "    To enable, set DEFAULT_USER_EMAIL, DEFAULT_USER_USERNAME, DEFAULT_USER_PASSWORD,"
    echo "    DEFAULT_USER_DJ_NAME, DEFAULT_USER_REAL_NAME, DEFAULT_ORG_SLUG, DEFAULT_ORG_NAME in .env"
  fi
else
  echo "Starting CI environment with standard configuration..."
fi

# Start database
$COMPOSE_CMD up -d ci-db

# Run database initialization
$COMPOSE_CMD up ci-db-init

# Start auth and backend services
# Environment variables are already exported above, Docker Compose will inherit them
$COMPOSE_CMD up -d auth backend

echo "CI environment is starting. Use 'npm run ci:test' to run tests."
