CREATE TABLE "wxyc_schema"."library_delete_denylist" (
	"legacy_release_id" integer PRIMARY KEY NOT NULL,
	"library_id" integer NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
