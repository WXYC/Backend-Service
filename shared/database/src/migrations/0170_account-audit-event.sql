-- 0170 account_audit_event (BS#2536, parent epic #2534): the storage
-- substrate for the account-modification audit trail. This migration lands
-- the table only — no call sites write to it yet (coverage ships in the
-- follow-up PR, BS#2537).
--
-- New table, no data migration: DDL-only, well within docs/migrations.md's
-- ddl-only rule. Lock behavior: CREATE TABLE + two CREATE INDEX on a brand
-- new table take no lock on any existing table and touch zero existing
-- rows — sub-second regardless of database size.
--
-- No FKs on actor_user_id / impersonator_user_id / subject_user_id, and no
-- precondition guard is needed for that omission (there is no constraint
-- being added to guard). See the schema.ts comment on account_audit_event
-- for the full "why no FK" rationale — in short, `admin/remove-user` is
-- itself an audited action, and ON DELETE SET NULL would let a manager who
-- deletes a user also erase themselves as actor from every prior event
-- touching that user.
--
-- Indexes: (subject_user_id, occurred_at) and (actor_user_id, occurred_at)
-- only. Deliberately no standalone (occurred_at) index — see the schema.ts
-- comment; the table is write-mostly and stays in the thousands of rows, so
-- the daily prune's range scan is a cheap seq scan.
CREATE TABLE "account_audit_event" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" varchar(255),
	"impersonator_user_id" varchar(255),
	"subject_user_id" varchar(255),
	"outcome" integer NOT NULL,
	"error_code" text,
	"ip_hash" varchar(16),
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "account_audit_event_subject_user_id_occurred_at_idx" ON "account_audit_event" USING btree ("subject_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "account_audit_event_actor_user_id_occurred_at_idx" ON "account_audit_event" USING btree ("actor_user_id","occurred_at");