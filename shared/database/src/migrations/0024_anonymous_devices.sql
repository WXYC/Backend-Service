CREATE TABLE "anonymous_devices" (
	"id" serial PRIMARY KEY NOT NULL,
	"device_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"blocked_at" timestamp with time zone,
	"blocked_reason" text,
	"request_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "anonymous_devices_device_id_unique" UNIQUE("device_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "anonymous_devices_device_id_key" ON "anonymous_devices" USING btree ("device_id");