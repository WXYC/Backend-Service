-- BS#3452 (specialty shows in the flowsheet, epic BS#3445, leaf L2): extend `specialty_shows` in place into a real catalog, so the FKs from `shows.specialty_id` and `schedule.specialty_id` keep working, and seed the nine programs.
--
-- Production holds no rows (BS#3476, queried 2026-10-18 13:04 PDT: 0 catalog rows, 0 `shows` / `schedule` references, 0 dangling `specialty_id`), so the backfill below has nothing to map there and the seeds insert fresh. The backfill and its guard stay anyway: the spec exercises the backfill on legacy rows, and a database that is not production (a clone, a restored snapshot) may hold some.
--
-- Backfill: a legacy row's slug is its normalized name (lowercased, runs of non-alphanumerics collapsed to one hyphen, ends trimmed), with `-<id>` appended when more than one row normalizes to it. The lowest-id row whose slug is a seed slug keeps the plain slug and is updated in place to the seed's values, so its id survives. Every other legacy row is set `active = false`: it still resolves history but never reaches the DJ site's prompt. The seed values live in a temp table so the in-place update and the insert share one copy.
--
-- Statement order matters: the guard and the constraints come after the backfill, the seeds after the unique index (`ON CONFLICT (slug)` needs it), and the triggers last so the seeds and backfill do not bump the flowsheet watermark. The per-row CDC trigger `cdc_specialty_shows` (0046) fires once per seeded row; that is a handful of `pg_notify` events with no table-specific consumer and is harmless.
--
-- `spotlight_role` carries all five values in its CREATE TYPE, so the seeds can use it in this transaction (see `single-transaction-migrate` in docs/migrations.md); the flowsheet's spotlight column (BS#3458) reuses the type.
--
-- @no-precondition-needed: the NOT NULL columns `logs_playcuts`, `slots` and `active` each carry a DEFAULT, so no existing row can violate them; `slug` and `short_name` are added nullable and SET NOT NULL behind the guard.
-- @no-analyze-needed: the UPDATEs touch a catalog of at most a few dozen rows, so there are no planner stats to drift.
CREATE TYPE "wxyc_schema"."spotlight_role" AS ENUM('performer', 'dj', 'reader', 'guest', 'host');--> statement-breakpoint
ALTER TABLE "wxyc_schema"."specialty_shows" ADD COLUMN "slug" varchar(64);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."specialty_shows" ADD COLUMN "short_name" varchar(32);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."specialty_shows" ADD COLUMN "tagline" varchar(120);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."specialty_shows" ADD COLUMN "logs_playcuts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."specialty_shows" ADD COLUMN "default_spotlight_role" "wxyc_schema"."spotlight_role";--> statement-breakpoint
ALTER TABLE "wxyc_schema"."specialty_shows" ADD COLUMN "artwork" jsonb;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."specialty_shows" ADD COLUMN "accent_color" char(7);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."specialty_shows" ADD COLUMN "slots" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."specialty_shows" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE TEMP TABLE "specialty_seed" (
	"slug" varchar(64), "specialty_name" varchar(64), "short_name" varchar(32), "description" text, "tagline" varchar(120),
	"logs_playcuts" boolean, "default_spotlight_role" "wxyc_schema"."spotlight_role", "slots" jsonb
);--> statement-breakpoint
INSERT INTO "specialty_seed" VALUES
('orange-county-special', 'Orange County Special', 'OCS', 'A celebration of the music of the folk world in North Carolina and beyond, with a special emphasis on local music and traditional American genres. On air since 1977, OCS is WXYC''s longest-running specialty show!', 'Folk, bluegrass and traditional music from North Carolina and beyond, on the air since 1977.', true, NULL, '[{"day":6,"start_time":"12:00","duration_minutes":120,"cadence":"weekly"}]'),
('hyperlocal', 'HyperLocal', 'HyperLocal', 'WXYC''s local news broadcast covering the university and Chapel Hill–Carrboro communities, particularly the local art scene.', 'Local news from the university and Chapel Hill–Carrboro, with an ear for the local art scene.', false, 'guest', '[{"day":6,"start_time":"16:00","duration_minutes":60,"cadence":"weekly"}]'),
('backyard-bbq', 'Backyard BBQ', 'BYBBQ', 'An hour of music and interviews with a local band, broadcast live from the WXYC station.', 'A local band, live in the station, for an hour of music and conversation.', false, 'performer', '[{"day":6,"start_time":"16:00","duration_minutes":60,"cadence":"some_weeks"}]'),
('sunset-soundtrack', 'Sunset Soundtrack', 'Sunset Soundtrack', 'A two-hour deep dive into the DJ''s choice of a film, television, or video game soundtrack, often featuring analysis of the work and music''s role in it.', 'Two hours on a film, television, or video game soundtrack of the DJ''s choosing.', true, NULL, '[{"day":6,"start_time":"19:00","duration_minutes":120,"cadence":"weekly"}]'),
('sunday-punk-radio', 'Sunday Punk Radio', 'Sunday Punk Radio', 'An exploration of any and all types of hardcore music, broadly construed. From the local scene and beyond.', 'Hardcore music, broadly construed, from the local scene and beyond.', true, NULL, '[{"day":6,"start_time":"19:00","duration_minutes":120,"cadence":"last_of_month"}]'),
('thursday-night-feature', 'Thursday Night Feature', 'TNF', 'A three-hour deep dive into the DJ''s choice of topic, from the straightforward to the wacky. Past shows include 3 hours of songs about chickens, 3 hours of bagpipe music, and a 3-hour tribute to the late, great John Peel.', 'Three hours on the DJ''s choice of topic, from the straightforward to the wacky.', true, NULL, '[{"day":3,"start_time":"21:00","duration_minutes":180,"cadence":"weekly"}]'),
('inside-track', 'Inside Track', 'Inside Track', 'One release from rotation played in its entirety, with background information on the artist and their artistry.', 'One release from rotation, played in full, with the story behind the artist.', true, NULL, '[{"day":4,"start_time":"21:00","duration_minutes":60,"cadence":"weekly"}]'),
('friday-night-story-hour', 'Friday Night Story Hour', 'Story Hour', 'WXYC''s newest specialty show, focused on spoken word and especially the work of local writers, who are invited to read their work live on air.', 'Spoken word, and local writers reading their work live on air.', false, 'reader', '[{"day":4,"start_time":"21:00","duration_minutes":60,"cadence":"some_weeks"}]'),
('new-science-experience', 'New Science Experience', 'NSE', 'A spotlight on beat-oriented music, dance culture, and the art of live mixing. The music spun live on NSE includes house, techno, hip hop, ambient, and various genres from the underground dance scene.', 'Beat-oriented music and live mixing: house, techno, hip hop, ambient and more.', false, 'dj', '[{"day":4,"start_time":"22:00","duration_minutes":120,"cadence":"weekly"}]');--> statement-breakpoint
WITH normalized AS (
	SELECT id, COALESCE(NULLIF(trim(both '-' from regexp_replace(lower(specialty_name), '[^a-z0-9]+', '-', 'g')), ''), 'show') AS base
	FROM "wxyc_schema"."specialty_shows"
), ranked AS (
	SELECT id, base, count(*) OVER (PARTITION BY base) AS n, row_number() OVER (PARTITION BY base ORDER BY id) AS rn FROM normalized
)
UPDATE "wxyc_schema"."specialty_shows" t
SET slug = CASE WHEN r.n = 1 OR (r.rn = 1 AND r.base IN (SELECT slug FROM "specialty_seed")) THEN r.base ELSE r.base || '-' || r.id END,
	short_name = left(t.specialty_name, 32),
	active = false
FROM ranked r
WHERE r.id = t.id;--> statement-breakpoint
UPDATE "wxyc_schema"."specialty_shows" t
SET specialty_name = s.specialty_name, short_name = s.short_name, description = s.description, tagline = s.tagline,
	logs_playcuts = s.logs_playcuts, default_spotlight_role = s.default_spotlight_role, slots = s.slots, active = true
FROM "specialty_seed" s
WHERE t.slug = s.slug;--> statement-breakpoint
DO $$
DECLARE null_slugs int; null_short_names int; dup_slugs int;
BEGIN
  SELECT COUNT(*) INTO null_slugs FROM wxyc_schema.specialty_shows WHERE slug IS NULL;
  SELECT COUNT(*) INTO null_short_names FROM wxyc_schema.specialty_shows WHERE short_name IS NULL;
  SELECT COUNT(*) INTO dup_slugs FROM (SELECT slug FROM wxyc_schema.specialty_shows GROUP BY slug HAVING COUNT(*) > 1) d;
  IF null_slugs > 0 OR null_short_names > 0 OR dup_slugs > 0 THEN
    RAISE EXCEPTION 'Cannot constrain specialty_shows: % null slugs, % null short_names, % duplicate slugs remain after the backfill. Fix the rows by hand first.', null_slugs, null_short_names, dup_slugs;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."specialty_shows" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."specialty_shows" ALTER COLUMN "short_name" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "specialty_shows_slug_unique" ON "wxyc_schema"."specialty_shows" USING btree ("slug");--> statement-breakpoint
INSERT INTO "wxyc_schema"."specialty_shows" (slug, specialty_name, short_name, description, tagline, logs_playcuts, default_spotlight_role, slots)
SELECT slug, specialty_name, short_name, description, tagline, logs_playcuts, default_spotlight_role, slots FROM "specialty_seed"
ON CONFLICT (slug) DO NOTHING;--> statement-breakpoint
DROP TABLE "specialty_seed";--> statement-breakpoint
DROP TRIGGER IF EXISTS touch_flowsheet_watermark_from_specialty_shows ON wxyc_schema.specialty_shows;--> statement-breakpoint
CREATE TRIGGER touch_flowsheet_watermark_from_specialty_shows
AFTER INSERT OR UPDATE OR DELETE ON wxyc_schema.specialty_shows
FOR EACH STATEMENT
EXECUTE FUNCTION wxyc_schema.touch_flowsheet_watermark();--> statement-breakpoint
CREATE OR REPLACE FUNCTION wxyc_schema.touch_specialty_shows_last_modified() RETURNS trigger AS $$
BEGIN
  NEW.last_modified = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS touch_specialty_shows_last_modified ON wxyc_schema.specialty_shows;--> statement-breakpoint
CREATE TRIGGER touch_specialty_shows_last_modified
BEFORE UPDATE ON wxyc_schema.specialty_shows
FOR EACH ROW
EXECUTE FUNCTION wxyc_schema.touch_specialty_shows_last_modified();
