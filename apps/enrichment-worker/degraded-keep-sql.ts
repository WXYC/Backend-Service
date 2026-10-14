/**
 * Conflict-branch `SET` entries for a degraded LML re-ask (BS#3117).
 *
 * When LML's Discogs saturation breaker sheds part of the enrichment tail, the
 * reply is still a match, but it carries null for the fields the shed step
 * would have produced, and it is marked `degraded: true` (LML#1420):
 *   - a release-step shed, or `_build_degraded_response` (which skips
 *     enrichment entirely), nulls the release-scoped fields and
 *     `discogs_artist_id`, and sometimes `artwork_url`;
 *   - an artist-step shed nulls the artist-scoped fields but keeps
 *     `discogs_artist_id`, which comes from the release.
 * Writing that reply as-is would replace stored values with null.
 *
 * The rule, per column group:
 *   - Identity columns (`discogs_url`, `discogs_artist_id`):
 *     `COALESCE(excluded.col, stored.col)`.
 *   - Release-scoped columns: keep the stored value where the reply is null,
 *     but only when `excluded.discogs_url` is null or IS NOT DISTINCT FROM the
 *     stored one. Otherwise the reply bound a different release, and it is
 *     written as-is, so the row never mixes two releases.
 *   - Artist-scoped columns: the same, keyed on `discogs_artist_id`.
 * A reply that carries a value always wins. This is used only for a degraded
 * reply: a healthy reply's null is LML's real answer (for example "this
 * artist has no Discogs profile") and is written as before. The streaming
 * columns are not here; `buildStreamingFieldConflictSet` already merges them.
 *
 * Its own side-effect-free module, and a tsup entry, so
 * `tests/integration/enrichment-worker-degraded-keep.spec.js` can run the real
 * builder against Postgres (the BS#1945 recipe).
 *
 * The identifiers are the table's property keys, which equal the column names
 * for every column here. Column `.name` is not used because the unit suite's
 * `@wxyc/database` double models columns as plain strings.
 */

import { sql, type SQL } from 'drizzle-orm';
import { album_metadata } from '@wxyc/database';

type AlbumMetadataKey = keyof typeof album_metadata.$inferSelect;

const RELEASE_SCOPED = [
  'artwork_url',
  'release_year',
  'label',
  'full_release_date',
  'genres',
  'styles',
  'tracklist',
] as const satisfies readonly AlbumMetadataKey[];

const ARTIST_SCOPED = [
  'artist_bio',
  'artist_wikipedia_url',
  'bio_tokens',
  'artist_image_url',
] as const satisfies readonly AlbumMetadataKey[];

type IdentityKey = 'discogs_url' | 'discogs_artist_id';
type GuardedKey = (typeof RELEASE_SCOPED)[number] | (typeof ARTIST_SCOPED)[number];

const excluded = (key: AlbumMetadataKey): SQL => sql`excluded.${sql.identifier(key)}`;

const coalesceStored = (key: AlbumMetadataKey): SQL => sql`COALESCE(${excluded(key)}, ${album_metadata[key]})`;

/** The reply names the same release/artist as the row, or names none. */
const sameOrUnnamed = (identity: IdentityKey): SQL =>
  sql`(${excluded(identity)} IS NULL OR ${excluded(identity)} IS NOT DISTINCT FROM ${album_metadata[identity]})`;

const keepStoredWhen = (identity: IdentityKey, key: GuardedKey): SQL =>
  sql`CASE WHEN ${sameOrUnnamed(identity)} THEN ${coalesceStored(key)} ELSE ${excluded(key)} END`;

export function buildDegradedConflictSet(): Record<IdentityKey | GuardedKey, SQL> {
  const set = {
    discogs_url: coalesceStored('discogs_url'),
    discogs_artist_id: coalesceStored('discogs_artist_id'),
  } as Record<IdentityKey | GuardedKey, SQL>;
  for (const key of RELEASE_SCOPED) set[key] = keepStoredWhen('discogs_url', key);
  for (const key of ARTIST_SCOPED) set[key] = keepStoredWhen('discogs_artist_id', key);
  return set;
}
