# Post-apply migration notes

This file documents corrections and rationale that postdate a migration's prod apply — content that can't live in the migration's own `.sql` file because editing an applied migration changes its content hash and trips the deploy verifier (see the next paragraph). Two kinds of entries live here: precondition rationale, documenting why specific migrations don't carry an inline `DO $$ ... RAISE EXCEPTION ... END $$;` precondition guard even though they add `UNIQUE`, `CHECK`, `NOT NULL`, or `FOREIGN KEY` constraints (CLAUDE.md, "Constraint-adding migrations should include precondition guards", is the policy this justifies against); and transaction-model corrections, documenting where a migration header's own prose got Drizzle's transaction model wrong.

The notes live here rather than as inline comments in the SQL files themselves because retroactively editing an applied migration's SQL changes its content hash and trips the deploy verifier (see `dev_env/init-db.mjs` Check 11 in `scripts/validate-migrations.mjs`, and the wedge that motivated this file: WXYC/Backend-Service#705 follow-up). Documentation that postdates a migration's prod apply must therefore live outside the .sql file. New migrations being authored may still inline `-- @no-precondition-needed:` annotations, or write accurate header prose directly — those exist before the migration is applied and never need to change after.

The validator's `HISTORICAL_NO_GUARD_NEEDED_TAGS` allowlist suppresses Check 8 (precondition-guard warning) for the tags in the Precondition rationale section below. That section explains _why_ each entry in that allowlist is safe.

---

## Precondition rationale

### 0034_legacy_id_columns

Each `UNIQUE INDEX` is built against a column that is freshly added as nullable in the immediately preceding `ALTER TABLE`. Every existing row holds NULL for the new column at index-build time, and Postgres's btree UNIQUE treats NULLs as distinct, so duplicate violations are impossible. The ETL backfills these columns post-deploy.

### 0048_fix-fk-on-delete-set-null

Each `ALTER TABLE` pair drops and re-adds the same `(column, references)` FK with the same target columns and a different `ON DELETE` action. Existing rows already satisfied the prior FK; the referential predicate is unchanged, so the new `ADD CONSTRAINT` cannot find an orphan that the old one missed. The DROP/ADD runs inside a single migration transaction, so no concurrent write can introduce a new orphan between the two statements.

### 0059_album-plays-materialized-view

The `UNIQUE INDEX` is defined against the materialized view's output, which is `GROUP BY album_id` — duplicate `album_id` rows are mathematically impossible by construction. The MV itself is created in this same migration, so there is no prior state to validate.

### 0067_flowsheet-linkage-review

Brand-new `CREATE TABLE`. The `UNIQUE` on `flowsheet_id`, the `NOT NULL` columns, and the FK to `flowsheet(id)` are all evaluated against zero rows at apply time — no existing data can violate them. Subsequent inserts are bounded by the constraints themselves.

---

## Transaction-model corrections

Three migration headers stated Drizzle's transaction model incorrectly. The correct model, per `docs/migrations.md`'s `single-transaction-migrate` rule: drizzle-orm's `migrate()` (`drizzle-orm/postgres-js/migrator`, used by both `dev_env/init-db.mjs` and `drizzle-kit migrate`) applies every pending migration of a deploy in ONE transaction, not one transaction per file. A value added by `ALTER TYPE ... ADD VALUE` cannot be used inside that same transaction, even by a later migration batched into the same deploy, and even when the enum type itself was created earlier in that same transaction — only a value present in the original `CREATE TYPE` is usable there (measured against `postgres:14.24`; prod RDS is 14.22). The `.sql` files below are frozen post-apply (WXYC/Backend-Service#2201) and were left unedited to avoid the WXYC/Backend-Service#705 wedge described above; each subsection quotes the wrong text and states the correction instead.

### 0117_recheck-after-unavailable-enum

The "Why its own migration" paragraph (`shared/database/src/migrations/0117_recheck-after-unavailable-enum.sql:12-14`) reads:

> ... and Drizzle wraps each migration in a transaction. Isolating the ADD VALUE guarantees it is committed before any later migration or app code references it (same shape as 0109 / 0086).

Both claims are wrong. Drizzle does not wrap each migration in its own transaction — `migrate()` wraps every pending migration of a deploy in ONE transaction — so isolating the `ADD VALUE` in its own file guarantees nothing for a consumer batched into the same deploy, and nothing on a fresh database, where 0117 and any consumer of `recheck_after_unavailable` land pending together in that one transaction. This is exactly the failure mode migration 0150 hit (bare `rotation_bin = 'N'` passed the Migration Dry-Run and failed `Integration-Tests`). What splitting the value into its own migration does buy: the value is committed for every _later_ deploy that references it. It is not a guarantee for the deploy that introduces it, and never for a fresh database.

### 0094_rotation-lml-identity-id

The DDL-only note (`shared/database/src/migrations/0094_rotation-lml-identity-id.sql:70-75`) reads:

> The enum-value addition runs fine inside Drizzle's transaction-per- migration shape on PG12+ as long as the new value isn't referenced in the same transaction — the follow-on `addToRotation` writes the new value at runtime, not migration time, so there's no ordering hazard.

The transaction model named — "transaction-per-migration" — is wrong; Drizzle does not run one transaction per migration. The conclusion is unaffected, and remains correct: `migrate()` wraps every pending migration of a deploy in ONE transaction, and the enum-value addition still runs fine inside it as long as the new value isn't referenced in that same transaction, because the follow-on `addToRotation` writes the new value at runtime, not migration time. There is no ordering hazard either way — this is the reasoning `docs/migrations.md`'s `single-transaction-migrate` rule cites approvingly as "the reasoning 0094's header already sets out."

### 0112_triangle-shows-concerts

The CAUTION note (`shared/database/src/migrations/0112_triangle-shows-concerts.sql:7-12`) reads:

> CAUTION for later migrations: drizzle's migrator runs ALL pending migrations of a deploy in ONE transaction, so a later migration batched with this one must not reference 'triangle_shows' in DML or index predicates either — on a DB where the enum type pre-exists (prod) that raises 55P04 "unsafe use of new value", while fresh CI DBs never reproduce it (0091 creates the type in the same batch).

The transaction fact is right — 0112 is the one predecessor among the three that already states it correctly. Only the fresh-CI-database exemption is wrong: Postgres rejects a value added by `ALTER TYPE ... ADD VALUE` even when the enum type itself was created earlier in the same transaction, so a later migration batched with 0112 that references `'triangle_shows'` in DML or an index predicate raises 55P04 on a fresh CI database exactly as it does on prod — 0091 creating `concert_source_enum` in the same batch does not exempt the value 0112 adds to it. Only a value present in the original `CREATE TYPE` is usable within the transaction that created it.
