ALTER TABLE "wxyc_schema"."djs" RENAME COLUMN "user_name" TO "cognito_user_name";--> statement-breakpoint
ALTER TABLE "wxyc_schema"."djs" DROP CONSTRAINT "djs_user_name_unique";--> statement-breakpoint
ALTER TABLE "wxyc_schema"."djs" ADD CONSTRAINT "djs_cognito_user_name_unique" UNIQUE("cognito_user_name");