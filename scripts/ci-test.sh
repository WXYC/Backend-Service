#!/bin/bash
# CI Test Runner Script
# Usage: ./scripts/ci-test.sh [--full] [jest args...]
#
# Options:
#   --full    Run all tests including rate limiting and admin ban tests
#
# Any other arguments (e.g. -t <pattern>) are forwarded to jest verbatim.
#
# CI_PORT / CI_AUTH_PORT / CI_DB_PORT / CI_BETTER_AUTH_URL resolve from the
# same .env dev_env/docker-compose.yml reads via --env-file, with a
# non-empty explicit shell export still able to override deliberately
# (BS#2348). See scripts/ci-env-vars.sh for the full precedence chain.

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
source "$SCRIPT_DIR/ci-env-vars.sh" # sets DB_PORT / PORT / BETTER_AUTH_URL
export MOCK_API_URL=http://localhost:${MOCK_API_PORT:-9090}

if [ "$FULL_MODE" = true ]; then
  echo "Running full test suite..."
  echo "  - Rate limiting tests: ENABLED"
  echo "  - Admin ban tests: DISABLED (gating CI enables these separately via"
  echo "    TEST_ADMIN_BAN in the 'Run Integration Tests' step of"
  echo "    .github/workflows/test.yml, BS#133 — uncomment below to also"
  echo "    exercise them against this local docker-based flow)"
  export TEST_RATE_LIMITING=true
  # Pass rate limit config to test runner (must match docker-compose.yml values)
  export RATE_LIMIT_REGISTRATION_WINDOW_MS=2000
  export RATE_LIMIT_REGISTRATION_MAX=5
  export RATE_LIMIT_REQUEST_WINDOW_MS=2000
  export RATE_LIMIT_REQUEST_MAX=20
  # getAdminToken() (tests/utils/anonymous_auth.js) signs in as the
  # dedicated test_station_manager fixture account (seeded by
  # dev_env/seed_db.sql), so no AUTH_USERNAME/AUTH_PASSWORD wiring is
  # needed here — uncomment to opt this local flow in too.
  # export TEST_ADMIN_BAN=true
else
  echo "Running standard test suite..."
fi

# Run tests with dotenvx to load .env file
cd "$PROJECT_ROOT"
dotenvx run -f .env -- jest --config jest.config.json --runInBand --coverage "$@"
