#!/usr/bin/env bash
# Asserts that the cross-cache-identity feature flags documented in CLAUDE.md's
# canonical inventory match the Backend-owned flags listed in .env.example.
#
# Tier 1 (this PR, E2 step 0d): doc-vs-doc consistency only.
# Tier 2 (E2-BS substrate PR): adds a check that flag names in code match the
#   doc; this script will be extended at that time.
#
# Plan reference: WXYC/wiki plans/library-hook-canonicalization-plan.md §4.2.
# Canonical table: CLAUDE.md "Cross-cache-identity feature flags (canonical inventory)".

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE_MD="$REPO_ROOT/CLAUDE.md"
ENV_EXAMPLE="$REPO_ROOT/.env.example"

if [[ ! -f "$CLAUDE_MD" ]]; then
  echo "FAIL: $CLAUDE_MD not found." >&2
  exit 1
fi

if [[ ! -f "$ENV_EXAMPLE" ]]; then
  echo "FAIL: $ENV_EXAMPLE not found." >&2
  exit 1
fi

# Extract the Backend-owned flags from the CLAUDE.md canonical table.
# The table has rows of the form `| `FLAG_NAME` | Backend-Service | ... |`.
# We extract the first cell (flag name) on rows where the second cell is
# "Backend-Service".
canonical_backend_flags=$(
  awk -F'|' '
    /^\| `[A-Z_]+`[[:space:]]*\| Backend-Service[[:space:]]*\|/ {
      # $2 = `FLAG_NAME` — strip backticks + whitespace
      gsub(/[` ]/, "", $2)
      print $2
    }
  ' "$CLAUDE_MD" | sort -u
)

if [[ -z "$canonical_backend_flags" ]]; then
  echo "FAIL: no Backend-Service flags found in CLAUDE.md canonical table." >&2
  echo "      Expected rows of the form '| \`FLAG_NAME\` | Backend-Service | ... |'." >&2
  exit 1
fi

# Extract the cross-cache-identity flags from .env.example.
# We scope to the lines under the '### Cross-cache-identity feature flags'
# header until the next header or EOF.
env_example_flags=$(
  awk '
    /^### Cross-cache-identity feature flags/ { in_section = 1; next }
    /^###/ && in_section { in_section = 0 }
    in_section && /^[A-Z_]+=/ {
      split($0, parts, "=")
      print parts[1]
    }
  ' "$ENV_EXAMPLE" | sort -u
)

if [[ -z "$env_example_flags" ]]; then
  echo "FAIL: no flags found under the '### Cross-cache-identity feature flags' header in .env.example." >&2
  exit 1
fi

# Diff the two sets.
canonical_only=$(comm -23 <(printf '%s\n' "$canonical_backend_flags") <(printf '%s\n' "$env_example_flags"))
env_only=$(comm -13 <(printf '%s\n' "$canonical_backend_flags") <(printf '%s\n' "$env_example_flags"))

failed=0

if [[ -n "$canonical_only" ]]; then
  echo "FAIL: flags in CLAUDE.md canonical table (Backend-Service) missing from .env.example:" >&2
  echo "$canonical_only" | sed 's/^/  - /' >&2
  failed=1
fi

if [[ -n "$env_only" ]]; then
  echo "FAIL: flags in .env.example missing from CLAUDE.md canonical table:" >&2
  echo "$env_only" | sed 's/^/  - /' >&2
  failed=1
fi

if [[ "$failed" -ne 0 ]]; then
  echo "" >&2
  echo "Both files must list the same Backend-owned cross-cache-identity flags." >&2
  echo "Canonical inventory: CLAUDE.md → 'Cross-cache-identity feature flags (canonical inventory)'." >&2
  exit 1
fi

count=$(printf '%s\n' "$canonical_backend_flags" | wc -l | tr -d ' ')
echo "PASS: $count Backend-owned cross-cache-identity flag(s) consistent across CLAUDE.md and .env.example."
