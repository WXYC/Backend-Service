-- BS#2471 (WXYC/dj-site#1480 Rotation Admin, backend PR B1): physical
-- rotation bins subdivide into numbered, optionally-named cards, and
-- rotation entries gain an ordered set of URLs. Schema only in this PR — no
-- backfill; `rotation.card_id` ships nullable and unpopulated on every
-- existing row (backfill is #2477).
--
-- rotation_cards: card identity is the stable `id`; `number` is display
-- order only — contiguity across a bin's cards is a service-layer rule
-- decided on the epic, not a DB constraint, so gaps and renumbers are legal.
-- rotation_urls: a child table (ordered, independently queryable) rather
-- than an array column, keyed on rotation_id + position.
-- rotation.card_id: nullable FK -> rotation_cards.id, partial-indexed on the
-- active set (`kill_date IS NULL`) — the cards listing's per-card active
-- count and the admin list's card filter both query only active rows,
-- against the whole rotation history.
--
-- Lock behavior: CREATE TABLE and the nullable ADD COLUMN are metadata-only
-- on PG14. The two new FK constraints and the unique index on rotation_cards
-- validate against either a freshly-created empty table (rotation_cards,
-- rotation_urls) or an all-NULL new column (card_id has no existing non-NULL
-- values to violate its FK) — so ADD CONSTRAINT's validation scan is a no-op
-- regardless of `rotation`'s size.
--
-- @no-precondition-needed: rotation_cards_bin_number_idx and both new FK
-- constraints (rotation_urls.rotation_id, rotation.card_id) validate against
-- either a freshly-created empty table or an all-NULL new column, per the
-- reasoning above.
--
-- The rotation_card_id_idx partial index below is the one exception: it is
-- built on `rotation`, an existing table with real rows, so it takes a SHARE
-- lock for the duration of its scan (blocking writes, not reads) rather than
-- being metadata-only. NOT the CONCURRENTLY form, because Drizzle wraps each
-- migration file in a transaction and `CREATE INDEX CONCURRENTLY cannot run
-- inside a transaction block` — same constraint as 0057, 0068, 0070, 0074,
-- 0078, 0080, 0139, 0144, 0148, 0154, 0163. If this deploy lands mid-show,
-- pre-build it out of band first:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "rotation_card_id_idx"
--     ON "wxyc_schema"."rotation" USING btree ("card_id")
--     WHERE "wxyc_schema"."rotation"."kill_date" IS NULL;
-- `IF NOT EXISTS` (added below) makes the in-migration CREATE INDEX a no-op
-- against a database that already has it, while fresh dev and CI databases
-- pick it up on first migrate. Same shape as 0068, 0070, 0074, 0080, 0139,
-- 0144, 0148, 0154, 0163.

CREATE TABLE "wxyc_schema"."rotation_cards" (
	"id" serial PRIMARY KEY NOT NULL,
	"bin" "freq_enum" NOT NULL,
	"number" integer NOT NULL,
	"name" text
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."rotation_urls" (
	"id" serial PRIMARY KEY NOT NULL,
	"rotation_id" integer NOT NULL,
	"url" text NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."rotation" ADD COLUMN "card_id" integer;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."rotation_urls" ADD CONSTRAINT "rotation_urls_rotation_id_rotation_id_fk" FOREIGN KEY ("rotation_id") REFERENCES "wxyc_schema"."rotation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rotation_cards_bin_number_idx" ON "wxyc_schema"."rotation_cards" USING btree ("bin","number");--> statement-breakpoint
CREATE INDEX "rotation_urls_rotation_id_idx" ON "wxyc_schema"."rotation_urls" USING btree ("rotation_id");--> statement-breakpoint
ALTER TABLE "wxyc_schema"."rotation" ADD CONSTRAINT "rotation_card_id_rotation_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "wxyc_schema"."rotation_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rotation_card_id_idx" ON "wxyc_schema"."rotation" USING btree ("card_id") WHERE "wxyc_schema"."rotation"."kill_date" IS NULL;