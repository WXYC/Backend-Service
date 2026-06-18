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
import type { LookupResponse } from '@wxyc/lml-client';
import { extractArtwork, finalizeRow, synthesizeSearchUrls } from '../../../../apps/enrichment-worker/enrich';

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
    expect(conflictCfg.set.spotify_url).toContain('open.spotify.com/search');
    expect(conflictCfg.set.youtube_music_url).toContain('music.youtube.com/search');
  });

  it('on no-match: flowsheet UPDATE only flips status (race detector stays on flowsheet)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([]);

    const outcome = await finalizeRow(LINKED_ROW, noMatchResponse);

    expect(outcome).toBe('enriched_no_match_raced');
    const setCall = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall.metadata_status).toBe('enriched_no_match');
    expect(setCall).not.toHaveProperty('youtube_music_url');
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
