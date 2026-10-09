-- @no-precondition-needed: no constraint is added. `text_match_key(text)` is an
--   IMMUTABLE PARALLEL SAFE function total over `text` (fold_artist_name
--   coalesces NULL to ''), and `library_text_match_album_idx` is a plain
--   (non-unique) btree on the function's output — neither admits a data
--   invariant that current rows must satisfy.
-- @no-analyze-needed: no UPDATE in this migration. The CREATE INDEX populates
--   index stats during the build; the table's row counts and column stats are
--   unaffected.
--
-- 0191 — `text_match_key(text)` SQL function + functional index on
-- `library.album_title` (BS#3064, part 1 of BS#3057).
--
-- Typed flowsheet plays are linked to the catalog by text. Every writer (the
-- insert path, the edit path, scripts/direct-link-flowsheet.sql) must share one
-- normalization so none can drift; this is it. Every comparison computes both
-- sides inside SQL, so there is deliberately no TypeScript twin.
--
-- Key ladder, each rung a strict coarsening of the one before:
--   lower()  ⊂  fold_artist_name (0134)  ⊂  text_match_key
--   1. fold_artist_name: NFD, strip U+0300–U+036F, lowercase.
--   2. Strip a leading "the " (explicit ASCII whitespace class, as 0092 does).
--   3. Delete every run outside [:alnum:], so punctuation, quotes, dashes and
--      whitespace vanish and only letters and digits remain.
-- The TS-side `relaxedAlbumKey` / `looseTitleKey` keep word boundaries and so
-- sit beside this ladder, not on it. Not folded, by design: `&` vs `and`, and
-- edition suffixes. A symbols-only title (`>>>`, `:)`) keys to '' — callers
-- must guard `<> ''` so '' never matches ''.
--
-- Collation note: `[:alnum:]` (like `lower()` in 0134) is lc_ctype-dependent
-- though catalog-marked IMMUTABLE. Non-Latin letters survive only under a UTF-8
-- lc_ctype, which dev, CI and prod all run. The functional index freezes the
-- lc_ctype at build time; if it ever changes, REINDEX `library_text_match_album_idx`.
--
-- Concurrency: per docs/migrations.md `if-not-exists-index`, the prod runbook is
-- to build the index out-of-band with CREATE INDEX CONCURRENTLY first so this
-- migration is a no-op against the running DB; IF NOT EXISTS lets it apply
-- cleanly in either order. The in-migration form is NOT CONCURRENTLY because
-- migrations run inside one shared transaction (CONCURRENTLY cannot). `library`
-- is ~64k rows, so the in-band build is sub-second regardless.
--
-- Production runbook (run outside any transaction, after the function exists):
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "library_text_match_album_idx" ON "wxyc_schema"."library" USING btree (wxyc_schema.text_match_key("album_title"));

CREATE OR REPLACE FUNCTION wxyc_schema.text_match_key(input text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT regexp_replace(
           regexp_replace(wxyc_schema.fold_artist_name(input), '^the[ \t\n\r\f\v]+', ''),
           '[^[:alnum:]]+', '', 'g');
$$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_text_match_album_idx" ON "wxyc_schema"."library" USING btree (wxyc_schema.text_match_key("album_title"));
