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
-- Lock behavior. Neither statement is DDL, so neither takes an
-- AccessExclusiveLock. The INSERT and UPDATE each take a RowExclusiveLock
-- at the table level (blocks concurrent DDL, e.g. another migration's ALTER
-- TABLE on `rotation` or `rotation_cards` in the same deploy batch; does not
-- block concurrent reads or other DML) plus a row-level lock on every row
-- they touch, held to COMMIT of the whole pending-migration transaction
-- (docs/migrations.md's `migrate()`-is-one-transaction note). At ~310
-- UPDATEd rows and at most 4 INSERTed rows, the row-lock set is small and
-- the statements themselves are sub-second; unlike 0164's ADD COLUMN, there
-- is no full-table scan here; the UPDATE's `card_id IS NULL` and
-- `kill_date` legs are both covered by 0164's partial `rotation_card_id_idx`
-- and this repo's existing `kill_date` indexes rather than a seq scan.
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
