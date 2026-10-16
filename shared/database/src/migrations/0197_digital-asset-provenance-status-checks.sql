-- BS#2439 -- CHECK constraints on `digital_asset.provenance` and
-- `digital_asset.status`, added while the table is empty.
--
-- WHAT THEY DEFEND. `provenance` was bare `text`, and
-- `digital-archive.service.ts` casts it straight into a closed client enum, so
-- a stray value would reach iOS and decode to `.unknownDefaultOpenApi`.
-- `status` was safe only because `csv.ts` happens to filter to two literals; a
-- typo'd value would hide a row from `has_digital_audio`, from the playback
-- manifest, and from the `WHERE status = 'needs_review'` guard that makes the
-- bind job's re-import idempotent -- the last of which silently breaks
-- idempotency for that row rather than just hiding it.
--
-- WHY NOW. Both tables hold zero rows, so the constraints cannot be violated
-- by existing data. After the ~4,500-row bind lands, adding them needs a data
-- audit first and any offending row blocks the migration.
--
-- SOURCES OF THE VALUE SETS.
--   provenance: `DigitalArchivePlaybackTrack.provenance` enum in
--     `apps/backend/app.yaml` (this repo's copy of the wxyc-shared api.yaml
--     contract): `rotation_upload`, `cd_rip` (reserved by ADR 0014).
--   status: the bind job's state machine -- `needs_review` (written by the
--     bind job), `bound` and `rejected` (written by `csv.ts` on import).
--
-- WIDENING LATER. The vocabulary is now closed on purpose: the CD-rip phase's
-- statuses (`pulled`, `ripped`, `exception`) and any new provenance each need
-- a migration that drops and re-adds the constraint. That is the intended
-- cost -- it is the review point at which the client enum is updated too.
--
-- Mirrored in `shared/database/src/schema.ts` so `drizzle:generate` does not
-- propose dropping them.

-- Precondition guard (issue #705): the table is empty today, but if a row with
-- an out-of-vocabulary value exists by the time this applies, fail with a
-- readable message instead of an opaque check_violation mid-ALTER.
DO $$
DECLARE bad_count int;
BEGIN
  SELECT COUNT(*) INTO bad_count
    FROM wxyc_schema.digital_asset
   WHERE provenance NOT IN ('rotation_upload', 'cd_rip')
      OR status NOT IN ('needs_review', 'bound', 'rejected');
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'Cannot apply digital_asset provenance/status CHECKs: % digital_asset rows hold a value outside the closed vocabularies. Audit and correct them first.', bad_count;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."digital_asset" ADD CONSTRAINT "digital_asset_provenance_ck" CHECK ("wxyc_schema"."digital_asset"."provenance" IN ('rotation_upload', 'cd_rip'));--> statement-breakpoint
ALTER TABLE "wxyc_schema"."digital_asset" ADD CONSTRAINT "digital_asset_status_ck" CHECK ("wxyc_schema"."digital_asset"."status" IN ('needs_review', 'bound', 'rejected'));
