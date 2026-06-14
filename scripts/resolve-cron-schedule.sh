#!/usr/bin/env bash
# Resolves the cron schedule for a deployable cron job (BS#914 / H7).
#
# Default behavior: reads the `cron-schedule` field from
# jobs/<target>/package.json (the source of truth).
#
# Override: if the job is `flowsheet-metadata-backfill` and the env var
# `BACKFILL_CRON_SCHEDULE` is set to a non-empty value, that value wins.
# This lets ops dial the cadence (e.g. up to hourly for the C6 retune)
# without a redeploy of the job's code — only the deploy-base workflow
# re-runs and picks up the new schedule on the next crontab install.
#
# Wired into `.github/workflows/deploy-base.yml` from the `Get Deploy Vars`
# step; the override is provided via the workflow's `vars.BACKFILL_CRON_SCHEDULE`
# repository variable (or a workflow_dispatch input), passed in as an env.
#
# Usage:
#   ./scripts/resolve-cron-schedule.sh <target>
#
# Exit:
#   0 with the resolved schedule on stdout.
#   1 if the package.json or its cron-schedule field is missing (caller
#     should fail the deploy step — exactly the legacy yq-r behavior).
#
# Test coverage: `tests/unit/scripts/resolve-cron-schedule.test.ts`.

set -euo pipefail

TARGET="${1:?usage: resolve-cron-schedule.sh <target>}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$REPO_ROOT/jobs/$TARGET/package.json"

if [ ! -f "$PKG" ]; then
  echo "Missing jobs/$TARGET/package.json" >&2
  exit 1
fi

# package.json is JSON, so jq is the right tool. The existing deploy
# workflow uses yq (which also handles JSON), but jq is more commonly
# available in CI/dev environments and produces identical output here.
DEFAULT=$(jq -r '.["cron-schedule"] // ""' "$PKG")
if [ -z "$DEFAULT" ]; then
  echo "Missing cron-schedule in jobs/$TARGET/package.json" >&2
  exit 1
fi

# Override only for jobs that explicitly opt into the shared env var.
# Generalizing to "any job" would risk an accidental override from a stale
# env var fanning out across the whole matrix; keep the allowlist narrow
# and explicit. Each entry needs a documented operational reason:
#   - flowsheet-metadata-backfill (BS#914 / H7): nightly metadata sweep;
#     ops occasionally tightens the cadence (hourly) during C6 retunes
#   - rotation-lml-identity-backfill (BS#1380): daily LML-identity resolve;
#     shares the metadata sweep's ops cadence story since both are
#     LML-bounded drift-repair crons
case "$TARGET" in
  flowsheet-metadata-backfill|rotation-lml-identity-backfill)
    if [ -n "${BACKFILL_CRON_SCHEDULE:-}" ]; then
      echo "$BACKFILL_CRON_SCHEDULE"
    else
      echo "$DEFAULT"
    fi
    ;;
  *)
    echo "$DEFAULT"
    ;;
esac
