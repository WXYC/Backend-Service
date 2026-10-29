-- 0208 (BS#3733): add library.alternate_artist_name to library.search_doc, at
-- weight C, behind its own position gap.
--
-- The station librarian filed a CD under Kath Bloom with the alternate artist
-- name `kath bloom & david Shapiro`, and classic catalog search for `shapiro`
-- did not return it. Stage 1 of Both-mode search (`searchLibraryByTsvector`)
-- is a prefix tsquery over this column, which indexed only `artist_name` (A)
-- and `album_title` (B). The only other route to an alternate name is the
-- `artist_search_alias` path, and it cannot reach this case: it scores the
-- whole credit with pg_trgm (`shapiro` against `Kath Bloom & David Shapiro`
-- is 0.32, under its 0.40 floor), the #3554 splitter splits on commas only,
-- and the daily job can take up to 7 days to pick a new name up. /wxycdb's
-- Lucene index put every word of the alternate name into the release's
-- tokenized contents when the release was saved, and that is what the
-- librarian expects. Because the column is generated, a release is now
-- findable by any word of its alternate name as soon as it is saved or
-- edited. The alias path is unchanged and still adds the owning artist's card.
--
-- WEIGHT C keeps an alternate-name-only hit below an artist-name or title hit
-- on the same word: `ts_rank` weights C at 0.2 against A's 1.0 and B's 0.4.
-- `match_tier` (an exact whole-lexeme hit above a prefix-only one) still sorts
-- first, as it already does for title hits. BS#871 plans to add `label` to this
-- column; whichever of the two lands second chooses its weight relative to the
-- other and rebases.
--
-- THE SECOND GAP. Migration 0178's header explains the mechanism: a sentinel
-- concatenated between two segments buys a position shift, and `ts_delete`
-- removes the sentinel without renumbering the survivors. The new segment gets
-- its own gap for the same reason the title got one: without it the title's
-- last lexeme and the alternate name's first are adjacent, and a phrase query
-- (which `to_tsquery` builds from an apostrophe or hyphen token) matches across
-- the seam. With it, `Cold Krush Cuts` / `DJ Krush & Coldcut` stores
-- `'cuts':8B` and `'dj':1A,12C`, a distance of 4. On the 64,193-row production
-- clone, zero rows contain the sentinel in `alternate_artist_name` either, so
-- 0178's sentinel-collision note still holds.
--
-- WHY DROP-AND-RE-ADD, and every other deviation from drizzle-kit's output,
-- is as 0178's header records it. Postgres cannot change a generated column's
-- expression in place before PG 17, and prod RDS is PG 14. `DROP COLUMN` takes
-- `library_search_doc_idx` with it, so the CREATE INDEX is hand-added and not
-- optional. The lock and statement timeouts and the IF EXISTS / IF NOT EXISTS
-- guards are hand-added too; the guards make every partial-apply state
-- re-runnable (the generated-column exception in docs/migrations.md's
-- `if-not-exists-index` rule). The index is not built CONCURRENTLY, because
-- `migrate()` runs inside a transaction and the DROP destroys the index in that
-- same transaction, so there is nothing ops could pre-build.
--
-- LOCK BUDGET. Measured on the full 64,193-row clone (PG 18.6, three runs,
-- each in a rolled-back transaction): DROP COLUMN about 1 ms, the ADD COLUMN
-- rewrite 1,061-1,213 ms, CREATE INDEX 115-148 ms, ANALYZE 450-509 ms. The same
-- statements with 0178's two-segment expression took 994-1,103 ms for the
-- rewrite and 125-144 ms for the index on the same clone. The GIN index grows
-- 3,944 kB -> 4,096 kB on a fresh build, from 4,844 alternate names. As in
-- 0178, `migrate()` applies every pending migration in ONE transaction, so the
-- ACCESS EXCLUSIVE lock DROP COLUMN takes on `library` is held until the whole
-- batch commits. This migration must therefore deploy with no other migration
-- pending, during a quiet hour. The timeouts bound the wait for the lock and
-- the rewrite, so contention fails the deploy with a clear error instead of
-- wedging it. This is the same knowing exception to the `ddl-only` rule that
-- 0065 and 0178 took.
--
-- Re-checked on the schema at 0207: no view or materialized view depends on
-- library.search_doc (pg_depend/pg_rewrite: 0 rows; `library_artist_view` and
-- `rotation_library_view` read `library` but not this column), so the DROP
-- needs no CASCADE. The only dependents are the column's own generation
-- expression and `library_search_doc_idx`. The column's attnum moves from 31
-- to the end of the table. `restoreCatalogDeleteSnapshot` replays exactly the
-- keys `captureCatalogDeleteSnapshot` stored, and capture skips generated
-- columns (`!column.generated`), so the move has no effect there and a restored
-- row gets the new vector on insert.
--
-- The trailing ANALYZE is required: a table rewrite discards the column's
-- pg_stats row and bumps no counters, so autoanalyze never repairs it (0150 and
-- 0178 record the same hazard), and the catalog search could fall back to a
-- bitmap-heap or sequential scan in front of on-air DJs (the BS#934 shape).

SET LOCAL lock_timeout = '30s';--> statement-breakpoint
SET LOCAL statement_timeout = '10min';--> statement-breakpoint

ALTER TABLE "wxyc_schema"."library" DROP COLUMN IF EXISTS "search_doc";--> statement-breakpoint

ALTER TABLE "wxyc_schema"."library"
  ADD COLUMN "search_doc" tsvector
  GENERATED ALWAYS AS (
    ts_delete(
      setweight(to_tsvector('simple', coalesce("artist_name", '')), 'A')
      || to_tsvector('simple', 'wxycsearchdocgap wxycsearchdocgap wxycsearchdocgap')
      || setweight(to_tsvector('simple', coalesce("album_title", '')), 'B')
      || to_tsvector('simple', 'wxycsearchdocgap wxycsearchdocgap wxycsearchdocgap')
      || setweight(to_tsvector('simple', coalesce("alternate_artist_name", '')), 'C'),
      'wxycsearchdocgap'
    )
  ) STORED;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "library_search_doc_idx"
  ON "wxyc_schema"."library" USING gin ("search_doc");--> statement-breakpoint

ANALYZE "wxyc_schema"."library";
