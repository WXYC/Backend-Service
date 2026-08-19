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

import { album_metadata, db, flowsheet } from '@wxyc/database';
import type { LookupResponse, StreamingResolutionStatus } from '@wxyc/lml-client';
import {
  buildStreamingFieldConflictSet,
  extractArtwork,
  finalizeRow,
  inferIncomingStreamingStatus,
  isBandcampReaskEnabled,
  mergeStreamingField,
  synthesizeSearchUrls,
  type StreamingFieldState,
} from '../../../../apps/enrichment-worker/enrich';

const mockDb = db as unknown as {
  insert: jest.Mock;
  update: jest.Mock;
  _chain: {
    set: jest.Mock;
    where: jest.Mock;
    returning: jest.Mock;
    values: jest.Mock;
    onConflictDoUpdate: jest.Mock;
    onConflictDoNothing: jest.Mock;
  };
};

/**
 * Renders a mocked drizzle-orm `sql` fragment's template text back to a
 * string, splicing `<col>` at each interpolation point — same convention as
 * `tests/unit/shared/database/concerts-sql.test.ts` /
 * `tests/unit/jobs/rotation-release-id-backfill/writer.test.ts`. Works here
 * because `buildStreamingFieldConflictSet` (BS#1923) writes each CASE
 * comparison out at its use site rather than nesting sub-fragments — every
 * returned `SQL` is a single flat `{ sql, values }` under the
 * `tests/__mocks__/drizzle-orm.ts` mock, never a `values` entry that is
 * itself another `sql` fragment.
 */
type SqlLike = { sql?: readonly string[]; values?: unknown[] };
const renderSql = (value: unknown): string => {
  const frag = value as SqlLike | null | undefined;
  if (!frag?.sql) return '';
  return frag.sql.join('<col>');
};
const sqlValues = (value: unknown): unknown[] => (value as SqlLike | null | undefined)?.values ?? [];

// Default row is UNLINKED (album_id=null) — preserves pre-D3 behavior for the
// existing assertions below. Linked-path tests use LINKED_ROW.
const ROW = {
  id: 42,
  artist_name: 'Juana Molina',
  album_title: 'DOGA',
  track_title: 'la paradoja',
  album_id: null,
};

const LINKED_ROW = { ...ROW, album_id: 5678 };

const matchResponse = {
  search_type: 'direct',
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

// Extended-mode response (BS#1336): the worker now sets `extended: true`, so
// the top-1 artwork block carries the 8 LML-only fields. Mirrors the shape in
// proxy.controller's extended-mode test fixture.
const extendedMatchResponse = {
  search_type: 'direct',
  results: [
    {
      artwork: {
        artwork_url: 'https://i.discogs.com/abc/cover.jpg',
        release_url: 'https://discogs.com/release/123',
        release_year: 2022,
        spotify_url: 'https://open.spotify.com/album/x',
        apple_music_url: null,
        youtube_music_url: null,
        bandcamp_url: null,
        soundcloud_url: null,
        artist_bio: null,
        wikipedia_url: null,
        // Extended-only fields
        discogs_artist_id: 3840,
        label: 'Sonamos',
        full_release_date: '2022-09-30',
        genres: ['Rock'],
        styles: ['Folk', 'Indie Rock'],
        tracklist: [{ position: '1', title: 'la paradoja', duration: '4:12' }],
        artist_image_url: 'https://i.discogs.com/artist/juana.jpg',
        profile_tokens: [{ type: 'plainText', text: 'Argentine musician' }],
        // BS#1499: track-level (precise) writer credit. provenance 'track'
        // → composer_source = 'discogs_track'; composer = joined names.
        writer_credits: {
          names: ['Juana Molina'],
          roles: ['Written-By'],
          provenance: 'track',
          track_position: 'A1',
        },
      },
    },
  ],
} as unknown as LookupResponse;

// Release-level (approximate) writer credit (BS#1499): provenance 'release'
// → composer_source = 'discogs_release'. Multiple names join with '; '.
// Exercises the linked + unlinked match arms with a release-provenance writer.
const releaseWriterMatchResponse = {
  search_type: 'direct',
  results: [
    {
      artwork: {
        artwork_url: 'https://i.discogs.com/abc/cover.jpg',
        release_url: 'https://discogs.com/release/123',
        release_year: 2022,
        writer_credits: {
          names: ['Sessa', 'Bianca Vianna'],
          roles: ['Written-By', 'Music By'],
          provenance: 'release',
        },
      },
    },
  ],
} as unknown as LookupResponse;

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
    // BS#1499: matchResponse carries no writer_credits → artist-as-proxy.
    expect(setCall.composer).toBe('Juana Molina');
    expect(setCall.composer_source).toBe('artist_proxy');
  });

  it('on match with a track-level writer credit: writes composer + discogs_track on flowsheet (BS#1499)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);

    await finalizeRow(ROW, extendedMatchResponse);

    const setCall = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall.composer).toBe('Juana Molina');
    expect(setCall.composer_source).toBe('discogs_track');
  });

  it('on match with a release-level writer credit: joins names with "; " + discogs_release on flowsheet (BS#1499)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);

    await finalizeRow(ROW, releaseWriterMatchResponse);

    const setCall = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall.composer).toBe('Sessa; Bianca Vianna');
    expect(setCall.composer_source).toBe('discogs_release');
  });

  it('on no-match: writes 4 synthesized search URLs and flips status to enriched_no_match', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);

    const outcome = await finalizeRow(ROW, noMatchResponse);

    expect(outcome).toBe('enriched_no_match');

    const setCall = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall.metadata_status).toBe('enriched_no_match');
    // The 6 non-search-URL metadata columns are NOT in the .set() —
    // preserves prior values. Apple Music intentionally absent (BS#1192).
    expect(setCall.artwork_url).toBeUndefined();
    expect(setCall.discogs_url).toBeUndefined();
    expect(setCall.release_year).toBeUndefined();
    expect(setCall.apple_music_url).toBeUndefined();
    expect(setCall.artist_bio).toBeUndefined();
    expect(setCall.artist_wikipedia_url).toBeUndefined();
    // The 4 search URLs ARE in the .set().
    expect(setCall.spotify_url).toContain('open.spotify.com/search');
    expect(setCall.youtube_music_url).toContain('music.youtube.com/search');
    expect(setCall.bandcamp_url).toContain('bandcamp.com/search');
    expect(setCall.soundcloud_url).toContain('soundcloud.com/search');
    // BS#1499: no match → no writer credit → artist-as-proxy composer.
    expect(setCall.composer).toBe('Juana Molina');
    expect(setCall.composer_source).toBe('artist_proxy');
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
      search_type: 'direct',
      results: [{ artwork: { artwork_url: 'https://i.discogs.com/x.jpg', release_year: 0 } }],
    } as unknown as LookupResponse;

    await finalizeRow(ROW, response);

    const setCall = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall.release_year).toBeNull();
  });

  it('strips spacer.gif placeholder from artwork_url', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);
    const response = {
      search_type: 'direct',
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

/**
 * BS#1359 — track-context trust gate, exercised through `finalizeRow` end to
 * end (as opposed to the `extractArtwork` unit tests above, which pin the
 * predicate in isolation). AC bullet 2 asks these consequences to be
 * explicit: a trusted `compilation` match still takes the match arm (a V/A
 * comp genuinely carrying the track is a correct match, not a substitution),
 * and an untrusted `alternative`/`fallback` match — even with a populated
 * `artwork` object — takes the SAME no-match arm a genuine LML miss does.
 */
describe('finalizeRow (BS#1359) — track-context trust gate end to end', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("a trusted 'compilation' match takes the match arm (regression pin: compilation is accepted)", async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);
    const compilationResponse = {
      search_type: 'compilation',
      results: [
        {
          artwork: {
            artwork_url: 'https://i.discogs.com/comp/cover.jpg',
            release_url: 'https://discogs.com/release/999',
          },
        },
      ],
    } as unknown as LookupResponse;

    const outcome = await finalizeRow(ROW, compilationResponse);

    expect(outcome).toBe('enriched_match');
    const setCall = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall.metadata_status).toBe('enriched_match');
    expect(setCall.artwork_url).toBe('https://i.discogs.com/comp/cover.jpg');
  });

  it.each(['alternative', 'fallback', 'song_as_artist'])(
    "an untrusted '%s' match (artwork populated) takes the no-match arm, same as a genuine LML miss",
    async (searchType) => {
      mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);
      const untrustedResponse = {
        search_type: searchType,
        results: [
          {
            artwork: {
              artwork_url: 'https://i.discogs.com/wrong-album/cover.jpg',
              release_url: 'https://discogs.com/release/wrong',
            },
          },
        ],
      } as unknown as LookupResponse;

      const outcome = await finalizeRow(ROW, untrustedResponse);

      expect(outcome).toBe('enriched_no_match');
      const setCall = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(setCall.metadata_status).toBe('enriched_no_match');
      // The 6 non-search-URL metadata columns are NOT in the .set() — same
      // shape as a genuine LML miss, never the wrong-album artwork.
      expect(setCall.artwork_url).toBeUndefined();
      expect(setCall.discogs_url).toBeUndefined();
      expect(setCall.spotify_url).toContain('open.spotify.com/search');
    }
  );

  it('BS#2217: an alternative row-less match whose title corresponds to row.album_title takes the match arm', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);
    const rowlessResponse = {
      search_type: 'alternative',
      results: [
        {
          library_item: { id: 0, title: ROW.album_title },
          artwork: {
            artwork_url: 'https://i.discogs.com/rowless/cover.jpg',
            release_url: 'https://discogs.com/release/rowless',
          },
        },
      ],
    } as unknown as LookupResponse;

    const outcome = await finalizeRow(ROW, rowlessResponse);

    expect(outcome).toBe('enriched_match');
    const setCall = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall.metadata_status).toBe('enriched_match');
    expect(setCall.artwork_url).toBe('https://i.discogs.com/rowless/cover.jpg');
  });

  it('BS#2217: an alternative match with a real library_item.id still takes the no-match arm even when the title corresponds (the Vantaa/Animaru shape)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);
    const substitutionResponse = {
      search_type: 'alternative',
      results: [
        {
          library_item: { id: 64288, title: ROW.album_title },
          artwork: {
            artwork_url: 'https://i.discogs.com/wrong-album/cover.jpg',
            release_url: 'https://discogs.com/release/wrong',
          },
        },
      ],
    } as unknown as LookupResponse;

    const outcome = await finalizeRow(ROW, substitutionResponse);

    expect(outcome).toBe('enriched_no_match');
  });

  it('BS#2217: an alternative row-less match whose title does NOT correspond to row.album_title still takes the no-match arm', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);
    const rowlessMismatchResponse = {
      search_type: 'alternative',
      results: [
        {
          library_item: { id: 0, title: 'Some Unrelated Album' },
          artwork: {
            artwork_url: 'https://i.discogs.com/wrong-album/cover.jpg',
            release_url: 'https://discogs.com/release/wrong',
          },
        },
      ],
    } as unknown as LookupResponse;

    const outcome = await finalizeRow(ROW, rowlessMismatchResponse);

    expect(outcome).toBe('enriched_no_match');
  });
});

