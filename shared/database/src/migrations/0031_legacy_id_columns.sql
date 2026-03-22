ALTER TABLE "wxyc_schema"."flowsheet" ADD COLUMN "legacy_entry_id" integer;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library" ADD COLUMN "legacy_release_id" integer;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" ADD COLUMN "legacy_show_id" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "flowsheet_legacy_entry_id_idx" ON "wxyc_schema"."flowsheet" USING btree ("legacy_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "library_legacy_release_id_idx" ON "wxyc_schema"."library" USING btree ("legacy_release_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shows_legacy_show_id_idx" ON "wxyc_schema"."shows" USING btree ("legacy_show_id");