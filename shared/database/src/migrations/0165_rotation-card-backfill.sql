-- BS#2477 (WXYC/dj-site#1480 Rotation Admin, backend PR B7): the data
-- backfill 0164 deferred. 0164 shipped `rotation.card_id` nullable and
-- unpopulated on every row so the epic's launch requires every active row
-- carded on day one. Separate migration from 0164 per the 0162 precedent
-- (`0162_rotation-format-label-columns.sql`'s header): a schema change's
-- lock profile is trivial, a bulk UPDATE across rotation history is not, so
-- the two get separate reviews.
--
-- Step 1: create card 1 for any bin that doesn't already have one.
-- `ON CONFLICT (bin, number) DO NOTHING` against `rotation_cards_bin_number_idx`
-- (0164) makes this idempotent — a bin with a pre-existing card 1 (e.g. from
-- a manual dj-site test) is left alone, never duplicated. Four bins
-- (`freq_enum`: S/L/M/H per 0150), so at most 4 rows inserted.
--
-- Step 2: file every active, uncarded rotation row under its bin's card 1.
-- "Active" mirrors the epic's own definition (`kill_date IS NULL OR
-- kill_date > CURRENT_DATE`, the same predicate `rotation-release-id-backfill`
-- and `rotation-tracks-cache-warm.service.ts` use) — NOT `0071`'s partial-index
-- form (`kill_date IS NULL` only), because a static index predicate can't
-- reference the mutable `CURRENT_DATE` but this one-time UPDATE evaluates it
-- once, same as those two runtime call sites. `AND card_id IS NULL` is the
-- targeted-WHERE half of the org data-safety rule: a row that already
-- carries a card (however it got one) is never touched, and every killed
-- row is left uncarded by construction — the UI already renders "—" for
-- that case. Re-running this UPDATE after it has applied is a no-op: every
-- row it would have set already has `card_id IS NOT NULL` and drops out of
-- the WHERE.
--
-- Row-count estimate. `rotation` is ~21.6k rows total (0150); the active
-- subset is far smaller — `rotation-tracks-cache-warm.service.ts`'s walk
-- over the identical `kill_date IS NULL OR kill_date > CURRENT_DATE`
-- predicate measured ~310 rows in prod. Both DML statements below are
-- comfortably under the `ddl-only` rule's ~10k-row bulk-DML threshold
-- (docs/migrations.md), so this stays a migration rather than a
-- `jobs/*-backfill` one-shot — same call as 0101's 6-row sentinel cleanup
-- and 0150's 15-row reclassification, both against this same table.
--
-- Lock behavior. The INSERT and UPDATE each take a RowExclusiveLock at the
-- table level plus row-level locks on the rows they touch (~310 UPDATEd, at
-- most 4 INSERTed), but the file's true maximum lock level comes from the
-- two ANALYZE statements at the bottom: ANALYZE takes a
-- ShareUpdateExclusiveLock on its table, and because the whole
-- pending-migration batch runs as one transaction (docs/migrations.md's
-- `migrate()`-is-one-transaction note), `rotation` and `rotation_cards`
-- both hold ShareUpdateExclusive from the ANALYZE until the batch COMMITs,
-- not just for the ANALYZE's own runtime. ShareUpdateExclusive conflicts
-- with ShareUpdateExclusive-and-stronger takers — autovacuum and manual
-- VACUUM/ANALYZE, CREATE INDEX (CONCURRENTLY included), REINDEX, ALTER
-- TABLE — but not with AccessShare or RowExclusive, so concurrent reads
-- and normal DML flow uninterrupted for the batch's whole duration.
--
-- Duration. The UPDATE's `kill_date IS NULL OR kill_date > CURRENT_DATE`
-- disjunction has no index path: 0164's partial `rotation_card_id_idx` is
-- predicated on `kill_date IS NULL` alone (the same narrowness Step 2
-- explains above; BS#2479), and `rotation` has no kill_date index at all.
-- So the UPDATE plans as a Seq Scan on `rotation` once per joined
-- `rotation_cards` row — four full passes over the ~21.6k-row table, ~86k
-- row examinations. That is the honest plan and the acceptable one: it
-- measures ~8 ms on a prod-shaped PG14 fixture at today's row counts, and
-- adding a kill_date index just to reshape a one-time backfill's plan
-- would cost more than the seq scans it saves. Both statements stay
-- sub-second with a small row-lock set.
--
-- Wire note: `rotation.card_id` was already exposed (as NULL) by 0164 — see
-- that migration's header. This backfill changes only the values ~310 active
-- rows return for that field; no new key, no shape change.
--
-- Neither statement adds a constraint, so the `constraint-precondition-guards`
-- rule (docs/migrations.md) doesn't apply here: the INSERT's own
-- `ON CONFLICT DO NOTHING` is the whole safety property for step 1, and the
-- UPDATE's WHERE is the whole safety property for step 2 — there's no
-- separate precondition to guard ahead of a DDL statement.
INSERT INTO "wxyc_schema"."rotation_cards" ("bin", "number", "name")
SELECT "bin", 1, NULL
  FROM unnest(enum_range(NULL::"public"."freq_enum")) AS "bin"
  ON CONFLICT ("bin", "number") DO NOTHING;
--> statement-breakpoint

-- The UPDATE below touches ~310 rows (see estimate above) and the INSERT
-- above takes `rotation_cards` from empty to up to 4 rows; per
-- docs/bulk-update-playbook.md's blanket rule, both get a paired ANALYZE at
-- the bottom of this file rather than a `@no-analyze-needed` suppression —
-- that pragma would make `check-bulk-update-analyze` skip the file
-- wholesale (see 0150's header for why that tradeoff is deliberately
-- avoided here too).
UPDATE "wxyc_schema"."rotation" AS "r"
   SET "card_id" = "rc"."id"
  FROM "wxyc_schema"."rotation_cards" AS "rc"
 WHERE "rc"."bin" = "r"."rotation_bin"
   AND "rc"."number" = 1
   AND "r"."card_id" IS NULL
   AND ("r"."kill_date" IS NULL OR "r"."kill_date" > CURRENT_DATE);
--> statement-breakpoint

ANALYZE "wxyc_schema"."rotation_cards";
--> statement-breakpoint
ANALYZE "wxyc_schema"."rotation";