/**
 * Epic D / BS#899 — when the candidate is linked to a library album
 * (`album_id !== null`), the 10-column metadata payload UPSERTs into
 * `album_metadata` keyed by album_id, and the flowsheet UPDATE only flips
 * `metadata_status`. The race detector stays on the flowsheet UPDATE; the
 * album_metadata UPSERT is idempotent on conflict.
 *
 * D4 (#900) ultimately drops the 10 inline columns from flowsheet. Before
 * then, dual-writer correctness depends on the linked branch never writing
 * those columns inline — these tests pin that boundary.
 */
describe('finalizeRow (BS#899 / Epic D D3) — linked row UPSERTs album_metadata', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('on match: UPSERTs the 10-column payload into album_metadata', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);

    const outcome = await finalizeRow(LINKED_ROW, matchResponse);

    expect(outcome).toBe('enriched_match');
    expect(mockDb.insert).toHaveBeenCalledWith(album_metadata);
    const insertPayload = mockDb._chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertPayload.album_id).toBe(5678);
    expect(insertPayload.artwork_url).toBe('https://i.discogs.com/abc/cover.jpg');
    expect(insertPayload.discogs_url).toBe('https://discogs.com/release/123');
    expect(insertPayload.release_year).toBe(2022);
    expect(insertPayload.spotify_url).toBe('https://open.spotify.com/album/x');
    expect(insertPayload.apple_music_url).toBe('https://music.apple.com/album/y');
    expect(insertPayload.youtube_music_url).toBe('https://music.youtube.com/playlist/z');
    expect(insertPayload.bandcamp_url).toBe('https://artist.bandcamp.com/album/w');
    expect(insertPayload.soundcloud_url).toContain('soundcloud.com/search');
    expect(insertPayload.artist_bio).toBe('A great Some Artist from Argentina.');
    expect(insertPayload.artist_wikipedia_url).toBe('https://en.wikipedia.org/wiki/Juana_Molina');
    expect(insertPayload.updated_at).toBeDefined();
  });

  it('on match: configures onConflictDoUpdate with all 10 columns and a race guard', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);

    await finalizeRow(LINKED_ROW, matchResponse);

    const conflictCfg = mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as {
      target: unknown;
      set: Record<string, unknown>;
      setWhere: unknown;
    };
    expect(conflictCfg).toBeDefined();
    expect(conflictCfg.set.artwork_url).toBe('https://i.discogs.com/abc/cover.jpg');
    expect(conflictCfg.set.artist_bio).toBe('A great Some Artist from Argentina.');
    expect(conflictCfg.set.updated_at).toBeDefined();
    // Race guard: only overwrite when the existing row is older. Prevents the
    // drift-repair backfill from clobbering a fresh runtime enrichment during
    // the dual-writer window before C5 (#894) deletes the in-process callsite.
    expect(conflictCfg.setWhere).toBeDefined();
  });

  it('on match: flowsheet UPDATE only sets metadata_status (no metadata columns)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);

    await finalizeRow(LINKED_ROW, matchResponse);

    expect(mockDb.update).toHaveBeenCalledWith(flowsheet);
    const setCall = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall.metadata_status).toBe('enriched_match');
    // The 10 metadata columns must NOT appear on the flowsheet UPDATE — that's
    // the whole point of Epic D. D4 will drop them; until then the inline
    // values stay at whatever D2 wrote and the COALESCE projection reads
    // through to album_metadata.
    expect(setCall.artwork_url).toBeUndefined();
    expect(setCall.discogs_url).toBeUndefined();
    expect(setCall.release_year).toBeUndefined();
    expect(setCall.spotify_url).toBeUndefined();
    expect(setCall.apple_music_url).toBeUndefined();
    expect(setCall.youtube_music_url).toBeUndefined();
    expect(setCall.bandcamp_url).toBeUndefined();
    expect(setCall.soundcloud_url).toBeUndefined();
    expect(setCall.artist_bio).toBeUndefined();
    expect(setCall.artist_wikipedia_url).toBeUndefined();
    // BS#1499: composer is the deliberate exception — it IS written on the
    // flowsheet UPDATE (it's a per-playcut property, not album-level), even
    // though every other metadata column routes through album_metadata.
    // matchResponse has no writer_credits → artist-as-proxy fallback.
    expect(setCall.composer).toBe('Juana Molina');
    expect(setCall.composer_source).toBe('artist_proxy');
  });

  it('linked match: composer rides the flowsheet UPDATE, not album_metadata (BS#1499)', async () => {
    // The load-bearing design decision: composer is a property of the
    // specific playcut (the track that played), not the album. album_metadata
    // is album-keyed, so two flowsheet rows that played different tracks off
    // the same release would clobber each other's composer there. Therefore
    // composer/composer_source must land on the flowsheet UPDATE and must be
    // ABSENT from the album_metadata UPSERT (insert + conflict-update) payload.
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);

    await finalizeRow(LINKED_ROW, extendedMatchResponse);

    // Flowsheet UPDATE carries composer (track-level credit → discogs_track).
    const setCall = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall.composer).toBe('Juana Molina');
    expect(setCall.composer_source).toBe('discogs_track');

    // album_metadata INSERT payload OMITS composer entirely.
    const insertPayload = mockDb._chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertPayload.composer).toBeUndefined();
    expect(insertPayload.composer_source).toBeUndefined();

    // album_metadata conflict-update set OMITS composer entirely.
    const conflictCfg = mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as { set: Record<string, unknown> };
    expect(conflictCfg.set.composer).toBeUndefined();
    expect(conflictCfg.set.composer_source).toBeUndefined();
  });

  it('on extended match: UPSERTs the 8 LML-only columns into album_metadata (BS#1336)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);

    await finalizeRow(LINKED_ROW, extendedMatchResponse);

    const insertPayload = mockDb._chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertPayload.discogs_artist_id).toBe(3840);
    expect(insertPayload.label).toBe('Sonamos');
    expect(insertPayload.full_release_date).toBe('2022-09-30');
    expect(insertPayload.genres).toEqual(['Rock']);
    expect(insertPayload.styles).toEqual(['Folk', 'Indie Rock']);
    expect(insertPayload.tracklist).toEqual([{ position: '1', title: 'la paradoja', duration: '4:12' }]);
    expect(insertPayload.artist_image_url).toBe('https://i.discogs.com/artist/juana.jpg');
    // `profile_tokens` is persisted under the `bio_tokens` column name.
    expect(insertPayload.bio_tokens).toEqual([{ type: 'plainText', text: 'Argentine musician' }]);

    // The same 8 columns ride the conflict-update set (idempotent re-enrich).
    const conflictCfg = mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as { set: Record<string, unknown> };
    expect(conflictCfg.set.discogs_artist_id).toBe(3840);
    expect(conflictCfg.set.bio_tokens).toEqual([{ type: 'plainText', text: 'Argentine musician' }]);
  });

  it('on extended match: the 8 columns default to null when LML omits them (no extended payload)', async () => {
    // matchResponse carries no extended fields — the worker still requested
    // them, but a degraded/older LML response can omit them. Persisting null
    // (not undefined) keeps the UPSERT column-complete.
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);

    await finalizeRow(LINKED_ROW, matchResponse);

    const insertPayload = mockDb._chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertPayload.discogs_artist_id).toBeNull();
    expect(insertPayload.label).toBeNull();
    expect(insertPayload.genres).toBeNull();
    expect(insertPayload.tracklist).toBeNull();
    expect(insertPayload.bio_tokens).toBeNull();
  });

  it('on extended match: the 8 columns are NOT written inline on flowsheet for an unlinked row', async () => {
    // Unlinked rows write inline on flowsheet, which carries none of the 8
    // BS#1336 columns. The inline UPDATE must stay at the original 10-column
    // shape regardless of the extended payload.
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);

    await finalizeRow(ROW, extendedMatchResponse);

    expect(mockDb.insert).not.toHaveBeenCalled();
    const setCall = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall).not.toHaveProperty('discogs_artist_id');
    expect(setCall).not.toHaveProperty('genres');
    expect(setCall).not.toHaveProperty('tracklist');
    expect(setCall).not.toHaveProperty('bio_tokens');
  });

  it('on no-match: UPSERTs the 4 search URLs into album_metadata', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);

    const outcome = await finalizeRow(LINKED_ROW, noMatchResponse);

    expect(outcome).toBe('enriched_no_match');
    expect(mockDb.insert).toHaveBeenCalledWith(album_metadata);

    const insertPayload = mockDb._chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertPayload.album_id).toBe(5678);
    // BS#1189 widened the no-match shape to 4 URLs: Spotify joined YT/BC/SC.
    // Apple Music intentionally absent (BS#1192).
    expect(insertPayload.spotify_url).toContain('open.spotify.com/search');
    expect(insertPayload.youtube_music_url).toContain('music.youtube.com/search');
    expect(insertPayload.bandcamp_url).toContain('bandcamp.com/search');
    expect(insertPayload.soundcloud_url).toContain('soundcloud.com/search');
    // 6 other metadata fields must NOT be in the insert payload — INSERT
    // path leaves them NULL; UPDATE path leaves existing values untouched
    // (matches the unlinked path's deliberate non-clobbering on no-match).
    expect(insertPayload).not.toHaveProperty('artwork_url');
    expect(insertPayload).not.toHaveProperty('discogs_url');
    expect(insertPayload).not.toHaveProperty('release_year');
    expect(insertPayload).not.toHaveProperty('apple_music_url');
    expect(insertPayload).not.toHaveProperty('artist_bio');
    expect(insertPayload).not.toHaveProperty('artist_wikipedia_url');

    const conflictCfg = mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as {
      set: Record<string, unknown>;
    };
    expect(conflictCfg.set).not.toHaveProperty('artwork_url');
    expect(conflictCfg.set).not.toHaveProperty('artist_bio');
    // BS#1359: the no-match arm's spotify_url/bandcamp_url conflict-update
    // set are now CASE fragments (buildStreamingFieldConflictSet with
    // incomingStatus=undefined) instead of plain search-URL overwrites —
    // never clobber a previously verified URL. See the downgrade-guard test
    // below for the full CASE structure + value pin.
    expect(renderSql(conflictCfg.set.spotify_url)).toBe("CASE WHEN <col> = 'verified' THEN <col> ELSE <col> END");
    expect(sqlValues(conflictCfg.set.spotify_url)).toEqual([
      album_metadata.spotify_status,
      album_metadata.spotify_url,
      expect.stringContaining('open.spotify.com/search'),
    ]);
    // youtube/soundcloud carry no status column — they stay plain
    // search-URL overwrites, unchanged by BS#1359.
    expect(conflictCfg.set.youtube_music_url).toContain('music.youtube.com/search');
  });

  it('on no-match: the spotify_url/bandcamp_url conflict fragments never clobber a previously verified URL (BS#1359)', async () => {
    // Downgrade guard: pin that the no-match arm's CASE fragments open with
    // "is the live status already verified — if so, keep the live url
    // verbatim" as their FIRST branch, mirroring the BS#1923 structural test
    // for the match arm above. This is the fix for the reachability gap the
    // plan calls out — an untrusted `alternative`/`fallback` search_type now
    // routes through this arm too, so the same album can match `direct` on
    // one play (persisting a `verified` spotify_url) and an untrusted type on
    // a later play — this CASE is what stops that later write from
    // downgrading the earlier verified URL.
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);

    await finalizeRow(LINKED_ROW, noMatchResponse);

    const conflictCfg = mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as { set: Record<string, unknown> };
    expect(renderSql(conflictCfg.set.spotify_url)).toBe("CASE WHEN <col> = 'verified' THEN <col> ELSE <col> END");
    expect(sqlValues(conflictCfg.set.spotify_url)[0]).toBe(album_metadata.spotify_status);
    expect(sqlValues(conflictCfg.set.spotify_url)[1]).toBe(album_metadata.spotify_url);
    expect(renderSql(conflictCfg.set.bandcamp_url)).toBe("CASE WHEN <col> = 'verified' THEN <col> ELSE <col> END");
    expect(sqlValues(conflictCfg.set.bandcamp_url)[0]).toBe(album_metadata.bandcamp_status);
    expect(sqlValues(conflictCfg.set.bandcamp_url)[1]).toBe(album_metadata.bandcamp_url);
    // Status columns are untouched — this arm asserts no verdict.
    expect(conflictCfg.set).not.toHaveProperty('spotify_status');
    expect(conflictCfg.set).not.toHaveProperty('bandcamp_status');
    expect(conflictCfg.set).not.toHaveProperty('apple_music_url');
  });

  it('on no-match: flowsheet UPDATE only flips status (race detector stays on flowsheet)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([]);

    const outcome = await finalizeRow(LINKED_ROW, noMatchResponse);

    expect(outcome).toBe('enriched_no_match_raced');
    const setCall = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall.metadata_status).toBe('enriched_no_match');
    expect(setCall).not.toHaveProperty('youtube_music_url');
    // BS#1499: linked no-match still writes composer on the flowsheet UPDATE
    // (artist-as-proxy, since there's no writer credit) — and never on
    // album_metadata.
    expect(setCall.composer).toBe('Juana Molina');
    expect(setCall.composer_source).toBe('artist_proxy');
    const insertPayload = mockDb._chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertPayload.composer).toBeUndefined();
    expect(insertPayload.composer_source).toBeUndefined();
    // …and not on the album_metadata conflict-update set either (symmetry with
    // the linked-match load-bearing assertion).
    const conflictCfg = mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as {
      set: Record<string, unknown>;
    };
    expect(conflictCfg.set.composer).toBeUndefined();
    expect(conflictCfg.set.composer_source).toBeUndefined();
  });

  it('on match: returns enriched_match_raced when the flowsheet UPDATE matches 0 rows', async () => {
    // The album_metadata UPSERT can succeed but the flowsheet UPDATE may
    // still race (C6 sweep reverted it past the claim window). The
    // album_metadata write is intentionally allowed to land — same data
    // outcome from the album's perspective; the metric distinguishes "this
    // worker finalized the row" from "the row was finalized by someone."
    mockDb._chain.returning.mockResolvedValueOnce([]);

    const outcome = await finalizeRow(LINKED_ROW, matchResponse);

    expect(outcome).toBe('enriched_match_raced');
    expect(mockDb.insert).toHaveBeenCalledWith(album_metadata);
  });
});

