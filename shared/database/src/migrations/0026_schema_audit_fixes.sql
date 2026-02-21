-- Schema audit fixes (Findings 18, 19, 20, 21, 37, 38, 39)
-- This migration must be applied AFTER verifying no NULL rows exist in
-- artist_library_crossreference, and after confirming the shift_covers
-- and flowsheet sequences are not relied upon for auto-generation.

-- F18: shift_covers.schedule_id serial → integer
-- Drop the auto-increment sequence. The column type is already integer in PG;
-- serial just adds a DEFAULT nextval() and owns the sequence.
ALTER TABLE "wxyc_schema"."shift_covers" ALTER COLUMN "schedule_id" DROP DEFAULT;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'shift_covers_schedule_id_seq') THEN
    DROP SEQUENCE "wxyc_schema"."shift_covers_schedule_id_seq";
  END IF;
END $$;
--> statement-breakpoint

-- F19: flowsheet.play_order serial → integer
ALTER TABLE "wxyc_schema"."flowsheet" ALTER COLUMN "play_order" DROP DEFAULT;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'flowsheet_play_order_seq') THEN
    DROP SEQUENCE "wxyc_schema"."flowsheet_play_order_seq";
  END IF;
END $$;
--> statement-breakpoint

-- F20: artist_library_crossreference – add NOT NULL to FK columns
-- IMPORTANT: Run this check first to confirm no NULLs exist:
--   SELECT count(*) FROM wxyc_schema.artist_library_crossreference
--   WHERE artist_id IS NULL OR library_id IS NULL;
ALTER TABLE "wxyc_schema"."artist_library_crossreference" ALTER COLUMN "artist_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artist_library_crossreference" ALTER COLUMN "library_id" SET NOT NULL;
--> statement-breakpoint

-- F21: show_djs – add unique constraint on (show_id, dj_id)
-- First remove any duplicate rows (keep the first inserted)
DELETE FROM "wxyc_schema"."show_djs" a USING "wxyc_schema"."show_djs" b
  WHERE a.ctid < b.ctid
    AND a.show_id = b.show_id
    AND a.dj_id = b.dj_id;
--> statement-breakpoint
CREATE UNIQUE INDEX "show_djs_show_id_dj_id_unique" ON "wxyc_schema"."show_djs" USING btree ("show_id", "dj_id");
--> statement-breakpoint

-- F37: anonymous_devices – remove redundant unique constraint
-- The explicit uniqueIndex('anonymous_devices_device_id_key') remains.
-- Drop the inline .unique() constraint (named by PG convention).
ALTER TABLE "anonymous_devices" DROP CONSTRAINT IF EXISTS "anonymous_devices_device_id_unique";
--> statement-breakpoint

-- F38: FK cascade rules
-- schedule FKs
ALTER TABLE "wxyc_schema"."schedule" DROP CONSTRAINT IF EXISTS "schedule_specialty_id_specialty_shows_id_fk";
ALTER TABLE "wxyc_schema"."schedule" ADD CONSTRAINT "schedule_specialty_id_specialty_shows_id_fk"
  FOREIGN KEY ("specialty_id") REFERENCES "wxyc_schema"."specialty_shows"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."schedule" DROP CONSTRAINT IF EXISTS "schedule_assigned_dj_id_auth_user_id_fk";
ALTER TABLE "wxyc_schema"."schedule" ADD CONSTRAINT "schedule_assigned_dj_id_auth_user_id_fk"
  FOREIGN KEY ("assigned_dj_id") REFERENCES "public"."auth_user"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."schedule" DROP CONSTRAINT IF EXISTS "schedule_assigned_dj_id2_auth_user_id_fk";
ALTER TABLE "wxyc_schema"."schedule" ADD CONSTRAINT "schedule_assigned_dj_id2_auth_user_id_fk"
  FOREIGN KEY ("assigned_dj_id2") REFERENCES "public"."auth_user"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- shift_covers FK
ALTER TABLE "wxyc_schema"."shift_covers" DROP CONSTRAINT IF EXISTS "shift_covers_cover_dj_id_auth_user_id_fk";
ALTER TABLE "wxyc_schema"."shift_covers" ADD CONSTRAINT "shift_covers_cover_dj_id_auth_user_id_fk"
  FOREIGN KEY ("cover_dj_id") REFERENCES "public"."auth_user"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- rotation FK
ALTER TABLE "wxyc_schema"."rotation" DROP CONSTRAINT IF EXISTS "rotation_album_id_library_id_fk";
ALTER TABLE "wxyc_schema"."rotation" ADD CONSTRAINT "rotation_album_id_library_id_fk"
  FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE CASCADE;
--> statement-breakpoint

-- flowsheet FKs
ALTER TABLE "wxyc_schema"."flowsheet" DROP CONSTRAINT IF EXISTS "flowsheet_show_id_shows_id_fk";
ALTER TABLE "wxyc_schema"."flowsheet" ADD CONSTRAINT "flowsheet_show_id_shows_id_fk"
  FOREIGN KEY ("show_id") REFERENCES "wxyc_schema"."shows"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" DROP CONSTRAINT IF EXISTS "flowsheet_album_id_library_id_fk";
ALTER TABLE "wxyc_schema"."flowsheet" ADD CONSTRAINT "flowsheet_album_id_library_id_fk"
  FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" DROP CONSTRAINT IF EXISTS "flowsheet_rotation_id_rotation_id_fk";
