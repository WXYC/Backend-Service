-- Create dj_stats table
CREATE TABLE IF NOT EXISTS "wxyc_schema"."dj_stats" (
	"user_id" varchar(255) PRIMARY KEY NOT NULL,
	"shows_covered" smallint DEFAULT 0 NOT NULL
);
--> statement-breakpoint

-- Migrate shows_covered data from djs to dj_stats by matching cognito_user_name to user.username or user.email
INSERT INTO "wxyc_schema"."dj_stats" ("user_id", "shows_covered")
SELECT u.id, COALESCE(d.shows_covered, 0)
FROM "auth_user" u
LEFT JOIN "wxyc_schema"."djs" d ON (d.cognito_user_name = u.username OR d.cognito_user_name = u.email)
WHERE d.id IS NOT NULL
ON CONFLICT ("user_id") DO NOTHING;
--> statement-breakpoint

-- Drop old foreign key constraints first (before changing column types)
ALTER TABLE "wxyc_schema"."schedule" DROP CONSTRAINT IF EXISTS "schedule_assigned_dj_id_djs_id_fk";
ALTER TABLE "wxyc_schema"."schedule" DROP CONSTRAINT IF EXISTS "schedule_assigned_dj_id2_djs_id_fk";
ALTER TABLE "wxyc_schema"."shift_covers" DROP CONSTRAINT IF EXISTS "shift_covers_cover_dj_id_djs_id_fk";
ALTER TABLE "wxyc_schema"."bins" DROP CONSTRAINT IF EXISTS "bins_dj_id_djs_id_fk";
ALTER TABLE "wxyc_schema"."shows" DROP CONSTRAINT IF EXISTS "shows_primary_dj_id_djs_id_fk";
ALTER TABLE "wxyc_schema"."show_djs" DROP CONSTRAINT IF EXISTS "show_djs_dj_id_djs_id_fk";
--> statement-breakpoint

-- Change column types from integer to varchar(255) FIRST (before updating data)
-- This converts existing integer values to text representations (e.g., 1 -> '1')
ALTER TABLE "wxyc_schema"."schedule" ALTER COLUMN "assigned_dj_id" TYPE varchar(255) USING assigned_dj_id::varchar(255);
ALTER TABLE "wxyc_schema"."schedule" ALTER COLUMN "assigned_dj_id2" TYPE varchar(255) USING assigned_dj_id2::varchar(255);
ALTER TABLE "wxyc_schema"."shift_covers" ALTER COLUMN "cover_dj_id" TYPE varchar(255) USING cover_dj_id::varchar(255);
ALTER TABLE "wxyc_schema"."bins" ALTER COLUMN "dj_id" TYPE varchar(255) USING dj_id::varchar(255);
ALTER TABLE "wxyc_schema"."shows" ALTER COLUMN "primary_dj_id" TYPE varchar(255) USING primary_dj_id::varchar(255);
ALTER TABLE "wxyc_schema"."show_djs" ALTER COLUMN "dj_id" TYPE varchar(255) USING dj_id::varchar(255);
--> statement-breakpoint

-- Create temporary mapping table for djs.id -> user.id
-- Note: old_dj_id is cast to varchar since columns are now varchar
CREATE TEMP TABLE djs_user_mapping AS
SELECT d.id::varchar(255) AS old_dj_id, u.id AS new_user_id
FROM "wxyc_schema"."djs" d
INNER JOIN "auth_user" u ON (d.cognito_user_name = u.username OR d.cognito_user_name = u.email);
--> statement-breakpoint

-- Now update the data: map old integer DJ IDs (now as text like '1', '2') to new user IDs
UPDATE "wxyc_schema"."schedule" s
SET assigned_dj_id = m.new_user_id
FROM djs_user_mapping m
WHERE s.assigned_dj_id = m.old_dj_id;
--> statement-breakpoint

UPDATE "wxyc_schema"."schedule" s
SET assigned_dj_id2 = m.new_user_id
FROM djs_user_mapping m
WHERE s.assigned_dj_id2 = m.old_dj_id;
--> statement-breakpoint

UPDATE "wxyc_schema"."shift_covers" sc
SET cover_dj_id = m.new_user_id
FROM djs_user_mapping m
WHERE sc.cover_dj_id = m.old_dj_id;
--> statement-breakpoint

UPDATE "wxyc_schema"."bins" b
SET dj_id = m.new_user_id
FROM djs_user_mapping m
WHERE b.dj_id = m.old_dj_id;
--> statement-breakpoint

UPDATE "wxyc_schema"."shows" s
SET primary_dj_id = m.new_user_id
FROM djs_user_mapping m
WHERE s.primary_dj_id = m.old_dj_id;
--> statement-breakpoint

UPDATE "wxyc_schema"."show_djs" sd
SET dj_id = m.new_user_id
FROM djs_user_mapping m
WHERE sd.dj_id = m.old_dj_id;
--> statement-breakpoint

-- Delete orphaned records (records that couldn't be mapped to users)
DELETE FROM "wxyc_schema"."schedule" WHERE assigned_dj_id IS NOT NULL AND assigned_dj_id NOT IN (SELECT id FROM "auth_user");
DELETE FROM "wxyc_schema"."schedule" WHERE assigned_dj_id2 IS NOT NULL AND assigned_dj_id2 NOT IN (SELECT id FROM "auth_user");
DELETE FROM "wxyc_schema"."shift_covers" WHERE cover_dj_id IS NOT NULL AND cover_dj_id NOT IN (SELECT id FROM "auth_user");
DELETE FROM "wxyc_schema"."bins" WHERE dj_id NOT IN (SELECT id FROM "auth_user");
DELETE FROM "wxyc_schema"."shows" WHERE primary_dj_id IS NOT NULL AND primary_dj_id NOT IN (SELECT id FROM "auth_user");
DELETE FROM "wxyc_schema"."show_djs" WHERE dj_id NOT IN (SELECT id FROM "auth_user");
--> statement-breakpoint

-- Add new foreign key constraints to user table
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."schedule" ADD CONSTRAINT "schedule_assigned_dj_id_auth_user_id_fk" FOREIGN KEY ("assigned_dj_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."schedule" ADD CONSTRAINT "schedule_assigned_dj_id2_auth_user_id_fk" FOREIGN KEY ("assigned_dj_id2") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."shift_covers" ADD CONSTRAINT "shift_covers_cover_dj_id_auth_user_id_fk" FOREIGN KEY ("cover_dj_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."bins" ADD CONSTRAINT "bins_dj_id_auth_user_id_fk" FOREIGN KEY ("dj_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."shows" ADD CONSTRAINT "shows_primary_dj_id_auth_user_id_fk" FOREIGN KEY ("primary_dj_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."show_djs" ADD CONSTRAINT "show_djs_dj_id_auth_user_id_fk" FOREIGN KEY ("dj_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."dj_stats" ADD CONSTRAINT "dj_stats_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Drop djs table
DROP TABLE IF EXISTS "wxyc_schema"."djs";
--> statement-breakpoint
