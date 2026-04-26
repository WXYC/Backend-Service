/**
 * Reads reconciled identities from LML's `entity.identity` table.
 *
 * The table lives in the discogs-cache PostgreSQL database, addressed by
 * `DATABASE_URL_DISCOGS`. Schema is owned by library-metadata-lookup
 * (`scripts/entity_resolution/store.py`):
 *
 *   id, library_name, discogs_artist_id, wikidata_qid,
 *   musicbrainz_artist_id, spotify_artist_id, apple_music_artist_id,
 *   bandcamp_id, reconciliation_status, updated_at
 *
 * We pull every row with at least one external ID set; partially-populated
 * rows are useful (a Discogs-only resolution still fills one column on the
 * artists table).
 */

import postgres from 'postgres';

export type LmlIdentity = {
  library_name: string;
  discogs_artist_id: number | null;
  wikidata_qid: string | null;
  musicbrainz_artist_id: string | null;
  spotify_artist_id: string | null;
  apple_music_artist_id: string | null;
  bandcamp_id: string | null;
};

let client: ReturnType<typeof postgres> | null = null;

const lmlClient = (): ReturnType<typeof postgres> => {
  if (client) return client;
  const url = process.env.DATABASE_URL_DISCOGS;
  if (!url) {
    throw new Error('[artist-identity-etl] DATABASE_URL_DISCOGS is not set; cannot read entity.identity from LML');
  }
  client = postgres(url, { max: 1, prepare: false });
  return client;
};

/**
 * Fetch identities updated since `sinceMs` (epoch milliseconds), or every
 * row when `sinceMs` is null. Filters out rows where every external ID is
 * null (no useful data to copy).
 */
export const fetchLmlIdentities = async (sinceMs: number | null): Promise<LmlIdentity[]> => {
  const sql = lmlClient();
  const rows =
    sinceMs == null
      ? await sql<LmlIdentity[]>`
        SELECT library_name, discogs_artist_id, wikidata_qid,
               musicbrainz_artist_id, spotify_artist_id,
               apple_music_artist_id, bandcamp_id
        FROM entity.identity
        WHERE discogs_artist_id IS NOT NULL
           OR wikidata_qid IS NOT NULL
           OR musicbrainz_artist_id IS NOT NULL
           OR spotify_artist_id IS NOT NULL
           OR apple_music_artist_id IS NOT NULL
           OR bandcamp_id IS NOT NULL
        ORDER BY library_name ASC
      `
      : await sql<LmlIdentity[]>`
        SELECT library_name, discogs_artist_id, wikidata_qid,
               musicbrainz_artist_id, spotify_artist_id,
               apple_music_artist_id, bandcamp_id
        FROM entity.identity
        WHERE updated_at > to_timestamp(${sinceMs}::double precision / 1000.0)
          AND (
            discogs_artist_id IS NOT NULL
            OR wikidata_qid IS NOT NULL
            OR musicbrainz_artist_id IS NOT NULL
            OR spotify_artist_id IS NOT NULL
            OR apple_music_artist_id IS NOT NULL
            OR bandcamp_id IS NOT NULL
          )
        ORDER BY library_name ASC
      `;
  return rows;
};

export const closeLmlConnection = async (): Promise<void> => {
  if (client) {
    await client.end();
    client = null;
  }
};
