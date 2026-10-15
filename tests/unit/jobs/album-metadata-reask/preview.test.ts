/**
 * `--preview`'s pure parts (BS#3150): the seeded, stratified sample and the sign-off line. The zero-writes guarantee
 * on the real statements is in `preview-statements.test.ts`.
 *
 * @see WXYC/Backend-Service#3150
 */

import { describe, it, expect } from '@jest/globals';
import type { ReaskCandidate as CohortRow } from '../../../../jobs/album-metadata-reask/cohort';
import { previewLine, sampleStratified, type StoredRow } from '../../../../jobs/album-metadata-reask/preview';
import type { AdmittedRow, DecidedRow } from '../../../../jobs/album-metadata-reask/run-batch';
import { CLEAR_RELEASE_GROUP, buildPayload } from '../../../../jobs/album-metadata-reask/payload';
import { normalizeLookup } from '@wxyc/metadata';

const admitted = (album_id: number, reason: CohortRow['reason'], pin_source: string): AdmittedRow => ({
  row: {
    album_id,
    legacy_release_id: 1000 + album_id,
    discogs_url: `https://www.discogs.com/release/${4000 + album_id}`,
    artwork_url: null,
    library_artwork_url: null,
    stored_release_id: 4000 + album_id,
    artist_name: 'Jessica Pratt',
    album_title: 'On Your Own Love Again',
    reason,
    pin_release_id: reason === 'pin_mismatch' ? 5000 + album_id : null,
    pin_source,
    restored: false,
  },
  entry: {
    library_id: 1000 + album_id,
    stored_release_id: 4000 + album_id,
    pin_release_id: 5000 + album_id,
    pin_source,
    stored_title_score: null,
    pin_title_score: null,
    stored_play_rate: null,
    pin_play_rate: null,
    excluded_other_plays: 0,
    excluded_inferred_plays: 0,
    tier: 'rebind',
    expected_release_id: null,
  },
});

// Three strata of very different sizes: 30, 6 and 2 albums.
const POPULATION = [
  ...Array.from({ length: 30 }, (_, i) => admitted(i + 1, 'pin_mismatch', 'alex-l-2026-masters-api')),
  ...Array.from({ length: 6 }, (_, i) => admitted(i + 101, 'pin_mismatch', 'alex-l-2026')),
  ...Array.from({ length: 2 }, (_, i) => admitted(i + 201, 'pin_removed', 'alex-l-2026-masters-api')),
];
const ids = (rows: AdmittedRow[]) => rows.map((r) => r.row.album_id);
const stratum = (rows: AdmittedRow[], lo: number, hi: number) => ids(rows).filter((id) => id >= lo && id < hi).length;

describe('sampleStratified', () => {
  it('is deterministic for a seed, whatever order the population arrives in', () => {
    const first = sampleStratified(POPULATION, 12, 20261014);

    expect(ids(sampleStratified([...POPULATION].reverse(), 12, 20261014))).toEqual(ids(first));
    expect(ids(sampleStratified(POPULATION, 12, 7))).not.toEqual(ids(first));
  });

  // Round robin over the strata: a small stratum is taken whole before a large one takes more than its share.
  it.each([
    ['12 albums: 5, 5 and both removals', 12, [5, 5, 2]],
    ['3 albums: one from each stratum', 3, [1, 1, 1]],
    ['20 albums: the six and the two whole, the rest from the large one', 20, [12, 6, 2]],
    ['more than the population: all of it', 100, [30, 6, 2]],
  ])('%s', (_label, size, [large, small, removed]) => {
    const sample = sampleStratified(POPULATION, size, 20261014);

    expect([stratum(sample, 1, 100), stratum(sample, 101, 200), stratum(sample, 201, 300)]).toEqual([
      large,
      small,
      removed,
    ]);
    expect(new Set(ids(sample)).size).toBe(sample.length);
    expect(ids(sample)).toEqual([...ids(sample)].sort((a, b) => a - b));
  });
});

// Juana Molina, *DOGA*: stored on release 4001, pinned to 5001.
const ROW: AdmittedRow = {
  row: {
    ...admitted(1, 'pin_mismatch', 'alex-l-2026').row,
    artist_name: 'Juana Molina',
    album_title: 'DOGA',
    artwork_url: 'https://i.discogs.com/4001.jpg',
    library_artwork_url: 'https://i.discogs.com/4001.jpg',
  },
  entry: admitted(1, 'pin_mismatch', 'alex-l-2026').entry,
};
/** The five streaming columns as the enrichment stored them for this answer. */
function streamingOf(answer: ReturnType<typeof lookup>) {
  const { spotify_url, apple_music_url, youtube_music_url, bandcamp_url, soundcloud_url } = normalizeLookup(answer, {
    artist: 'Juana Molina',
    album: 'DOGA',
  });
  return { spotify_url, apple_music_url, youtube_music_url, bandcamp_url, soundcloud_url };
}

const STORED: StoredRow = {
  album_id: 1,
  discogs_url: 'https://www.discogs.com/release/4001',
  artwork_url: 'https://i.discogs.com/4001.jpg',
  release_year: 2024,
  label: 'Sonamos',
  full_release_date: null,
  genres: ['Rock'],
  styles: null,
  tracklist: null,
  discogs_artist_id: 77,
  artist_bio: 'Argentine singer and songwriter.',
  artist_wikipedia_url: null,
  artist_image_url: null,
  bio_tokens: null,
  cover_sibling: true,
  ...streamingOf(lookup({})),
};

