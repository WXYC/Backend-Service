-- BS#2052 — narrow the `library` watermark trigger from an unqualified
-- `UPDATE` to `UPDATE OF <exported columns>`.
--
-- Migration 0104 (#1467) attached `touch_library_watermark()` to
-- `wxyc_schema.library` as `AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ...
-- FOR EACH STATEMENT`, with an unqualified `UPDATE`. That means the
-- catalog-export watermark advances on ANY statement that mentions the table in
-- its SET clause, including columns no catalog export ever reads. The observed
-- consequence: `jobs/library-identity-consumer` stamps
-- `library.unresolved_attempted_at` once per batch as an internal drain
-- marker (docs/migrations.md's "Attempt-at markers" section) — a genuine
-- `NOW()` row change, not a filterable no-op — so every `--recheck` sweep bumps
-- `library_watermark` and busts every client's conditional GET for a change no
-- export surfaces. Documented as a permanent residual when #1990/#1991 shipped;
-- this migration is the fix those PRs deferred (#2041 review, option b).
--
-- COLUMN-SET DERIVATION — read the export queries, not the table definition.
-- The two HTTP surfaces gated on `library_watermark` (both via
-- `conditionalGet(getCatalogLastModifiedAt)` in
-- `apps/backend/routes/library.route.ts`) are `GET /library/catalog` and its
-- sibling `GET /library/catalog/compilation-tracks`, both served from
-- `apps/backend/services/catalog-export.service.ts`:
--
--   - `getCatalogExportRows()` — the `CatalogExportRow` projection
--   - `getCompilationTrackExportRows()` — the `CompilationTrackExportRow`
--     projection, which reaches `library` only via a join to resolve
--     `legacy_release_id` and the same eligibility joins as the row above
--
-- Every `library.<column>` token appearing in either query text was enumerated
-- — both columns projected directly into the response AND columns used only as
-- join keys, because a join-key change (e.g. `artist_id`) changes which joined
-- row's fields the export ships even though the key itself is never
-- serialized. That gives 14 columns:
--
--   id                      -- CatalogExportRow.id; join key for rotation /
--                              album_plays / album_popularity
--   legacy_release_id       -- CatalogExportRow.legacy_release_id; CTA export
--                              join key back to `library`
--   artist_id               -- join key: artists / genre_artist_crossreference
--                              / artist_aliases (drives artist_name,
--                              code_letters, cross_reference_names)
--   genre_id                -- join key: genres / genre_artist_crossreference
--                              (drives genre_name, code_artist_number)
--   format_id               -- join key: format (drives format_name)
--   alternate_artist_name   -- CatalogExportRow.alternate_artist_name
--   album_artist             -- CatalogExportRow.album_artist
--   album_title              -- CatalogExportRow.album_title
--   label                    -- CatalogExportRow.label
--   code_number              -- CatalogExportRow.code_number
--   on_streaming             -- CatalogExportRow.on_streaming
--   artwork_url               -- CatalogExportRow.artwork_url
--   artist_name               -- COALESCEd into CatalogExportRow.artist_name
--   canonical_entity_id       -- join key into album_popularity via
--                                logicalAlbumKeySql(); drives
--                                CatalogExportRow.popularity
--
-- Columns that exist on `library` but are deliberately EXCLUDED because the
-- export queries never read them: `label_id` (the export reads the raw
-- `library.label` text column, not the `label_id` FK — see
-- `catalog-export.service.ts`'s docstring on the label source), `plays` (a
-- dead counter nothing maintains; the export uses the `album_plays` materialized
-- view instead, per the same docstring), `code_volume_letters`, `disc_quantity`,
-- `add_date`, `last_modified`, `date_lost`, `date_found`,
-- `canonical_entity_confidence`, `canonical_entity_resolved_at`,
-- `unresolved_attempted_at` (the column this migration exists to stop
-- triggering on), `discogs_unavailable`, `discogs_unavailable_note`,
-- `last_discogs_recheck_at`, and the generated `search_doc` (explicitly dropped
-- from the export per the `CatalogExportRow` docstring).
--
-- OBLIGATION: this list is a snapshot of the export query's read set, not a
-- derived view of it. Any future column added to `CatalogExportRow`,
-- `CompilationTrackExportRow`, or a new join key either query starts using MUST
-- be added to the `UPDATE OF` list below in the same PR, or writes to it join
-- the same silent-and-unbounded failure mode 0138's header warned about for a
-- table missing the trigger entirely: the write lands, changes what the next
-- export would show, but never advances the watermark to make that export
-- happen.
--
-- INSERT / DELETE / TRUNCATE stay unqualified — Postgres does not support an
-- `OF <columns>` qualifier on those event types, and 0104's header already
-- established why they must all advance the watermark unconditionally (a
-- deleted or truncated row can retreat what a naive `MAX(library.last_modified)`
-- read would show).
--
-- Reuses `wxyc_schema.touch_library_watermark()` VERBATIM (defined in 0104) —
-- same single-row `library_watermark` UPDATE, same monotonic
-- `GREATEST(now(), last_modified_at)` advance, same O(1) per-statement cost. Do
-- NOT redefine the function here. No schema objects change, so `drizzle:generate`
-- produces no diff and this is a `--custom` migration whose snapshot is
-- byte-identical to 0140's apart from the id/prevId chain link (mirrors 0114 /
-- 0105's precedent for a trigger-only migration).
--
-- Idempotent: `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER` (`CREATE TRIGGER`
-- itself is not idempotent) so a re-apply, or a fresh dev DB that already has
-- 0104 applied, is a no-op followed by the narrowed definition landing cleanly.
--
-- SCOPE: this migration touches ONLY the `library` trigger. Migration 0138
-- reuses `touch_library_watermark()` verbatim for two more triggers, on
-- `artist_crossreference` and `compilation_track_artist` — both are
-- deliberately left unqualified here. See the PR description for the explicit
-- assessment of whether they share this over-firing exposure.
--
-- @no-analyze-needed: no UPDATE on a stats-bearing table — the only write is the
-- one-row `library_watermark` UPDATE inside the reused trigger function.
-- @no-precondition-needed: trigger DDL only; no constraint, no data invariant.

DROP TRIGGER IF EXISTS touch_library_watermark ON wxyc_schema.library;--> statement-breakpoint
CREATE TRIGGER touch_library_watermark
AFTER INSERT OR UPDATE OF
  id,
  legacy_release_id,
  artist_id,
  genre_id,
  format_id,
  alternate_artist_name,
  album_artist,
  album_title,
  label,
  code_number,
  on_streaming,
  artwork_url,
  artist_name,
  canonical_entity_id
  OR DELETE OR TRUNCATE ON wxyc_schema.library
FOR EACH STATEMENT
EXECUTE FUNCTION wxyc_schema.touch_library_watermark();
