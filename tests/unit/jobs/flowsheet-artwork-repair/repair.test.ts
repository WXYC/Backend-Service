/**
 * Unit tests for flowsheet-artwork-repair `repair.ts` (BS#1209).
 *
 * Pins the two write shapes against three invariants from the ticket body:
 *
 *   1. Free-form path (album_id IS NULL): a 10-column UPDATE on `flowsheet`
 *      with an idempotent WHERE narrowing by `id`, `artwork_url IS NULL`,
 *      and `metadata_status = 'enriched_match'`. Status read-only —
 *      `metadata_status` NEVER appears in the .set() block.
 *   2. Linked path (album_id IS NOT NULL): a 10-column UPSERT on
 *      `album_metadata` with `setWhere: album_metadata.updated_at < NOW()`
 *      as the race guard. NO flowsheet write at all.
 *   3. Both paths early-return `still_null_after_lml` when LML's fresh
 *      lookup carries no artwork — those rows are legitimate no-cover-
 *      anywhere releases (post-LML#409) and should not be touched.
 *
 * Race-guard tests exercise the "concurrent fresh enrichment landed first"
 * path: empty `returning()` array ⇒ `raced` for either writer.
 */
import { jest } from '@jest/globals';

import { album_metadata, db, flowsheet } from '@wxyc/database';
import {
  extractArtwork,
  repairFreeFormRow,
  repairLinkedAlbum,
  type FreeFormRow,
  type LinkedAlbum,
} from '../../../../jobs/flowsheet-artwork-repair/repair';
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
  insert: jest.Mock;
  update: jest.Mock;
  _chain: {
    set: jest.Mock;
    where: jest.Mock;
    returning: jest.Mock;
    values: jest.Mock;
    onConflictDoUpdate: jest.Mock;
  };
};

const freeFormRow: FreeFormRow = {
  id: 42,
  artist_name: 'Stereolab',
  album_title: 'Aluminum Tunes',
  track_title: 'Pop Quiz',
};

const linkedAlbum: LinkedAlbum = {
  album_id: 5678,
  artist_name: 'Stereolab',
  album_title: 'Aluminum Tunes',
};

