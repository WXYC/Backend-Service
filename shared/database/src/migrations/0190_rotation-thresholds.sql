-- Station-wide rotation thresholds: one row (`CHECK (id = true)`), edited by the music directors through
-- PATCH /library/rotation/thresholds. The seed runs only where the row is absent, so a re-run (or a database that
-- already holds an edited row) is left alone. Fresh CREATE TABLE plus seed, so there is no existing data for a
-- constraint to trip over.
CREATE TABLE "wxyc_schema"."rotation_thresholds" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"window_days_h" integer DEFAULT 60 NOT NULL,
	"window_days_m" integer DEFAULT 60 NOT NULL,
	"window_days_l" integer DEFAULT 60 NOT NULL,
	"window_days_s" integer DEFAULT 60 NOT NULL,
	"card_stale_days" integer DEFAULT 30 NOT NULL,
	CONSTRAINT "rotation_thresholds_singleton" CHECK ("id" = true),
	CONSTRAINT "rotation_thresholds_days_positive" CHECK ("window_days_h" >= 1 AND "window_days_m" >= 1 AND "window_days_l" >= 1 AND "window_days_s" >= 1 AND "card_stale_days" >= 1)
);
--> statement-breakpoint
INSERT INTO "wxyc_schema"."rotation_thresholds" ("id", "window_days_h", "window_days_m", "window_days_l", "window_days_s", "card_stale_days")
VALUES (true, 60, 60, 60, 60, 30)
ON CONFLICT DO NOTHING;
