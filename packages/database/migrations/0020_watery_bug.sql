CREATE TABLE "wxyc_schema"."account" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"accountId" varchar(255) NOT NULL,
	"providerId" varchar(255) NOT NULL,
	"userId" varchar(255) NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp,
	"refreshTokenExpiresAt" timestamp,
	"scope" varchar(500),
	"password" varchar(255),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."session" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"token" varchar(255) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"ipAddress" varchar(255),
	"userAgent" varchar(500),
	"userId" varchar(255) NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."user" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"name" varchar(255),
	"image" varchar(500),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"realName" varchar(255),
	"djName" varchar(255),
	"onboarded" boolean DEFAULT false NOT NULL,
	"appSkin" varchar(50) DEFAULT 'modern-light' NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."verification" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"identifier" varchar(255) NOT NULL,
	"value" varchar(255) NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."djs" ALTER COLUMN "cognito_user_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."djs" ADD COLUMN "user_id" varchar(255);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "wxyc_schema"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "wxyc_schema"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "wxyc_schema"."account" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "session_token_idx" ON "wxyc_schema"."session" USING btree ("token");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "wxyc_schema"."session" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "user_email_idx" ON "wxyc_schema"."user" USING btree ("email");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "wxyc_schema"."verification" USING btree ("identifier");--> statement-breakpoint
ALTER TABLE "wxyc_schema"."djs" ADD CONSTRAINT "djs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "wxyc_schema"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE VIEW "wxyc_schema"."library_artist_view" AS (select "wxyc_schema"."library"."id", "wxyc_schema"."artists"."code_letters", "wxyc_schema"."artists"."code_artist_number", "wxyc_schema"."library"."code_number", "wxyc_schema"."artists"."artist_name", "wxyc_schema"."library"."album_title", "wxyc_schema"."format"."format_name", "wxyc_schema"."genres"."genre_name", "wxyc_schema"."rotation"."play_freq", "wxyc_schema"."library"."add_date", "wxyc_schema"."library"."label" from "wxyc_schema"."library" inner join "wxyc_schema"."artists" on "wxyc_schema"."artists"."id" = "wxyc_schema"."library"."artist_id" inner join "wxyc_schema"."format" on "wxyc_schema"."format"."id" = "wxyc_schema"."library"."format_id" inner join "wxyc_schema"."genres" on "wxyc_schema"."genres"."id" = "wxyc_schema"."library"."genre_id" left join "wxyc_schema"."rotation" on "wxyc_schema"."rotation"."album_id" = "wxyc_schema"."library"."id" AND ("wxyc_schema"."rotation"."kill_date" < CURRENT_DATE OR "wxyc_schema"."rotation"."kill_date" IS NULL));--> statement-breakpoint
CREATE VIEW "wxyc_schema"."rotation_library_view" AS (select "wxyc_schema"."library"."id", "wxyc_schema"."rotation"."id", "wxyc_schema"."library"."label", "wxyc_schema"."rotation"."play_freq", "wxyc_schema"."library"."album_title", "wxyc_schema"."artists"."artist_name", "wxyc_schema"."rotation"."kill_date" from "wxyc_schema"."library" inner join "wxyc_schema"."rotation" on "wxyc_schema"."library"."id" = "wxyc_schema"."rotation"."album_id" inner join "wxyc_schema"."artists" on "wxyc_schema"."artists"."id" = "wxyc_schema"."library"."artist_id");