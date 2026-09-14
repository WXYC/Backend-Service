# Post-apply migration notes

This file documents corrections and rationale that postdate a migration's prod apply, and therefore can't live in the migration's own `.sql` file. Three kinds of entries live here: **precondition rationale**, documenting why specific migrations don't carry an inline `DO $$ ... RAISE EXCEPTION ... END $$;` precondition guard even though they add `UNIQUE`, `CHECK`, `NOT NULL`, or `FOREIGN KEY` constraints; **transaction-model corrections**, documenting where a migration header's own prose reasons wrongly about Drizzle's transaction model; and **semantic corrections**, where a header's claim about a column's meaning was superseded after the migration applied.

The notes live here rather than as inline comments in the SQL files themselves because retroactively editing an applied migration's SQL changes its content hash, which two separate guards reject: `scripts/validate-migrations.mjs` Check 11 catches it at PR time, and `dev_env/init-db.mjs`'s `verifyMigrations()` — the production migrate job — throws on it at deploy time. That is the wedge that motivated this file (WXYC/Backend-Service#705 follow-up). Documentation that postdates a migration's prod apply must therefore live outside the .sql file. New migrations being authored may still inline `-- @no-precondition-needed:` annotations, or write accurate header prose directly — those exist before the migration is applied and never need to change after.

The validator's `HISTORICAL_NO_GUARD_NEEDED_TAGS` allowlist suppresses Check 8 (precondition-guard warning) for 23 tags, and is closed — `scripts/validate-migrations.mjs` states that new tags must not be added to it. The Precondition rationale section below documents four of those 23. They are four of the five migrations (0034, 0048, 0059, 0067, 0071) whose inline `-- @no-precondition-needed:` annotations were retrofitted by 2710f2e and then reverted by the #705 follow-up, so they have nowhere else to record the reasoning; 0071 needs no entry because it carries a real `DO $$` guard and clears Check 8 on its own. The remaining nineteen are grandfathered-applied migrations that never carried such an annotation, and the allowlist comment in `scripts/validate-migrations.mjs` is the record for those — allowlist membership has never implied a justification here.

---

## Precondition rationale

These justify against `docs/migrations.md`'s `constraint-precondition-guards` rule, "Constraint-adding migrations should include precondition guards."

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

Five migrations add a value to `discogs_release_id_source_enum` or `concert_source_enum` — 0086, 0094, 0109, 0112, and 0117 — and three of them reason wrongly about Drizzle's transaction model: 0117 and 0094 state the model itself incorrectly, while 0112 states it correctly and draws a wrong inference from it. 0086 and 0109 scope their claims to their own file and are fine as written. Scope note: several index-building headers (0078, 0083, 0098, 0136) also say "Drizzle wraps each migration in a transaction," but their subject is `CREATE INDEX CONCURRENTLY`, where `docs/migrations.md`'s `if-not-exists-index` rule already records that the conclusion is unaffected either way. They are not corrected here.

The correct model, per `docs/migrations.md`'s `single-transaction-migrate` rule: drizzle-orm's `migrate()` (`drizzle-orm/postgres-js/migrator`, used by both `dev_env/init-db.mjs` and `drizzle-kit migrate`) applies every pending migration of a deploy in ONE transaction, not one transaction per file. A value added by `ALTER TYPE ... ADD VALUE` cannot be used inside that same transaction, even by a later migration batched into the same deploy, and even when the enum type itself was created earlier in that same transaction — only a value present in the original `CREATE TYPE` is usable there (measured against `postgres:14.24`; prod RDS is 14.22).

The `.sql` files below are frozen by the applied-hash pin (`meta/applied-hashes.json` + Check 11), so they were left unedited to avoid the WXYC/Backend-Service#705 wedge described above; WXYC/Backend-Service#2201 is where that call was made. Each subsection quotes the wrong text and states the correction instead.

### 0117_recheck-after-unavailable-enum

The "Why its own migration" paragraph (`shared/database/src/migrations/0117_recheck-after-unavailable-enum.sql:12-14`) reads:

> ... and Drizzle wraps each migration in a transaction. Isolating the ADD VALUE guarantees it is committed before any later migration or app code references it (same shape as 0109 / 0086).

Both claims are wrong. Drizzle does not wrap each migration in its own transaction, so isolating the `ADD VALUE` in its own file guarantees nothing for a consumer batched into the same deploy, and nothing on a fresh database, where 0117 and any consumer of `recheck_after_unavailable` land pending together in that one transaction. This is exactly the failure mode migration 0150 hit. What the split does buy — the value is committed for every _later_ deploy, but is no guarantee for the deploy that introduces it — is stated in full by `docs/migrations.md`'s `single-transaction-migrate` rule.

### 0094_rotation-lml-identity-id

The DDL-only note (`shared/database/src/migrations/0094_rotation-lml-identity-id.sql:70-75`) reads:

> The enum-value addition runs fine inside Drizzle's transaction-per- migration shape on PG12+ as long as the new value isn't referenced in the same transaction — the follow-on `addToRotation` writes the new value at runtime, not migration time, so there's no ordering hazard.

Only the model name is wrong: Drizzle does not run one transaction per migration. Substitute the one-transaction-per-deploy model and the rest of the note holds unchanged — the enum-value addition still runs fine inside that one transaction, because the follow-on `addToRotation` writes the new value at runtime, not migration time, so there is no ordering hazard. That is the reasoning `docs/migrations.md`'s `single-transaction-migrate` rule cites approvingly as "the reasoning 0094's header already sets out."

### 0112_triangle-shows-concerts

The CAUTION note (`shared/database/src/migrations/0112_triangle-shows-concerts.sql:7-12`) reads:

> CAUTION for later migrations: drizzle's migrator runs ALL pending migrations of a deploy in ONE transaction, so a later migration batched with this one must not reference 'triangle_shows' in DML or index predicates either — on a DB where the enum type pre-exists (prod) that raises 55P04 "unsafe use of new value", while fresh CI DBs never reproduce it (0091 creates the type in the same batch). migrate-dryrun usually catches it.

The transaction fact is right — 0112 is the one predecessor among the three that already states it correctly. Two things after it are wrong.

First, the fresh-CI-database exemption does not exist: 0091 creating `concert_source_enum` in the same batch does not exempt the value 0112 adds to it, so a later migration batched with 0112 that references `'triangle_shows'` in DML or an index predicate raises 55P04 on a fresh CI database exactly as it does on prod.

Second, the closing "migrate-dryrun usually catches it." That was defensible while 0112 was still unapplied, when a consumer would be pending alongside it against the prod snapshot and the dry-run would apply both in one transaction. It is not true for a reader today: 0112 committed to prod long ago, so it is not pending there at all, and a new consumer of `'triangle_shows'` is the **cross-deploy** case that `docs/migrations.md`'s `single-transaction-migrate` rule identifies as precisely the dry-run's structural blind spot. `Integration-Tests` is the job that catches it — the same inversion migration 0150 demonstrated.

---

## Semantic corrections

### 0164_rotation-cards-urls

The `rotation_cards` paragraph (`shared/database/src/migrations/0164_rotation-cards-urls.sql:7-9`) reads:

> rotation_cards: card identity is the stable `id`; `number` is display order only — contiguity across a bin's cards is a service-layer rule decided on the epic, not a DB constraint, so gaps and renumbers are legal.

The "not a DB constraint" half is right and stands: the DB enforces only `(bin, number)` uniqueness, so a gap row is representable as storage. The conclusion drawn from it — "gaps and renumbers are legal" — was superseded when wxyc-shared published `RotationCard.number` as "Contiguous 1..N within a bin" (the WXYC/Backend-Service#2472 contract). Contiguity is a published API promise, not a free service-layer choice: `addRotationCard` assigns `number` as the bin's max + 1 under a `FOR UPDATE` lock on the bin's top card, and `deleteRotationCardFromDB` refuses every delete but the bin's top card under the same lock, so bins grow and shrink only at the top. A gap row is therefore a contract violation if it is ever served, reachable only by manual SQL — not a legal state the schema deliberately admits. `shared/database/src/schema.ts`'s `rotation_cards` comment carries the corrected two-layer statement; this entry exists because the migration header's `.sql` bytes are frozen by the applied-hash pin and cannot say it themselves.

The `rotation.card_id` paragraph (`shared/database/src/migrations/0164_rotation-cards-urls.sql:23-26`) reads:

> Partial-indexed on the active set (`kill_date IS NULL`) — the cards listing's per-card active count and the admin list's card filter both query only active rows, against the whole rotation history.

The premise was wrong at the time it was written, not just superseded later: neither consumer named actually queries `kill_date IS NULL`. Both query the canonical active-rotation predicate — `kill_date IS NULL OR kill_date > CURRENT_DATE` (`rotationActiveSql()` in `apps/backend/services/library.service.ts`) — because a future-dated kill is still rotating and must still count as active. Postgres uses a partial index only when the query's WHERE provably implies the index predicate, and the broader OR-predicate does not imply the narrower `kill_date IS NULL`, so `rotation_card_id_idx` as shipped in 0164 could never have served either consumer; it also could not have been fixed by widening its own predicate, since `CURRENT_DATE` is STABLE and Postgres rejects non-IMMUTABLE expressions in index predicates outright. WXYC/Backend-Service#2479 replaced it with a non-partial index (`rotation_card_id_full_idx` on `(card_id)`, migration 0167) that the broad predicate can use — measured against a prod-shaped clone, a `(card_id, kill_date)` composite loses to the plain form on the cards listing's GROUP BY query (the migration's own header has the numbers). `shared/database/src/schema.ts`'s `cardIdIdx` comment carries the corrected statement; this entry exists for the same reason as the one above — 0164's `.sql` bytes are frozen by the applied-hash pin.
