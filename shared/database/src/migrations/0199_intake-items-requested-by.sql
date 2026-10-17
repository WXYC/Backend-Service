-- BS#3386: records which music director asked a DJ to review an item, so a read can name the asker after the ask email is sent. SET NULL because the asker's account can be deleted; the item and its request stay.
-- DDL-only: a nullable column with no default rewrites nothing. No backfill: a request made before this column reads NULL, which the contract allows.
-- @no-precondition-needed: the column is new and all NULL, so the foreign key has no rows to violate it.
ALTER TABLE "wxyc_schema"."intake_items" ADD COLUMN "requested_by" varchar(255);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."intake_items" ADD CONSTRAINT "intake_items_requested_by_auth_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;