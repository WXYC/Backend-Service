/**
 * Unit tests for enrichment-worker enrich.ts (BS#892 / Epic C C2, PR-2).
 *
 * Pins the consumer's finalize contract: the UPDATE narrows by
 * `metadata_status='enriching'` (set by claim.ts) and writes the terminal
 * status the LML response implies — `enriched_match` if artwork came
 * back, `enriched_no_match` otherwise. Race detector: `_raced` variants
 * fire when `.returning({ id })` is empty (the row left `enriching`
 * between claim and finalize — typically the C6 stranded-claim sweep).
 *
 * Mirrors the backfill's enrich.test.ts in shape but exercises the
 * different idempotency guard (status enum vs marker IS NULL) and the
 * different terminal column (status enum vs metadata_attempt_at).
 */

import { jest } from '@jest/globals';

import { db, flowsheet } from '@wxyc/database';
import type { LookupResponse } from '@wxyc/lml-client';
import {
  cleanDiscogsBio,
  extractArtwork,
  filterSpacerGif,
  finalizeRow,
  synthesizeSearchUrls,
} from '../../../../apps/enrichment-worker/enrich';

const mockDb = db as unknown as {
  update: jest.Mock;
  _chain: { set: jest.Mock; where: jest.Mock; returning: jest.Mock };
};

const ROW = {
  id: 42,
  artist_name: 'Juana Molina',
  album_title: 'DOGA',
  track_title: 'la paradoja',
};

const matchResponse = {
  results: [
    {
      artwork: {
        artwork_url: 'https://i.discogs.com/abc/cover.jpg',
        release_url: 'https://discogs.com/release/123',
        release_year: 2022,
        spotify_url: 'https://open.spotify.com/album/x',
        apple_music_url: 'https://music.apple.com/album/y',
        youtube_music_url: 'https://music.youtube.com/playlist/z',
        bandcamp_url: 'https://artist.bandcamp.com/album/w',
        soundcloud_url: null,
        artist_bio: 'A great [a=Some Artist] from Argentina.',
        wikipedia_url: 'https://en.wikipedia.org/wiki/Juana_Molina',
      },
    },
  ],
} as unknown as LookupResponse;

const noMatchResponse = { results: [] } as unknown as LookupResponse;

describe('finalizeRow (BS#892 PR-2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('on match: writes the 10 metadata columns and flips status to enriched_match', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);

    const outcome = await finalizeRow(ROW, matchResponse);

    expect(outcome).toBe('enriched_match');
    expect(mockDb.update).toHaveBeenCalledWith(flowsheet);

    const setCall = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall.metadata_status).toBe('enriched_match');
    expect(setCall.artwork_url).toBe('https://i.discogs.com/abc/cover.jpg');
    expect(setCall.discogs_url).toBe('https://discogs.com/release/123');
    expect(setCall.release_year).toBe(2022);
    expect(setCall.spotify_url).toBe('https://open.spotify.com/album/x');
    expect(setCall.apple_music_url).toBe('https://music.apple.com/album/y');
    expect(setCall.youtube_music_url).toBe('https://music.youtube.com/playlist/z');
    expect(setCall.bandcamp_url).toBe('https://artist.bandcamp.com/album/w');
    // LML returned null for soundcloud → fall back to synthesized.
    expect(setCall.soundcloud_url).toContain('soundcloud.com/search');
    expect(setCall.artist_bio).toBe('A great Some Artist from Argentina.');
    expect(setCall.artist_wikipedia_url).toBe('https://en.wikipedia.org/wiki/Juana_Molina');
  });

  it('on no-match: writes 3 synthesized search URLs and flips status to enriched_no_match', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);

    const outcome = await finalizeRow(ROW, noMatchResponse);

    expect(outcome).toBe('enriched_no_match');

    const setCall = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall.metadata_status).toBe('enriched_no_match');
    // The 7 metadata columns are NOT in the .set() — preserves prior values.
    expect(setCall.artwork_url).toBeUndefined();
    expect(setCall.discogs_url).toBeUndefined();
    expect(setCall.release_year).toBeUndefined();
    expect(setCall.artist_bio).toBeUndefined();
    // The 3 search URLs ARE in the .set().
    expect(setCall.youtube_music_url).toContain('music.youtube.com/search');
    expect(setCall.bandcamp_url).toContain('bandcamp.com/search');
    expect(setCall.soundcloud_url).toContain('soundcloud.com/search');
  });

  it('returns _raced when the UPDATE matches 0 rows (status left enriching between claim and finalize)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([]);

    const outcome = await finalizeRow(ROW, matchResponse);

    expect(outcome).toBe('enriched_match_raced');
  });

  it('returns enriched_no_match_raced on no-match path when the UPDATE matches 0 rows', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([]);

    const outcome = await finalizeRow(ROW, noMatchResponse);

    expect(outcome).toBe('enriched_no_match_raced');
  });

  it('coerces release_year=0 (Discogs "year unknown" sentinel) to null', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);
    const response = {
      results: [{ artwork: { artwork_url: 'https://i.discogs.com/x.jpg', release_year: 0 } }],
    } as unknown as LookupResponse;

    await finalizeRow(ROW, response);

    const setCall = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall.release_year).toBeNull();
  });

  it('strips spacer.gif placeholder from artwork_url', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);
    const response = {
      results: [{ artwork: { artwork_url: 'https://i.discogs.com/spacer.gif' } }],
    } as unknown as LookupResponse;

    await finalizeRow(ROW, response);

    const setCall = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall.artwork_url).toBeNull();
  });

  it('calls .where() exactly once with a non-empty predicate', async () => {
    // The WHERE uses typed `and(eq(flowsheet.id, id), eq(flowsheet.metadata_status, 'enriching'))`
    // builders. Column refs + the 'enriching' enum literal are compile-time
    // checked against BS#891's schema. Structural assertion here; behavioral
    // narrowing covered by the _raced tests above.
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);

    await finalizeRow(ROW, matchResponse);

    expect(mockDb._chain.where).toHaveBeenCalledTimes(1);
    expect(mockDb._chain.where.mock.calls[0]?.[0]).toBeDefined();
  });

  it('propagates DB errors instead of swallowing them', async () => {
    const dbError = new Error('connection refused');
    mockDb._chain.returning.mockRejectedValueOnce(dbError);

    await expect(finalizeRow(ROW, matchResponse)).rejects.toThrow('connection refused');
  });
});