/**
 * BS#1923 — `buildStreamingFieldConflictSet` builds the `onConflictDoUpdate`
 * `set` fragments for one streaming field as SQL `CASE` expressions over the
 * LIVE `album_metadata` columns, closing the TOCTOU window the old
 * read-then-merge-then-write flow left open (a concurrent CDC verify landing
 * during the LML round-trip could get clobbered by a write computed against
 * a now-stale JS snapshot). These tests pin the exact CASE text and column
 * bindings per `mergeStreamingField` rule/incoming-verdict combination —
 * independent of `finalizeRow`/`upsertMatchedAlbumMetadata`, which the
 * describe blocks further below exercise end to end (still via the mocked
 * `db`, asserting the SAME fragments land in the real `set` object).
 */
describe('buildStreamingFieldConflictSet (BS#1923)', () => {
  // A field WITH a synthesized search-URL fallback (spotify/bandcamp).
  const FALLBACK = 'https://open.spotify.com/search/fallback';

  describe('a field with a search-URL fallback (spotify/bandcamp shape)', () => {
    it('incoming undefined (never consulted): status left unchanged; url recomputes the fresh fallback unless already verified', () => {
      const frag = buildStreamingFieldConflictSet(
        album_metadata.spotify_status,
        album_metadata.spotify_url,
        undefined,
        null,
        FALLBACK
      );

      expect(renderSql(frag.status)).toBe('<col>');
      expect(sqlValues(frag.status)).toEqual([album_metadata.spotify_status]);

      expect(renderSql(frag.url)).toBe("CASE WHEN <col> = 'verified' THEN <col> ELSE <col> END");
      expect(sqlValues(frag.url)).toEqual([album_metadata.spotify_status, album_metadata.spotify_url, FALLBACK]);
    });

    it("incoming 'verified': status becomes 'verified' unconditionally; url adopts incomingUrl unless the live row is already verified", () => {
      const frag = buildStreamingFieldConflictSet(
        album_metadata.spotify_status,
        album_metadata.spotify_url,
        'verified',
        'https://open.spotify.com/album/NEW',
        FALLBACK
      );

      expect(renderSql(frag.status)).toBe("'verified'");
      expect(sqlValues(frag.status)).toEqual([]);

      expect(renderSql(frag.url)).toBe("CASE WHEN <col> = 'verified' THEN <col> ELSE <col> END");
      expect(sqlValues(frag.url)).toEqual([
        album_metadata.spotify_status,
        album_metadata.spotify_url,
        'https://open.spotify.com/album/NEW',
      ]);
    });

    it("incoming 'absent': status becomes 'absent' unless already verified; url falls back to the fresh search URL in that same branch", () => {
      const frag = buildStreamingFieldConflictSet(
        album_metadata.bandcamp_status,
        album_metadata.bandcamp_url,
        'absent',
        null,
        FALLBACK
      );

      expect(renderSql(frag.status)).toBe("CASE WHEN <col> = 'verified' THEN <col> ELSE 'absent' END");
      expect(sqlValues(frag.status)).toEqual([album_metadata.bandcamp_status, album_metadata.bandcamp_status]);

      expect(renderSql(frag.url)).toBe("CASE WHEN <col> = 'verified' THEN <col> ELSE <col> END");
      expect(sqlValues(frag.url)).toEqual([album_metadata.bandcamp_status, album_metadata.bandcamp_url, FALLBACK]);
    });

    it("incoming 'unresolved': status becomes 'unresolved' unless already verified OR already absent (both terminal); url recomputes the fresh fallback in the same non-verified branch", () => {
      const frag = buildStreamingFieldConflictSet(
        album_metadata.bandcamp_status,
        album_metadata.bandcamp_url,
        'unresolved',
        null,
        FALLBACK
      );

      expect(renderSql(frag.status)).toBe(
        "CASE WHEN <col> = 'verified' OR <col> = 'absent' THEN <col> ELSE 'unresolved' END"
      );
      expect(sqlValues(frag.status)).toEqual([
        album_metadata.bandcamp_status,
        album_metadata.bandcamp_status,
        album_metadata.bandcamp_status,
      ]);

      expect(renderSql(frag.url)).toBe("CASE WHEN <col> = 'verified' THEN <col> ELSE <col> END");
      expect(sqlValues(frag.url)).toEqual([album_metadata.bandcamp_status, album_metadata.bandcamp_url, FALLBACK]);
    });
  });

  describe('a field with NO fallback (Apple Music shape, BS#1192)', () => {
    it('incoming undefined: status AND url both left completely unchanged (no CASE at all)', () => {
      const frag = buildStreamingFieldConflictSet(
        album_metadata.apple_music_status,
        album_metadata.apple_music_url,
        undefined,
        null,
        null
      );

      expect(renderSql(frag.status)).toBe('<col>');
      expect(sqlValues(frag.status)).toEqual([album_metadata.apple_music_status]);
      // No fallback → no CASE at all; the url column is left as a bare
      // self-reference (a structural no-op UPDATE, not a search-URL guess).
      expect(renderSql(frag.url)).toBe('<col>');
      expect(sqlValues(frag.url)).toEqual([album_metadata.apple_music_url]);
    });

    it("incoming 'verified': same shape as a fallback field — adopts incomingUrl unless already verified (no fallback needed on this branch)", () => {
      const frag = buildStreamingFieldConflictSet(
        album_metadata.apple_music_status,
        album_metadata.apple_music_url,
        'verified',
        'https://music.apple.com/album/NEW',
        null
      );

      expect(renderSql(frag.status)).toBe("'verified'");
      expect(renderSql(frag.url)).toBe("CASE WHEN <col> = 'verified' THEN <col> ELSE <col> END");
      expect(sqlValues(frag.url)).toEqual([
        album_metadata.apple_music_status,
        album_metadata.apple_music_url,
        'https://music.apple.com/album/NEW',
      ]);
    });

    it("incoming 'absent': url's non-verified branch is forced NULL (the fallback param), not a search URL", () => {
      const frag = buildStreamingFieldConflictSet(
        album_metadata.apple_music_status,
        album_metadata.apple_music_url,
        'absent',
        null,
        null
      );

      expect(renderSql(frag.status)).toBe("CASE WHEN <col> = 'verified' THEN <col> ELSE 'absent' END");
      expect(renderSql(frag.url)).toBe("CASE WHEN <col> = 'verified' THEN <col> ELSE <col> END");
      expect(sqlValues(frag.url)).toEqual([album_metadata.apple_music_status, album_metadata.apple_music_url, null]);
    });

    it("incoming 'unresolved': url is left as the bare live column in EVERY branch — never changes for an unresolved verdict", () => {
      const frag = buildStreamingFieldConflictSet(
        album_metadata.apple_music_status,
        album_metadata.apple_music_url,
        'unresolved',
        null,
        null
      );

      expect(renderSql(frag.status)).toBe(
        "CASE WHEN <col> = 'verified' OR <col> = 'absent' THEN <col> ELSE 'unresolved' END"
      );
      // No CASE for the url at all — matches `mergeStreamingField` rule 6
      // (carry `current.url` forward unchanged) with no post-merge fallback
      // ternary layered on top (unlike spotify/bandcamp).
      expect(renderSql(frag.url)).toBe('<col>');
      expect(sqlValues(frag.url)).toEqual([album_metadata.apple_music_url]);
    });
  });
});

