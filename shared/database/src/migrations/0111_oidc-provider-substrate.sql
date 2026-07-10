-- @no-precondition-needed: three brand-new tables. FKs land at CREATE-time
--   against empty relations, so there are no invariants to violate. The
--   UNIQUE constraints on `client_id` / `access_token` / `refresh_token` are
--   emitted inline inside CREATE TABLE, so they exist before the two FKs
--   (auth_oauth_access_token.client_id, auth_oauth_consent.client_id) that
--   reference `auth_oauth_application.client_id` are added — otherwise
--   Postgres 42830s ("no unique constraint matching given keys for referenced
--   table"). See the design note in shared/database/src/schema.ts.
-- 0111: substrate for the better-auth `oidcProvider` plugin (WXYC/Backend-Service#1571).
--   Rows are minted at /auth/oauth2/register (application) and at consent-write
--   time inside the /auth/oauth2/authorize return trip (access token + consent).
--   Without these tables the Drizzle adapter throws
--   `BetterAuthError: The model "oauthConsent" was not found in the schema
--   object` when the authorize endpoint tries to write a consent row — every
--   OIDC login (Wiki.js, flowsheet-digitization verifier) 500s. DDL-only. The
--   plugin's schema contract lives at
--   node_modules/better-auth/dist/plugins/oidc-provider/schema.mjs; column
--   names, types, and required-ness match it field-for-field so the drizzle
--   adapter's field map has no aliases to maintain.


CREATE TABLE "auth_oauth_access_token" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"access_token_expires_at" timestamp with time zone NOT NULL,
	"refresh_token_expires_at" timestamp with time zone NOT NULL,
	"client_id" varchar(255) NOT NULL,
	"user_id" varchar(255),
	"scopes" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_oauth_access_token_access_token_key" UNIQUE("access_token"),
	CONSTRAINT "auth_oauth_access_token_refresh_token_key" UNIQUE("refresh_token")
);
--> statement-breakpoint
CREATE TABLE "auth_oauth_application" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"icon" text,
	"metadata" text,
	"client_id" varchar(255) NOT NULL,
	"client_secret" text,
	"redirect_urls" text NOT NULL,
	"type" varchar(32) NOT NULL,
	"disabled" boolean DEFAULT false,
	"user_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_oauth_application_client_id_key" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "auth_oauth_consent" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"client_id" varchar(255) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"scopes" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consent_given" boolean NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_oauth_access_token" ADD CONSTRAINT "auth_oauth_access_token_client_id_auth_oauth_application_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."auth_oauth_application"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_oauth_access_token" ADD CONSTRAINT "auth_oauth_access_token_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_oauth_application" ADD CONSTRAINT "auth_oauth_application_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_oauth_consent" ADD CONSTRAINT "auth_oauth_consent_client_id_auth_oauth_application_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."auth_oauth_application"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_oauth_consent" ADD CONSTRAINT "auth_oauth_consent_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_oauth_access_token_client_id_idx" ON "auth_oauth_access_token" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "auth_oauth_access_token_user_id_idx" ON "auth_oauth_access_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_oauth_application_user_id_idx" ON "auth_oauth_application" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_oauth_consent_client_id_idx" ON "auth_oauth_consent" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "auth_oauth_consent_user_id_idx" ON "auth_oauth_consent" USING btree ("user_id");