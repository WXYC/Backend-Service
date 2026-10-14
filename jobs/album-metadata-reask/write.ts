/**
 * The re-ask's guarded `album_metadata` write (BS#3145; BS#3137 "Data safety", decisions 3, 7 and 8).
 *
 * One statement per album: it locks the row only while it still stores the release the cohort enumerated (the race
 * guard), writes the backup row with before and after images of all 13 release- and artist-group columns and the
 * provenance, then updates the row and bumps `updated_at`. The backup and the update commit together or not at all.
 * Zero rows back means the guard failed: the live worker or another job got there first (`skipped_raced`).
 *
 * The release group moves as a unit, nulls included, and is all NULL on `clear` (decision 3). The artist group
 * follows `buildArtistKeepSet` (decision 8) and is kept as stored on `clear`; it is still imaged, so a restore never
 * meets a missing key. No streaming column is written. No `library` statement here: the catalog cover pass is its
 * own slice, so the catalog watermark moves once per run, not once per album.
 *
 * A tsup entry (dist/write.cjs) so the integration spec runs the real statement.
 */

import { sql, type SQL } from 'drizzle-orm';
import { db } from '@wxyc/database';
import { ARTIST_KEYS, buildArtistKeepSet, jsonParam, type ArtistKey } from './artist-keep-sql.js';
import { table, textArrayLiteral, type ReaskCandidate as CohortRow } from './cohort.js';
import type { Verdict } from './decide.js';
import type { Tier } from './inputs.js';
import { CLEAR_RELEASE_GROUP, type ReleaseGroup } from './payload.js';

export type WritingVerdict = Extract<Verdict, { kind: 'rebind' | 'rebind_unpinned' | 'clear' }>;

export interface AlbumWrite {
  run_id: string;
  pin_export_sha256: string;
  /** The row as the cohort read it; its `discogs_url` is the race guard. */
  row: CohortRow;
  tier: Tier;
  verdict: WritingVerdict;
}

/** Stamped on the backup row, so every write names the pin state and the grade it acted on. */
const provenance = ({ row, tier, verdict, pin_export_sha256 }: AlbumWrite) => ({
  reason: row.reason,
  verdict: verdict.kind,
  tier,
  legacy_release_id: row.legacy_release_id,
  pin_release_id: row.pin_release_id,
  pin_source: row.pin_source,
  pin_export_sha256,
  prior_release_id: row.stored_release_id,
  new_release_id: verdict.kind === 'clear' ? null : verdict.release_id,
});

export type WriteOutcome = { written: false } | { written: true; artist_cleared: boolean };

type Column = keyof ReleaseGroup | ArtistKey;

const COLUMNS = [...(Object.keys(CLEAR_RELEASE_GROUP) as (keyof ReleaseGroup)[]), ...ARTIST_KEYS];

const col = (alias: 'p' | 'n', key: Column): SQL => sql`${sql.raw(alias)}.${sql.identifier(key)}`;
const prior = (key: Column): SQL => col('p', key);
const eachColumn = (fragment: (key: Column) => SQL): SQL => sql.join(COLUMNS.map(fragment), sql`, `);
const image = (alias: 'p' | 'n'): SQL =>
  sql`jsonb_build_object(${eachColumn((key) => sql`${sql.raw(`'${key}'`)}, ${col(alias, key)}`)})`;

const textArray = (values: string[] | null): string | null => (values === null ? null : textArrayLiteral(values));

const releaseValues = (r: Readonly<ReleaseGroup>): Record<keyof ReleaseGroup, SQL> => ({
  discogs_url: sql`${r.discogs_url}::text`,
  artwork_url: sql`${r.artwork_url}::text`,
  release_year: sql`${r.release_year}::smallint`,
  label: sql`${r.label}::text`,
  full_release_date: sql`${r.full_release_date}::text`,
  genres: sql`${textArray(r.genres)}::text[]`,
  styles: sql`${textArray(r.styles)}::text[]`,
  tracklist: sql`${jsonParam(r.tracklist)}::jsonb`,
});

export const writeAlbumSql = (w: AlbumWrite): SQL => {
  const { release, artist } = w.verdict.payload;
  const next: Record<Column, SQL> = {
    ...releaseValues(release),
    ...(artist === null
      ? (Object.fromEntries(ARTIST_KEYS.map((key) => [key, prior(key)])) as Record<ArtistKey, SQL>)
      : buildArtistKeepSet(artist, prior)),
  };
  return sql`WITH prior AS (
  SELECT am.* FROM ${table('album_metadata')} am
   WHERE am."album_id" = ${w.row.album_id}::int AND am."discogs_url" IS NOT DISTINCT FROM ${w.row.discogs_url}::text
   FOR UPDATE OF am
), next AS (
  SELECT p."album_id", ${eachColumn((key) => sql`${next[key]} AS ${sql.identifier(key)}`)} FROM prior p
), backup AS (
  INSERT INTO ${table('album_metadata_reask_backup')}
         (run_id, target_table, row_id, album_id, before_image, after_image, provenance, written_at)
  SELECT ${w.run_id}::text, 'album_metadata', p."album_id", p."album_id", ${image('p')}, ${image('n')}, ${jsonParam(provenance(w))}::jsonb, NOW()
    FROM prior p JOIN next n USING (album_id)
  RETURNING album_id
)
UPDATE ${table('album_metadata')} am
   SET ${eachColumn((key) => sql`${sql.identifier(key)} = ${col('n', key)}`)}, "updated_at" = NOW()
  FROM next n JOIN prior p USING (album_id)
 WHERE am."album_id" = n."album_id" AND EXISTS (SELECT 1 FROM backup)
RETURNING am."album_id", (p."artist_bio" IS NOT NULL AND n."artist_bio" IS NULL) AS artist_cleared`;
};

/** One album's write. `written: false` is `skipped_raced`; `artist_cleared` is a stored bio replaced by none. */
export const writeAlbum = async (w: AlbumWrite): Promise<WriteOutcome> => {
  const [row] = (await db.execute(writeAlbumSql(w))) as unknown as Array<{ artist_cleared: boolean }>;
  return row ? { written: true, artist_cleared: row.artist_cleared === true } : { written: false };
};
