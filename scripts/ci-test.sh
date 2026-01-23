#!/bin/bash
# Run CI integration tests
# Usage: ./scripts/ci-test.sh [--fast]
#   --fast: Skip authentication tests (uses AUTH_BYPASS=true)

set -e

JEST_CMD="jest --config jest.config.json --runInBand --coverage"

if [[ "$1" == "--fast" ]]; then
  echo "🏃 Running tests in fast mode (auth bypass enabled)..."
  npx dotenvx run -f .env -f .env.ci -f .env.ci.fast --overload -- $JEST_CMD
else
  echo "🧪 Running full integration tests..."
  npx dotenvx run -f .env -f .env.ci --overload -- $JEST_CMD
fi
