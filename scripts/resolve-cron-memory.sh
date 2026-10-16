#!/usr/bin/env bash
# Resolves the optional memory cap for a deployable cron job.
#
# Reads the `cron-memory` field from jobs/<target>/package.json. The deploy
# turns a non-empty value into `docker run --memory=<value>` on the job's
# crontab line. A sibling of resolve-cron-schedule.sh rather than an extension:
# that script's stdout is the single value its caller captures.
#
# Usage:
#   ./scripts/resolve-cron-memory.sh <target>
#
# Env:
#   CRON_JOBS_DIR  jobs directory to read (default: the repo's jobs/). Tests only.
#
# Exit:
#   0 with the value on stdout, or nothing on stdout if the field is absent.
#   1 if package.json is missing, or the value is not a positive whole number
#     followed by `m` or `g` (the caller should fail the deploy step).
#
# Test coverage: `tests/unit/scripts/resolve-cron-memory.test.ts`.

set -euo pipefail

# Docker rejects `--memory` below 6MB ("Minimum memory limit allowed is 6MB"),
# and a crontab line carrying such a value fails every run silently. Reject it
# here, at deploy time. This is the one place the floor is defined.
MIN_MEMORY_MB=6

TARGET="${1:?usage: resolve-cron-memory.sh <target>}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="${CRON_JOBS_DIR:-$REPO_ROOT/jobs}/$TARGET/package.json"

if [ ! -f "$PKG" ]; then
  echo "Missing jobs/$TARGET/package.json" >&2
  exit 1
fi

# tojson keeps non-strings (numbers, null) distinguishable from a valid string.
RAW=$(jq -r 'if has("cron-memory") then (.["cron-memory"] | tojson) else empty end' "$PKG")
if [ -z "$RAW" ]; then
  exit 0
fi

if [[ ! "$RAW" =~ ^\"([1-9][0-9]*[mg])\"$ ]]; then
  echo "Invalid cron-memory $RAW in jobs/$TARGET/package.json (expected a positive whole number followed by m or g, e.g. 192m)" >&2
  exit 1
fi

VALUE="${BASH_REMATCH[1]}"
if [[ "$VALUE" == *m && "${VALUE%m}" -lt "$MIN_MEMORY_MB" ]]; then
  echo "Invalid cron-memory $RAW in jobs/$TARGET/package.json (Docker rejects memory limits below ${MIN_MEMORY_MB}m)" >&2
  exit 1
fi

echo "$VALUE"
