/**
 * `--preview`, the sign-off sample (BS#3150; BS#3137 "Dry run, preview, and sign-off"). A seeded sample of admitted
 * albums, stratified by `reason` and pin source; `runBatch` asks LML for it with `write: null`; one JSON line per
 * album says what `--execute` would do. Nothing is written: the only statements are the cohort reads and the stored
 * read here. A tsup entry for the integration spec.
 */

import { isDeepStrictEqual } from 'util';
import { sql, type SQL } from 'drizzle-orm';
import { intArrayLiteral, type AlbumMetadata } from '@wxyc/database';
import { normalizeLookup } from '@wxyc/metadata';
import { ARTIST_KEYS } from './artist-keep-sql.js';
import { table, withStatementTimeout } from './cohort.js';
import { mergeArtistGroup, type ArtistGroup, type ReleaseGroup } from './payload.js';
import type { AdmittedRow, DecidedRow } from './run-batch.js';
import { COLUMNS } from './write.js';

/** mulberry32: a small seeded PRNG, so a seed names one sample on every machine. */
const seededRandom = (seed: number): (() => number) => {
  let state = seed % 2 ** 32;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
};

const shuffle = <T>(items: T[], random: () => number): T[] => {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
};

/**
 * Up to `size` albums, the same ones for the same seed and population. Strata are `reason` and pin source, taken
 * round robin in a seeded order, each shuffled by the seed, so a small stratum is in the sample whole before a large
 * one takes more than an equal share. Returned in `album_id` order.
 */
export const sampleStratified = (rows: readonly AdmittedRow[], size: number, seed: number): AdmittedRow[] => {
  const random = seededRandom(seed);
  const strata = new Map<string, AdmittedRow[]>();
  for (const admitted of [...rows].sort((a, b) => a.row.album_id - b.row.album_id)) {
    const key = `${admitted.row.reason}\t${admitted.row.pin_source}`;
    strata.set(key, [...(strata.get(key) ?? []), admitted]);
  }
  const queues = shuffle([...strata.keys()].sort(), random).map((key) => shuffle(strata.get(key) ?? [], random));
  const picked: AdmittedRow[] = [];
  for (let round = 0; picked.length < size && queues.some((queue) => round < queue.length); round++) {
    for (const queue of queues) {
      if (round < queue.length && picked.length < size) {
        picked.push(queue[round]);
      }
    }
  }
  return picked.sort((a, b) => a.row.album_id - b.row.album_id);
};

const STREAMING = ['spotify_url', 'apple_music_url', 'youtube_music_url', 'bandcamp_url', 'soundcloud_url'] as const;

/**
 * The stored row as the preview compares it. `cover_sibling`: another album shares a lookup key with one of this
 * album's plays and has a cover, which `/playlists/recentEntries?v=2` (`enrichPlaycuts`) would show if this one's
 * cover went NULL.
 */
export type StoredRow = ReleaseGroup &
  ArtistGroup &
  Pick<AlbumMetadata, 'album_id' | (typeof STREAMING)[number]> & { cover_sibling: boolean };

/** `enrichPlaycuts`'s lookup key, written as `flowsheet_album_link_lookup_idx` indexes it. */
const lookupKey = (alias: string): SQL =>
  sql.raw(`lower(trim(${alias}."artist_name")) || '-' || lower(trim(coalesce(${alias}."album_title", '')))`);

/** The sampled albums' stored rows. A read: the preview's only statement outside the cohort reads. */
export const previewStoredSql = (albumIds: readonly number[]): SQL => sql`SELECT am.*, EXISTS (
  SELECT 1 FROM ${table('flowsheet')} f
    JOIN ${table('flowsheet')} f2 ON ${lookupKey('f2')} = ${lookupKey('f')} AND f2."album_id" IS NOT NULL
     AND f2."album_id" <> am."album_id"
    JOIN ${table('album_metadata')} s ON s."album_id" = f2."album_id" AND s."artwork_url" IS NOT NULL
   WHERE f."album_id" = am."album_id"
) AS cover_sibling
  FROM ${table('album_metadata')} am
 WHERE am."album_id" = ANY(${intArrayLiteral([...albumIds])}::int[])`;

export const readStored = async (albumIds: readonly number[], timeoutMs: number): Promise<Map<number, StoredRow>> => {
  const rows = await withStatementTimeout(
    timeoutMs,
    async (tx) => (await tx.execute(previewStoredSql(albumIds))) as unknown as StoredRow[]
  );
  return new Map(rows.map((row) => [Number(row.album_id), row]));
};

const pick = <K extends string>(from: Record<K, unknown>, keys: readonly K[]) =>
  Object.fromEntries(keys.map((key) => [key, from[key] ?? null])) as Record<K, unknown>;

/**
 * The sign-off line for one album: who it is, what LML answered and the verdict, and for a writing verdict what the
 * album write and the catalog cover pass would change. `streaming_links_equal` compares the answer's links, as the
 * enrichment would store them, with the stored ones (null for `clear`, which has no answer).
 */
export const previewLine = ({ admitted, item, verdict }: DecidedRow, stored: StoredRow | undefined) => {
  const { row, entry } = admitted;
  const lookup = item?.status === 'match' ? item.lookup : null;
  const artwork = lookup?.results?.[0]?.artwork;
  const line = {
    album_id: row.album_id,
    card: row.legacy_release_id,
    artist: row.artist_name,
    title: row.album_title,
    reason: row.reason,
    tier: entry.tier,
    stored_release: { id: row.stored_release_id, url: row.discogs_url },
    pin: { release_id: row.pin_release_id, source: row.pin_source, expected_release_id: entry.expected_release_id },
    lml_release: artwork ? { id: artwork.release_id, title: artwork.album ?? null } : null,
    verdict: verdict.kind,
  };
  if (!('payload' in verdict) || !stored) {
    return line;
  }
  const { release, artist } = verdict.payload;
  const next = { ...release, ...(artist ? mergeArtistGroup(stored, artist) : pick(stored, ARTIST_KEYS)) };
  const old = pick(stored, COLUMNS);
  const changed = COLUMNS.filter((key) => !isDeepStrictEqual(old[key], next[key]));
  const mirrors = row.library_artwork_url !== null && row.library_artwork_url === stored.artwork_url;
  const answered = lookup
    ? pick(normalizeLookup(lookup, { artist: row.artist_name, album: row.album_title }), STREAMING)
    : null;
  return {
    ...line,
    changes: Object.fromEntries(changed.map((key) => [key, { old: old[key], new: next[key] }])),
    catalog_cover:
      mirrors && next.artwork_url !== row.library_artwork_url
        ? { old: row.library_artwork_url, new: next.artwork_url }
        : null,
    streaming_links_equal: answered ? isDeepStrictEqual(answered, pick(stored, STREAMING)) : null,
    artist_cleared: stored.artist_bio !== null && next.artist_bio === null,
    null_cover_sibling: next.artwork_url === null ? stored.cover_sibling : null,
  };
};
