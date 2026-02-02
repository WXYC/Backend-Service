CREATE INDEX "bins_dj_id_idx" ON "wxyc_schema"."bins" USING btree ("dj_id");--> statement-breakpoint
CREATE INDEX "bins_album_id_idx" ON "wxyc_schema"."bins" USING btree ("album_id");--> statement-breakpoint
CREATE INDEX "flowsheet_show_id_idx" ON "wxyc_schema"."flowsheet" USING btree ("show_id");--> statement-breakpoint
CREATE INDEX "flowsheet_album_id_idx" ON "wxyc_schema"."flowsheet" USING btree ("album_id");--> statement-breakpoint
CREATE INDEX "flowsheet_rotation_id_idx" ON "wxyc_schema"."flowsheet" USING btree ("rotation_id");--> statement-breakpoint
CREATE INDEX "show_djs_show_id_dj_id_idx" ON "wxyc_schema"."show_djs" USING btree ("show_id","dj_id");--> statement-breakpoint
CREATE INDEX "show_djs_dj_id_idx" ON "wxyc_schema"."show_djs" USING btree ("dj_id");