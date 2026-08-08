-- precondition-guard: not-required (this migration does not touch library_identity / library_identity_source / library_identity_history — those names appear below only in prose comparing track_artist_link_method's naming convention to library_identity_source.method, and noting that the #792 library_track_identity_source sidecar is cancelled; no DDL here references the cross-cache-identity substrate)
-- BS#1990 (#801 S1) — widen wxyc_schema.compilation_track_artist (CTA) with
-- a per-track artist canonicalization link, plus the index strategy and key
-- decision the parent ticket's S0 measurement + owner sign-off settled.
--
-- (a) NEW COLUMNS: `track_artist_id integer NULL REFERENCES artists(id)`,
--     `track_artist_link_confidence real NULL CHECK (BETWEEN 0 AND 1)`,
--     `track_artist_link_method text NULL`. All nullable — most rows will
--     never resolve. Naming mirrors `library_identity_source.method` /
--     `.confidence`. `track_artist_id` is ON DELETE SET NULL, matching the
--     `concerts.headlining_artist_id` precedent — deleting an artist row
--     shouldn't take a compilation-track credit with it. No sidecar table:
--     per #801 D6, provenance lives on these three columns only —
--     `library_track_identity_source` (the #792 design-only sibling this
--     ticket originally planned to agree with) is cancelled.
--
-- (b) UNIQUE KEY UNCHANGED, PERMANENTLY. #801 D7, from S0/#1989's prod
--     measurement: `(library_id, track_position)` is not viable —
--     78.31% of rows have a NULL track_position, and among the rest there
--     are 5,509 duplicate groups (61.5% of positioned rows), because the
--     table's grain is one row per credited artist per track — a
--     66-performer track legitimately shares one position. `cta_unique_idx`
--     (migration 0037, `(library_id, artist_name, track_title)`) stays
--     exactly as-is; this migration does not touch it.
--
-- (c) DROP `cta_unique_null_track_idx` (migration 0099 / BS#1135). Its
--     precondition guard counted `(library_id, artist_name)` groups with a
--     NULL `track_title`; the S0/#1989 prod audit re-ran that same count
--     and measured ZERO such rows. The partial index was protecting an
--     empty slice — pure write-tax on every CTA insert with a NULL
--     track_title. `IF EXISTS` so a hypothetical fresh DB without it is a
--     no-op, matching the 0095 catch-up precedent. Runtime-behavior test
--     updated at tests/integration/cta-unique-null-track-partial.spec.js;
--     schema-drift test at
--     tests/unit/database/schema.cta-unique-null-track-partial.test.ts.
--
-- (d) INDEX STRATEGY — trgm on BOTH `track_title` and `artist_name` (#801
--     D15, on codebase evidence, not the tsvector alternative). The CTA
--     suggest query (`apps/backend/services/suggest.service.ts:73-74`) is
--     exact-ILIKE `artist_name` + prefix-ILIKE `track_title` — a literal
--     sibling of the flowsheet suggest query, which migration 0042 indexes
--     with GIN `gin_trgm_ops` on both columns. `pg_trgm` is already
--     installed and used by five shipped migrations; LML#269 measured trgm
--     at 97x for this exact shape. The pre-existing `cta_artist_name_idx`
--     btree (migration 0037) cannot serve exact-ILIKE and seq-scans today —
--     it stays for equality lookups elsewhere, the new GIN carries the
--     ILIKE path. `cta_track_artist_id_idx` is a plain btree — without it
--     the "all tracks by this artist across releases" query (S4) seq-scans
--     CTA (144,778 rows today, projected 500K-1M once non-V/A lands at S5).
--     All three new indexes are drop-and-rebuild candidates during S5's
--     bulk load; that call belongs to S5's trigger-strategy decision.
--
-- PG-version constraint: prod RDS runs PostgreSQL 14.22 (see docs/migrations.md
-- "Dev/CI Postgres version vs. prod RDS"). Every statement below is PG14
-- syntax — no `NULLS NOT DISTINCT`, no `MERGE`.
--
-- Triggers: `cdc_compilation_track_artist` (migration 0046) and
-- `touch_library_watermark_from_compilation_track_artist` (migration 0138)
-- are both `AFTER ... FOR EACH ROW` / `FOR EACH STATEMENT` triggers with no
-- column list — they fire on any INSERT/UPDATE/DELETE regardless of which
-- columns are touched, so adding nullable columns and swapping indexes
-- doesn't require re-creating either. Verified by
-- tests/integration/library-catalog-producer-export.spec.js (watermark,
-- pre-existing, continues to pass unmodified) and the new
-- tests/integration/cta-track-artist-link-cdc.spec.js (CDC).
--
-- @no-precondition-needed: every constraint here is provably safe against
-- current data. `track_artist_id`'s FK and `track_artist_link_confidence`'s
-- CHECK are added alongside their own brand-new nullable columns — every
-- existing CTA row gets NULL in both, and Postgres FK/CHECK constraints are
-- vacuously satisfied by NULL (three-valued logic: an unknown comparison
-- never fails a constraint). No existing row can violate either.
--
-- Additive + index-swap only. No data migration, no backfill, no row
-- deletion (the DROP INDEX removes a constraint object, not rows).

DROP INDEX IF EXISTS "wxyc_schema"."cta_unique_null_track_idx";--> statement-breakpoint
ALTER TABLE "wxyc_schema"."compilation_track_artist" ADD COLUMN "track_artist_id" integer;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."compilation_track_artist" ADD COLUMN "track_artist_link_confidence" real;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."compilation_track_artist" ADD COLUMN "track_artist_link_method" text;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."compilation_track_artist" ADD CONSTRAINT "compilation_track_artist_track_artist_id_artists_id_fk" FOREIGN KEY ("track_artist_id") REFERENCES "wxyc_schema"."artists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cta_track_artist_id_idx" ON "wxyc_schema"."compilation_track_artist" USING btree ("track_artist_id");--> statement-breakpoint
CREATE INDEX "cta_artist_name_trgm_idx" ON "wxyc_schema"."compilation_track_artist" USING gin ("artist_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "cta_track_title_trgm_idx" ON "wxyc_schema"."compilation_track_artist" USING gin ("track_title" gin_trgm_ops);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."compilation_track_artist" ADD CONSTRAINT "cta_track_artist_link_confidence_range" CHECK ("wxyc_schema"."compilation_track_artist"."track_artist_link_confidence" BETWEEN 0 AND 1);