ALTER TABLE "wxyc_schema"."flowsheet" ADD CONSTRAINT "flowsheet_rotation_id_rotation_id_fk"
  FOREIGN KEY ("rotation_id") REFERENCES "wxyc_schema"."rotation"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- reviews FK
ALTER TABLE "wxyc_schema"."reviews" DROP CONSTRAINT IF EXISTS "reviews_album_id_library_id_fk";
ALTER TABLE "wxyc_schema"."reviews" ADD CONSTRAINT "reviews_album_id_library_id_fk"
  FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE CASCADE;
--> statement-breakpoint

-- genre_artist_crossreference FKs
ALTER TABLE "wxyc_schema"."genre_artist_crossreference" DROP CONSTRAINT IF EXISTS "genre_artist_crossreference_artist_id_artists_id_fk";
ALTER TABLE "wxyc_schema"."genre_artist_crossreference" ADD CONSTRAINT "genre_artist_crossreference_artist_id_artists_id_fk"
  FOREIGN KEY ("artist_id") REFERENCES "wxyc_schema"."artists"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."genre_artist_crossreference" DROP CONSTRAINT IF EXISTS "genre_artist_crossreference_genre_id_genres_id_fk";
ALTER TABLE "wxyc_schema"."genre_artist_crossreference" ADD CONSTRAINT "genre_artist_crossreference_genre_id_genres_id_fk"
  FOREIGN KEY ("genre_id") REFERENCES "wxyc_schema"."genres"("id") ON DELETE CASCADE;
--> statement-breakpoint

-- artist_library_crossreference FKs
ALTER TABLE "wxyc_schema"."artist_library_crossreference" DROP CONSTRAINT IF EXISTS "artist_library_crossreference_artist_id_artists_id_fk";
ALTER TABLE "wxyc_schema"."artist_library_crossreference" ADD CONSTRAINT "artist_library_crossreference_artist_id_artists_id_fk"
  FOREIGN KEY ("artist_id") REFERENCES "wxyc_schema"."artists"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artist_library_crossreference" DROP CONSTRAINT IF EXISTS "artist_library_crossreference_library_id_library_id_fk";
ALTER TABLE "wxyc_schema"."artist_library_crossreference" ADD CONSTRAINT "artist_library_crossreference_library_id_library_id_fk"
  FOREIGN KEY ("library_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE CASCADE;
--> statement-breakpoint

-- shows FKs
ALTER TABLE "wxyc_schema"."shows" DROP CONSTRAINT IF EXISTS "shows_primary_dj_id_auth_user_id_fk";
ALTER TABLE "wxyc_schema"."shows" ADD CONSTRAINT "shows_primary_dj_id_auth_user_id_fk"
  FOREIGN KEY ("primary_dj_id") REFERENCES "public"."auth_user"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" DROP CONSTRAINT IF EXISTS "shows_specialty_id_specialty_shows_id_fk";
ALTER TABLE "wxyc_schema"."shows" ADD CONSTRAINT "shows_specialty_id_specialty_shows_id_fk"
  FOREIGN KEY ("specialty_id") REFERENCES "wxyc_schema"."specialty_shows"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- show_djs FK (show_id → cascade, dj_id already has cascade)
ALTER TABLE "wxyc_schema"."show_djs" DROP CONSTRAINT IF EXISTS "show_djs_show_id_shows_id_fk";
ALTER TABLE "wxyc_schema"."show_djs" ADD CONSTRAINT "show_djs_show_id_shows_id_fk"
  FOREIGN KEY ("show_id") REFERENCES "wxyc_schema"."shows"("id") ON DELETE CASCADE;
--> statement-breakpoint

-- F39: Convert all wxyc_schema timestamps to timestamptz
-- PostgreSQL preserves values when converting timestamp → timestamptz
ALTER TABLE "wxyc_schema"."shift_covers" ALTER COLUMN "shift_timestamp" TYPE timestamptz USING "shift_timestamp" AT TIME ZONE 'America/New_York';
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artists" ALTER COLUMN "last_modified" TYPE timestamptz USING "last_modified" AT TIME ZONE 'America/New_York';
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library" ALTER COLUMN "add_date" TYPE timestamptz USING "add_date" AT TIME ZONE 'America/New_York';
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library" ALTER COLUMN "last_modified" TYPE timestamptz USING "last_modified" AT TIME ZONE 'America/New_York';
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ALTER COLUMN "add_time" TYPE timestamptz USING "add_time" AT TIME ZONE 'America/New_York';
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."genres" ALTER COLUMN "last_modified" TYPE timestamptz USING "last_modified" AT TIME ZONE 'America/New_York';
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" ALTER COLUMN "last_modified" TYPE timestamptz USING "last_modified" AT TIME ZONE 'America/New_York';
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" ALTER COLUMN "start_time" TYPE timestamptz USING "start_time" AT TIME ZONE 'America/New_York';
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" ALTER COLUMN "end_time" TYPE timestamptz USING "end_time" AT TIME ZONE 'America/New_York';
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."specialty_shows" ALTER COLUMN "last_modified" TYPE timestamptz USING "last_modified" AT TIME ZONE 'America/New_York';
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."album_metadata" ALTER COLUMN "last_accessed" TYPE timestamptz USING "last_accessed" AT TIME ZONE 'America/New_York';
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."album_metadata" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'America/New_York';
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artist_metadata" ALTER COLUMN "last_accessed" TYPE timestamptz USING "last_accessed" AT TIME ZONE 'America/New_York';
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artist_metadata" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'America/New_York';
