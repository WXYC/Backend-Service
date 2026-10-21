#!/usr/bin/env bash
# Picks the base commit for the Auto Build & Deploy affected-target diff
# (BS#3564).
#
# `deploy-auto.yml` runs in a concurrency group, and GitHub keeps only one
# pending run per group: a newer push cancels the older pending run. A diff
# from `github.event.before` covers only the surviving run's own push, so a
# target that only a dropped push changed is never built. The base is
# therefore the head of the last successful Auto Build & Deploy run on main,
# which is the last commit known to be fully deployed.
#
# Fallbacks, in order:
#   1. The head SHA of the last successful run, if it is a commit in this
#      clone and a strict ancestor of HEAD_SHA.
#   2. EVENT_BEFORE, verbatim, when the lookup fails, returns nothing, or
#      gives a commit that is not a strict ancestor (force-push, or a re-run
#      of the commit that already deployed).
# The caller decides what an unusable EVENT_BEFORE means (all zeros, or not an
# ancestor): it deploys every target, the fail-open that turbo already has.
#
# Usage (env): EVENT_BEFORE, HEAD_SHA, GH_TOKEN, GH_REPO; optional
# DEPLOY_WORKFLOW (default deploy-auto.yml) and DEPLOY_BRANCH (default main).
#   BASE=$(scripts/resolve-deploy-base.sh)
#
# Prints the base SHA on stdout (it can be empty or all zeros, from
# EVENT_BEFORE). Prints the base and its source on stderr. Always exits 0.
#
# Test coverage: `tests/unit/scripts/deploy-affected-targets.test.ts`.

set -uo pipefail

EVENT_BEFORE="${EVENT_BEFORE:-}"
HEAD_SHA="${HEAD_SHA:?HEAD_SHA is required}"
WORKFLOW="${DEPLOY_WORKFLOW:-deploy-auto.yml}"
BRANCH="${DEPLOY_BRANCH:-main}"

fallback() {
  echo "::notice title=Affected base::Affected base: ${EVENT_BEFORE:-<none>} (source: github.event.before; $1)" >&2
  echo "$EVENT_BEFORE"
  exit 0
}

ERR=$(mktemp)
LAST=$(gh run list --workflow "$WORKFLOW" --branch "$BRANCH" --event push --status success \
  --limit 1 --json headSha --jq '.[0].headSha // ""' 2>"$ERR")
STATUS=$?
DETAIL=$(tr '\n' ' ' <"$ERR")
rm -f "$ERR"

if [ "$STATUS" -ne 0 ]; then
  echo "::warning title=Last-success lookup failed::gh run list exited $STATUS: $DETAIL" >&2
  fallback "the last-success lookup failed"
fi
if [ -z "$LAST" ]; then
  fallback "no successful $WORKFLOW run on $BRANCH"
fi
if [ "$LAST" = "$HEAD_SHA" ]; then
  fallback "the last successful run is this commit, so this is a re-run"
fi
if ! git cat-file -e "$LAST^{commit}" 2>/dev/null; then
  echo "::warning title=Last-success commit missing::$LAST is not in this clone" >&2
  fallback "the last successful head $LAST is not in this clone"
fi
if ! git merge-base --is-ancestor "$LAST" "$HEAD_SHA" 2>/dev/null; then
  echo "::warning title=Last-success commit not an ancestor::$LAST is not an ancestor of $HEAD_SHA (force-push?)" >&2
  fallback "the last successful head $LAST is not an ancestor of HEAD"
fi

echo "::notice title=Affected base::Affected base: $LAST (source: last successful Auto Build & Deploy run on $BRANCH; github.event.before was ${EVENT_BEFORE:-<none>})" >&2
echo "$LAST"