/**
 * BS#1915 — bounded self-heal of unresolved streaming links, consuming
 * LML#1053's per-service `verified` / `absent` / `unresolved` verdict on
 * `DiscogsMatchResult.streaming_status`.
 *
 * The linked-match arm now reads the album's PRIOR persisted streaming
 * state before writing, and merges it with the fresh LML verdict via
 * `mergeStreamingField` — never downgrading an already-`verified` field,
 * treating `absent` as terminal (url forced null), and leaving `unresolved`
 * transient (retry-eligible). `streaming_reask_attempts` — the shared
 * per-album bound, not per-service — increments ONLY on the conflict-update
 * branch (a genuine re-ask against an existing row); a fresh album's
 * first-ever write leaves it at the schema DEFAULT 0.
 *
 * BS#1923 folds that merge directly into the UPSERT as CASE expressions
 * over the LIVE row (`buildStreamingFieldConflictSet`, tested independently
 * above) — the describe block below exercises `finalizeRow` end to end and
 * asserts the resulting `set` fragments structurally (their rendered CASE
 * text + bound values), since they are no longer plain merged JS values.
 * BS#1924 gates the `streaming_reask_attempts` bump on a pre-existing
 * load-bearing match, tested further below.
 */
describe('finalizeRow (BS#1915) — streaming self-heal merge on the linked-match arm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fresh album: persists a verified/absent/unresolved per-service status alongside each url', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);
    const response = {
      search_type: 'direct',
      results: [
        {
          artwork: {
            artwork_url: 'https://i.discogs.com/abc/cover.jpg',
            release_url: 'https://discogs.com/release/123',
            spotify_url: 'https://open.spotify.com/album/x',
            apple_music_url: null,
            bandcamp_url: null,
            streaming_status: { spotify: 'verified', apple_music: 'unresolved', bandcamp: 'absent' },
          },
        },
      ],
    } as unknown as LookupResponse;

    await finalizeRow(LINKED_ROW, response);

    const insertPayload = mockDb._chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertPayload.spotify_status).toBe('verified');
    expect(insertPayload.spotify_url).toBe('https://open.spotify.com/album/x');
    expect(insertPayload.apple_music_status).toBe('unresolved');
    expect(insertPayload.apple_music_url).toBeNull();
    expect(insertPayload.bandcamp_status).toBe('absent');
    // Bandcamp (unlike Apple Music) keeps its pre-#1915 synthesized
    // search-URL fallback for any non-verified status — status='absent' is
    // tracked, but the displayed url still falls back so the UX doesn't
    // regress. Only Apple Music has no fallback (BS#1192).
    expect(insertPayload.bandcamp_url).toContain('bandcamp.com/search');
  });

  it('infers verified from a bare non-null url when streaming_status is entirely absent (pre-LML#1053 compatibility)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);
    // matchResponse carries real spotify_url/apple_music_url but no
    // streaming_status object at all (an LML predating the LML#1053
    // producer rollout, or a path that doesn't resolve one).
    await finalizeRow(LINKED_ROW, matchResponse);

    const insertPayload = mockDb._chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertPayload.spotify_status).toBe('verified');
    expect(insertPayload.spotify_url).toBe('https://open.spotify.com/album/x');
    expect(insertPayload.apple_music_status).toBe('verified');
    expect(insertPayload.apple_music_url).toBe('https://music.apple.com/album/y');
  });

  it('never overwrites a previously verified URL, even when a later re-ask flaps to unresolved or absent (BS#1923: checked against the LIVE row, not a stale read)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);
    const flappyResponse = {
      search_type: 'direct',
      results: [
        {
          artwork: {
            artwork_url: 'https://i.discogs.com/abc/cover.jpg',
            release_url: 'https://discogs.com/release/123',
            spotify_url: null,
            apple_music_url: null,
            streaming_status: { spotify: 'unresolved', apple_music: 'absent' },
          },
        },
      ],
    } as unknown as LookupResponse;

    await finalizeRow(LINKED_ROW, flappyResponse);

    // There is no more prior-state mock to flap against — the write no
    // longer reads a snapshot at all. The invariant instead has to hold
    // structurally: the CASE's FIRST branch, evaluated by Postgres against
    // whatever the row actually holds at write time, is always "is the live
    // status already verified — if so, keep the live status/url verbatim."
    // A concurrently-verified row can therefore never be downgraded by this
    // write, regardless of what LML's flappy verdict says.
    const conflictCfg = mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as { set: Record<string, unknown> };
    expect(renderSql(conflictCfg.set.spotify_status)).toBe(
      "CASE WHEN <col> = 'verified' OR <col> = 'absent' THEN <col> ELSE 'unresolved' END"
    );
    expect(sqlValues(conflictCfg.set.spotify_status)).toEqual([
      album_metadata.spotify_status,
      album_metadata.spotify_status,
      album_metadata.spotify_status,
    ]);
    expect(renderSql(conflictCfg.set.spotify_url)).toBe("CASE WHEN <col> = 'verified' THEN <col> ELSE <col> END");
    // The THEN branch (live status IS verified) reads the LIVE spotify_url
    // column, not a fabricated/stale value — that is what makes the prior
    // verified URL survive a flappy re-ask.
    expect(sqlValues(conflictCfg.set.spotify_url)[0]).toBe(album_metadata.spotify_status);
    expect(sqlValues(conflictCfg.set.spotify_url)[1]).toBe(album_metadata.spotify_url);

    expect(renderSql(conflictCfg.set.apple_music_status)).toBe(
      "CASE WHEN <col> = 'verified' THEN <col> ELSE 'absent' END"
    );
    expect(renderSql(conflictCfg.set.apple_music_url)).toBe("CASE WHEN <col> = 'verified' THEN <col> ELSE <col> END");
    expect(sqlValues(conflictCfg.set.apple_music_url)[0]).toBe(album_metadata.apple_music_status);
    expect(sqlValues(conflictCfg.set.apple_music_url)[1]).toBe(album_metadata.apple_music_url);
  });

  it('absent is terminal: the non-verified branch forces status=absent/url=NULL, whether the live row was already absent or newly flapping there', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);
    const response = {
      search_type: 'direct',
      results: [
        {
          artwork: {
            artwork_url: 'https://i.discogs.com/abc/cover.jpg',
            release_url: 'https://discogs.com/release/123',
            apple_music_url: null,
            streaming_status: { apple_music: 'absent' },
          },
        },
      ],
    } as unknown as LookupResponse;

    await finalizeRow(LINKED_ROW, response);

    const conflictCfg = mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as { set: Record<string, unknown> };
    expect(renderSql(conflictCfg.set.apple_music_status)).toBe(
      "CASE WHEN <col> = 'verified' THEN <col> ELSE 'absent' END"
    );
    // Apple Music has no search-URL fallback (BS#1192) — the non-verified
    // branch's url is the literal NULL fallback param, not a live-column
    // carry-forward.
    expect(renderSql(conflictCfg.set.apple_music_url)).toBe("CASE WHEN <col> = 'verified' THEN <col> ELSE <col> END");
    expect(sqlValues(conflictCfg.set.apple_music_url)).toEqual([
      album_metadata.apple_music_status,
      album_metadata.apple_music_url,
      null,
    ]);
  });

  it('a never-consulted service (key omitted, no url) is left as a bare self-reference — structurally cannot invent a verdict', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);
    const response = {
      search_type: 'direct',
      results: [
        {
          artwork: {
            artwork_url: 'https://i.discogs.com/abc/cover.jpg',
            release_url: 'https://discogs.com/release/123',
            spotify_url: null,
            apple_music_url: null,
            bandcamp_url: null,
            // bandcamp key deliberately omitted from streaming_status, and
            // its url is null — inferIncomingStreamingStatus returns
            // undefined (genuinely never consulted this round).
            streaming_status: { spotify: 'unresolved' },
          },
        },
      ],
    } as unknown as LookupResponse;

    await finalizeRow(LINKED_ROW, response);

    const conflictCfg = mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as { set: Record<string, unknown> };
    // status is a bare column self-reference — whatever the live row holds
    // survives untouched, never overwritten with an invented verdict.
    expect(renderSql(conflictCfg.set.bandcamp_status)).toBe('<col>');
    expect(sqlValues(conflictCfg.set.bandcamp_status)).toEqual([album_metadata.bandcamp_status]);
    // bandcamp DOES have a search-URL fallback (unlike Apple Music), so its
    // url still recomputes the fresh synthesized search URL whenever the
    // live status isn't verified — same recompute rule as every other
    // non-verified branch, unrelated to this round's never-consulted status.
    expect(renderSql(conflictCfg.set.bandcamp_url)).toBe("CASE WHEN <col> = 'verified' THEN <col> ELSE <col> END");
    const bandcampUrlValues = sqlValues(conflictCfg.set.bandcamp_url);
    expect(bandcampUrlValues[0]).toBe(album_metadata.bandcamp_status);
    expect(bandcampUrlValues[1]).toBe(album_metadata.bandcamp_url);
    expect(bandcampUrlValues[2]).toContain('bandcamp.com/search');
  });
});

