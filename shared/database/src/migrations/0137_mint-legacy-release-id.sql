-- BS#1963. Make `wxyc_schema.library.legacy_release_id` total and let Backend
-- mint it on catalog adds.
--
-- Background: `legacy_release_id` was added nullable (0034) and, until now, was
-- populated ONLY by the tubafrenzy library-etl (jobs/library-etl/job.ts), which
-- copies the tubafrenzy `LIBRARY_RELEASE.ID`. Post-cutover, MD-API catalog adds
-- (POST /library -> insertAlbum) leave it NULL (76 such rows in prod today), and
-- the two id spaces are on a collision course: the BS `library.id` serial (max
-- ~70,472) already overlaps the tubafrenzy legacy id space (max 72,276), so the
-- Backend-sourced `library.db` producer cannot safely emit a stored
-- `legacy_release_id AS id` while the column is partial.
--
-- Decision (BS#1963): Backend mints `legacy_release_id` from a dedicated Postgres
-- sequence floored at 1,000,000 — comfortably above the legacy id space — so a
-- Backend-authored id can never collide with a tubafrenzy one. The mint fires
-- via a column DEFAULT, which is inert everywhere legacy_release_id is set
-- explicitly (the ETL insert and every seed/fixture) and engages ONLY on the
-- addAlbum path that omits the column. The 76 existing NULL-legacy rows are
-- backfilled from the same sequence so the column becomes NOT NULL (total).
--
-- Statement order (data invariant first, then constraints — the 0101 shape):
--   1. CREATE SEQUENCE (floor + start 1,000,000).
--   2. Backfill the NULL-legacy rows from the sequence.
--   3. Precondition guard (#705): fail fast if any NULL survives the backfill.
--   4. SET DEFAULT nextval(seq)  — mint on future omitted inserts.
--   5. SET NOT NULL.
-- (SET DEFAULT follows the guard so the guard precedes the first ALTER TABLE;
-- placing it before the backfill has no behavioral effect — a DEFAULT never
-- retro-fills existing rows — but hides the guard from the precondition-guard
-- linter's regex.)
--
-- Lock behavior: the SET DEFAULT and SET NOT NULL each take an
-- AccessExclusiveLock on `library`; Drizzle runs the whole file in one
-- transaction, so the lock is held from step 4 to COMMIT. The 76-row backfill is
-- trivial and the NOT NULL validation scan over ~64k rows is fast, but a live
-- writer (library-etl, addAlbum, streaming/artwork updates) could hold a
-- conflicting lock at deploy time. `SET LOCAL lock_timeout` bounds the wait so
-- the migration fails fast and the deploy retries, rather than wedging every
-- library reader behind a pending AccessExclusiveLock. PG14-compatible
-- throughout (CREATE SEQUENCE / nextval / DO $$ / SET NOT NULL); prod RDS is
-- PG14.22 (see docs/migrations.md dev/prod PG skew).

SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE SEQUENCE "wxyc_schema"."library_legacy_release_id_seq" INCREMENT BY 1 MINVALUE 1000000 MAXVALUE 9223372036854775807 START WITH 1000000 CACHE 1;--> statement-breakpoint
-- @no-analyze-needed: 76-row backfill, stats drift negligible. legacy_release_id
-- is covered only by the unique btree `library_legacy_release_id_idx`, which no
-- read-path query plans against by value; the planner never needs fresh stats on
-- this column, so no ANALYZE is warranted (BS#934 rule).
UPDATE wxyc_schema.library SET legacy_release_id = nextval('"wxyc_schema"."library_legacy_release_id_seq"'::regclass) WHERE legacy_release_id IS NULL;--> statement-breakpoint
-- Precondition guard (#705). The SET NOT NULL below depends on the backfill above
-- having made every row non-NULL. If any NULL survives — a concurrent writer
-- inserting a NULL between the backfill and this check under READ COMMITTED —
-- fail fast with a readable message instead of wedging mid-ALTER.
DO $$ BEGIN IF (SELECT count(*) FROM wxyc_schema.library WHERE legacy_release_id IS NULL) > 0 THEN RAISE EXCEPTION 'legacy_release_id backfill incomplete: % NULL rows remain', (SELECT count(*) FROM wxyc_schema.library WHERE legacy_release_id IS NULL); END IF; END $$;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library" ALTER COLUMN "legacy_release_id" SET DEFAULT nextval('"wxyc_schema"."library_legacy_release_id_seq"'::regclass);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library" ALTER COLUMN "legacy_release_id" SET NOT NULL;