const matchedResponse: LookupResponse = {
  results: [
    {
      library_item: { id: 1 },
      artwork: {
        release_id: 12345,
        release_url: 'https://www.discogs.com/release/12345',
        artwork_url: 'https://i.discogs.com/art.jpg',
        release_year: 1998,
        artist_bio: '[a=Tim Gane] and [a=Lætitia Sadier] are Stereolab.',
        wikipedia_url: 'https://en.wikipedia.org/wiki/Stereolab',
        spotify_url: 'https://open.spotify.com/album/abc',
        apple_music_url: 'https://music.apple.com/album/xyz',
        youtube_music_url: 'https://music.youtube.com/album/aaa',
        bandcamp_url: 'https://stereolab.bandcamp.com/album/aluminum-tunes',
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

describe('extractArtwork', () => {
  it('returns the top-1 artwork block when present', () => {
    expect(extractArtwork(matchedResponse)?.artwork_url).toBe('https://i.discogs.com/art.jpg');
  });

  it('returns null on empty results', () => {
    expect(extractArtwork(noMatchResponse)).toBeNull();
  });

  it('returns null when artwork is null on the top result', () => {
    expect(extractArtwork(noArtworkResponse)).toBeNull();
  });
});

describe('repairFreeFormRow (BS#1209) — free-form UPDATE shape', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb._chain.returning.mockResolvedValue([{ id: freeFormRow.id }]);
  });

  it('writes exactly 10 metadata columns on a fresh LML match — status NEVER touched', async () => {
    const outcome = await repairFreeFormRow(freeFormRow, matchedResponse);
    expect(outcome).toBe('repaired');

    expect(mockDb.update).toHaveBeenCalledWith(flowsheet);
    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;

    // soundcloud_url is null in the fixture; the writer falls back to a
    // synthesized search URL (track-leaning). See the streaming-URL
    // fallback test below for the synthesis invariant.
    expect(setArgs).toEqual({
      artwork_url: 'https://i.discogs.com/art.jpg',
      discogs_url: 'https://www.discogs.com/release/12345',
      release_year: 1998,
      spotify_url: 'https://open.spotify.com/album/abc',
      apple_music_url: 'https://music.apple.com/album/xyz',
      youtube_music_url: 'https://music.youtube.com/album/aaa',
      bandcamp_url: 'https://stereolab.bandcamp.com/album/aluminum-tunes',
      soundcloud_url: `https://soundcloud.com/search?q=${encodeURIComponent('Stereolab Pop Quiz')}`,
      artist_bio: 'Tim Gane and Lætitia Sadier are Stereolab.',
      artist_wikipedia_url: 'https://en.wikipedia.org/wiki/Stereolab',
    });
    expect(Object.keys(setArgs)).toHaveLength(10);
    expect('metadata_status' in setArgs).toBe(false);
    expect('metadata_attempt_at' in setArgs).toBe(false);
  });

  it('falls back to synthesized search URLs when LML returns null for youtube / bandcamp / soundcloud — no regression of populated columns', async () => {
    // Target population for the BS#1209 drain is rows already enriched
    // (`metadata_status='enriched_match'`) whose artwork is null. Those
    // rows likely already carry synthesized search URLs from the original
    // enrichment write. If LML's fresh lookup returns null for any of the
    // three streaming columns, the writer must NOT overwrite the existing
    // value with null — it must instead persist the same synthesized URL
    // shape the original enrichment used. Mirrors enrichment-worker
    // (apps/enrichment-worker/enrich.ts:171-174) + flowsheet-metadata-backfill
    // (jobs/flowsheet-metadata-backfill/enrich.ts:172-174).
    const allStreamingNullResponse: LookupResponse = {
      ...matchedResponse,
      results: [
        {
          library_item: { id: 1 },
          artwork: {
            ...matchedResponse.results[0].artwork!,
            youtube_music_url: null,
            bandcamp_url: null,
            soundcloud_url: null,
          },
        },
      ],
    };
    await repairFreeFormRow(freeFormRow, allStreamingNullResponse);
    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(setArgs.youtube_music_url).toBe(
      `https://music.youtube.com/search?q=${encodeURIComponent('Stereolab Pop Quiz')}`
    );
    expect(setArgs.bandcamp_url).toBe(
      `https://bandcamp.com/search?q=${encodeURIComponent('Stereolab Aluminum Tunes')}`
    );
    expect(setArgs.soundcloud_url).toBe(`https://soundcloud.com/search?q=${encodeURIComponent('Stereolab Pop Quiz')}`);
  });

  it('strips Discogs spacer.gif from artwork_url', async () => {
    const spacerResponse: LookupResponse = {
      ...matchedResponse,
      results: [
        {
          library_item: { id: 1 },
          artwork: { ...matchedResponse.results[0].artwork!, artwork_url: 'https://s.discogs.com/images/spacer.gif' },
        },
      ],
    };
    const outcome = await repairFreeFormRow(freeFormRow, spacerResponse);
    expect(outcome).toBe('repaired');
    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArgs.artwork_url).toBeNull();
  });

  it('coerces release_year=0 (Discogs sentinel for unknown) to null', async () => {
    const zeroYearResponse: LookupResponse = {
      ...matchedResponse,
      results: [
        {
          library_item: { id: 1 },
          artwork: { ...matchedResponse.results[0].artwork!, release_year: 0 },
        },
      ],
    };
    await repairFreeFormRow(freeFormRow, zeroYearResponse);
    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArgs.release_year).toBeNull();
  });

  it('idempotent WHERE narrows by id AND artwork_url IS NULL AND metadata_status=enriched_match', async () => {
    await repairFreeFormRow(freeFormRow, matchedResponse);
    expect(mockDb._chain.where).toHaveBeenCalledTimes(1);
    const rendered = renderSql(mockDb._chain.where.mock.calls[0]?.[0]).toLowerCase();
    expect(rendered).toMatch(/"id"/);
    expect(rendered).toMatch(/artwork_url/);
    expect(rendered).toMatch(/is null/);
    expect(rendered).toMatch(/metadata_status/);
    expect(rendered).toMatch(/enriched_match/);
  });

  it('returns raced when 0 rows update (artwork already non-null OR status flipped)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([]);
    const outcome = await repairFreeFormRow(freeFormRow, matchedResponse);
    expect(outcome).toBe('raced');
  });

  it('returns still_null_after_lml when LML returns empty results — no DB write', async () => {
    const outcome = await repairFreeFormRow(freeFormRow, noMatchResponse);
    expect(outcome).toBe('still_null_after_lml');
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('returns still_null_after_lml when LML returns artwork: null on top hit — no DB write', async () => {
    const outcome = await repairFreeFormRow(freeFormRow, noArtworkResponse);
    expect(outcome).toBe('still_null_after_lml');
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('returns still_null_after_lml when artwork.artwork_url is null on the top hit — no DB write', async () => {
    // Post-LML#409, a release with artist+label but no images[0] returns
    // `artwork.artwork_url: null`. Treat the same as no-match for write
    // purposes — never persist a null over a null.
    const nullArtworkUrl: LookupResponse = {
      ...matchedResponse,
      results: [
        {
          library_item: { id: 1 },
          artwork: { ...matchedResponse.results[0].artwork!, artwork_url: null },
        },
      ],
    };
    const outcome = await repairFreeFormRow(freeFormRow, nullArtworkUrl);
    expect(outcome).toBe('still_null_after_lml');
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});

describe('repairLinkedAlbum (BS#1209) — linked UPSERT shape', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb._chain.returning.mockResolvedValue([{ album_id: linkedAlbum.album_id }]);
  });

  it('UPSERTs exactly 10 metadata columns into album_metadata keyed by album_id — no flowsheet write', async () => {
    const outcome = await repairLinkedAlbum(linkedAlbum, matchedResponse);
    expect(outcome).toBe('repaired');

    expect(mockDb.insert).toHaveBeenCalledWith(album_metadata);
    expect(mockDb.update).not.toHaveBeenCalled();

    const valuesArgs = mockDb._chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(valuesArgs.album_id).toBe(linkedAlbum.album_id);
    expect(valuesArgs.artwork_url).toBe('https://i.discogs.com/art.jpg');
    expect(valuesArgs.discogs_url).toBe('https://www.discogs.com/release/12345');
    expect(valuesArgs.release_year).toBe(1998);
    expect(valuesArgs.artist_bio).toBe('Tim Gane and Lætitia Sadier are Stereolab.');
    expect(renderSql(valuesArgs.updated_at)).toMatch(/now\(\)/i);

    const onConflictArg = mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as {
      target: unknown;
      set: Record<string, unknown>;
      setWhere: unknown;
    };
    expect(onConflictArg.target).toBe(album_metadata.album_id);
    // 10 metadata cols + updated_at sentinel
    expect(Object.keys(onConflictArg.set)).toHaveLength(11);
    expect(onConflictArg.set.artwork_url).toBe('https://i.discogs.com/art.jpg');
    expect(renderSql(onConflictArg.set.updated_at)).toMatch(/now\(\)/i);
    // Race guard: only overwrite a row whose updated_at predates ours.
    // `album_metadata.updated_at` is a stub in the mock so renderSql drops
    // the column-ref chunk; assert on the literal `< NOW()` shape that's
    // load-bearing for correctness.
    const setWhereRendered = renderSql(onConflictArg.setWhere).toLowerCase();
    expect(setWhereRendered).toContain('<');
    expect(setWhereRendered).toContain('now()');
  });

  it('strips spacer.gif from artwork_url in both INSERT values and UPDATE set', async () => {
    const spacerResponse: LookupResponse = {
      ...matchedResponse,
      results: [
        {
          library_item: { id: 1 },
          artwork: { ...matchedResponse.results[0].artwork!, artwork_url: 'https://s.discogs.com/images/spacer.gif' },
        },
      ],
    };
    await repairLinkedAlbum(linkedAlbum, spacerResponse);
    const valuesArgs = mockDb._chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    const onConflictArg = mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as { set: Record<string, unknown> };
    expect(valuesArgs.artwork_url).toBeNull();
    expect(onConflictArg.set.artwork_url).toBeNull();
  });

  it('coerces release_year=0 to null in both INSERT and UPDATE branches', async () => {
    const zeroYearResponse: LookupResponse = {
      ...matchedResponse,
      results: [
        {
          library_item: { id: 1 },
          artwork: { ...matchedResponse.results[0].artwork!, release_year: 0 },
        },
      ],
    };
    await repairLinkedAlbum(linkedAlbum, zeroYearResponse);
    const valuesArgs = mockDb._chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    const onConflictArg = mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as { set: Record<string, unknown> };
    expect(valuesArgs.release_year).toBeNull();
    expect(onConflictArg.set.release_year).toBeNull();
  });

  it('does NOT synthesize streaming search URLs when LML returns null — track_title unavailable in LinkedAlbum (mirrors album-level-backfill)', async () => {
    // Linked path has only artist + album, no track. SoundCloud's
    // track-leaning fallback would degrade to album-only queries that
    // surface unrelated DJ mixes, so the convention (same as
    // album-level-backfill/job.ts:294-296) is `?? null` — leave the
    // column null rather than synthesize against insufficient inputs.
    // The runtime read path COALESCEs over album_metadata + flowsheet, so
    // a null here preserves whatever the flowsheet row already carries.
    const allStreamingNullResponse: LookupResponse = {
      ...matchedResponse,
      results: [
        {
          library_item: { id: 1 },
          artwork: {
            ...matchedResponse.results[0].artwork!,
            youtube_music_url: null,
            bandcamp_url: null,
            soundcloud_url: null,
          },
        },
      ],
    };
    await repairLinkedAlbum(linkedAlbum, allStreamingNullResponse);
    const valuesArgs = mockDb._chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    const onConflictArg = mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as { set: Record<string, unknown> };
    expect(valuesArgs.youtube_music_url).toBeNull();
    expect(valuesArgs.bandcamp_url).toBeNull();
    expect(valuesArgs.soundcloud_url).toBeNull();
    expect(onConflictArg.set.youtube_music_url).toBeNull();
    expect(onConflictArg.set.bandcamp_url).toBeNull();
    expect(onConflictArg.set.soundcloud_url).toBeNull();
  });

  it("returns raced when the UPSERT setWhere doesn't fire (concurrent fresh enrichment)", async () => {
    mockDb._chain.returning.mockResolvedValueOnce([]);
    const outcome = await repairLinkedAlbum(linkedAlbum, matchedResponse);
    expect(outcome).toBe('raced');
  });

  it('returns still_null_after_lml on empty results — no DB write', async () => {
    const outcome = await repairLinkedAlbum(linkedAlbum, noMatchResponse);
    expect(outcome).toBe('still_null_after_lml');
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('returns still_null_after_lml when artwork.artwork_url is null on the top hit — no DB write', async () => {
    const nullArtworkUrl: LookupResponse = {
      ...matchedResponse,
      results: [
        {
          library_item: { id: 1 },
          artwork: { ...matchedResponse.results[0].artwork!, artwork_url: null },
        },
      ],
    };
    const outcome = await repairLinkedAlbum(linkedAlbum, nullArtworkUrl);
    expect(outcome).toBe('still_null_after_lml');
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});