/**
 * BS#1924 — the shared per-album `streaming_reask_attempts` counter must
 * increment only on a GENUINE re-ask of an already-enriched album, never on
 * a BS#1089 no-match shell row's first real match (a shell already has an
 * `album_metadata` row — search-URLs only — so its first real match also
 * hits the `onConflictDoUpdate` branch and used to miscount 0->1 before any
 * actual re-ask happened). The gate gets checked against the LIVE
 * `artwork_url`/`discogs_url` columns as they stood BEFORE this write (the
 * same pre-UPDATE-row evaluation every other `set` expression in this
 * statement relies on) — composes with the BS#1923 CASE rewrite in the same
 * `set` clause. The actual VALUE this CASE resolves to at conflict time (0
 * for a shell's first match, N+1 for a genuine re-ask) is a real-Postgres
 * fact, pinned by the integration spec
 * (tests/integration/enrichment-worker-streaming-toctou.spec.js); this
 * suite pins the CASE's structure and its wiring into `finalizeRow`.
 */
describe('finalizeRow (BS#1924) — re-ask counter gated on a pre-existing load-bearing match', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('never appears in the fresh-INSERT branch — a brand-new row leaves the counter at its schema DEFAULT 0', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);

    await finalizeRow(LINKED_ROW, matchResponse);

    const insertPayload = mockDb._chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertPayload).not.toHaveProperty('streaming_reask_attempts');
  });

  it('the conflict-update CASE only increments when the live row already carries artwork_url OR discogs_url', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);

    await finalizeRow(LINKED_ROW, matchResponse);

    const conflictCfg = mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as { set: Record<string, unknown> };
    expect(renderSql(conflictCfg.set.streaming_reask_attempts)).toBe(
      'CASE\n' +
        '          WHEN <col> IS NOT NULL OR <col> IS NOT NULL\n' +
        '          THEN <col> + 1\n' +
        '          ELSE <col>\n' +
        '        END'
    );
    expect(sqlValues(conflictCfg.set.streaming_reask_attempts)).toEqual([
      album_metadata.artwork_url,
      album_metadata.discogs_url,
      album_metadata.streaming_reask_attempts,
      album_metadata.streaming_reask_attempts,
    ]);
  });
});

