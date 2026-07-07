/**
 * Parity test: the on-match 10-column flowsheet UPDATE payload written by
 * `jobs/flowsheet-reenrichment/enrich.ts:reenrichRow` MUST equal the
 * unlinked+match branch of `apps/enrichment-worker/enrich.ts:finalizeRow`.
 *
 * Both jobs target the same column set; the only structural difference is the
 * WHERE guard. If the payloads drift, iOS shows different metadata depending
 * on which path enriched the row. This snapshot pins them in lockstep so
 * the next drift fails CI loudly.
 *
 * Method: drive both functions with identical inputs, capture the `.set()`
 * arg from the mocked DB chain, and assert deep-equal on the 10 metadata
 * columns (excluding metadata_status, which differs by design).
 */
import { jest } from '@jest/globals';

import { db } from '@wxyc/database';
import { reenrichRow, type ReenrichRow } from '../../../../jobs/flowsheet-reenrichment/enrich';
import { finalizeRow, type EnrichRow as WorkerEnrichRow } from '../../../../apps/enrichment-worker/enrich';
import type { LookupResponse } from '@wxyc/lml-client';

const mockDb = db as unknown as {
  update: jest.Mock;
  _chain: {
    set: jest.Mock;
    where: jest.Mock;
    returning: jest.Mock;
  };
};

const METADATA_COLUMNS = [
  'artwork_url',
  'discogs_url',
  'release_year',
  'spotify_url',
  'apple_music_url',
  'youtube_music_url',
  'bandcamp_url',
  'soundcloud_url',
  'artist_bio',
  'artist_wikipedia_url',
] as const;

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
};

const reenrichBaseRow: ReenrichRow = {
  id: 99,
  artist_name: 'Autechre',
  album_title: 'Confield',
  track_title: 'VI Scose Poise',
};

const finalizeBaseRow: WorkerEnrichRow = {
  id: 99,
  artist_name: 'Autechre',
  album_title: 'Confield',
  track_title: 'VI Scose Poise',
  album_id: null, // unlinked, same as reenrichRow's implicit constraint
};

type Cases = {
  name: string;
  response: LookupResponse;
  reenrichRow_row?: ReenrichRow;
  finalizeRow_row?: WorkerEnrichRow;
};
const cases: Cases[] = [
  { name: 'full LML match with all fields', response: matchedResponse },
  {
    name: 'artist-only row (no album/track)',
    response: matchedResponse,
    reenrichRow_row: { id: 99, artist_name: 'Stereolab', album_title: null, track_title: null },
    finalizeRow_row: { id: 99, artist_name: 'Stereolab', album_title: null, track_title: null, album_id: null },
  },
  {
    name: 'zero release_year coerced to null',
    response: {
      ...matchedResponse,
      results: [
        { ...matchedResponse.results[0], artwork: { ...matchedResponse.results[0].artwork!, release_year: 0 } },
      ],
    },
  },
  {
    name: 'spacer.gif artwork_url filtered to null',
    response: {
      ...matchedResponse,
      results: [
        {
          ...matchedResponse.results[0],
          artwork: { ...matchedResponse.results[0].artwork!, artwork_url: 'https://s.discogs.com/images/spacer.gif' },
        },
      ],
    },
  },
];

describe('payload parity: reenrichRow vs finalizeRow (unlinked+match)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: UPDATE matched 1 row (non-raced)
    mockDb._chain.returning.mockResolvedValue([{ id: 99 }]);
  });

  it.each(cases)('$name', async ({ response, reenrichRow_row, finalizeRow_row }) => {
    const rRow = reenrichRow_row ?? reenrichBaseRow;
    const fRow = finalizeRow_row ?? finalizeBaseRow;

    // Capture reenrichRow's payload
    await reenrichRow(rRow, response);
    const reenrichSet = { ...(mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>) };
    jest.clearAllMocks();
    mockDb._chain.returning.mockResolvedValue([{ id: 99 }]);

    // Capture finalizeRow's payload (unlinked branch → album_id=null → same shape)
    await finalizeRow(fRow, response);
    const finalizeSet = { ...(mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>) };

    // Assert the 10 metadata columns match exactly
    for (const col of METADATA_COLUMNS) {
      expect({ col, value: reenrichSet[col] }).toEqual({ col, value: finalizeSet[col] });
    }
  });
});
