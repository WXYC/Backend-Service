-- BS#3792 (plan BS#3790, the Discogs release picker): the record of every music-director change to a release's Discogs link, and the before image of the album_metadata row each change overwrote, so a change can be undone by hand.
-- library_discogs_release_change holds ids, a timestamp and the replaced pin's short source only, so its CDC payload stays far below pg_notify's 8,000-byte limit. It gets the same cdc_notify() function as the other CDC tables (0046, redefined by 0096), but on INSERT only: an INSERT is the signal each Backend instance clears its lookup caches on, and the rows are append-only, so a hand UPDATE or DELETE must not clear every instance's caches. The three release ids are positive or NULL, never Discogs' 0 sentinel (as rotation_discogs_release_id_not_sentinel, 0101), so NULL alone means "no link". album_id and actor_user_id carry no foreign key, so the record outlives a delete of the release or the user.
-- library_discogs_release_change_before holds the large jsonb image and has no trigger, so it never meets pg_notify. It is keyed by the change row and deleted with it.
-- DDL-only: two new, empty tables, one index and one trigger on them. No existing table is locked or rewritten.
-- @no-precondition-needed: both tables are new and empty, so the CHECKs and the foreign key have no rows to violate them.
CREATE TABLE "wxyc_schema"."library_discogs_release_change" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"album_id" integer NOT NULL,
	"actor_user_id" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"old_discogs_release_id" integer,
	"new_discogs_release_id" integer NOT NULL,
	"replaced_pin_discogs_release_id" integer,
	"replaced_pin_source" text,
	CONSTRAINT "library_discogs_release_change_new_release_id_ck" CHECK ("wxyc_schema"."library_discogs_release_change"."new_discogs_release_id" > 0),
	CONSTRAINT "library_discogs_release_change_old_release_id_ck" CHECK ("wxyc_schema"."library_discogs_release_change"."old_discogs_release_id" IS NULL OR "wxyc_schema"."library_discogs_release_change"."old_discogs_release_id" > 0),
	CONSTRAINT "library_discogs_release_change_replaced_pin_release_id_ck" CHECK ("wxyc_schema"."library_discogs_release_change"."replaced_pin_discogs_release_id" IS NULL OR "wxyc_schema"."library_discogs_release_change"."replaced_pin_discogs_release_id" > 0)
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."library_discogs_release_change_before" (
	"change_id" bigint PRIMARY KEY NOT NULL,
	"before_image" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library_discogs_release_change_before" ADD CONSTRAINT "library_discogs_release_change_before_change_id_library_discogs_release_change_id_fk" FOREIGN KEY ("change_id") REFERENCES "wxyc_schema"."library_discogs_release_change"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_discogs_release_change_album_id_idx" ON "wxyc_schema"."library_discogs_release_change" USING btree ("album_id");--> statement-breakpoint
CREATE TRIGGER cdc_library_discogs_release_change AFTER INSERT ON wxyc_schema.library_discogs_release_change FOR EACH ROW EXECUTE FUNCTION cdc_notify();