describe('mergeStreamingField + inferIncomingStreamingStatus (BS#1915)', () => {
  const FRESH: StreamingFieldState = { status: null, url: null };

  describe('inferIncomingStreamingStatus', () => {
    it('trusts an explicit status over url presence', () => {
      expect(inferIncomingStreamingStatus('unresolved', 'https://example.com/x')).toBe('unresolved');
    });

    it('infers verified from a bare non-null url when no explicit status is given', () => {
      expect(inferIncomingStreamingStatus(undefined, 'https://example.com/x')).toBe('verified');
    });

    it('returns undefined (genuinely unknown) when there is neither an explicit status nor a url', () => {
      expect(inferIncomingStreamingStatus(undefined, null)).toBeUndefined();
      expect(inferIncomingStreamingStatus(undefined, undefined)).toBeUndefined();
    });
  });

  describe('mergeStreamingField', () => {
    const asStatus = (s: StreamingResolutionStatus) => s;

    it('never-consulted this round (incomingStatus undefined) preserves the current state exactly', () => {
      const current: StreamingFieldState = { status: 'unresolved', url: null };
      expect(mergeStreamingField(current, undefined, undefined)).toEqual(current);
    });

    it('never overwrites an already-verified field — not with a fresh url, not with absent, not with unresolved', () => {
      const current: StreamingFieldState = { status: 'verified', url: 'https://example.com/PRIOR' };
      expect(mergeStreamingField(current, asStatus('verified'), 'https://example.com/NEW')).toEqual(current);
      expect(mergeStreamingField(current, asStatus('absent'), null)).toEqual(current);
      expect(mergeStreamingField(current, asStatus('unresolved'), null)).toEqual(current);
    });

    it('verified: adopts the incoming url and status', () => {
      expect(mergeStreamingField(FRESH, asStatus('verified'), 'https://example.com/x')).toEqual({
        status: 'verified',
        url: 'https://example.com/x',
      });
    });

    it('absent: terminal — url forced null regardless of any stray incoming url', () => {
      expect(mergeStreamingField(FRESH, asStatus('absent'), 'https://example.com/should-be-ignored')).toEqual({
        status: 'absent',
        url: null,
      });
    });

    it('never downgrades a terminal absent field — a later unresolved/absent flap is ignored (BS#1747/#1089)', () => {
      // Reachable when the album is pulled in to heal a SIBLING unresolved
      // field: the whole row is re-merged, and if LML's fresh probe flaps the
      // already-absent service to 'unresolved', the field must NOT be
      // resurrected for re-ask (that is the negative-cache amplifier
      // BS#1747/#1089 killed).
      const current: StreamingFieldState = { status: 'absent', url: null };
      expect(mergeStreamingField(current, asStatus('unresolved'), null)).toEqual(current);
      expect(mergeStreamingField(current, asStatus('absent'), null)).toEqual(current);
      expect(mergeStreamingField(current, undefined, undefined)).toEqual(current);
    });

    it('absent → verified: a genuine resolved url supersedes a prior absent (a release that finally appeared)', () => {
      const current: StreamingFieldState = { status: 'absent', url: null };
      expect(mergeStreamingField(current, asStatus('verified'), 'https://example.com/new')).toEqual({
        status: 'verified',
        url: 'https://example.com/new',
      });
    });

    it('unresolved: transient — status flips to unresolved; url carries forward from current, never fabricated', () => {
      expect(mergeStreamingField(FRESH, asStatus('unresolved'), null)).toEqual({ status: 'unresolved', url: null });
      const current: StreamingFieldState = { status: 'unresolved', url: null };
      expect(mergeStreamingField(current, asStatus('unresolved'), null)).toEqual({ status: 'unresolved', url: null });
    });
  });
});

