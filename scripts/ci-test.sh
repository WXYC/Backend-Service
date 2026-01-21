#!/bin/bash
# CI Test Runner Script
# Usage: ./scripts/ci-test.sh [--full]
#
# Options:
#   --full    Run all tests including rate limiting and admin ban tests

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

# Base environment variables
export DB_HOST=localhost
export DB_PORT=${CI_DB_PORT:-5433}
export PORT=${CI_PORT:-8081}
export BETTER_AUTH_URL=${CI_BETTER_AUTH_URL:-http://localhost:8083/auth}

if [ "$FULL_MODE" = true ]; then
  echo "Running full test suite..."
  echo "  - Rate limiting tests: ENABLED"
  echo "  - Admin ban tests: DISABLED (requires AUTH_USERNAME/AUTH_PASSWORD - see GitHub issue)"
  export TEST_RATE_LIMITING=true
  # Pass rate limit config to test runner (must match docker-compose.yml values)
  export RATE_LIMIT_REGISTRATION_WINDOW_MS=2000
  export RATE_LIMIT_REGISTRATION_MAX=5
  export RATE_LIMIT_REQUEST_WINDOW_MS=2000
  export RATE_LIMIT_REQUEST_MAX=20
  # TEST_ADMIN_BAN disabled until admin credentials are configured
  # export TEST_ADMIN_BAN=true
else
  echo "Running standard test suite..."
fi

# Run tests with dotenvx to load .env file
cd "$PROJECT_ROOT"
dotenvx run -f .env -- jest --config jest.config.json --runInBand --coverage
