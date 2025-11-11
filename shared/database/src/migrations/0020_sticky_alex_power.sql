CREATE TABLE "auth_account" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"account_id" varchar(255) NOT NULL,
	"provider_id" varchar(255) NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" varchar(255),
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_invitation" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"organization_id" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"role" varchar(255),
	"status" varchar(255) DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"inviter_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_jwks" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_member" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"organization_id" varchar(255) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"role" varchar(255) DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_organization" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"logo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" varchar(255),
	"user_agent" text,
	"impersonated_by" varchar(255),
	"active_organization_id" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"role" varchar(255),
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"username" varchar(255),
	"display_username" varchar(255),
	"real_name" varchar(255),
	"dj_name" varchar(255),
	"app_skin" varchar(255) DEFAULT 'modern-light' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"identifier" varchar(255) NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_invitation" ADD CONSTRAINT "auth_invitation_organization_id_auth_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."auth_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_invitation" ADD CONSTRAINT "auth_invitation_inviter_id_auth_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_member" ADD CONSTRAINT "auth_member_organization_id_auth_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."auth_organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_member" ADD CONSTRAINT "auth_member_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_account_provider_account_key" ON "auth_account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "auth_invitation_email_idx" ON "auth_invitation" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_member_org_user_key" ON "auth_member" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_organization_slug_key" ON "auth_organization" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_session_token_key" ON "auth_session" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_user_email_key" ON "auth_user" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_user_username_key" ON "auth_user" USING btree ("username");--> statement-breakpoint