#!/usr/bin/env bash
# Pins the set of source files that may mention the literal `spacer.gif`.
# BS#890 / Epic B unified three drifted inline copies of the filter onto a
# canonical `filterSpacerGif` (originally in
# `apps/backend/services/metadata/metadata.service.ts`; moved to
# `shared/metadata/src/helpers/filter-spacer-gif.ts` by the deep-module
# refactor — `metadata.service.ts` now re-exports). The inline duplicates
# in the four jobs + the enrichment worker remain pinned to that canonical
# via the parity tests under tests/unit/jobs/<job>/ and
# tests/unit/apps/enrichment-worker/. PR 7 of the deep-module refactor will
# delete the inline copies (and this script) as each one migrates to
# `@wxyc/metadata`.
#
# Test files are EXCLUDED from the source-set count because they exercise
# the inputs (they MUST contain the literal). Comments in unrelated files
# that reference the canonical-via-text are also excluded — searching is
# scoped to apps/ jobs/ shared/, skipping tests/.
#
# Wired into CI as the "spacer.gif callsites" step in
# `.github/workflows/test.yml`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Allowed source files (relative to repo root) that may contain the
# `spacer.gif` *code literal* (a single- or double-quoted string).
# The canonical lives in `shared/metadata/src/helpers/filter-spacer-gif.ts`
# (npm package `@wxyc/metadata`); the four jobs + enrichment worker each
# keep an inline copy for build-graph isolation from `apps/backend`. Those
# inline copies are slated for removal as PR 7 of the deep-module refactor.
#
# Adding a new entry here requires also adding a parity test under
# tests/unit/jobs/<job>/filter-spacer-gif-parity.test.ts that pins the
# new inline copy's truthy/falsy behavior to the canonical.
ALLOWED=(
  "shared/metadata/src/helpers/filter-spacer-gif.ts"
  "jobs/flowsheet-metadata-backfill/enrich.ts"
  "jobs/album-level-backfill/job.ts"
  "jobs/flowsheet-artwork-repair/repair.ts"
  "apps/enrichment-worker/enrich.ts"
)

cd "$REPO_ROOT"

# Find every source file under apps/ jobs/ shared/ that contains the
# `spacer.gif` *code literal* (single- or double-quoted). Bare-prose
# mentions in comments are not flagged because they're not duplication —
# only code references count. Skip node_modules, dist, build, tests.
FOUND=$(grep -rlE "['\"]spacer\.gif['\"]" apps jobs shared 2>/dev/null \
  | grep -v -E '/(node_modules|dist|build|\.next|coverage|__tests__)/' \
  | grep -v -E '(^|/)tests/' \
  | grep -v -E '\.(test|spec)\.(ts|tsx|js)$' \
  | grep -v -E '_snapshot\.json$' \
  | sort -u || true)

# Diff against the allowlist.
ALLOWED_SORTED=$(printf '%s\n' "${ALLOWED[@]}" | sort -u)

UNEXPECTED=$(comm -23 <(printf '%s\n' "$FOUND") <(printf '%s\n' "$ALLOWED_SORTED") || true)
MISSING=$(comm -13 <(printf '%s\n' "$FOUND") <(printf '%s\n' "$ALLOWED_SORTED") || true)

failed=0

if [ -n "$UNEXPECTED" ]; then
  echo "FAIL: file(s) reference 'spacer.gif' but are not in the allowlist." >&2
  echo "      BS#890 / @wxyc/metadata is the canonical." >&2
  echo "      Import the canonical in apps/backend/** or register a new build-graph-isolated" >&2
  echo "      inline duplicate in scripts/check-spacer-gif-callsites.sh ALLOWED + parity test." >&2
  while IFS= read -r f; do [ -n "$f" ] && echo "      - $f"; done <<<"$UNEXPECTED" >&2
  failed=1
fi

if [ -n "$MISSING" ]; then
  echo "FAIL: allowlist entries no longer mention 'spacer.gif' (stale allowlist)." >&2
  echo "      Either restore the reference or drop the entry from ALLOWED." >&2
  while IFS= read -r f; do [ -n "$f" ] && echo "      - $f"; done <<<"$MISSING" >&2
  failed=1
fi

if [ "$failed" -ne 0 ]; then
  exit 1
fi

# Count truthy lines (skip empty).
COUNT=$(printf '%s\n' "$FOUND" | grep -c . || true)
echo "PASS: $COUNT source file(s) reference 'spacer.gif'; all in the allowlist."
