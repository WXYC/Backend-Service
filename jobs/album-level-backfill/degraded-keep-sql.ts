/**
 * Conflict-branch `SET` entries for a degraded LML reply (BS#3127).
 *
 * The same rule as the enrichment worker's `buildDegradedConflictSet`
 * (`apps/enrichment-worker/degraded-keep-sql.ts`, BS#3117), narrowed to the
 * ten columns this job writes. Jobs do not import from apps, so the rule is
 * copied here. Keep the copies in step.
 *
 * When LML's Discogs saturation breaker sheds part of the enrichment tail, the
 * reply is still a match, but it carries null for the fields the shed step
 * would have produced, and it is marked `degraded: true` (LML#1420). Written
 * as they are, those nulls would replace values already stored for the
 * album. So, on a degraded reply only:
 *   - `discogs_url` (the release identity): `COALESCE(excluded, stored)`.
 *   - Release-scoped columns (`artwork_url`, `release_year`): keep the stored
 *     value where the reply is null, but only while the reply's `discogs_url`
 *     is null or the same as the stored one.
 *   - Artist-scoped columns (`artist_bio`, `artist_wikipedia_url`): keep the
 *     stored value where the reply is null when both `discogs_artist_id`s are
 *     known and equal, or, when either id is unknown, when the release is
 *     unchanged (the same test as above). This job never writes
 *     `discogs_artist_id` (it does not request `extended`), so here the rule
 *     is "keep the bio only for the same release".
 * Otherwise the reply bound a different release or artist and is written as
 * it is, so the row never mixes two. A value the reply carries always wins.
 * A healthy reply never reaches this: its null bio is LML's real "no Discogs
 * profile" answer and still clears the column.
 *
 * Its own side-effect-free module, and a tsup CJS entry, so the integration
 * spec can run the real builder against Postgres (the BS#1945 recipe).
 */

import { sql, type SQL } from 'drizzle-orm';
import { album_metadata } from '@wxyc/database';

type Key = 'discogs_url' | 'artwork_url' | 'release_year' | 'artist_bio' | 'artist_wikipedia_url';

const excluded = (key: Key | 'discogs_artist_id'): SQL => sql`excluded.${sql.identifier(key)}`;
const coalesceStored = (key: Key): SQL => sql`COALESCE(${excluded(key)}, ${album_metadata[key]})`;

/** The reply names the same release as the row, or names none. */
const sameRelease = sql`(${excluded('discogs_url')} IS NULL OR ${excluded('discogs_url')} IS NOT DISTINCT FROM ${album_metadata.discogs_url})`;

/** Both artist ids known and equal; or either unknown and the release unchanged. */
const sameArtist = sql`((${excluded('discogs_artist_id')} IS NOT NULL AND ${album_metadata.discogs_artist_id} IS NOT NULL AND ${excluded('discogs_artist_id')} = ${album_metadata.discogs_artist_id}) OR ((${excluded('discogs_artist_id')} IS NULL OR ${album_metadata.discogs_artist_id} IS NULL) AND ${sameRelease}))`;

const keepStoredWhen = (guard: SQL, key: Key): SQL =>
  sql`CASE WHEN ${guard} THEN ${coalesceStored(key)} ELSE ${excluded(key)} END`;

export function buildDegradedConflictSet(): Record<Key, SQL> {
  return {
    discogs_url: coalesceStored('discogs_url'),
    artwork_url: keepStoredWhen(sameRelease, 'artwork_url'),
    release_year: keepStoredWhen(sameRelease, 'release_year'),
    artist_bio: keepStoredWhen(sameArtist, 'artist_bio'),
    artist_wikipedia_url: keepStoredWhen(sameArtist, 'artist_wikipedia_url'),
  };
}
