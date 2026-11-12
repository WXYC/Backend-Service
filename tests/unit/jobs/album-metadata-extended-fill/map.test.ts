/**
 * The extended fill's mapping from LML's release and artist responses onto the
 * eight `album_metadata` columns (BS#1442), and the release-id parse it reads
 * the stored `discogs_url` with.
 *
 * Pure, so every rule is a row: empty values stay NULL, the compilation gate
 * withholds the artist columns, and a scalar longer than its column is dropped
 * and counted rather than truncated.
 *
 * @see WXYC/Backend-Service#1442
 */

import { describe, it, expect } from '@jest/globals';
import {
  VARIOUS_ARTISTS_DISCOGS_ID,
  mapArtist,
  mapRelease,
  parseDiscogsReleaseId,
} from '../../../../jobs/album-metadata-extended-fill/map';

// The types map.ts itself resolves, so the fixtures cannot drift onto a second copy of the DTOs.
type DiscogsReleaseMetadata = Parameters<typeof mapRelease>[0];
type DiscogsArtistDetails = Parameters<typeof mapArtist>[0];

const TRACK = { position: 'A1', title: 'la paradoja', duration: '4:12', artists: [] };

// Fixtures carry only the fields the mapping reads; the generated DTOs require every defaulted field.
const release = (overrides: Record<string, unknown> = {}): DiscogsReleaseMetadata =>
  ({
    release_id: 1442,
    title: 'DOGA',
    artist: 'Juana Molina',
    release_url: 'https://www.discogs.com/release/1442',
    artist_id: 82730,
    artists: [{ artist_id: 82730, name: 'Juana Molina', join: '' }],
    label: 'Sonamos',
    released: '2024-05-10',
    genres: ['Electronic', 'Rock'],
    styles: ['Experimental'],
    tracklist: [TRACK],
    ...overrides,
  }) as unknown as DiscogsReleaseMetadata;

const artist = (overrides: Record<string, unknown> = {}): DiscogsArtistDetails =>
  ({
    artist_id: 82730,
    name: 'Juana Molina',
    image_url: 'https://i.discogs.com/a/82730.jpg',
    profile_tokens: [{ type: 'plainText', text: 'Argentine singer.' }],
    ...overrides,
  }) as unknown as DiscogsArtistDetails;

describe('parseDiscogsReleaseId', () => {
  it.each([
    ['https://www.discogs.com/release/1442', 1442],
    ['https://www.discogs.com/release/1442-Juana-Molina-DOGA', 1442],
    ['https://www.discogs.com/es/release/27351?x=1', 27351],
    ['https://www.discogs.com/master/1442', undefined],
    ['https://www.discogs.com/release/0', undefined],
    ['https://www.discogs.com/release/', undefined],
    ['', undefined],
    [null, undefined],
  ])('%p -> %p', (url, expected) => {
    expect(parseDiscogsReleaseId(url)).toBe(expected);
  });
});

describe('mapRelease', () => {
  it('maps every release-scoped column and keeps the primary artist id', () => {
    expect(mapRelease(release())).toEqual({
      columns: {
        tracklist: [TRACK],
        genres: ['Electronic', 'Rock'],
        styles: ['Experimental'],
        label: 'Sonamos',
        full_release_date: '2024-05-10',
        discogs_artist_id: 82730,
      },
      gate: 'single',
      tooLong: [],
    });
  });

  it.each([
    ['an empty tracklist', { tracklist: [] }, { tracklist: null }],
    ['empty genres', { genres: [] }, { genres: null }],
    ['empty styles', { styles: [] }, { styles: null }],
    [
      'missing arrays',
      { tracklist: undefined, genres: undefined, styles: undefined },
      { tracklist: null, genres: null, styles: null },
    ],
    ['a missing released', { released: undefined }, { full_release_date: null }],
    ['a null released', { released: null }, { full_release_date: null }],
    ['an empty label', { label: '' }, { label: null }],
    ['a null label', { label: null }, { label: null }],
  ])('writes NULL for %s', (_label, overrides, expected) => {
    expect(mapRelease(release(overrides)).columns).toMatchObject(expected);
  });

  it.each([
    ['no artist_id', { artist_id: null }, 'no_artist_id'],
    ['artist_id 0', { artist_id: 0 }, 'no_artist_id'],
    ['the Various artist (194)', { artist_id: VARIOUS_ARTISTS_DISCOGS_ID }, 'various'],
    [
      'two primary credits',
      {
        artists: [
          { artist_id: 82730, name: 'Juana Molina', join: ' & ' },
          { artist_id: 5150, name: 'Jessica Pratt', join: '' },
        ],
      },
      'multiple_credits',
    ],
  ])('withholds the artist id for %s', (_label, overrides, gate) => {
    const mapped = mapRelease(release(overrides));

    expect(mapped.gate).toBe(gate);
    expect(mapped.columns.discogs_artist_id).toBeNull();
    // The six release-scoped columns are filled regardless.
    expect(mapped.columns.tracklist).toEqual([TRACK]);
    expect(mapped.columns.label).toBe('Sonamos');
  });

  it('treats a release with an artist id but no credits array as a single artist', () => {
    expect(mapRelease(release({ artists: undefined })).gate).toBe('single');
  });

  it.each([
    ['label', { label: 'x'.repeat(256) }, 'x'.repeat(255)],
    ['full_release_date', { released: 'y'.repeat(33) }, 'y'.repeat(32)],
  ] as const)('drops an over-length %s, counts it, and keeps the other columns', (column, overrides, atLimit) => {
    const over = mapRelease(release(overrides));
    expect(over.columns[column]).toBeNull();
    expect(over.tooLong).toEqual([column]);
    expect(over.columns.tracklist).toEqual([TRACK]);

    const key = column === 'label' ? 'label' : 'released';
    const fits = mapRelease(release({ [key]: atLimit }));
    expect(fits.columns[column]).toBe(atLimit);
    expect(fits.tooLong).toEqual([]);
  });
});

describe('mapArtist', () => {
  it('maps the image and the profile tokens', () => {
    expect(mapArtist(artist())).toEqual({
      columns: {
        artist_image_url: 'https://i.discogs.com/a/82730.jpg',
        bio_tokens: [{ type: 'plainText', text: 'Argentine singer.' }],
      },
      tooLong: [],
    });
  });

  it.each([
    ['no image', { image_url: null }, { artist_image_url: null }],
    ['empty profile tokens', { profile_tokens: [] }, { bio_tokens: null }],
    ['null profile tokens', { profile_tokens: null }, { bio_tokens: null }],
  ])('writes NULL for %s', (_label, overrides, expected) => {
    expect(mapArtist(artist(overrides)).columns).toMatchObject(expected);
  });

  it('drops an over-length image URL and counts it', () => {
    const mapped = mapArtist(artist({ image_url: 'https://i.discogs.com/' + 'z'.repeat(500) }));

    expect(mapped.columns.artist_image_url).toBeNull();
    expect(mapped.tooLong).toEqual(['artist_image_url']);
    expect(mapped.columns.bio_tokens).not.toBeNull();
  });
});