describe('synthesizeSearchUrls (per-service precedence)', () => {
  it('YouTube Music prefers trackTitle over albumTitle over artistName', () => {
    expect(
      synthesizeSearchUrls({ id: 1, artist_name: 'A', album_title: 'B', track_title: 'C' }).youtube_music_url
    ).toBe('https://music.youtube.com/search?q=A%20C');
    expect(
      synthesizeSearchUrls({ id: 1, artist_name: 'A', album_title: 'B', track_title: null }).youtube_music_url
    ).toBe('https://music.youtube.com/search?q=A%20B');
    expect(
      synthesizeSearchUrls({ id: 1, artist_name: 'A', album_title: null, track_title: null }).youtube_music_url
    ).toBe('https://music.youtube.com/search?q=A');
  });

  it('Bandcamp prefers albumTitle over artistName (NO track fallback)', () => {
    expect(synthesizeSearchUrls({ id: 1, artist_name: 'A', album_title: 'B', track_title: 'C' }).bandcamp_url).toBe(
      'https://bandcamp.com/search?q=A%20B'
    );
    expect(synthesizeSearchUrls({ id: 1, artist_name: 'A', album_title: null, track_title: 'C' }).bandcamp_url).toBe(
      'https://bandcamp.com/search?q=A'
    );
  });

  it('SoundCloud prefers trackTitle over artistName (NO album fallback)', () => {
    expect(synthesizeSearchUrls({ id: 1, artist_name: 'A', album_title: 'B', track_title: 'C' }).soundcloud_url).toBe(
      'https://soundcloud.com/search?q=A%20C'
    );
    // No track → falls straight to artist, NOT album. Album-only SoundCloud
    // queries surface unrelated DJ mixes, which is the whole reason for the
    // asymmetric precedence.
    expect(synthesizeSearchUrls({ id: 1, artist_name: 'A', album_title: 'B', track_title: null }).soundcloud_url).toBe(
      'https://soundcloud.com/search?q=A'
    );
  });
});

describe('filterSpacerGif', () => {
  it('returns null for spacer.gif URLs', () => {
    expect(filterSpacerGif('https://i.discogs.com/spacer.gif')).toBeNull();
    expect(filterSpacerGif('https://example.com/path/spacer.gif?v=1')).toBeNull();
  });

  it('preserves non-spacer URLs', () => {
    expect(filterSpacerGif('https://i.discogs.com/abc/cover.jpg')).toBe('https://i.discogs.com/abc/cover.jpg');
  });

  it('returns null for nullish input', () => {
    expect(filterSpacerGif(null)).toBeNull();
    expect(filterSpacerGif(undefined)).toBeNull();
    expect(filterSpacerGif('')).toBeNull();
  });
});

describe('cleanDiscogsBio', () => {
  it('strips Discogs markup tags', () => {
    expect(cleanDiscogsBio('See also [a=Other Artist] for more.')).toBe('See also Other Artist for more.');
    expect(cleanDiscogsBio('Released on [l=Some Label] in 2022.')).toBe('Released on Some Label in 2022.');
    expect(cleanDiscogsBio('Catalog [r=12345] is the master.')).toBe('Catalog 12345 is the master.');
    expect(cleanDiscogsBio('From the [m=67890] master.')).toBe('From the 67890 master.');
  });

  it('strips Discogs URL tags, keeping link text', () => {
    expect(cleanDiscogsBio('See [url=https://example.com]our site[/url] for more.')).toBe('See our site for more.');
  });

  it('leaves plain text alone', () => {
    expect(cleanDiscogsBio('Just a plain bio with no markup.')).toBe('Just a plain bio with no markup.');
  });
});

describe('extractArtwork', () => {
  it("returns the first result's artwork on match", () => {
    expect(extractArtwork(matchResponse)).toEqual(matchResponse.results![0]!.artwork);
  });

  it('returns null when results is empty', () => {
    expect(extractArtwork(noMatchResponse)).toBeNull();
  });

  it('returns null when results[0] has no artwork field', () => {
    expect(extractArtwork({ results: [{}] } as unknown as LookupResponse)).toBeNull();
  });

  it('returns null when results is undefined', () => {
    expect(extractArtwork({} as unknown as LookupResponse)).toBeNull();
  });
});
