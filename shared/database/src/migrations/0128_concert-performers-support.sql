-- 0128 concert_performers junction + concerts.has_resolved_support
-- (BS#1759, parent #1618, On Tour epic #1588).
--
-- DDL-only substrate for support-act identities. No behavior change: no
-- writer exists yet for `concert_performers`, and `has_resolved_support`
-- lands inert (DEFAULT false, no reader/writer). Kept as a separate slice
-- from the sync/resolve code per this repo's migration-chain cadence
-- discipline (docs/migrations.md) and to keep this PR reviewable.
-- Structural donor: migration 0122 (artist_similar_artists) for the
-- fresh-table + FK + @no-precondition-needed shape.
--
--   - `concert_performer_role_enum` — 'headliner' | 'support'. Both values
--     declared; only 'support' rows are written by the later sync/resolve
--     slice. 'headliner' is a forward seam, not dual-written speculatively
--     — the headliner stays denormalized on `concerts.headlining_*`.
--   - `concert_performers` — one row per (concert_id, role, raw_name).
--     `artist_id` is the Phase-B pure-SQL strict/alias resolve target (FK
--     → artists.id, ON DELETE SET NULL). `discogs_artist_id` is the
--     Phase-D LML verify-before-mint target for performers absent from the
--     library — bare external id, NO FK (mirrors
--     concerts.headlining_discogs_artist_id). `discogs_artist_id_source`
--     is provenance, TEXT with a documented vocabulary rather than a
--     pgEnum (the 0109 saga: each enum-value addition costs a migration).
--     `artist_resolve_attempted_at` is an attempt-at marker
--     (docs/migrations.md "Attempt-at markers") binding ONLY the Phase-D
--     LML arm — byte-identical semantics to
--     concerts.artist_resolve_attempted_at. `removed_at` is a
--     soft-tombstone for array-shrink on re-sync. UNIQUE(concert_id, role,
--     raw_name) is both the sync upsert target and a dedupe backstop; its
--     leading concert_id column serves the embed/sync join, so no separate
--     index is added (a partial index on the unresolved-support scan
--     candidate set is deferred until a later slice's EXPLAIN shows it's
--     needed — the active-support set is small).
--   - `concerts.has_resolved_support` — denormalized curated-feed flag,
--     NOT NULL DEFAULT false. The sync/resolve slice will maintain it; the
--     curated-feed slice widens `concerts_curated_starts_on_idx` to a
--     third predicate term once the column carries real data. That
--     widening is deliberately NOT part of this migration.
--
-- Lock behavior: one fresh CREATE TYPE, one fresh CREATE TABLE, one ADD
-- COLUMN with a constant DEFAULT on the existing (small, single-digit-
-- thousands-of-rows) `concerts` table, two ADD CONSTRAINT (FK), and one
-- CREATE UNIQUE INDEX on the brand-new empty table. `CREATE INDEX` here is
-- plain / in-transaction — the table has zero rows at migration time, so
-- no CONCURRENTLY pre-build is needed (contrast the `IF NOT EXISTS`
-- pattern used for indexes added to existing large tables, e.g. 0057/
-- 0068/0070/0119).
-- @no-precondition-needed: `concert_performers` is a brand-new table with
-- zero rows at ADD CONSTRAINT / CREATE UNIQUE INDEX time, so neither FK
-- (concert_id → concerts.id, artist_id → artists.id) nor the UNIQUE index
-- can find a violation. `concerts.has_resolved_support` is NOT NULL paired
-- with a DEFAULT, so every existing row is populated at ADD COLUMN time.
CREATE TYPE "wxyc_schema"."concert_performer_role_enum" AS ENUM('headliner', 'support');--> statement-breakpoint
CREATE TABLE "wxyc_schema"."concert_performers" (
	"id" serial PRIMARY KEY NOT NULL,
	"concert_id" integer NOT NULL,
	"raw_name" text NOT NULL,
	"role" "wxyc_schema"."concert_performer_role_enum" NOT NULL,
	"artist_id" integer,
	"discogs_artist_id" integer,
	"discogs_artist_id_source" text,
	"artist_resolve_attempted_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."concerts" ADD COLUMN "has_resolved_support" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."concert_performers" ADD CONSTRAINT "concert_performers_concert_id_concerts_id_fk" FOREIGN KEY ("concert_id") REFERENCES "wxyc_schema"."concerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."concert_performers" ADD CONSTRAINT "concert_performers_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "wxyc_schema"."artists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "concert_performers_concert_role_raw_name_idx" ON "wxyc_schema"."concert_performers" USING btree ("concert_id","role","raw_name");