function lookup(artwork: Record<string, unknown>) {
  return {
    search_type: 'direct',
    results: [
      {
        library_item: { id: ROW.row.legacy_release_id },
        artwork: {
          release_id: 5001,
          album: 'DOGA',
          release_url: 'https://www.discogs.com/release/5001',
          artwork_url: 'https://i.discogs.com/5001.jpg',
          release_year: 2024,
          label: 'Sonamos',
          genres: ['Rock'],
          discogs_artist_id: 77,
          artist_bio: 'Argentine singer and songwriter.',
          spotify_url: 'https://open.spotify.com/album/doga',
          ...artwork,
        },
      },
    ],
  };
}

const decided = (kind: 'rebind' | 'pin_not_bound', artwork: Record<string, unknown> = {}): DecidedRow => {
  const answer = lookup(artwork);
  const item = { index: 0, status: 'match', lookup: answer } as unknown as DecidedRow['item'];
  const verdict =
    kind === 'rebind'
      ? {
          kind,
          release_id: 5001,
          payload: buildPayload(answer, { artist: 'Juana Molina', album: 'DOGA' }),
        }
      : { kind };
  return { admitted: ROW, item, verdict };
};

const CLEARED: DecidedRow = {
  admitted: {
    ...ROW,
    row: { ...ROW.row, reason: 'pin_removed', pin_release_id: null },
    entry: { ...ROW.entry, pin_release_id: 4001 },
  },
  item: { index: 0, status: 'no_match', lookup: null } as unknown as DecidedRow['item'],
  verdict: {
    kind: 'clear',
    payload: { release: CLEAR_RELEASE_GROUP, artist: null },
  },
};

describe('previewLine', () => {
  const identity = {
    album_id: 1,
    card: 1001,
    artist: 'Juana Molina',
    title: 'DOGA',
    tier: 'rebind',
    stored_release: { id: 4001, url: 'https://www.discogs.com/release/4001' },
  };

  it.each<[string, DecidedRow, Record<string, unknown>]>([
    [
      'a rebind: the changed columns, the catalog cover, the links and the bio',
      decided('rebind'),
      {
        ...identity,
        reason: 'pin_mismatch',
        pin: { release_id: 5001, source: 'alex-l-2026', expected_release_id: null },
        lml_release: { id: 5001, title: 'DOGA' },
        verdict: 'rebind',
        changes: {
          discogs_url: { old: 'https://www.discogs.com/release/4001', new: 'https://www.discogs.com/release/5001' },
          artwork_url: { old: 'https://i.discogs.com/4001.jpg', new: 'https://i.discogs.com/5001.jpg' },
        },
        catalog_cover: { old: 'https://i.discogs.com/4001.jpg', new: 'https://i.discogs.com/5001.jpg' },
        streaming_links_equal: true,
        artist_cleared: false,
        null_cover_sibling: null,
      },
    ],
    [
      'a rebind to another artist with no bio, no cover and other links',
      decided('rebind', {
        artwork_url: null,
        discogs_artist_id: 78,
        artist_bio: null,
        spotify_url: 'https://open.spotify.com/album/other',
      }),
      expect.objectContaining({
        changes: expect.objectContaining({
          artwork_url: { old: 'https://i.discogs.com/4001.jpg', new: null },
          discogs_artist_id: { old: 77, new: 78 },
          artist_bio: { old: 'Argentine singer and songwriter.', new: null },
        }),
        catalog_cover: { old: 'https://i.discogs.com/4001.jpg', new: null },
        streaming_links_equal: false,
        artist_cleared: true,
        null_cover_sibling: true,
      }),
    ],
    [
      'a clear: the release group goes NULL, the artist group stays',
      CLEARED,
      expect.objectContaining({
        reason: 'pin_removed',
        pin: { release_id: null, source: 'alex-l-2026', expected_release_id: null },
        lml_release: null,
        verdict: 'clear',
        changes: {
          discogs_url: { old: 'https://www.discogs.com/release/4001', new: null },
          artwork_url: { old: 'https://i.discogs.com/4001.jpg', new: null },
          release_year: { old: 2024, new: null },
          label: { old: 'Sonamos', new: null },
          genres: { old: ['Rock'], new: null },
        },
        streaming_links_equal: null,
        artist_cleared: false,
        null_cover_sibling: true,
      }),
    ],
    [
      'a verdict that does not write: who and what, nothing would change',
      decided('pin_not_bound', { release_id: 4001, album: 'Doga (Deluxe)' }),
      {
        ...identity,
        reason: 'pin_mismatch',
        pin: { release_id: 5001, source: 'alex-l-2026', expected_release_id: null },
        lml_release: { id: 4001, title: 'Doga (Deluxe)' },
        verdict: 'pin_not_bound',
      },
    ],
  ])('%s', (_label, row, expected) => {
    expect(previewLine(row, STORED)).toEqual(expected);
  });

  // Code review on #3278: a vanished row must not read as "nothing changes", and a long list must not split the line.
  it.each<[string, StoredRow | undefined, Record<string, unknown>]>([
    ['a row gone before the stored read says so', undefined, { verdict: 'rebind', changes: null }],
    [
      'a tracklist is shown by its length',
      { ...STORED, tracklist: [{ position: 'A1', title: 'la paradoja' }] },
      { changes: expect.objectContaining({ tracklist: { old: '1 items', new: null } }) },
    ],
  ])('%s', (_label, stored, expected) => {
    expect(previewLine(decided('rebind'), stored)).toMatchObject(expected);
  });

  it('leaves the catalog cover alone when it does not mirror the stored cover', () => {
    const own = {
      ...decided('rebind'),
      admitted: { ...ROW, row: { ...ROW.row, library_artwork_url: 'librarian.jpg' } },
    };

    expect(previewLine(own, STORED)).toMatchObject({ catalog_cover: null });
  });
});
