-- Denormalize the resolved DJ name onto flowsheet (step 5b.1).
--
-- The search hot path currently joins flowsheet -> shows -> auth_user just to
-- compute COALESCE(auth_user.dj_name, shows.legacy_dj_name, auth_user.name)
-- for display and for the dj-name search OR-decomposition added in 0051.
-- Storing the resolved name directly on the flowsheet row removes the join
-- from the search hot path and lets dj_name fold into the search_doc tsvector
-- in a follow-up.
--
-- Order of operations across the 5b sub-issues:
--   5b.1 (this migration): add the column nullable + backfill from existing rows.
--   5b.2: ETL and live insert controller start writing the column on insert.
--   5b.3: search.service reads dj_name directly; search_doc regenerated to include it;
--         the trigram indexes from 0051 are dropped.
--
-- Production note: ALTER TABLE ... ADD COLUMN of a nullable column is metadata-only
-- and instant. The backfill UPDATE rewrites every track row but holds row locks,
-- not a table lock, so concurrent reads keep working. Apply during a low-traffic
-- window if the table is large enough that the UPDATE takes more than a few seconds.

ALTER TABLE "wxyc_schema"."flowsheet"
  ADD COLUMN "dj_name" text;--> statement-breakpoint

UPDATE "wxyc_schema"."flowsheet" AS f
SET "dj_name" = COALESCE(u."dj_name", s."legacy_dj_name", u."name")
FROM "wxyc_schema"."shows" AS s
LEFT JOIN "auth_user" AS u ON u."id" = s."primary_dj_id"
WHERE f."show_id" = s."id"
  AND f."entry_type" = 'track'
  AND f."dj_name" IS NULL;
