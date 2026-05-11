/**
 * Writer for the library-identity-consumer (BS#802).
 *
 * Post-#800 pivot: LML composes; Backend writes. For each `BulkResolveResult`
 * we open a `db.transaction()` and atomically:
 *   1. SELECT … FOR UPDATE on the main row (defense-in-depth lock; no-op on
 *      first-insert — the real serialisation is `ON CONFLICT (library_id)`).
 *   2. UPSERT one row per `provenance` entry into `library_identity_source`
 *      with `ON CONFLICT (library_id, source) DO UPDATE`.
 *   3. UPSERT the denormalised main row into `library_identity` with
 *      `ON CONFLICT (library_id) DO UPDATE`. The (method, confidence) and
 *      `agreement_sources` on the main row come straight from LML — Backend
 *      no longer composes them.
 *
 * Provenance rows with `confidence === null` are skipped: the substrate
 * check constraint requires `confidence BETWEEN 0 AND 1` and NOT NULL.
 * Per the LML contract this only happens when `external_id` is also null,
 * which corresponds to a provenance entry that contributes signal but no
 * concrete external id — Backend has nowhere to store that today.
 *
 * The `kind: 'unresolved'` case writes nothing (the orchestrator counts it
 * separately). The `kind: 'compilation'` case is deferred to BS#801; the
 * orchestrator counts it as `rows_skipped` before reaching the writer.
 *
 * MAIN-ROW COLUMN GAP
 * ===================
 * LML's `ReconciledIdentity` carries six artist-level external IDs:
 * `discogs_artist_id`, `musicbrainz_artist_id`, `wikidata_qid`,
 * `spotify_artist_id`, `apple_music_artist_id`, `bandcamp_id`. Only three
 * (wikidata, spotify, apple_music) have main-row destinations on
 * `library_identity` today — the rest are release/recording-level columns.
 *
 * The artist-level IDs without a main-row column are NOT lost: each LML
 * provenance entry's `external_id` (text) carries the per-source id
 * verbatim into `library_identity_source`. The main row is therefore a
 * partial denormalised view of the per-source rows until a follow-up
 * migration adds artist-id columns. Mapping is called out in the BS#802
 * PR body so the reviewer can land a migration in a separate PR.
 */

import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';

import type { BulkResolveResult, ReconciledIdentity } from './lml-types.js';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const LIBRARY_IDENTITY_TABLE = sql.raw(`"${SCHEMA}"."library_identity"`);
const LIBRARY_IDENTITY_SOURCE_TABLE = sql.raw(`"${SCHEMA}"."library_identity_source"`);

/**
 * Write categories the orchestrator counts. `unresolved` and `compilation`
 * are handled before this function is called; this function returns the
 * disposition for `single_artist` only (success/error are signalled by
 * throwing or completing).
 */
export type WriteOutcome = {
  source_rows_written: number;
  source_rows_skipped_null_confidence: number;
};

/**
 * Project the LML main payload onto `library_identity` columns. The
 * artist-id columns without main-row destinations (discogs_artist_id,
 * musicbrainz_artist_id, bandcamp_id) are dropped from the main row but
 * preserved in provenance — see the file header for the rationale and
 * follow-up migration plan.
 */
type MainRowFields = {
  discogs_master_id: number | null;
  discogs_release_id: number | null;
  musicbrainz_release_group_mbid: string | null;
  musicbrainz_release_mbid: string | null;
  musicbrainz_recording_mbid: string | null;
  wikidata_qid: string | null;
  spotify_id: string | null;
  apple_music_id: string | null;
};

export const projectMainRow = (main: ReconciledIdentity): MainRowFields => ({
  // Release/recording-level columns: not in the LML contract today. Per the
  // BS#800 pivot, these are LML's to compose if/when it surfaces them.
  discogs_master_id: null,
  discogs_release_id: null,
  musicbrainz_release_group_mbid: null,
  musicbrainz_release_mbid: null,
  musicbrainz_recording_mbid: null,
  // Artist-level columns that have a destination on library_identity.
  wikidata_qid: main.wikidata_qid ?? null,
  spotify_id: main.spotify_artist_id ?? null,
  apple_music_id: main.apple_music_artist_id ?? null,
  // discogs_artist_id, musicbrainz_artist_id, bandcamp_id: no main-row
  // destination on library_identity yet — carried by provenance rows
  // only. Follow-up migration tracked in the BS#802 PR body.
});

