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
#   1. a NON-EMPTY explicit shell export (CI_PORT=28081 npm run ci:test).
#      An explicitly empty shell export (CI_PORT= npm run ci:test) is
#      treated the same as unset and falls through to .env -- bash's
#      ${VAR:-fallback} can't tell "empty" from "unset", and this script
#      doesn't try to make it.
#   2. the value in .env -- the same file compose's --env-file reads,
#      parsed with `dotenvx get` (the same parser `dotenvx run -f .env --
#      jest ...` uses a few lines below in the caller), so this resolver
#      and compose can never disagree about what a line in .env means:
#      `export KEY=value`, leading whitespace, an unquoted inline comment,
#      CRLF line endings, and a quoted value all resolve the same way here
#      as they do for compose. A missing or empty .env (GHA's `touch .env`)
#      cleanly falls through to the next tier.
#   3. the hard-coded default below (byte-identical to pre-BS#2348 behavior
#      when neither of the above is set -- GHA's case: test.yml exports
#      CI_PORT / CI_DB_PORT / CI_BETTER_AUTH_URL itself, so precedence 1
#      wins there and .env -- which GHA leaves empty -- is never consulted)
#
# Intended to be sourced (`source "$SCRIPT_DIR/ci-env-vars.sh"`), not
# executed, by scripts/ci-test.sh and scripts/ci-test-parallel.sh. Callers
# must set PROJECT_ROOT before sourcing.

_ci_env_var() {
  local key="$1" file="$2"
  [ -f "$file" ] || return 0
  # `env -u "$key"` strips the caller's shell value for this one key
  # before invoking dotenvx, so the result always reflects .env's own
  # value regardless of what's in the shell. Without it, dotenvx's own
  # default behavior (an unqualified `get`) prefers an existing env var --
  # including an explicitly empty one -- over .env, which would leak the
  # caller's shell state into what is meant to be a pure .env-only lookup
  # and break the "empty shell export falls through to .env" precedence
  # documented above. `2>/dev/null` swallows dotenvx's MISSING_KEY /
  # MISSING_ENV_FILE warnings; `return 0` keeps a not-found key (dotenvx
  # exits 1 on those) from tripping `set -e` in the sourcing caller.
  env -u "$key" dotenvx get "$key" -f "$file" 2>/dev/null
  return 0
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
