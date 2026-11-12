/**
 * The fill-null write (BS#1442). One UPDATE per album fills each of the eight
 * columns only where it is NULL, so a value the enrichment worker or the
 * re-ask wrote first always survives. The WHERE carries the `discogs_url` the
 * cohort read, so a row whose release moved in between matches nothing.
 *
 * `updated_at` is not touched: it would make every filled row look freshly
 * enriched to the readers that key on it, and nothing about the match changed.
 */

import { sql, type SQL } from 'drizzle-orm';
import { db } from '@wxyc/database';
import type { FillCandidate } from './cohort.js';
import type { ArtistColumns, ReleaseColumns } from './map.js';

/** The values one album's fetch produced; a null leaves the column as it is. */
export type FillValues = ReleaseColumns & ArtistColumns;

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');

// Copied from `jobs/album-metadata-reask/artist-keep-sql.ts`.
const jsonParam = (value: unknown): string | null => (value === null ? null : JSON.stringify(value));

// Copied from `jobs/album-metadata-reask/cohort.ts`: a `text[]` literal with
// each element quoted, backslashes escaped before quotes.
const quoteArrayElement = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const textArrayLiteral = (values: string[] | null): string | null =>
  values === null ? null : `{${values.map(quoteArrayElement).join(',')}}`;

/**
 * The guarded UPDATE for one album.
 *
 * - `bio_tokens` are written only beside a stored bio, judged here rather than
 *   from the cohort snapshot, so a bio cleared in between leaves them NULL.
 * - The two artist columns are written only when the row's artist id is NULL
 *   or the one fetched, so they never describe a different artist than
 *   `discogs_artist_id` does.
 */
export const writeFillSql = (candidate: FillCandidate, v: FillValues): SQL => {
  const am = sql.raw(`"${SCHEMA}"."album_metadata"`);
  const fill = (column: string, value: SQL): SQL =>
    sql`${sql.identifier(column)} = COALESCE(${am}.${sql.identifier(column)}, ${value})`;
  const sameArtist = sql`(${am}."discogs_artist_id" IS NULL OR ${am}."discogs_artist_id" = ${v.discogs_artist_id}::int)`;
  return sql`UPDATE ${am}
   SET ${fill('tracklist', sql`${jsonParam(v.tracklist)}::jsonb`)},
       ${fill('genres', sql`${textArrayLiteral(v.genres)}::text[]`)},
       ${fill('styles', sql`${textArrayLiteral(v.styles)}::text[]`)},
       ${fill('label', sql`${v.label}::text`)},
       ${fill('full_release_date', sql`${v.full_release_date}::text`)},
       ${fill('discogs_artist_id', sql`${v.discogs_artist_id}::int`)},
       "artist_image_url" = CASE WHEN ${sameArtist}
         THEN COALESCE(${am}."artist_image_url", ${v.artist_image_url}::text)
         ELSE ${am}."artist_image_url" END,
       "bio_tokens" = CASE WHEN ${am}."artist_bio" IS NOT NULL AND ${sameArtist}
         THEN COALESCE(${am}."bio_tokens", ${jsonParam(v.bio_tokens)}::jsonb)
         ELSE ${am}."bio_tokens" END
 WHERE ${am}."album_id" = ${candidate.album_id}::int
   AND ${am}."discogs_url" = ${candidate.discogs_url}::text
RETURNING ${am}."album_id"`;
};

/** Run the guarded UPDATE. False when no row matched: the stored release moved. */
export const writeFill = async (candidate: FillCandidate, values: FillValues): Promise<boolean> => {
  const rows = (await db.execute(writeFillSql(candidate, values))) as unknown as unknown[];
  return rows.length > 0;
};
