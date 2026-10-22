#!/usr/bin/env bash
# Prints one target's deploy version from the `version-<target>-<build_id>`
# artifacts that `actions/download-artifact` put in a directory (BS#3640).
#
# With several matching artifacts the action extracts each into a subfolder
# named after it. With exactly one match it extracts the artifact straight into
# the destination and makes no subfolder. Both layouts are read here:
#
#   several artifacts: <versions-dir>/version-<target>-<build_id>/deploy_version.txt
#   one artifact:      <versions-dir>/deploy_version.txt
#
# A flat file carries no target name, so it is accepted only when the run has
# exactly one target and no subfolder exists. Otherwise it could belong to a
# different target (say, one whose `version-<target>-<build_id>` artifact was
# not downloaded), and guessing would check the wrong image.
#
# Used by `migrate` in `.github/workflows/deploy-base.yml` (`Check app images`).
#
# Usage:
#   ./scripts/read-deploy-version.sh <versions-dir> <target> <build_id> <target-count>
#
# Exit:
#   0  the tag is printed on stdout.
#   1  no usable version file; an ::error names the target and the paths tried.
#
# Test coverage: `tests/unit/scripts/read-deploy-version.test.ts`.

set -uo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: read-deploy-version.sh <versions-dir> <target> <build_id> <target-count>" >&2
  exit 2
fi

DIR="$1"
TARGET="$2"
BUILD_ID="$3"
COUNT="$4"

SUBFOLDER_FILE="$DIR/version-$TARGET-$BUILD_ID/deploy_version.txt"
FLAT_FILE="$DIR/deploy_version.txt"

fail() {
  echo "::error title=No deploy version for $TARGET::$1" >&2
  exit 1
}

if [ -f "$SUBFOLDER_FILE" ]; then
  FILE="$SUBFOLDER_FILE"
elif [ -f "$FLAT_FILE" ] && [ "$COUNT" = "1" ] && ! compgen -G "$DIR/version-*-$BUILD_ID" > /dev/null; then
  FILE="$FLAT_FILE"
elif [ -f "$FLAT_FILE" ]; then
  fail "Found $FLAT_FILE but cannot tell which target it belongs to: the run has $COUNT targets and there is no $SUBFOLDER_FILE. Check that the `handle-git-tags` job uploaded `version-$TARGET-$BUILD_ID` for this run and that the download step fetched it."
else
  fail "Expected $SUBFOLDER_FILE (or $FLAT_FILE when the run has one target); neither exists. Check that the `handle-git-tags` job uploaded `version-$TARGET-$BUILD_ID` for this run and that the download step fetched it."
fi

TAG=$(tr -d '[:space:]' < "$FILE")
if [ -z "$TAG" ]; then
  fail "$FILE is empty."
fi
echo "$TAG"
