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
-- than an array column, keyed on rotation_id + position and unique on that
-- pair — one URL per slot, so `ORDER BY position` is deterministic and a
-- stale-read `max(position)+1` writer collides instead of silently landing
-- a duplicate slot. The unique index's leading column also serves the
-- FK-lookup role, so there is no separate rotation_id index.
-- rotation.card_id: nullable FK -> rotation_cards.id, ON DELETE SET NULL —
-- card deletion (#2472) is refused only while ACTIVE rows reference the
-- card, but killed rows keep their reference forever, so NO ACTION would
-- make every once-used card undeletable at the SQL level; the epic decided
-- killed rows may be uncarded (the UI shows — for uncarded), so deleting a
-- card unfiles its killed rows. Consistency between the row's rotation_bin
-- and the referenced card's bin is a service-layer rule (same decision as
-- card-number contiguity above), not a composite FK. Partial-indexed on the
-- active set (`kill_date IS NULL`) — the cards listing's per-card active
-- count and the admin list's card filter both query only active rows,
-- against the whole rotation history.
--
-- Lock behavior: the ADD COLUMN on `rotation` takes an AccessExclusiveLock,
-- and Postgres holds it to COMMIT — which, per docs/migrations.md's
-- `single-transaction-migrate` rule, is the end of the deploy's WHOLE
-- pending-migration batch, not of this file. From that statement on, reads
-- AND writes of `rotation` block. The ADD COLUMN itself is metadata-only
-- (nullable, no default, no rewrite); the hold's duration is governed by
-- what runs after it inside the transaction, dominated by the two
-- O(rotation-rows) passes below — the card_id FK's validation scan and the
-- partial-index build. Expected duration: sub-second to low seconds at
-- rotation's scale (the FK scan measures ~100 ms per 3M cached rows on
-- PG14), longer if other migrations are pending in the same batch.
-- CREATE TABLE and the constraints on the two freshly-created empty tables
-- are metadata-only.
--
-- The card_id FK's ADD CONSTRAINT runs its initial validation as a full seq
-- scan of `rotation` even though the column is all-NULL — the scan happens
-- and reads every row; the all-NULL property makes the *match set* empty
-- (no row can violate, so the migration cannot abort), not the scan free.
--
-- @no-precondition-needed: rotation_cards_bin_number_idx,
-- rotation_urls_rotation_id_position_idx, and both new FK constraints
-- (rotation_urls.rotation_id, rotation.card_id) validate against either a
-- freshly-created empty table or an all-NULL new column, so no existing row
-- can violate any of them (safe means an empty match set, not a skipped
-- scan — see above).
--
-- The rotation_card_id_idx partial index below is built on `rotation`, an
-- existing table with real rows — a full scan plus sort, not metadata-only.
-- NOT the CONCURRENTLY form, because migrations run inside a transaction
-- (`CREATE INDEX CONCURRENTLY cannot run inside a transaction block`) —
-- same constraint as 0057, 0068, 0070, 0074, 0078, 0080, 0139, 0144, 0148,
-- 0154, 0163. If this deploy lands mid-show, pre-build it out of band
-- first:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "rotation_card_id_idx"
--     ON "wxyc_schema"."rotation" USING btree ("card_id")
--     WHERE "wxyc_schema"."rotation"."kill_date" IS NULL;
-- Pre-building removes the largest single contributor to the transaction's
-- hold on `rotation`, but — unlike the index-only siblings above — it does
-- NOT make readers safe here: the ADD COLUMN's AccessExclusiveLock (see
-- lock behavior above) still blocks rotation reads for the rest of the
-- transaction. `IF NOT EXISTS` (added below) makes the in-migration CREATE
-- INDEX a no-op against a database that already has it, while fresh dev and
-- CI databases pick it up on first migrate. Same shape as 0068, 0070, 0074,
-- 0080, 0139, 0144, 0148, 0154, 0163.
--
-- Wire note: addRotation and updateRotation return unprojected .returning()
-- rows and the rotation CDC trigger (0046) serializes to_jsonb(NEW), so
-- POST /library/rotation and PATCH /library/rotation/:id responses (and
-- every rotation CDC frame) gain `card_id` (as NULL) the moment this
-- applies — additive, accepted, same call as 0162's format_id/label_id;
-- spec updates ride the epic's consuming endpoint PRs (dj-site#1480 B2/B3).

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
CREATE UNIQUE INDEX "rotation_urls_rotation_id_position_idx" ON "wxyc_schema"."rotation_urls" USING btree ("rotation_id","position");--> statement-breakpoint
ALTER TABLE "wxyc_schema"."rotation" ADD CONSTRAINT "rotation_card_id_rotation_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "wxyc_schema"."rotation_cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rotation_card_id_idx" ON "wxyc_schema"."rotation" USING btree ("card_id") WHERE "wxyc_schema"."rotation"."kill_date" IS NULL;