/**
 * Write the verdict for a single library_id atomically.
 *
 * Returns the per-row counts the orchestrator accumulates. For
 * `kind: 'single_artist'`, both per-source rows and main row land in one
 * transaction; rollback on any error leaves the database untouched.
 *
 * The caller is responsible for only calling this with
 * `kind: 'single_artist'` (the orchestrator dispatches `unresolved` and
 * `compilation` to counters without involving the writer).
 */
export const writeSingleArtist = async (
  result: Extract<BulkResolveResult, { kind: 'single_artist' }>
): Promise<WriteOutcome> => {
  const main = projectMainRow(result.main);
  const lastVerifiedAt = new Date();

  let sourceRowsWritten = 0;
  let sourceRowsSkippedNullConfidence = 0;

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT 1 FROM ${LIBRARY_IDENTITY_TABLE}
      WHERE "library_id" = ${result.library_id}
      FOR UPDATE
    `);

    for (const p of result.provenance) {
      if (p.confidence === null) {
        // The substrate's BETWEEN-NOT-NULL constraint forbids null
        // confidence; LML emits this when external_id is also null, which
        // means the provenance entry contributes no concrete id. Skip
        // rather than violate the constraint.
        sourceRowsSkippedNullConfidence += 1;
        continue;
      }
      await tx.execute(sql`
        INSERT INTO ${LIBRARY_IDENTITY_SOURCE_TABLE} (
          "library_id", "source", "external_id", "method", "confidence",
          "last_verified_at", "boost_sources", "notes"
        ) VALUES (
          ${result.library_id}, ${p.source}, ${p.external_id}, ${p.method}, ${p.confidence},
          ${lastVerifiedAt}, ${null}, ${'consumer:lml-bulk'}
        )
        ON CONFLICT ("library_id", "source") DO UPDATE SET
          "external_id" = EXCLUDED."external_id",
          "method" = EXCLUDED."method",
          "confidence" = EXCLUDED."confidence",
          "last_verified_at" = EXCLUDED."last_verified_at",
          "boost_sources" = EXCLUDED."boost_sources",
          "notes" = EXCLUDED."notes"
      `);
      sourceRowsWritten += 1;
    }

    await tx.execute(sql`
      INSERT INTO ${LIBRARY_IDENTITY_TABLE} (
        "library_id",
        "discogs_master_id", "discogs_release_id",
        "musicbrainz_release_group_mbid", "musicbrainz_release_mbid", "musicbrainz_recording_mbid",
        "wikidata_qid", "spotify_id", "apple_music_id",
        "last_verified_at", "method", "confidence", "agreement_sources", "notes"
      ) VALUES (
        ${result.library_id},
        ${main.discogs_master_id}, ${main.discogs_release_id},
        ${main.musicbrainz_release_group_mbid}, ${main.musicbrainz_release_mbid}, ${main.musicbrainz_recording_mbid},
        ${main.wikidata_qid}, ${main.spotify_id}, ${main.apple_music_id},
        ${lastVerifiedAt}, ${result.method}, ${result.confidence}, ${null}, ${'consumer:lml-bulk'}
      )
      ON CONFLICT ("library_id") DO UPDATE SET
        "discogs_master_id" = EXCLUDED."discogs_master_id",
        "discogs_release_id" = EXCLUDED."discogs_release_id",
        "musicbrainz_release_group_mbid" = EXCLUDED."musicbrainz_release_group_mbid",
        "musicbrainz_release_mbid" = EXCLUDED."musicbrainz_release_mbid",
        "musicbrainz_recording_mbid" = EXCLUDED."musicbrainz_recording_mbid",
        "wikidata_qid" = EXCLUDED."wikidata_qid",
        "spotify_id" = EXCLUDED."spotify_id",
        "apple_music_id" = EXCLUDED."apple_music_id",
        "last_verified_at" = EXCLUDED."last_verified_at",
        "method" = EXCLUDED."method",
        "confidence" = EXCLUDED."confidence",
        "agreement_sources" = EXCLUDED."agreement_sources",
        "notes" = EXCLUDED."notes"
    `);
  });

  return {
    source_rows_written: sourceRowsWritten,
    source_rows_skipped_null_confidence: sourceRowsSkippedNullConfidence,
  };
};
