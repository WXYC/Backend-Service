/**
 * Source-2 resolver: Backend's mirrored `artists` identity columns
 * (`discogs_artist_id`, `musicbrainz_artist_id`, `wikidata_qid`,
 * `spotify_artist_id`, `apple_music_artist_id`, `bandcamp_id`) →
 * per-source rows for the library-identity-backfill (sub-PR 2.1).
 *
 * The IDs themselves come from Backend's PG (already mirrored from LML by
 * `jobs/artist-identity-etl/`); the `(method, confidence)` for each
 * `(library_name, source)` pair comes from the LML provenance index built
 * at job start. When the index has no entry for a pair (rare hand-edit
 * case), we narrow-fall-back to `alias_match 0.85` and tag the row so
 * post-run audit can detect drift.
 *
 * Within-row cross-source agreement: when ≥2 of the six identity columns
 * are non-null, those sources were resolved together by LML's matcher and
 * refer to the same artist. The resolver emits `agreementSources = [list
 * of populated sources]` so the writer's §3.4.1.1 recompute applies Rule
 * 2 → main-row method becomes `cross_source_agreement` with confidence
 * `MAX(0.95, MIN-of-corroborating-confidences)`.
 *
 * S1 ↔ S2 cross-source agreement (release-level vs artist-level) is
 * deferred to a follow-up — within-row agreement is enough to land
 * 2.1's gate-improving coverage.
 */

import type { SourceRowToWrite } from './resolve.js';
import type { ProvenanceIndex } from './sources/lml-provenance-index.js';

/** Library-row joined to its `artists` row at SELECT time. */
export type LibraryArtistRow = {
  id: number;
  artist_name: string;
  discogs_artist_id: number | null;
  musicbrainz_artist_id: string | null;
  wikidata_qid: string | null;
  spotify_artist_id: string | null;
  apple_music_artist_id: string | null;
  bandcamp_id: string | null;
  /** From `artists.last_modified` — used as the per-source row's last_verified_at. */
  last_modified: Date;
};

export type ResolveS2Outcome =
  | { status: 'match'; sourceRows: SourceRowToWrite[]; agreementSources: string[] }
  | { status: 'no_identity_columns' }
  | { status: 'artist_name_missing' };

/**
 * Maps each `artists` identity column to the canonical source name used in
 * `library_identity_source.source`. The naming separates from S1's
 * `discogs_release` so the (library_id, source) PK never collides between
 * legs.
 */
const COLUMN_TO_SOURCE_NAME: Array<{
  column: keyof LibraryArtistRow;
  /** The source name in `library_identity_source.source`. */
  sourceName: string;
  /** The source name in LML's `entity.reconciliation_log.source` — used to look up provenance. */
  lmlSource: string;
}> = [
  { column: 'discogs_artist_id', sourceName: 'discogs_artist', lmlSource: 'discogs' },
  { column: 'musicbrainz_artist_id', sourceName: 'mb_artist', lmlSource: 'musicbrainz' },
  { column: 'wikidata_qid', sourceName: 'wikidata', lmlSource: 'wikidata' },
  { column: 'spotify_artist_id', sourceName: 'spotify', lmlSource: 'spotify' },
  { column: 'apple_music_artist_id', sourceName: 'apple_music', lmlSource: 'apple_music' },
  { column: 'bandcamp_id', sourceName: 'bandcamp', lmlSource: 'bandcamp' },
];

/** Tag suffixes for the `notes` column — distinguish real vs. fallback rows for audit. */
export const NOTES_TAG_S2 = 'backfill:S2';
export const NOTES_TAG_S2_FALLBACK_NO_LOG = 'backfill:S2,fallback=no-log';
export const NOTES_TAG_S2_FALLBACK_NULL_CONFIDENCE = 'backfill:S2,fallback=null-confidence';

const FALLBACK_METHOD = 'alias_match';
const FALLBACK_CONFIDENCE = 0.85;

export const resolveS2 = (row: LibraryArtistRow, index: ProvenanceIndex): ResolveS2Outcome => {
  if (row.artist_name == null || row.artist_name === '') {
    return { status: 'artist_name_missing' };
  }

  const sourceRows: SourceRowToWrite[] = [];
  const agreementSources: string[] = [];

  for (const { column, sourceName, lmlSource } of COLUMN_TO_SOURCE_NAME) {
    const externalIdRaw = row[column];
    if (externalIdRaw == null) continue;

    agreementSources.push(sourceName);

    const provenance = index.lookup(row.artist_name, lmlSource);
    let method: string;
    let confidence: number;
    let notes: string;
    if (provenance === undefined) {
      method = FALLBACK_METHOD;
      confidence = FALLBACK_CONFIDENCE;
      notes = NOTES_TAG_S2_FALLBACK_NO_LOG;
    } else if (provenance.confidence == null) {
      method = FALLBACK_METHOD;
      confidence = FALLBACK_CONFIDENCE;
      notes = NOTES_TAG_S2_FALLBACK_NULL_CONFIDENCE;
    } else {
      method = provenance.method;
      confidence = provenance.confidence;
      notes = NOTES_TAG_S2;
    }

    sourceRows.push({
      library_id: row.id,
      source: sourceName,
      external_id: String(externalIdRaw),
      method,
      confidence,
      last_verified_at: row.last_modified,
      boost_sources: null,
      notes,
    });
  }

  if (sourceRows.length === 0) {
    return { status: 'no_identity_columns' };
  }

  // agreementSources only meaningful when ≥2 — single-source rows don't
  // corroborate themselves.
  return {
    status: 'match',
    sourceRows,
    agreementSources: agreementSources.length >= 2 ? agreementSources : [],
  };
};
