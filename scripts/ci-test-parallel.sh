#!/bin/bash
# CI Parallel Test Runner Script
# Usage: ./scripts/ci-test-parallel.sh [jest args...]
#
# Any arguments (e.g. -t <pattern>) are forwarded to jest verbatim -- the
# npm script this file replaced forwarded args too (npm appends `-- <args>`
# to the end of a flat script command line), so this preserves that
# capability rather than regressing it.
#
# Same purpose as scripts/ci-test.sh but runs jest.parallel.config.json
# instead of the --runInBand integration config. CI_PORT / CI_AUTH_PORT /
# CI_DB_PORT / CI_BETTER_AUTH_URL resolve identically to ci-test.sh -- see
# scripts/ci-env-vars.sh for the precedence chain (non-empty explicit
# shell export > .env > script default; BS#2348).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

source "$SCRIPT_DIR/ci-env-vars.sh" # sets DB_PORT / PORT / BETTER_AUTH_URL

cd "$PROJECT_ROOT"
dotenvx run -f .env -- jest --config jest.parallel.config.json --coverage "$@"
