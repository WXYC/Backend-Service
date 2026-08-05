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

/**
 * BS#1998: shed classification, ported from the sibling drain's BS#1995
 * Arm 3 guard (`jobs/flowsheet-metadata-backfill/enrich.ts`).
 *
 * This job's no-match arm is a pure no-op, so — unlike the sibling — a shed
 * response cannot *corrupt* a row here: nothing is written either way. What
 * it corrupts is the VERDICT. `still_no_match` is what the runbook tells the
 * operator to read as "LML looked and there is genuinely nothing there," and
 * it is the counter that decides whether a re-run is warranted. Laundering a
 * breaker shed into that bucket reports an un-asked row as an answered one,
 * and the row is never retried within the run.
 *
 * The distinct `upstream_unavailable_skipped` outcome keeps the two apart.
 * Both are no-ops at the DB level; only the count differs — which is the
 * entire point.
 */
describe('reenrichRow (BS#1998) — upstream_unavailable classification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb._chain.returning.mockResolvedValue([{ id: baseRow.id }]);
  });

  const shedResponse: LookupResponse = {
    results: [],
    search_type: 'none',
    degraded: true,
    degraded_reason: 'upstream_unavailable',
  };

  it('degraded_reason: upstream_unavailable with no match is upstream_unavailable_skipped, not still_no_match', async () => {
    const outcome = await reenrichRow(baseRow, shedResponse);

    expect(outcome).toBe('upstream_unavailable_skipped');
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  // Post-LML#1128 the search leg emits the same marker the tail legs always
  // have, so this shape now covers the incident's dominant case too — the
  // reason the sibling job's "indistinguishable search-leg shed" caveat is
  // retired. See LML `lookup/orchestrator.py`'s `degraded = state.upstream_shed`.
  it('search-leg shed (LML#1128: empty results carrying the marker) is skipped, not counted as a verdict', async () => {
    const searchLegShed: LookupResponse = {
      results: [],
      search_type: 'none',
      song_not_found: true,
      degraded: true,
      degraded_reason: 'upstream_unavailable',
    };

    const outcome = await reenrichRow(baseRow, searchLegShed);

    expect(outcome).toBe('upstream_unavailable_skipped');
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  // Mirrors the sibling's B2 review finding: LML's degraded-response builder
  // returns whatever the tail legs produced BEFORE the breaker tripped, so a
  // degraded response CAN carry a complete match. Discarding it would
  // downgrade a real answer to a retry and re-spend the very Discogs ceiling
  // the shed exists to protect.
  it('degraded_reason: upstream_unavailable WITH a populated match still writes as a normal match', async () => {
    const shedWithMatch: LookupResponse = {
      ...matchedResponse,
      degraded: true,
      degraded_reason: 'upstream_unavailable',
    };

    const outcome = await reenrichRow(baseRow, shedWithMatch);

    expect(outcome).toBe('match');
    expect(mockDb.update).toHaveBeenCalledWith(flowsheet);
    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArgs.metadata_status).toBe('enriched_match');
  });

  // The BS#1748 client-side limiter shed carries no `degraded_reason` at all
  // — it never reached LML — and is discriminated by `outcome` via
  // `shedReasonOf`. This job's limiter is unbounded today, so this is a
  // defensive pin, exactly as the sibling job documents it.
  it.each(['shed_limiter_saturated', 'shed_breaker_open'])(
    'BS#1748 client-side shed (outcome: %s) is skipped, not counted as a verdict',
    async (outcome) => {
      const limiterShed = {
        results: [],
        search_type: 'none',
        outcome,
      } as unknown as LookupResponse;

      expect(await reenrichRow(baseRow, limiterShed)).toBe('upstream_unavailable_skipped');
      expect(mockDb.update).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['deadline_exceeded', { results: [], search_type: 'none', degraded: true, degraded_reason: 'deadline_exceeded' }],
    ['timeout', { results: [], search_type: 'none', timeout: true }],
    ['genuine empty', { results: [], search_type: 'none', timeout: false, degraded: false }],
  ])(
    'regression pin: %s STILL counts as still_no_match (deliberate terminal verdicts — do not widen the guard)',
    async (_name, response) => {
      expect(await reenrichRow(baseRow, response as LookupResponse)).toBe('still_no_match');
      expect(mockDb.update).not.toHaveBeenCalled();
    }
  );
});
