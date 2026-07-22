-- 0118 — library "Not on Discogs" columns (BS#1281 / Not-on-Discogs 1a,
--   epic #1280). The music director's write surface for suppressing false LML
--   fuzzy matches on embargoed promos / audience-segment pressings.
--
-- Columns:
--   discogs_unavailable       boolean NOT NULL DEFAULT false — the flag.
--   discogs_unavailable_note  varchar(500) — the MD's optional rationale
--     (capped; uncapped `text` was flagged as a footgun in self-review).
--   last_discogs_recheck_at   timestamptz — server-write-only, stamped by the
--     future recheck cron; the PATCH handler never writes it.
--
-- ADD COLUMN with a constant default is a catalog-only change in PG11+ (no
-- table rewrite); the lock is a brief AccessExclusiveLock on `library`. Plain
-- ADD COLUMN (no IF NOT EXISTS) so a pre-existing column surfaces as drift
-- rather than being silently masked (migrations-doc if-not-exists-index rule).
--
-- CHECK `library_discogs_unavailable_note_check` enforces `note alive ⟺ flag
-- alive` (a note may exist only while the row is flagged). Added NOT VALID then
-- VALIDATE'd so the shape generalizes to a non-empty table; every row here is
-- freshly (false, NULL) so validation is trivially satisfied.
--
-- @no-precondition-needed: the CHECK and the NOT NULL are evaluated only
-- against rows this same migration creates as (discogs_unavailable = false,
-- note NULL) — "flag OR note IS NULL" holds for every one, and the NOT NULL is
-- paired with DEFAULT false. No pre-existing data can violate either.
--
-- Partial index `library_discogs_unavailable_idx` targets only the flagged
-- subset (the recheck cron's candidate query + the album-level-backfill
-- filter). IF NOT EXISTS + non-CONCURRENTLY here because Drizzle wraps the
-- migration in a transaction (CREATE INDEX CONCURRENTLY cannot run inside one).
-- The flagged subset is empty at deploy time (all rows default false) so the
-- in-transaction build is instant; to instead build out-of-band on a populated
-- table, run this first, then deploy:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "library_discogs_unavailable_idx"
--     ON "wxyc_schema"."library" ("discogs_unavailable")
--     WHERE "discogs_unavailable" = true;

ALTER TABLE "wxyc_schema"."library" ADD COLUMN "discogs_unavailable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library" ADD COLUMN "discogs_unavailable_note" varchar(500);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library" ADD COLUMN "last_discogs_recheck_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library" ADD CONSTRAINT "library_discogs_unavailable_note_check" CHECK ("discogs_unavailable" OR "discogs_unavailable_note" IS NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library" VALIDATE CONSTRAINT "library_discogs_unavailable_note_check";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_discogs_unavailable_idx" ON "wxyc_schema"."library" USING btree ("discogs_unavailable") WHERE "discogs_unavailable" = true;
