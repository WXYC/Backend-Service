-- 0178 (BS#2714): give library.search_doc a position gap between its two segments.
--
-- `tsvector || tsvector` shifts the right operand's positions to continue from
-- the left's with NO gap, so the album title's first lexeme sits directly
-- adjacent to the artist name's last one and a phrase query can match across
-- the field boundary. On PG 18:
--
--   setweight(to_tsvector('simple','Todd Rundgren'),'A') || setweight(to_tsvector('simple','Angel Hair'),'B')
--   -> 'angel':3B 'hair':4B 'rundgren':2A 'todd':1A
--
-- `rundgren` at 2 and `angel` at 3 are adjacent, so `'rundgren' <-> 'angel'`
-- matches a document where those words are in different fields and were never
-- adjacent in any real text.
--
-- Measured on a 64,193-row production clone: `'d':* <-> 'a':*` -- what
-- `to_tsquery` makes of a `d'a` prefix token -- matched 760 rows, of which 184
-- straddled the seam (`Amor Belhom Duo / Amor Belhom Duo`, `It's a Beautiful
-- Day / At Carnegie Hall`, `PM Dawn / A Watcher's Point Of View 12"`,
-- `Deerhoof / Apple O'`). After this migration the same query matches 576, and
-- 0 cross-boundary. Within-field phrase matching is unchanged (`'todd' <->
-- 'rundgren'`: 17 rows before and after), as is every prefix of a hyphenated
-- compound (all 20 prefixes of `chuquimamani-condori`: identical counts).
--
-- The defect is in the generated column, not in any reader. A reader can only
-- expose it -- and one is about to: BS#670's prefix builder necessarily emits
-- prefix-phrase queries, because `to_tsquery` re-lexes a quoted hyphenated
-- token into an adjacency chain (`'chuquimamani-cond':*` becomes
-- `'chuquimamani-cond':* <-> 'chuquimamani':* <-> 'cond':*`). That adjacency is
-- wanted -- it anchors the compound inside one field -- and cannot be
-- sanitized away without breaking `Chuquimamani-Condori`. So the gap is a
-- prerequisite for that work rather than defense in depth.
--
-- HOW THE GAP IS BOUGHT. There is no position-offset function in core
-- Postgres, and `|| to_tsvector('simple','')` does NOT work -- an empty
-- tsvector contributes no positions and shifts nothing. So a sentinel buys the
-- shift and `ts_delete` then removes it: `ts_delete` deletes a lexeme's entry
-- WITHOUT renumbering the survivors' positions, leaving
-- `'todd':1A 'rundgren':2A 'angel':6B 'hair':7B` -- a cross-seam distance of 4.
--
-- Deleting the sentinel rather than leaving it in place is load-bearing, not
-- tidiness. A sentinel lexeme in the index is prefix-reachable, so `'w':*`
-- would match every row in the catalog. `ts_delete` is IMMUTABLE on both
-- majors (`provolatile = 'i'` on 14.24 and 18.0), so it is legal inside a
-- STORED generated column. Measured consequence: the GIN index grows
-- 3904 kB -> 3944 kB (+1%), from position bytes only -- no new lexemes.
--
-- Width 3 gives a cross-seam distance of 4, so `<->`, `<2>` and `<3>` all
-- fail. Under the 'simple' config there are no stop words, so
-- `websearch_to_tsquery` only ever emits `<->` and width 1 would do; the extra
-- positions are free and cover a future config change or a reader that emits
-- an explicit distance.
--
-- SENTINEL COLLISION. If a library row's artist_name or album_title ever
-- contains the literal token `wxycsearchdocgap`, `ts_delete` strips it from
-- that row's search_doc too. Zero of the 64,193 rows on the production clone
-- do. The failure mode is one dropped lexeme on one row -- benign -- but it is
-- the reason the sentinel is this improbable rather than something short.
--
-- WHY DROP-AND-RE-ADD, AND WHY THE DDL DEVIATES FROM DRIZZLE'S OUTPUT.
-- Postgres does not allow modifying the generation expression of an existing
-- generated column -- migration 0054's header records the same constraint, and
-- 0065 is the precedent for this exact operation on `flowsheet.search_doc`.
-- `ALTER TABLE ... ALTER COLUMN ... SET EXPRESSION AS` would avoid the
-- drop, but it is PG17+ and prod RDS is 14.22; verified rejected on 14.24 with
-- `syntax error at or near "EXPRESSION"`, which the `migrate-dryrun` job
-- (the one that restores a real RDS snapshot) is where it would have surfaced.
--
-- Drizzle-kit generated the DROP/ADD pair but NOT the index recreation, and
-- `DROP COLUMN` takes `library_search_doc_idx` with it -- so the CREATE INDEX
-- below is hand-added and is not optional. Following 0065, this file also
-- hand-adds the lock/statement timeouts and the IF EXISTS / IF NOT EXISTS
-- idempotency guards described next.
--
-- Idempotent against any partial-apply state:
--   - DROP COLUMN IF EXISTS handles the column already being gone (a prior
--     partial apply that got past the drop and failed later).
--   - ADD COLUMN can be unconditional because the previous statement
--     guarantees the column does not exist at this point.
--   - CREATE INDEX IF NOT EXISTS handles the index already having been rebuilt.
-- This is a sanctioned exception to the `if-not-exists-index` rule's "don't add
-- IF NOT EXISTS to other DDL" clause; see that rule in docs/migrations.md,
-- which this change amends to name the generated-column case.
--
-- The CREATE INDEX is deliberately NOT CONCURRENTLY: `migrate()` wraps every
-- pending migration in one transaction and CONCURRENTLY cannot run inside a
-- transaction block. The rule's usual escape -- have ops pre-build the index
-- CONCURRENTLY out of band so the migration finds it already there -- does not
-- apply here, because the DROP COLUMN above destroys the index in the same
-- transaction. There is nothing to pre-build, so the IF NOT EXISTS is purely
-- partial-apply idempotency rather than prod pre-prep.
--
-- LOCK BUDGET. Measured on the full 64,193-row / 47 MB clone inside a
-- rolled-back transaction: DROP COLUMN 5 ms (metadata-only), the ADD COLUMN
-- rewrite 1,358 ms, CREATE INDEX 349 ms -- about 1.71 s of statements. But
-- `migrate()` applies every pending migration in ONE transaction, so the
-- ACCESS EXCLUSIVE lock that DROP COLUMN takes on `library` is held until the
-- whole batch commits, not for those 1.71 s. This migration should therefore
-- land in a deploy with nothing else pending, and the timeouts below bound the
-- wait to acquire the lock and cap the rewrite so contention surfaces as a
-- clear error rather than a wedged deploy (the behaviour 0056/#524 built).
-- Apply during a low-traffic window. This is a knowing exception to the
-- `ddl-only` rule, the same one 0065 took and for the same reason.
--
-- No view or materialized view depends on library.search_doc -- checked via
-- pg_depend/pg_rewrite (0 rows); `library_artist_view` does not reference it --
-- so the DROP needs no CASCADE and nothing has to be recreated afterwards.
-- The column's attnum moves from 22 to 31. The only writer that inserts whole
-- library rows, `restoreCatalogDeleteSnapshot`, is key-matched via
-- `jsonb_populate_recordset` with an explicit column list that omits generated
-- columns, so the reordering is inert.
--
-- The trailing ANALYZE is required. A table rewrite discards the column's
-- pg_stats row and bumps no counters, so autoanalyze never repairs it -- 0150's
-- header records the same hazard for ALTER COLUMN ... TYPE. Without it the
-- catalog search can revert to a bitmap-heap or sequential scan, which is the
-- BS#934 regression shape in front of on-air DJs.

SET LOCAL lock_timeout = '30s';--> statement-breakpoint
SET LOCAL statement_timeout = '10min';--> statement-breakpoint

ALTER TABLE "wxyc_schema"."library" DROP COLUMN IF EXISTS "search_doc";--> statement-breakpoint

ALTER TABLE "wxyc_schema"."library"
  ADD COLUMN "search_doc" tsvector
  GENERATED ALWAYS AS (
    ts_delete(
      setweight(to_tsvector('simple', coalesce("artist_name", '')), 'A')
      || to_tsvector('simple', 'wxycsearchdocgap wxycsearchdocgap wxycsearchdocgap')
      || setweight(to_tsvector('simple', coalesce("album_title", '')), 'B'),
      'wxycsearchdocgap'
    )
  ) STORED;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "library_search_doc_idx"
  ON "wxyc_schema"."library" USING gin ("search_doc");--> statement-breakpoint

ANALYZE "wxyc_schema"."library";
