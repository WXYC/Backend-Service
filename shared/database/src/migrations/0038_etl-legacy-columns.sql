ALTER TABLE "wxyc_schema"."flowsheet" ADD COLUMN "legacy_release_id" integer;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" ADD COLUMN "legacy_dj_name" varchar(128);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" ADD COLUMN "legacy_dj_id" integer;--> statement-breakpoint
CREATE INDEX "flowsheet_legacy_release_id_idx" ON "wxyc_schema"."flowsheet" USING btree ("legacy_release_id");