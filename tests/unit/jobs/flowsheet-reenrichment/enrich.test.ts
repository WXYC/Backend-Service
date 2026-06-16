/**
 * Unit tests for flowsheet-reenrichment enrich.ts.
 *
 * Pins the row-level UPDATE shape per the issue's three changes from finalizeRow:
 *
 *   1. Idempotency guard: WHERE narrows by `metadata_status='enriched_no_match'
 *      AND album_id IS NULL` (not `metadata_status='enriching'`).
 *   2. No-match outcome is a no-op early return (no UPDATE). The four
 *      synthesized search URLs and `enriched_no_match` status are already
 *      correct from the original pass.
 *   3. No linked branch. All rows in this cohort have `album_id IS NULL`.
 *   4. `metadata_attempt_at` is NOT stamped (CDC consumer convention).
 */
import { jest } from '@jest/globals';

import { db, flowsheet } from '@wxyc/database';
import { reenrichRow, type ReenrichRow } from '../../../../jobs/flowsheet-reenrichment/enrich';
import type { LookupResponse } from '@wxyc/lml-client';

type SqlLike = { sql?: string | string[]; queryChunks?: Array<string | { value?: string | string[] }> };
const renderSql = (value: unknown): string => {
  const obj = value as SqlLike | null | undefined;
  if (!obj) return '';
  if (Array.isArray(obj.sql)) return obj.sql.join('');
  if (typeof obj.sql === 'string') return obj.sql;
  if (obj.queryChunks) {
    return obj.queryChunks
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk;
        if (Array.isArray(chunk.value)) return chunk.value.join('');
        if (typeof chunk.value === 'string') return chunk.value;
        return '';
      })
      .join('');
  }
  return '';
};

const mockDb = db as unknown as {
  update: jest.Mock;
  _chain: {
    set: jest.Mock;
    where: jest.Mock;
    returning: jest.Mock;
  };
};

const baseRow: ReenrichRow = {
  id: 42,
  artist_name: 'Autechre',
  album_title: 'Confield',
  track_title: 'VI Scose Poise',
};

const matchedResponse: LookupResponse = {
  results: [
    {
      library_item: { id: 1 },
      artwork: {
        release_id: 12345,
        release_url: 'https://www.discogs.com/release/12345',
        artwork_url: 'https://i.discogs.com/art.jpg',
        release_year: 2001,
        artist_bio: '[a=Rob Brown] and [a=Sean Booth] are Autechre.',
        wikipedia_url: 'https://en.wikipedia.org/wiki/Autechre',
        spotify_url: 'https://open.spotify.com/album/abc',
        apple_music_url: 'https://music.apple.com/album/xyz',
        youtube_music_url: 'https://music.youtube.com/album/aaa',
        bandcamp_url: null,
        soundcloud_url: null,
      },
    },
  ],
  search_type: 'direct',
  song_not_found: false,
};

const noMatchResponse: LookupResponse = {
  results: [],
  search_type: 'none',
  song_not_found: true,
};

const noArtworkResponse: LookupResponse = {
  results: [{ library_item: { id: 1 }, artwork: null }],
  search_type: 'direct',
};

describe('reenrichRow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb._chain.returning.mockResolvedValue([{ id: baseRow.id }]);
  });

  it('writes 10 metadata columns and flips metadata_status to enriched_match on LML match', async () => {
    const outcome = await reenrichRow(baseRow, matchedResponse);
    expect(outcome).toBe('match');
    expect(mockDb.update).toHaveBeenCalledWith(flowsheet);

    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArgs).toMatchObject({
      artwork_url: 'https://i.discogs.com/art.jpg',
      discogs_url: 'https://www.discogs.com/release/12345',
      release_year: 2001,
      spotify_url: 'https://open.spotify.com/album/abc',
      apple_music_url: 'https://music.apple.com/album/xyz',
      youtube_music_url: 'https://music.youtube.com/album/aaa',
      metadata_status: 'enriched_match',
    });
    // bandcamp/soundcloud null on LML response → fall back to synthesized
    expect(setArgs.bandcamp_url).toContain('bandcamp.com/search');
    expect(setArgs.soundcloud_url).toContain('soundcloud.com/search');
    // Bio is cleaned of Discogs markup tags
    expect(setArgs.artist_bio).toBe('Rob Brown and Sean Booth are Autechre.');
    expect(setArgs.artist_wikipedia_url).toBe('https://en.wikipedia.org/wiki/Autechre');
  });

  it('does NOT stamp metadata_attempt_at (CDC consumer convention)', async () => {
    await reenrichRow(baseRow, matchedResponse);
    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('metadata_attempt_at' in setArgs).toBe(false);
  });

  it('idempotency guard: WHERE includes metadata_status=enriched_no_match AND album_id IS NULL', async () => {
    await reenrichRow(baseRow, matchedResponse);
    // Check the WHERE clause passed to the update chain
    const whereCall = mockDb._chain.where.mock.calls[0]?.[0];
    const whereStr = renderSql(whereCall) + JSON.stringify(whereCall);
    // Must reference both conditions
    expect(whereStr).toMatch(/enriched_no_match/);
    expect(whereStr.toLowerCase()).toMatch(/album_id/);
  });

  it('still_no_match: returns still_no_match with no UPDATE when LML returns empty results', async () => {
    const outcome = await reenrichRow(baseRow, noMatchResponse);
    expect(outcome).toBe('still_no_match');
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('still_no_match: returns still_no_match with no UPDATE when artwork is null', async () => {
    const outcome = await reenrichRow(baseRow, noArtworkResponse);
    expect(outcome).toBe('still_no_match');
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('match_raced: returns match_raced when UPDATE returns 0 rows (concurrent status change)', async () => {
    mockDb._chain.returning.mockResolvedValue([]);
    const outcome = await reenrichRow(baseRow, matchedResponse);
    expect(outcome).toBe('match_raced');
  });

  it('does NOT touch album_metadata (no linked branch)', async () => {
    // The new job never UPSERTs album_metadata — all rows are album_id IS NULL
    const mockInsert = db as unknown as { insert: jest.Mock };
    await reenrichRow(baseRow, matchedResponse);
    expect(mockInsert.insert).not.toHaveBeenCalled();
  });

  it('strips Discogs spacer.gif placeholder from artwork_url', async () => {
    const spacerResponse: LookupResponse = {
      ...matchedResponse,
      results: [
        {
          library_item: { id: 1 },
          artwork: {
            ...matchedResponse.results[0].artwork!,
            artwork_url: 'https://s.discogs.com/images/spacer.gif',
          },
        },
      ],
    };

    const outcome = await reenrichRow(baseRow, spacerResponse);
    expect(outcome).toBe('match');
    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArgs.artwork_url).toBeNull();
  });

  it('coerces release_year 0 to null (Discogs "year unknown" sentinel)', async () => {
    const zeroYearResponse: LookupResponse = {
      ...matchedResponse,
      results: [
        {
          library_item: { id: 1 },
          artwork: { ...matchedResponse.results[0].artwork!, release_year: 0 },
        },
      ],
    };
    await reenrichRow(baseRow, zeroYearResponse);
    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArgs.release_year).toBeNull();
  });
});
