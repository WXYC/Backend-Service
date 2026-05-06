# Precondition rationale notes

This file documents why specific migrations don't carry an inline `DO $$ ... RAISE EXCEPTION ... END $$;` precondition guard, even though they add `UNIQUE`, `CHECK`, `NOT NULL`, or `FOREIGN KEY` constraints. CLAUDE.md ("Constraint-adding migrations should include precondition guards") is the policy; this is the per-migration justification.

The notes live here rather than as `-- @no-precondition-needed:` comments in the SQL files themselves because retroactively editing an applied migration's SQL changes its content hash and trips the deploy verifier (see `dev_env/init-db.mjs` Check 11 in `scripts/validate-migrations.mjs`, and the wedge that motivated this file: WXYC/Backend-Service#705 follow-up). Documentation that postdates a migration's prod apply must therefore live outside the .sql file. New migrations being authored may still inline `-- @no-precondition-needed:` annotations — those exist before the migration is applied and never need to change after.

The validator's `HISTORICAL_NO_GUARD_NEEDED_TAGS` allowlist suppresses Check 8 (precondition-guard warning) for these tags. This file explains _why_ each entry in that allowlist is safe.

---

## 0034_legacy_id_columns

Each `UNIQUE INDEX` is built against a column that is freshly added as nullable in the immediately preceding `ALTER TABLE`. Every existing row holds NULL for the new column at index-build time, and Postgres's btree UNIQUE treats NULLs as distinct, so duplicate violations are impossible. The ETL backfills these columns post-deploy.

## 0048_fix-fk-on-delete-set-null

Each `ALTER TABLE` pair drops and re-adds the same `(column, references)` FK with the same target columns and a different `ON DELETE` action. Existing rows already satisfied the prior FK; the referential predicate is unchanged, so the new `ADD CONSTRAINT` cannot find an orphan that the old one missed. The DROP/ADD runs inside a single migration transaction, so no concurrent write can introduce a new orphan between the two statements.

## 0059_album-plays-materialized-view

The `UNIQUE INDEX` is defined against the materialized view's output, which is `GROUP BY album_id` — duplicate `album_id` rows are mathematically impossible by construction. The MV itself is created in this same migration, so there is no prior state to validate.

## 0067_flowsheet-linkage-review

Brand-new `CREATE TABLE`. The `UNIQUE` on `flowsheet_id`, the `NOT NULL` columns, and the FK to `flowsheet(id)` are all evaluated against zero rows at apply time — no existing data can violate them. Subsequent inserts are bounded by the constraints themselves.
