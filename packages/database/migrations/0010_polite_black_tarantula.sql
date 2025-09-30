ALTER TABLE "wxyc_schema"."djs" RENAME COLUMN "dj_name" TO "user_name";--> statement-breakpoint
ALTER TABLE "wxyc_schema"."djs" DROP CONSTRAINT "djs_dj_name_unique";--> statement-breakpoint
ALTER TABLE "wxyc_schema"."djs" DROP CONSTRAINT "djs_email_unique";--> statement-breakpoint
ALTER TABLE "wxyc_schema"."djs" DROP COLUMN IF EXISTS "email";--> statement-breakpoint
ALTER TABLE "wxyc_schema"."djs" ADD CONSTRAINT "djs_user_name_unique" UNIQUE("user_name");