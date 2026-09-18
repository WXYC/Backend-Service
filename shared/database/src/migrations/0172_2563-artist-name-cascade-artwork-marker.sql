-- 0172 (BS#2563): teach the `cascade_library_artist_name` trigger (migration
-- 0060) to also clear `library.artwork_lookup_attempted_at` on every release
-- a rename cascades to.
--
-- `updateAlbumInDB` clears this marker whenever a `PATCH /library/:id` edit
-- changes `artist_name`, `album_title`, or `artist_id` -- migration 0169's
-- rationale is that a stored "LML has no cover for this" becomes a statement
-- about a release that no longer exists under that name once the pair it was
-- asked about changes. A rename arriving through `PATCH /library/artists/:id`
-- bypasses that path entirely: the trigger rewrites `artist_name` and leaves
-- the marker standing, suppressing re-lookup for the rest of the negative
-- window on every release under the artist. Clearing it here, in the
-- trigger, follows 0060's own reasoning for choosing a trigger over an
-- application-side path in the first place -- the `artists` row is the
-- source of truth, and a forgotten call site would drift silently.
--
-- `CREATE OR REPLACE FUNCTION` only. The trigger definition itself (`AFTER
-- UPDATE OF artist_name ... WHEN (OLD.artist_name IS DISTINCT FROM
-- NEW.artist_name)`) is unchanged and does not need to be re-created -- a
-- trigger always calls the current definition of the function it names.
--
-- @no-precondition-needed: this only changes a function body; it adds no
-- constraint against existing data.
--
-- @no-analyze-needed: this migration rewrites ZERO rows when it is applied.
-- Its only statement is the `CREATE OR REPLACE FUNCTION` below; the `UPDATE
-- wxyc_schema.library` the checker matched is inside that function's
-- dollar-quoted body, and `check-bulk-update-analyze.mjs` scans such bodies
-- the same as top-level DML by design (see its "Limits" note), which is why
-- the annotation is the answer here rather than a rewrite. An `ANALYZE
-- wxyc_schema.library` at the bottom of this file would re-stat a table no
-- row of which this migration touched -- it would silence the check and
-- assert nothing.
--
-- The runtime half, stated so a future reader can check it rather than take
-- it on faith: the trigger's UPDATE is scoped `WHERE artist_id = NEW.id`, one
-- artist's shelf, on a rename an operator performs by hand through `PATCH
-- /library/artists/:id`. It is not a backfill and never sweeps the table.
-- Typical shelves are tens of rows; the known ceiling is 3,107 rows for
-- artist 1087 ('Various Artists'), counted in
-- `apps/backend/controllers/library.controller.ts`. The trigger itself must
-- NOT `ANALYZE`: that would take a ShareUpdateExclusiveLock on `library` and
-- re-sample the whole table inside every rename's transaction. So for the
-- one case where planner-stats drift on `library.artist_name` /
-- `library.search_doc` could plausibly matter -- renaming an artist with a
-- shelf in the thousands -- the remedy is the out-of-band operator ANALYZE
-- that `docs/bulk-update-playbook.md` names as an accepted suppression
-- reason: `ANALYZE wxyc_schema.library;` after the rename.
CREATE OR REPLACE FUNCTION wxyc_schema.cascade_library_artist_name() RETURNS trigger AS $$
BEGIN
  UPDATE wxyc_schema.library
     SET artist_name = NEW.artist_name,
         artwork_lookup_attempted_at = NULL
   WHERE artist_id = NEW.id
     AND artist_name IS DISTINCT FROM NEW.artist_name;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
