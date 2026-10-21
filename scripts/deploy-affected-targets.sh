#!/usr/bin/env bash
# Picks the Auto Build & Deploy targets: every app/job workspace that changed
# since the commit THAT TARGET was last deployed at (BS#3564).
#
# Each successful `deploy` leg in deploy-base.yml force-updates
# `refs/deployed/<target>` to the commit it deployed. Diffing per target from
# that ref, not from `github.event.before`, means a target changed by a push
# whose run GitHub dropped from the concurrency queue still builds, and a
# target whose deploy failed stays pending without holding back the others.
#
# Base for each target, in order:
#   1. refs/deployed/<target>, if it is a strict ancestor of HEAD_SHA. If it is
#      HEAD_SHA or a descendant (a re-run of an older run), the target is
#      skipped: older code never goes out over newer. If it has diverged
#      (force-push), warn and fall through.
#   2. The commit of the newest <target>/v* tag, if a strict ancestor. Tags are
#      cut before build and deploy, so this is only a bootstrap guess.
#   3. EVENT_BEFORE, if a strict ancestor.
#   4. None: the target is built unscoped (fail open), with a warning.
# Targets that share a base share one `turbo ls --affected` call.
#
# Env: HEAD_SHA (required), EVENT_BEFORE. Needs full history and tags
# (`fetch-depth: 0`) plus the fetched refs/deployed/*.
# Prints a JSON object {target: base} for the affected targets on stdout; the
# base is "" for an unscoped target. Logs each base and its source on stderr.
# Exits 1 if turbo cannot diff a range that git can resolve (BS#2264).
#
# Test coverage: `tests/unit/scripts/deploy-affected-targets.test.ts`.

set -euo pipefail

HEAD_SHA="${HEAD_SHA:?HEAD_SHA is required}"
EVENT_BEFORE="${EVENT_BEFORE:-}"
SELECT='[.packages.items[] | select(.path | (startswith("apps/") or startswith("jobs/"))) | .path | split("/")[1]] | unique | sort'

strict_ancestor() {
  [ -n "$1" ] && [ "$1" != "$HEAD_SHA" ] && git merge-base --is-ancestor "$1" "$HEAD_SHA" 2>/dev/null
}

# Prints "<base> <source>" for one target. The base is "skip" or "none" when
# there is no commit to diff from.
resolve_base() {
  local target="$1" ref tag tag_sha
  ref=$(git rev-parse -q --verify "refs/deployed/$target^{commit}" || true)
  if [ -n "$ref" ]; then
    if strict_ancestor "$ref"; then
      echo "$ref refs/deployed/$target"
      return
    fi
    if git merge-base --is-ancestor "$HEAD_SHA" "$ref" 2>/dev/null; then
      echo "skip refs/deployed/$target"
      return
    fi
    echo "::warning title=Deployed ref diverged::refs/deployed/$target ($ref) is not an ancestor of $HEAD_SHA (force-push?); falling back to its tag or github.event.before." >&2
  fi
  tag=$(git for-each-ref --count=1 --sort=-v:refname --format='%(refname:strip=2)' "refs/tags/$target/v*")
  tag_sha=$(git rev-parse -q --verify "refs/tags/$tag^{commit}" || true)
  if [ -n "$tag" ] && strict_ancestor "$tag_sha"; then
    echo "$tag_sha tag:$tag"
  elif strict_ancestor "$EVENT_BEFORE"; then
    echo "$EVENT_BEFORE github.event.before"
  else
    echo "none none"
  fi
}

PLAN=$(mktemp)
trap 'rm -f "$PLAN"' EXIT
# An assignment, so a failing turbo stops the script instead of yielding none.
ALL=$(npx turbo ls --output=json 2>/dev/null | jq -r "$SELECT | .[]")
for TARGET in $ALL; do
  echo "$TARGET $(resolve_base "$TARGET")" >>"$PLAN"
done

RESULT='{}'
# shellcheck disable=SC2013 # bases are single words (a SHA, "skip" or "none")
for BASE in $(awk '{print $2}' "$PLAN" | sort -u); do
  GROUP=$(awk -v b="$BASE" '$2 == b {print $1}' "$PLAN" | tr '\n' ' ')
  SOURCES=$(awk -v b="$BASE" '$2 == b {print $3}' "$PLAN" | sort -u | tr '\n' ' ')
  if [ "$BASE" = "skip" ]; then
    echo "::notice title=Already deployed::Skipping $GROUP: already deployed at or after $HEAD_SHA (a re-run of an older run?)" >&2
    continue
  fi
  if [ "$BASE" = "none" ]; then
    echo "::warning title=Deploying unscoped targets::No usable base for $GROUP; building them unscoped." >&2
    AFFECTED="$GROUP"
    BASE=""
  else
    echo "Affected base $BASE (source: $SOURCES) for: $GROUP" >&2
    TURBO_STDERR=$(mktemp)
    AFFECTED=$(TURBO_SCM_BASE="$BASE" TURBO_SCM_HEAD="$HEAD_SHA" npx turbo ls --affected --output=json 2>"$TURBO_STDERR" | jq -r "$SELECT | .[]")
    cat "$TURBO_STDERR" >&2
    if grep -q 'assuming all files have changed' "$TURBO_STDERR"; then
      echo "::error title=Affected-target detection is broken::turbo could not diff $BASE..$HEAD_SHA even though git resolves it. Refusing to deploy every target silently -- see BS#2264." >&2
      exit 1
    fi
    rm -f "$TURBO_STDERR"
  fi
  for TARGET in $AFFECTED; do
    if [[ " $GROUP " == *" $TARGET "* ]]; then
      RESULT=$(echo "$RESULT" | jq -c --arg t "$TARGET" --arg b "$BASE" '. + {($t): $b}')
    fi
  done
done
echo "$RESULT"
