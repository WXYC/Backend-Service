-- BS#1467 (Epic F pattern, applied to the catalog) — single-row watermark for
-- the catalog conditional-GET path. Companion to 0084's `flowsheet_watermark`;
-- the freshness source the bulk-export endpoint (#1466 child 2) gates 304s on.
--
-- `library_watermark` — single-row sibling table with one `last_modified_at`
-- column, touched by an AFTER INSERT/UPDATE/DELETE STATEMENT trigger on
-- `library`. This is the source `library.service.getCatalogLastModifiedAt()`
-- reads. A DB trigger (not an app-level watermark) is mandatory because the
-- catalog's primary writer — the `jobs/library-etl/` daily sync — writes
-- straight to Postgres, bypassing the BS app layer entirely; an app-level
-- `updateLastModified()` would silently miss every ETL write (the #1106 bypass
-- failure mode). **DELETE matters** for the same reason it does on flowsheet:
-- a `MAX(library.last_modified)` read would retreat when the row holding the
-- MAX is deleted, so a polling client would 304 against a stale baseline and
-- miss the deletion. The sibling row only ever moves forward.
--
-- WATERMARK FORMULA — deliberate divergence from 0084 (read before copying):
-- this trigger uses `GREATEST(now(), last_modified_at)`, dropping 0084's
-- `+ interval '1 second'` floor. Postgres `now()` is `transaction_timestamp()`,
-- frozen at transaction start. The library writer runs its entire per-row loop
-- inside a single transaction (`jobs/library-etl/job.ts`), so with a `+1s`
-- floor each of the N library-mutating statements would force a +1s advance
-- while `now()` stays frozen — landing the watermark at `T_start + (N-1)s`,
-- N seconds in the FUTURE. On a re-seed / big-change day (~50k rows), amplified
-- by the 0060 artist-name cascade, that (a) emits a future `Last-Modified`
-- (RFC 9110 SHOULD-NOT; iOS conditional-GET against a future date is undefined,
-- realistically spurious 200s that re-download the whole catalog) and (b)
-- breaks daily self-heal once drift exceeds the inter-sync interval — the
-- drift-forward half of #1106. `GREATEST(now(), last_modified_at)` is monotonic
-- and correct under both write shapes: in a frozen-`now()` transaction it pins
-- the watermark at `T_start` regardless of statement count; under autocommit it
-- tracks wall clock; it never retreats on clock skew. The only property given
-- up is same-wall-clock-second disambiguation between two SEPARATE catalog
-- transactions — vanishingly unlikely for a once-daily ETL feeding a once-daily
-- poller, and self-correcting on the next write. (0084's `+1s` stays correct
-- for flowsheet, a high-frequency, human-paced writer with ~1 Hz pollers — this
-- is a per-table decision, not a blanket convention.)
--
-- @no-analyze-needed: the only `UPDATE` in this migration lives inside the
-- `touch_library_watermark` trigger function and targets the single-row
-- `library_watermark` table. A one-row table has no planner-stats surface area
-- to drift. The trigger fires per statement on `library`, but each invocation
-- rewrites the same one row — no bulk-UPDATE cost, no `ANALYZE` need.
--
-- @no-precondition-needed: `library_watermark` is a fresh CREATE TABLE. The
-- `library_watermark_singleton` CHECK (`"id" = true`) is trivially satisfied by
-- the single seed row inserted below (`id = true`), and the NOT NULL columns
-- both carry defaults. No existing data to violate either constraint.

CREATE TABLE "wxyc_schema"."library_watermark" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"last_modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_watermark_singleton" CHECK ("id" = true)
);--> statement-breakpoint
INSERT INTO "wxyc_schema"."library_watermark" ("id", "last_modified_at") VALUES (true, now()) ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE OR REPLACE FUNCTION wxyc_schema.touch_library_watermark() RETURNS trigger AS $$
BEGIN
  UPDATE wxyc_schema.library_watermark
  SET last_modified_at = GREATEST(now(), last_modified_at)   -- monotonic; NO +1s floor (see header)
  WHERE id = true;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER touch_library_watermark
AFTER INSERT OR UPDATE OR DELETE ON wxyc_schema.library
FOR EACH STATEMENT
EXECUTE FUNCTION wxyc_schema.touch_library_watermark();