describe('synthesizeSearchUrls (per-service precedence)', () => {
  it('Spotify prefers trackTitle over albumTitle over artistName (same selector as YT)', () => {
    // Path-style URL (no `?q=`) — must match LML's `_build_streaming_search_url`
    // for byte-identical alignment so iOS reads back the same URL whether LML
    // surfaced it or BS synthesized it (BS#1185 + LML#401).
    expect(
      synthesizeSearchUrls({ id: 1, artist_name: 'A', album_title: 'B', track_title: 'C', album_id: null }).spotify_url
    ).toBe('https://open.spotify.com/search/A%20C');
    expect(
      synthesizeSearchUrls({ id: 1, artist_name: 'A', album_title: 'B', track_title: null, album_id: null }).spotify_url
    ).toBe('https://open.spotify.com/search/A%20B');
    expect(
      synthesizeSearchUrls({ id: 1, artist_name: 'A', album_title: null, track_title: null, album_id: null })
        .spotify_url
    ).toBe('https://open.spotify.com/search/A');
  });

  it('YouTube Music prefers trackTitle over albumTitle over artistName', () => {
    expect(
      synthesizeSearchUrls({ id: 1, artist_name: 'A', album_title: 'B', track_title: 'C', album_id: null })
        .youtube_music_url
    ).toBe('https://music.youtube.com/search?q=A%20C');
    expect(
      synthesizeSearchUrls({ id: 1, artist_name: 'A', album_title: 'B', track_title: null, album_id: null })
        .youtube_music_url
    ).toBe('https://music.youtube.com/search?q=A%20B');
    expect(
      synthesizeSearchUrls({ id: 1, artist_name: 'A', album_title: null, track_title: null, album_id: null })
        .youtube_music_url
    ).toBe('https://music.youtube.com/search?q=A');
  });

  it('Bandcamp prefers albumTitle over artistName (NO track fallback)', () => {
    expect(
      synthesizeSearchUrls({ id: 1, artist_name: 'A', album_title: 'B', track_title: 'C', album_id: null }).bandcamp_url
    ).toBe('https://bandcamp.com/search?q=A%20B');
    expect(
      synthesizeSearchUrls({ id: 1, artist_name: 'A', album_title: null, track_title: 'C', album_id: null })
        .bandcamp_url
    ).toBe('https://bandcamp.com/search?q=A');
  });

  it('SoundCloud prefers trackTitle over artistName (NO album fallback)', () => {
    expect(
      synthesizeSearchUrls({ id: 1, artist_name: 'A', album_title: 'B', track_title: 'C', album_id: null })
        .soundcloud_url
    ).toBe('https://soundcloud.com/search?q=A%20C');
    // No track → falls straight to artist, NOT album. Album-only SoundCloud
    // queries surface unrelated DJ mixes, which is the whole reason for the
    // asymmetric precedence.
    expect(
      synthesizeSearchUrls({ id: 1, artist_name: 'A', album_title: 'B', track_title: null, album_id: null })
        .soundcloud_url
    ).toBe('https://soundcloud.com/search?q=A');
  });
});

describe('extractArtwork', () => {
  it("returns the first result's artwork on a trusted 'direct' match", () => {
    expect(extractArtwork(matchResponse)).toEqual(matchResponse.results![0]!.artwork);
  });

  it('returns null when results is empty', () => {
    expect(extractArtwork(noMatchResponse)).toBeNull();
  });

  it('returns null when results[0] has no artwork field', () => {
    expect(extractArtwork({ results: [{}], search_type: 'direct' } as unknown as LookupResponse)).toBeNull();
  });

  it('returns null when results is undefined', () => {
    expect(extractArtwork({ search_type: 'direct' } as unknown as LookupResponse)).toBeNull();
  });

  /**
   * BS#1359 — track-context trust gate. `isTrustedLmlTrackContextMatch`
   * accepts `direct` and `compilation`; every other `search_type` (including
   * absent) is a same-artist substitution (the Yenbett class) and must be
   * treated as no-match regardless of whether LML populated an `artwork`
   * object.
   */
  describe('BS#1359 track-context trust gate', () => {
    const withSearchType = (searchType: string | undefined) =>
      ({
        results: [
          {
            artwork: {
              artwork_url: 'https://i.discogs.com/abc/cover.jpg',
              release_url: 'https://discogs.com/release/123',
            },
          },
        ],
        ...(searchType !== undefined ? { search_type: searchType } : {}),
      }) as unknown as LookupResponse;

    it("accepts 'compilation' (a V/A comp genuinely carrying the track is a correct match)", () => {
      const response = withSearchType('compilation');
      expect(extractArtwork(response)).toEqual(response.results![0]!.artwork);
    });

    it("walks past a null-artwork results[0] to a later compilation entry that carries it (BS#961 shape — the gate accepts 'compilation', so extraction must too)", () => {
      const laterArtwork = {
        artwork_url: 'https://i.discogs.com/comp/later.jpg',
        release_url: 'https://discogs.com/release/comp',
      };
      const response = {
        search_type: 'compilation',
        results: [{ artwork: null }, { artwork: laterArtwork }],
      } as unknown as LookupResponse;
      expect(extractArtwork(response)).toEqual(laterArtwork);
    });

    it.each(['alternative', 'fallback', 'song_as_artist', 'none'])(
      "rejects search_type '%s' even when artwork is populated",
      (searchType) => {
        expect(extractArtwork(withSearchType(searchType))).toBeNull();
      }
    );

    it('rejects an absent search_type (fail-closed)', () => {
      expect(extractArtwork(withSearchType(undefined))).toBeNull();
    });
  });

  describe('BS#2217 request<->result correspondence', () => {
    const rowlessResponse = (title: string) =>
      ({
        search_type: 'alternative',
        results: [
          {
            library_item: { id: 0, title },
            artwork: { artwork_url: 'https://i.discogs.com/rowless/cover.jpg', release_url: 'https://discogs.com/release/rowless' },
          },
        ],
      }) as unknown as LookupResponse;

    it('returns the artwork when a row-less alternative match corresponds to requestedAlbum', () => {
      const response = rowlessResponse('The Spiritual Sound');
      expect(extractArtwork(response, 'The Spiritual Sound')).toEqual(response.results![0]!.artwork);
    });

    it('returns null when requestedAlbum is omitted — carve-out inactive, identical to pre-BS#2217 behavior', () => {
      expect(extractArtwork(rowlessResponse('The Spiritual Sound'))).toBeNull();
    });

    it('returns null when requestedAlbum does not correspond to the returned title', () => {
      expect(extractArtwork(rowlessResponse('The Spiritual Sound'), 'A Different Album')).toBeNull();
    });
  });
});

