#!/usr/bin/env bash
# Asserts that every Drizzle migration referencing `library_identity*` columns
# (FK or NOT NULL constraint) includes a precondition guard inlining the
# `truly_unresolved_rows < 1000` gate from `scripts/check-library-identity-gate.sql`.
#
# Plan reference: plans/library-hook-canonicalization-plan.md §3.2.3.1.
#
# False-positive escape hatch: a migration that legitimately doesn't need a
# guard (e.g., adding an index on an existing column) can include the comment
# `-- precondition-guard: not-required (rationale)` on its first line; the
# linter treats this as an explicit opt-out and passes the file. PRs using
# the escape hatch require the rationale to be reviewed at PR time.
#
# Wired into CI as the "Migration guards" job in `.github/workflows/test.yml`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/shared/database/src/migrations"

if [[ ! -d "$MIGRATIONS_DIR" ]]; then
  echo "FAIL: migrations directory $MIGRATIONS_DIR not found." >&2
  exit 1
fi

failed=0
checked=0
guarded=0
opted_out=0

for sql in "$MIGRATIONS_DIR"/*.sql; do
  [[ -f "$sql" ]] || continue
  checked=$((checked + 1))

  # Does this migration reference any of the substrate tables (FK/NOT NULL
  # constraint, or any DDL touching the table or its columns)?
  if ! grep -qE 'library_identity(_source|_history)?' "$sql"; then
    continue
  fi

  # The substrate-creating migration itself does not need to guard against
  # itself — the tables don't exist yet at migration-run time. Detect via the
  # `CREATE TABLE` for any of the three substrate tables; if present, the
  # migration creates rather than depends on them.
  if grep -qE 'CREATE TABLE[^;]*"library_identity(_source|_history)?"' "$sql"; then
    continue
  fi

  # Opt-out: first line is `-- precondition-guard: not-required (...)`.
  if head -n1 "$sql" | grep -qE '^-- precondition-guard: not-required'; then
    opted_out=$((opted_out + 1))
    continue
  fi

  # Otherwise, require a guard inlining the gate-check predicate.
  if grep -qE 'truly_unresolved_rows|RAISE EXCEPTION.*library_identity|check-library-identity-gate' "$sql"; then
    guarded=$((guarded + 1))
    continue
  fi

  echo "FAIL: $(basename "$sql") references library_identity* but lacks a precondition guard." >&2
  echo "      Either inline the gate-check from scripts/check-library-identity-gate.sql in a" >&2
  echo "      DO \$\$ ... RAISE EXCEPTION ... END \$\$ block, or add" >&2
  echo "      '-- precondition-guard: not-required (<rationale>)' as the first line." >&2
  failed=1
done

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi

echo "PASS: $checked migration(s) checked; $guarded with inline gate, $opted_out opted out, $((checked - guarded - opted_out)) untouched by library_identity*."
