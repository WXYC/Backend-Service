-- Cascade `artists.artist_name` updates onto the denormalized
-- `library.artist_name` column added in 0058 (Epic A.3).
--
-- Synchronous trigger: chosen over an application-side rename path because
-- the artists row is the source of truth, and a forgotten call site would
-- silently drift the search_doc tsvector (whose A-weighted artist_name
-- powers the new catalog search in A.5). Write amplification is modest --
-- the typical artist has fewer than 10 library rows -- and an
-- ACCESS EXCLUSIVE lock is never held since the trigger only updates rows
-- already covered by the originating UPDATE's row-level locks.
--
-- The WHEN guard keeps the trigger inert for UPDATEs that don't touch
-- artist_name (e.g. the artist-identity ETL writing reconciled-identity
-- columns), avoiding redundant library writes and pg_notify CDC fanout.

CREATE OR REPLACE FUNCTION wxyc_schema.cascade_library_artist_name() RETURNS trigger AS $$
BEGIN
  UPDATE wxyc_schema.library
     SET artist_name = NEW.artist_name
   WHERE artist_id = NEW.id
     AND artist_name IS DISTINCT FROM NEW.artist_name;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER cascade_library_artist_name
AFTER UPDATE OF artist_name ON wxyc_schema.artists
FOR EACH ROW
WHEN (OLD.artist_name IS DISTINCT FROM NEW.artist_name)
EXECUTE FUNCTION wxyc_schema.cascade_library_artist_name();