/**
 * Bandcamp re-ask de-freeze (iOS Bandcamp search-fallback program).
 *
 * The freeze this un-sticks: a MATCHED album (load-bearing artwork/discogs
 * present) for which LML returns no direct `bandcamp_url` and no explicit
 * `streaming_status.bandcamp` currently persists `bandcamp_status = NULL` +
 * the synthesized `bandcamp.com/search?q=` fallback URL. NULL is
 * indistinguishable from "never consulted" — neither `precheck.ts` nor the
 * BS#1915 streaming-reask sweep ever re-ask a NULL-status field — so once
 * the LML-side workstreams teach LML to resolve a direct Bandcamp URL, that
 * fresh URL can never reach the already-written row: it stays frozen on the
 * search fallback forever (the same class of permanent-null freeze BS#1747
 * documents for the Apple/Spotify precheck skip).
 *
 * The interlock, Bandcamp-only, behind `ENRICHMENT_BANDCAMP_REASK` (default
 * off, so merging is a no-op until the LML side is live): when LML returns a
 * match with no Bandcamp verdict at all, infer `'unresolved'` (retryable)
 * instead of leaving the status NULL. The displayed URL still falls back to
 * the search URL (no UX regression — same as pre-#1915 Bandcamp), but the
 * STATUS now says "retryable, not verified", so the existing status-driven
 * sweep re-asks it and a later direct URL supersedes the fallback. The
 * coercion is Bandcamp-scoped on purpose: Apple Music's NULL is load-bearing
 * "no verified iTunes match" (BS#1192) and must NOT become a re-ask magnet.
 */
describe('Bandcamp re-ask de-freeze — ENRICHMENT_BANDCAMP_REASK gate', () => {
  const priorFlag = process.env.ENRICHMENT_BANDCAMP_REASK;

  afterEach(() => {
    if (priorFlag === undefined) delete process.env.ENRICHMENT_BANDCAMP_REASK;
    else process.env.ENRICHMENT_BANDCAMP_REASK = priorFlag;
  });

  describe('isBandcampReaskEnabled', () => {
    it("is true only for the exact string 'true'", () => {
      process.env.ENRICHMENT_BANDCAMP_REASK = 'true';
      expect(isBandcampReaskEnabled()).toBe(true);
    });

    it('is false when unset', () => {
      delete process.env.ENRICHMENT_BANDCAMP_REASK;
      expect(isBandcampReaskEnabled()).toBe(false);
    });

    it.each(['false', '1', 'yes', 'TRUE', ''])("is false for a non-'true' value (%p)", (raw) => {
      process.env.ENRICHMENT_BANDCAMP_REASK = raw;
      expect(isBandcampReaskEnabled()).toBe(false);
    });
  });

  // Linked match whose artwork carries NO bandcamp signal at all: no direct
  // url, no streaming_status object. This is exactly the shape that freezes
  // bandcamp_status at NULL today.
  const bandcampMissingResponse = {
    search_type: 'direct',
    results: [
      {
        artwork: {
          artwork_url: 'https://i.discogs.com/abc/cover.jpg',
          release_url: 'https://discogs.com/release/123',
          spotify_url: 'https://open.spotify.com/album/x',
          apple_music_url: null,
          bandcamp_url: null,
        },
      },
    ],
  } as unknown as LookupResponse;

  describe('flag OFF (default) — behavior is exactly as before', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      delete process.env.ENRICHMENT_BANDCAMP_REASK;
    });

    it('a match with no bandcamp url/status leaves bandcamp_status NULL on the fresh INSERT', async () => {
      mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);

      await finalizeRow(LINKED_ROW, bandcampMissingResponse);

      const insertPayload = mockDb._chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(insertPayload.bandcamp_status).toBeNull();
      // The display URL still falls back to the synthesized search URL.
      expect(insertPayload.bandcamp_url).toContain('bandcamp.com/search');
    });

    it('the conflict branch leaves bandcamp_status a bare, unchanged column reference (never consulted)', async () => {
      mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);

      await finalizeRow(LINKED_ROW, bandcampMissingResponse);

      const conflictCfg = mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as { set: Record<string, unknown> };
      expect(renderSql(conflictCfg.set.bandcamp_status)).toBe('<col>');
      expect(sqlValues(conflictCfg.set.bandcamp_status)).toEqual([album_metadata.bandcamp_status]);
    });
  });

  describe('flag ON — a bandcamp-less match becomes retryable (unresolved), not frozen', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      process.env.ENRICHMENT_BANDCAMP_REASK = 'true';
    });

    it("persists bandcamp_status='unresolved' + the search-fallback url on the fresh INSERT", async () => {
      mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);

      await finalizeRow(LINKED_ROW, bandcampMissingResponse);

      const insertPayload = mockDb._chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(insertPayload.bandcamp_status).toBe('unresolved');
      // Display fallback preserved — status carries the "retryable" signal,
      // the URL stays clickable.
      expect(insertPayload.bandcamp_url).toContain('bandcamp.com/search');
    });

    it('the conflict branch flips bandcamp_status to the retryable CASE (unless already verified/absent)', async () => {
      mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);

      await finalizeRow(LINKED_ROW, bandcampMissingResponse);

      const conflictCfg = mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as { set: Record<string, unknown> };
      // Same shape buildStreamingFieldConflictSet emits for an incoming
      // 'unresolved' verdict: terminal verified/absent are preserved, anything
      // else (NULL included) becomes 'unresolved'.
      expect(renderSql(conflictCfg.set.bandcamp_status)).toBe(
        "CASE WHEN <col> = 'verified' OR <col> = 'absent' THEN <col> ELSE 'unresolved' END"
      );
      // URL recomputes the search fallback in the non-verified branch.
      expect(renderSql(conflictCfg.set.bandcamp_url)).toBe("CASE WHEN <col> = 'verified' THEN <col> ELSE <col> END");
      const bandcampUrlValues = sqlValues(conflictCfg.set.bandcamp_url);
      expect(bandcampUrlValues[2]).toContain('bandcamp.com/search');
    });

    it('does NOT touch a genuinely verified bandcamp — a real direct url still infers verified', async () => {
      mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);
      // matchResponse carries a real bandcamp_url → inferred 'verified',
      // coercion never fires.
      await finalizeRow(LINKED_ROW, matchResponse);

      const insertPayload = mockDb._chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(insertPayload.bandcamp_status).toBe('verified');
      expect(insertPayload.bandcamp_url).toBe('https://artist.bandcamp.com/album/w');
    });

    it("does NOT override an explicit LML 'absent' bandcamp verdict (absent stays terminal)", async () => {
      mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);
      const absentResponse = {
        search_type: 'direct',
        results: [
          {
            artwork: {
              artwork_url: 'https://i.discogs.com/abc/cover.jpg',
              release_url: 'https://discogs.com/release/123',
              bandcamp_url: null,
              streaming_status: { bandcamp: 'absent' },
            },
          },
        ],
      } as unknown as LookupResponse;

      await finalizeRow(LINKED_ROW, absentResponse);

      const insertPayload = mockDb._chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(insertPayload.bandcamp_status).toBe('absent');
    });

    it('leaves Apple Music and Spotify inference untouched — coercion is Bandcamp-only', async () => {
      mockDb._chain.returning.mockResolvedValueOnce([{ id: 42 }]);
      // bandcampMissingResponse has apple_music_url null and no apple status —
      // Apple must stay NULL (never a re-ask magnet), only bandcamp is coerced.
      await finalizeRow(LINKED_ROW, bandcampMissingResponse);

      const insertPayload = mockDb._chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(insertPayload.apple_music_status).toBeNull();
      // Spotify DID carry a url → verified, unrelated to the bandcamp coercion.
      expect(insertPayload.spotify_status).toBe('verified');
    });
  });
});
