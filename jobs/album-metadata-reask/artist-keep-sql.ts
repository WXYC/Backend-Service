/**
 * The artist group of the re-ask's `album_metadata` write (BS#3145): decision 8 on BS#3137, as Drizzle `sql`.
 *
 * BS#3128's rule (`apps/enrichment-worker/degraded-keep-sql.ts`) with "same release" false, since a rebind always
 * changes the release: keep the stored value where the answer is null only when both `discogs_artist_id`s are set and
 * equal; otherwise write the answer, nulls included. `discogs_artist_id` is always the answer's. `mergeArtistGroup`
 * in `payload.ts` is the same rule over values in hand. By decision, the worker applies this only to a degraded
 * reply; this job never writes one and applies it to healthy rebind answers.
 *
 * Modelled on `buildDegradedInlineSet` (`jobs/flowsheet-artwork-repair/degraded-keep-sql.ts`): bound values with
 * explicit casts, and the "answer id null" arm decided here, so SQL never compares a bound NULL. Side-effect free,
 * with its own tsup entry for the integration spec.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { ArtistGroup } from './payload.js';

export type ArtistKey = keyof ArtistGroup;

/** The columns the rule may keep; `discogs_artist_id` is never kept. */
const KEEPABLE = ['artist_bio', 'artist_wikipedia_url', 'artist_image_url', 'bio_tokens'] as const;

/** The artist group's columns, in the order the write images them. */
export const ARTIST_KEYS = ['discogs_artist_id', ...KEEPABLE] as const satisfies readonly ArtistKey[];

/** A jsonb parameter: JSON text, or SQL NULL (never the JSON `null`). */
export const jsonParam = (value: unknown): string | null => (value === null ? null : JSON.stringify(value));

/**
 * One `SET`-ready expression per artist column. `stored(key)` names the column on the row the write locked, for
 * example `p."artist_bio"`.
 */
export function buildArtistKeepSet(answer: ArtistGroup, stored: (key: ArtistKey) => SQL): Record<ArtistKey, SQL> {
  const set: Record<ArtistKey, SQL> = {
    discogs_artist_id: sql`${answer.discogs_artist_id}::int`,
    artist_bio: sql`${answer.artist_bio}::text`,
    artist_wikipedia_url: sql`${answer.artist_wikipedia_url}::text`,
    artist_image_url: sql`${answer.artist_image_url}::text`,
    bio_tokens: sql`${jsonParam(answer.bio_tokens)}::jsonb`,
  };
  if (answer.discogs_artist_id === null) return set;

  // A NULL stored id makes the test NULL, so "either id null" also writes as answered. Each value is bound once.
  for (const key of KEEPABLE) {
    set[key] =
      sql`COALESCE(${set[key]}, CASE WHEN ${stored('discogs_artist_id')} = ${answer.discogs_artist_id}::int THEN ${stored(key)} END)`;
  }
  return set;
}
