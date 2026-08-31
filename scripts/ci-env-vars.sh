#!/bin/bash
# Resolves the CI_PORT / CI_AUTH_PORT / CI_DB_PORT / CI_BETTER_AUTH_URL
# family into the PORT / AUTH_PORT / DB_PORT / BETTER_AUTH_URL exports the
# local test runners hand to jest, from the SAME .env file
# dev_env/docker-compose.yml's `--env-file .env` (see scripts/ci-env.sh)
# reads. Without this, a `.env` carrying non-default ports (e.g.
# CI_PORT=28081 to dodge another worktree's CI stack) brings compose up on
# the offset ports while a plain shell resolves the hard-coded defaults
# instead, and `ci:testmock` times out waiting on the wrong port (BS#2348).
#
# Precedence, highest first:
#   1. an explicit shell export (CI_PORT=28081 npm run ci:test)
#   2. the value in .env -- the file compose's --env-file also reads
#   3. the hard-coded default below (byte-identical to pre-BS#2348 behavior
#      when neither of the above is set -- GHA's case: test.yml exports
#      CI_PORT / CI_DB_PORT / CI_BETTER_AUTH_URL itself, so precedence 1
#      wins there and .env is never consulted)
#
# Intended to be sourced (`source "$SCRIPT_DIR/ci-env-vars.sh"`), not
# executed, by scripts/ci-test.sh and scripts/ci-test-parallel.sh. Callers
# must set PROJECT_ROOT before sourcing.

_ci_env_var() {
  local key="$1" file="$2"
  [ -f "$file" ] || return 0
  # Last matching non-comment assignment wins, mirroring dotenvx/compose
  # semantics; strip a surrounding pair of quotes if present.
  grep -E "^${key}=" "$file" | tail -n1 | cut -d'=' -f2- | sed -E "s/^\"(.*)\"\$/\1/; s/^'(.*)'\$/\1/"
}

: "${PROJECT_ROOT:?PROJECT_ROOT must be set before sourcing ci-env-vars.sh}"
_CI_ENV_FILE="$PROJECT_ROOT/.env"

_CI_DB_PORT_RESOLVED="${CI_DB_PORT:-$(_ci_env_var CI_DB_PORT "$_CI_ENV_FILE")}"
export DB_PORT="${_CI_DB_PORT_RESOLVED:-15433}"

_CI_PORT_RESOLVED="${CI_PORT:-$(_ci_env_var CI_PORT "$_CI_ENV_FILE")}"
export PORT="${_CI_PORT_RESOLVED:-8081}"

# AUTH_PORT mirrors compose's `${CI_AUTH_PORT:-8083}:8080` port mapping, so
# the tests/integration/*.spec.js files and tests/setup/globalSetup.js that
# fall back to AUTH_PORT/CI_AUTH_PORT (when BETTER_AUTH_URL is absent or
# unparseable) see the same offset compose put the auth container on.
_CI_AUTH_PORT_RESOLVED="${CI_AUTH_PORT:-$(_ci_env_var CI_AUTH_PORT "$_CI_ENV_FILE")}"
export AUTH_PORT="${_CI_AUTH_PORT_RESOLVED:-8083}"

# BETTER_AUTH_URL wins outright when set explicitly (shell export or
# .env); otherwise it's built from the just-resolved AUTH_PORT rather than
# a second hard-coded port, so the two can't drift out of sync.
_CI_BETTER_AUTH_URL_RESOLVED="${CI_BETTER_AUTH_URL:-$(_ci_env_var CI_BETTER_AUTH_URL "$_CI_ENV_FILE")}"
export BETTER_AUTH_URL="${_CI_BETTER_AUTH_URL_RESOLVED:-http://localhost:${AUTH_PORT}/auth}"

unset -f _ci_env_var
unset _CI_ENV_FILE _CI_DB_PORT_RESOLVED _CI_PORT_RESOLVED _CI_AUTH_PORT_RESOLVED _CI_BETTER_AUTH_URL_RESOLVED
