-- 0175 (BS#2661): storage for the DJ-replies feature (WXYC/wiki#148) --
-- listener_requests (ROM's post of a listener request to Slack),
-- listener_request_replies (the station's reply, sent to Slack and pushed
-- to the listener), and listener_push_tokens (APNs/FCM device tokens for
-- that push). Migration ships alone, ahead of any route that reads these
-- tables.
--
-- @no-precondition-needed: new tables, no existing rows
CREATE TABLE "wxyc_schema"."listener_push_tokens" (
	"provider" text NOT NULL,
	"token" text NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"environment" text NOT NULL,
	"bundle_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_delivered_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	CONSTRAINT "listener_push_tokens_provider_token_pk" PRIMARY KEY("provider","token"),
	CONSTRAINT "listener_push_tokens_provider_ck" CHECK ("wxyc_schema"."listener_push_tokens"."provider" IN ('apns', 'fcm')),
	CONSTRAINT "listener_push_tokens_environment_ck" CHECK ("wxyc_schema"."listener_push_tokens"."environment" IN ('production', 'sandbox'))
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."listener_request_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"body" text NOT NULL,
	"sender_kind" text NOT NULL,
	"sent_by_slack_user_id" varchar(64) NOT NULL,
	"on_air_dj_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retracted_at" timestamp with time zone,
	"retracted_by_slack_user_id" varchar(64),
	"push_state" text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "listener_request_replies_body_length_ck" CHECK (char_length("wxyc_schema"."listener_request_replies"."body") BETWEEN 1 AND 500),
	CONSTRAINT "listener_request_replies_sender_kind_ck" CHECK ("wxyc_schema"."listener_request_replies"."sender_kind" IN ('on_air', 'moderator')),
	CONSTRAINT "listener_request_replies_push_state_ck" CHECK ("wxyc_schema"."listener_request_replies"."push_state" IN ('pending', 'sent', 'no_token', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."listener_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint" uuid,
	"anonymous_user_id" varchar(255),
	"slack_channel_id" varchar(64) NOT NULL,
	"slack_ts" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'posted' NOT NULL,
	"anonymized_at" timestamp with time zone,
	CONSTRAINT "listener_requests_status_ck" CHECK ("wxyc_schema"."listener_requests"."status" IN ('posted', 'hidden', 'held'))
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."listener_push_tokens" ADD CONSTRAINT "listener_push_tokens_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."listener_request_replies" ADD CONSTRAINT "listener_request_replies_request_id_listener_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "wxyc_schema"."listener_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."listener_requests" ADD CONSTRAINT "listener_requests_anonymous_user_id_auth_user_id_fk" FOREIGN KEY ("anonymous_user_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listener_push_tokens_user_id_idx" ON "wxyc_schema"."listener_push_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "listener_request_replies_active_request_idx" ON "wxyc_schema"."listener_request_replies" USING btree ("request_id") WHERE "wxyc_schema"."listener_request_replies"."retracted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "listener_requests_channel_created_idx" ON "wxyc_schema"."listener_requests" USING btree ("slack_channel_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "listener_requests_fingerprint_idx" ON "wxyc_schema"."listener_requests" USING btree ("fingerprint") WHERE "wxyc_schema"."listener_requests"."fingerprint" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "listener_requests_unanonymized_idx" ON "wxyc_schema"."listener_requests" USING btree ("created_at") WHERE "wxyc_schema"."listener_requests"."anonymized_at" IS NULL;