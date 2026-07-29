/**
 * Unit tests for flowsheet-metadata-backfill enrich.ts.
 *
 * Pins the row-level UPDATE shape against #639's contract guarantees, cut
 * over to the `metadata_status` guard by BS#895 (Epic C C6):
 *   1. On LML success-with-match, all 10 metadata columns are written and
 *      `metadata_status = 'enriched_match'` (+ the historical
 *      `metadata_attempt_at = sql\`now()\`` marker) is in the same .set()
 *      block.
 *   2. On LML success-no-match, the three search-URL columns are written
 *      and `metadata_status = 'enriched_no_match'` is set — no-match is
 *      still an attempt the recurring sweep should not retry.
 *   3. The .set() block calls `eq(flowsheet.id, row.id)` AND
 *      `eq(flowsheet.metadata_status, fromStatus)` (default `'pending'`) so
 *      a concurrent writer (the CDC worker claiming the row, or — for the
 *      W4 self-heal pass, `fromStatus: 'enriched_no_match'` — a different
 *      race) landing between the caller's SELECT and this UPDATE wins.
 *
 * spacer.gif filter and Discogs bio cleanup are covered directly in
 * tests/unit/shared/metadata/; exercised here transitively via
 * applyEnrichment's match-path assertions.
 */
import { jest } from '@jest/globals';

import { album_metadata, db, flowsheet } from '@wxyc/database';
import {
  applyEnrichment,
  extractArtwork,
  stampDeadLetter,
  type EnrichRow,
} from '../../../../jobs/flowsheet-metadata-backfill/enrich';
import type { LookupResponse } from '@wxyc/lml-client';

type SqlLike = {
  sql?: string | string[];
  values?: unknown[];
  queryChunks?: Array<string | { value?: string | string[] }>;
};
/**
 * `drizzle-orm` is mocked in the unit harness to `{ sql: string[], values }`
 * (the raw template's text chunks and its bound params, kept separate) —
 * same shape `worklist.test.ts`'s harness uses. `renderSql` below only
 * stitches the TEMPLATE TEXT back together (the bound params render as
 * nothing in that shape), so a column name interpolated as a literal in the
 * template is visible via `renderSql`, but a bound VALUE (e.g. the
 * `fromStatus` string param) is only visible via `boundValues`.
 */
const boundValues = (value: unknown): unknown[] => (value as SqlLike | null | undefined)?.values ?? [];
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

const baseRow: EnrichRow = {
  id: 42,
  artist_name: 'Autechre',
  album_title: 'Confield',
  track_title: 'VI Scose Poise',
  album_id: null,
};

const linkedRow: EnrichRow = { ...baseRow, album_id: 5678 };

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

describe('applyEnrichment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default to "1 row updated" so existing match/no-match assertions
    // exercise the non-raced path. Tests that pin the race detector
    // override with `.mockResolvedValueOnce([])`.
    mockDb._chain.returning.mockResolvedValue([{ id: baseRow.id }]);
  });

  it('writes 10 metadata columns, flips metadata_status to enriched_match, and stamps the historical metadata_attempt_at marker on LML success-with-match', async () => {
    const outcome = await applyEnrichment(baseRow, matchedResponse);
    expect(outcome).toBe('enriched_match');
    expect(mockDb.update).toHaveBeenCalledWith(flowsheet);

    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArgs).toMatchObject({
      artwork_url: 'https://i.discogs.com/art.jpg',
      discogs_url: 'https://www.discogs.com/release/12345',
      release_year: 2001,
      spotify_url: 'https://open.spotify.com/album/abc',
      apple_music_url: 'https://music.apple.com/album/xyz',
      youtube_music_url: 'https://music.youtube.com/album/aaa',
      // bandcamp_url / soundcloud_url were null on the LML response → fall
      // back to the synthesized search URLs (mirrors metadata.service.ts).
      metadata_status: 'enriched_match',
    });
    expect(setArgs.bandcamp_url).toContain('bandcamp.com/search');
    expect(setArgs.soundcloud_url).toContain('soundcloud.com/search');
    // Bio is cleaned of Discogs markup tags
    expect(setArgs.artist_bio).toBe('Rob Brown and Sean Booth are Autechre.');
    expect(setArgs.artist_wikipedia_url).toBe('https://en.wikipedia.org/wiki/Autechre');
    // The stamp is the canonical sql`now()` chunk, not a JS Date. Still
    // written (BS#895: no longer the control-flow gate, but kept for the
    // other jobs still keyed on it — see enrich.ts's module docstring).
    expect(renderSql(setArgs.metadata_attempt_at)).toMatch(/now\(\)/i);
  });

  it('writes synthesized search URLs (4), flips metadata_status to enriched_no_match, and stamps the marker on LML success-no-match (empty results)', async () => {
    const outcome = await applyEnrichment(baseRow, noMatchResponse);
    expect(outcome).toBe('enriched_no_match');

    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    // BS#1189 widened the no-match shape to 4 URLs: Spotify joined YT/BC/SC
    // as a write-path fallback. Apple Music is intentionally absent (BS#1192
    // — null is load-bearing "no verified iTunes match" signal).
    expect(setArgs.spotify_url).toContain('open.spotify.com/search');
    expect(setArgs.youtube_music_url).toContain('music.youtube.com/search');
    expect(setArgs.bandcamp_url).toContain('bandcamp.com/search');
    expect(setArgs.soundcloud_url).toContain('soundcloud.com/search');
    expect(setArgs.metadata_status).toBe('enriched_no_match');
    expect(renderSql(setArgs.metadata_attempt_at)).toMatch(/now\(\)/i);
    // The 6 non-search-URL metadata columns should NOT be set on no-match
    // (so they remain NULL in the DB) — the runtime path produces the same
    // shape. Apple Music is also absent (BS#1192).
    expect('artwork_url' in setArgs).toBe(false);
    expect('discogs_url' in setArgs).toBe(false);
    expect('release_year' in setArgs).toBe(false);
    expect('apple_music_url' in setArgs).toBe(false);
    expect('artist_bio' in setArgs).toBe(false);
    expect('artist_wikipedia_url' in setArgs).toBe(false);
  });

  it('treats artwork: null the same as no-match', async () => {
    const outcome = await applyEnrichment(baseRow, noArtworkResponse);
    expect(outcome).toBe('enriched_no_match');
  });

  it('strips Discogs spacer.gif placeholder from artwork_url (#638 note 1, until #649 lands)', async () => {
    const spacerResponse: LookupResponse = {
      ...matchedResponse,
      results: [
        {
          library_item: { id: 1 },
          artwork: {
            ...matchedResponse.results[0].artwork,
            artwork_url: 'https://s.discogs.com/images/spacer.gif',
          },
        },
      ],
    };

    const outcome = await applyEnrichment(baseRow, spacerResponse);
    expect(outcome).toBe('enriched_match');
    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArgs.artwork_url).toBeNull();
  });

  it('cache-hit shape (apple_music_url key absent on artwork): inline UPDATE omits apple_music_url so the row preserves any prior value', async () => {
    // Reproduces the artwork shape after lookup-cache.ts's
    // `stripTrackAwareUrls` deletes per-track URL fields on cache hits.
    // BS#1192: apple_music_url is track-aware on LML's side and `null`
    // is load-bearing. Including `apple_music_url: null` here would
    // overwrite any prior value on the flowsheet row's column —
    // unlikely to matter on first-attempt rows (typically NULL already)
    // but a real loss if an out-of-band path had stamped a value.
    const artworkSansApple = { ...matchedResponse.results[0].artwork! };
    delete artworkSansApple.apple_music_url;
    const responseFromCache: LookupResponse = {
      ...matchedResponse,
      results: [{ ...matchedResponse.results[0], artwork: artworkSansApple }],
    };

    await applyEnrichment(baseRow, responseFromCache);
    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('apple_music_url' in setArgs).toBe(false);
  });

  it("LML returned apple_music_url: null (no verified iTunes match): inline UPDATE writes null (records LML's decision)", async () => {
    // Distinct from cache-hit: here LML's response explicitly carries
    // `apple_music_url: null`, meaning "no verified Apple match". The
    // `in` witness fires (key present), so the conditional spread
    // records the decision rather than omitting the field.
    const artworkAppleNull = { ...matchedResponse.results[0].artwork!, apple_music_url: null };
    const responseAppleNull: LookupResponse = {
      ...matchedResponse,
      results: [{ ...matchedResponse.results[0], artwork: artworkAppleNull }],
    };

    await applyEnrichment(baseRow, responseAppleNull);
    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('apple_music_url' in setArgs).toBe(true);
    expect(setArgs.apple_music_url).toBeNull();
  });

  // BS#1338: extend the apple_music_url cache-hit-preservation pattern to
  // the four search URLs. On cache hit, lookup-cache.ts strips all five
  // track-aware URL keys. Without the conditional spread, the `?? search`
  // fallback would synthesize a per-row search URL for R2 and the inline
  // UPDATE would carry it; on the linked path, the album_metadata UPSERT's
  // `setWhere updated_at < NOW()` would then clobber R1's verified deep
  // link with R2's per-row synthesized URL.
  describe.each(['spotify_url', 'youtube_music_url', 'bandcamp_url', 'soundcloud_url'] as const)(
    'cache-hit conditional spread on %s',
    (field) => {
      it(`cache-hit shape (${field} key absent on artwork): inline UPDATE omits ${field} so the row preserves any prior value`, async () => {
        const artworkSansField = { ...matchedResponse.results[0].artwork! };
        delete artworkSansField[field];
        const responseFromCache: LookupResponse = {
          ...matchedResponse,
          results: [{ ...matchedResponse.results[0], artwork: artworkSansField }],
        };

        await applyEnrichment(baseRow, responseFromCache);
        const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(field in setArgs).toBe(false);
      });

      it(`LML returned ${field}: null (no LML decision): inline UPDATE falls back to synthesized search URL (records LML's decision via the witness)`, async () => {
        // Distinct from cache-hit: the key is PRESENT on artwork with value
        // null. The conditional-spread witness fires, the `??` fallback then
        // chooses the synthesized search URL — matches the pre-cache shape
        // and the unlinked-no-match path's fallback for the same field.
        const artworkFieldNull = { ...matchedResponse.results[0].artwork!, [field]: null };
        const responseFieldNull: LookupResponse = {
          ...matchedResponse,
          results: [{ ...matchedResponse.results[0], artwork: artworkFieldNull }],
        };

        await applyEnrichment(baseRow, responseFieldNull);
        const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(field in setArgs).toBe(true);
        // The synthesized URL's host segment depends on the field; check it's a
        // string ending in a `search` token rather than verified-URL-shaped.
        expect(typeof setArgs[field]).toBe('string');
        expect(setArgs[field] as string).toMatch(/\/search/);
      });
    }
  );

  it('idempotency guard: WHERE narrows by id AND metadata_status = fromStatus (default pending)', async () => {
    // The WHERE makes the UPDATE a no-op against rows a concurrent writer
    // (the CDC worker claiming this row) already moved off `fromStatus`.
    // Verify .where() was called once with a single expression whose
    // rendered SQL references both columns, bound to the default status.
    await applyEnrichment(baseRow, matchedResponse);
    expect(mockDb._chain.where).toHaveBeenCalledTimes(1);
    const whereArg = mockDb._chain.where.mock.calls[0]?.[0];
    const rendered = renderSql(whereArg);
    expect(rendered).toMatch(/id/);
    expect(rendered.toLowerCase()).toMatch(/metadata_status/);
    expect(boundValues(whereArg)).toContain('pending');
  });

  it('defaults fromStatus to pending but honors an explicit override (W4 self-heal reuse)', async () => {
    await applyEnrichment(baseRow, matchedResponse, { fromStatus: 'enriched_no_match' });
    const whereArg = mockDb._chain.where.mock.calls[0]?.[0];
    const values = boundValues(whereArg);
    expect(values).toContain('enriched_no_match');
    expect(values).not.toContain('pending');
  });

  it('returns enriched_match_raced when 0 rows update (a concurrent writer claimed the row first)', async () => {
    // Race scenario: between the caller's SELECT and this UPDATE, a
    // concurrent writer (the CDC worker) moved the row off `fromStatus`, so
    // the guard no longer matches and Postgres updates 0 rows. The data
    // outcome is identical (both writers produce the same payload) — only
    // the metric splits.
    mockDb._chain.returning.mockResolvedValueOnce([]);

    const outcome = await applyEnrichment(baseRow, matchedResponse);
    expect(outcome).toBe('enriched_match_raced');
  });

  it('returns enriched_no_match_raced when 0 rows update on the no-match path', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([]);

    const outcome = await applyEnrichment(baseRow, noMatchResponse);
    expect(outcome).toBe('enriched_no_match_raced');
  });
});

/**
 * Epic D / BS#1027 — when the backfill row is linked to a library album
 * (`album_id !== null`), the 10-column metadata payload UPSERTs into
 * `album_metadata` keyed by album_id, and the flowsheet UPDATE only flips
 * `metadata_status` (+ stamps the historical `metadata_attempt_at`
 * marker). The race detector stays on the flowsheet UPDATE (BS#895:
 * `metadata_status = fromStatus` guard), and the album_metadata UPSERT
 * carries a `updated_at < NOW()` setWhere so a delayed backfill cycle can't
 * clobber a fresher runtime/worker enrichment. Mirrors the D3 worker
 * pattern in `apps/enrichment-worker/enrich.ts` (BS#899).
 *
 * Contract difference from the worker, narrowed by BS#895: both now guard
 * on `metadata_status`, but the backfill's `fromStatus` defaults to
 * `'pending'` (rows the consumer never claimed) while the W4 self-heal pass
 * overrides it to `'enriched_no_match'` (rows already terminal); the worker
 * always guards on `'enriching'` (a claim it made itself).
 */
describe('applyEnrichment (BS#1027) — linked row UPSERTs album_metadata', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb._chain.returning.mockResolvedValue([{ id: linkedRow.id }]);
  });

  it('on match: UPSERTs the 10-column payload into album_metadata keyed by album_id', async () => {
    const outcome = await applyEnrichment(linkedRow, matchedResponse);
    expect(outcome).toBe('enriched_match');
    expect(mockDb.insert).toHaveBeenCalledWith(album_metadata);

    const insertPayload = mockDb._chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertPayload.album_id).toBe(linkedRow.album_id);
    expect(insertPayload.artwork_url).toBe('https://i.discogs.com/art.jpg');
    expect(insertPayload.discogs_url).toBe('https://www.discogs.com/release/12345');
    expect(insertPayload.release_year).toBe(2001);
    expect(insertPayload.spotify_url).toBe('https://open.spotify.com/album/abc');
    expect(insertPayload.apple_music_url).toBe('https://music.apple.com/album/xyz');
    expect(insertPayload.youtube_music_url).toBe('https://music.youtube.com/album/aaa');
    // bandcamp + soundcloud were null on LML → fall back to synthesized.
    expect(insertPayload.bandcamp_url).toContain('bandcamp.com/search');
    expect(insertPayload.soundcloud_url).toContain('soundcloud.com/search');
    expect(insertPayload.artist_bio).toBe('Rob Brown and Sean Booth are Autechre.');
    expect(insertPayload.artist_wikipedia_url).toBe('https://en.wikipedia.org/wiki/Autechre');
    expect(insertPayload.updated_at).toBeDefined();
  });

  it('on match: onConflictDoUpdate carries all 10 columns + race guard setWhere(updated_at < NOW())', async () => {
    await applyEnrichment(linkedRow, matchedResponse);

    const conflictCfg = mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as {
      target: unknown;
      set: Record<string, unknown>;
      setWhere: unknown;
    };
    expect(conflictCfg).toBeDefined();
    expect(conflictCfg.set.artwork_url).toBe('https://i.discogs.com/art.jpg');
    expect(conflictCfg.set.artist_bio).toBe('Rob Brown and Sean Booth are Autechre.');
    expect(conflictCfg.set.updated_at).toBeDefined();
    // The race guard prevents stale backfill writes from clobbering a fresher
    // runtime / worker enrichment of the same album_id.
    expect(conflictCfg.setWhere).toBeDefined();
    expect(renderSql(conflictCfg.setWhere)).toMatch(/<\s*NOW\(\)/i);
  });

  it('on match: flowsheet UPDATE flips metadata_status + stamps metadata_attempt_at only (no inline metadata columns)', async () => {
    await applyEnrichment(linkedRow, matchedResponse);

    expect(mockDb.update).toHaveBeenCalledWith(flowsheet);
    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(renderSql(setArgs.metadata_attempt_at)).toMatch(/now\(\)/i);
    expect(setArgs.metadata_status).toBe('enriched_match');
    // The 10 metadata columns must NOT appear on the flowsheet UPDATE — that's
    // the whole point of the D3 dual-write split. The inline drift this fixes
    // is exactly this previous behavior.
    expect(setArgs).not.toHaveProperty('artwork_url');
    expect(setArgs).not.toHaveProperty('discogs_url');
    expect(setArgs).not.toHaveProperty('release_year');
    expect(setArgs).not.toHaveProperty('spotify_url');
    expect(setArgs).not.toHaveProperty('apple_music_url');
    expect(setArgs).not.toHaveProperty('youtube_music_url');
    expect(setArgs).not.toHaveProperty('bandcamp_url');
    expect(setArgs).not.toHaveProperty('soundcloud_url');
    expect(setArgs).not.toHaveProperty('artist_bio');
    expect(setArgs).not.toHaveProperty('artist_wikipedia_url');
  });

  it('on cache-hit (apple_music_url absent on artwork): album_metadata UPSERT omits apple_music_url from INSERT and SET so a prior verified URL is preserved', async () => {
    // The destructive scenario this guards: R1 misses cache, calls LML for
    // (artist, album, track A), receives apple_music_url='/song/123',
    // UPSERTs album_metadata with that value. Cache stores R1's response.
    // R2 same (artist, album) but track B; hits cache; stripped artwork
    // has no apple_music_url key. Without the conditional spread, R2's
    // payload would carry `apple_music_url: null`; the UPSERT's
    // `setWhere updated_at < NOW()` predicate always passes within a
    // batch (R1's updated_at is microseconds in the past), so the UPDATE
    // would overwrite R1's '/song/123' with null. The conditional spread
    // means R2's set clause omits the column entirely, preserving R1's
    // verified URL on album_metadata. Mirror to BS#1192.
    const artworkSansApple = { ...matchedResponse.results[0].artwork! };
    delete artworkSansApple.apple_music_url;
    const responseFromCache: LookupResponse = {
      ...matchedResponse,
      results: [{ ...matchedResponse.results[0], artwork: artworkSansApple }],
    };

    await applyEnrichment(linkedRow, responseFromCache);

    const insertPayload = mockDb._chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('apple_music_url' in insertPayload).toBe(false);

    const conflictCfg = mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as {
      set: Record<string, unknown>;
    };
    expect('apple_music_url' in conflictCfg.set).toBe(false);
  });

  // BS#1338: linked-path twin of the unlinked cache-hit tests above. The
  // destructive scenario this guards: R1 misses cache, calls LML for
  // (artist, album, track A), receives spotify_url='https://open.spotify.com/album/abc',
  // UPSERTs album_metadata with that verified deep-link. Cache stores R1's
  // response. R2 same (artist, album) but track B; hits cache; stripped
  // artwork has no spotify_url key. Without the conditional spread, R2's
  // payload would synthesize `https://open.spotify.com/search/<artist>%20<track-B>`;
  // the UPSERT's `setWhere updated_at < NOW()` predicate always passes
  // within a batch (R1's updated_at is microseconds in the past), so the
  // UPDATE would overwrite R1's verified deep-link with R2's per-row
  // synthesized search URL — album-level table loses album-level data.
  // The conditional spread means R2's set clause omits the column
  // entirely, preserving R1's verified URL on album_metadata.
  describe.each(['spotify_url', 'youtube_music_url', 'bandcamp_url', 'soundcloud_url'] as const)(
    'on cache-hit (linked path) — %s',
    (field) => {
      it(`album_metadata UPSERT omits ${field} from INSERT and onConflictDoUpdate.set so a prior verified URL is preserved`, async () => {
        const artworkSansField = { ...matchedResponse.results[0].artwork! };
        delete artworkSansField[field];
        const responseFromCache: LookupResponse = {
          ...matchedResponse,
          results: [{ ...matchedResponse.results[0], artwork: artworkSansField }],
        };

        await applyEnrichment(linkedRow, responseFromCache);

        const insertPayload = mockDb._chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(field in insertPayload).toBe(false);

        const conflictCfg = mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as {
          set: Record<string, unknown>;
        };
        expect(field in conflictCfg.set).toBe(false);
      });
    }
  );

  it('on match: flowsheet WHERE still uses the metadata_status race detector (one where call, non-empty predicate)', async () => {
    // Linked path uses typed `and(eq(flowsheet.id, row.id),
    // eq(flowsheet.metadata_status, fromStatus))` builders (BS#895). Column
    // refs are compile-time checked against the schema; the race-detector
    // behavior is covered by the _raced tests below.
    await applyEnrichment(linkedRow, matchedResponse);
    expect(mockDb._chain.where).toHaveBeenCalledTimes(1);
    expect(mockDb._chain.where.mock.calls[0]?.[0]).toBeDefined();
  });

  it('on no-match: UPSERTs the 4 search URLs into album_metadata', async () => {
    const outcome = await applyEnrichment(linkedRow, noMatchResponse);
    expect(outcome).toBe('enriched_no_match');
    expect(mockDb.insert).toHaveBeenCalledWith(album_metadata);

    const insertPayload = mockDb._chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertPayload.album_id).toBe(linkedRow.album_id);
    // BS#1189 widened the no-match shape to 4 URLs: Spotify joined YT/BC/SC.
    // Apple Music intentionally absent (BS#1192).
    expect(insertPayload.spotify_url).toContain('open.spotify.com/search');
    expect(insertPayload.youtube_music_url).toContain('music.youtube.com/search');
    expect(insertPayload.bandcamp_url).toContain('bandcamp.com/search');
    expect(insertPayload.soundcloud_url).toContain('soundcloud.com/search');
    // 6 other metadata fields must NOT be in the insert payload — INSERT path
    // leaves them NULL; UPDATE path leaves existing values untouched.
    expect(insertPayload).not.toHaveProperty('artwork_url');
    expect(insertPayload).not.toHaveProperty('discogs_url');
    expect(insertPayload).not.toHaveProperty('release_year');
    expect(insertPayload).not.toHaveProperty('apple_music_url');
    expect(insertPayload).not.toHaveProperty('artist_bio');
    expect(insertPayload).not.toHaveProperty('artist_wikipedia_url');

    const conflictCfg = mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as {
      set: Record<string, unknown>;
      setWhere: unknown;
    };
    expect(conflictCfg.set).not.toHaveProperty('artwork_url');
    expect(conflictCfg.set).not.toHaveProperty('artist_bio');
    // BS#895 finding #3: the conflict-path set clause fill-nulls each of the
    // 4 search-URL columns via COALESCE(existing, excluded) rather than
    // overwriting unconditionally — see the dedicated COALESCE test below
    // for the full clobber-prevention contract. Spot-check here that this
    // branch is no longer a bare string (the pre-fix shape) but a COALESCE
    // expression; the synthesized value itself is asserted via `values`
    // (the mocked drizzle harness blanks interpolated args from the
    // rendered `.sql` text — see `boundValues`/`renderSql`'s doc comment).
    expect(typeof conflictCfg.set.spotify_url).not.toBe('string');
    expect(renderSql(conflictCfg.set.spotify_url)).toMatch(/COALESCE/i);
    expect(renderSql(conflictCfg.set.spotify_url)).toContain('excluded."spotify_url"');
    expect(typeof conflictCfg.set.youtube_music_url).not.toBe('string');
    expect(renderSql(conflictCfg.set.youtube_music_url)).toMatch(/COALESCE/i);
    expect(renderSql(conflictCfg.set.youtube_music_url)).toContain('excluded."youtube_music_url"');
    expect(conflictCfg.setWhere).toBeDefined();
    expect(renderSql(conflictCfg.setWhere)).toMatch(/<\s*NOW\(\)/i);
  });

  it('on no-match: conflict-path set clause fill-nulls all 4 search-URL columns via COALESCE(existing, excluded) — never clobbers a real streaming URL (BS#895 W4 self-heal re-attempt safety)', async () => {
    await applyEnrichment(linkedRow, noMatchResponse);

    const conflictCfg = mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as {
      set: Record<string, unknown>;
    };
    for (const field of ['spotify_url', 'youtube_music_url', 'bandcamp_url', 'soundcloud_url'] as const) {
      const rendered = renderSql(conflictCfg.set[field]);
      const values = boundValues(conflictCfg.set[field]);
      // The rendered template text is `COALESCE(<interpolated>, excluded."<field>")`
      // — the mocked drizzle harness blanks the interpolated arg from the
      // joined `.sql` text (same shape documented on `boundValues` above),
      // so the visible text alone already proves the existing-column
      // reference sits BEFORE the literal `, excluded."<field>")` suffix —
      // i.e. COALESCE's first (winning) argument is the existing value, not
      // `excluded`. `values` confirms an interpolation happened at all
      // (the mock's album_metadata.<field> placeholder is the field's own
      // name — see tests/mocks/database.mock.ts).
      expect(rendered).toMatch(/^COALESCE\(/i);
      expect(rendered).toBe(`COALESCE(, excluded."${field}")`);
      expect(values).toContain(field);
    }
    // updated_at is NOT COALESCE'd — freezing it would neuter the setWhere
    // race guard (a stale run could never re-pass `updated_at < NOW()`).
    expect(renderSql(conflictCfg.set.updated_at)).not.toMatch(/COALESCE/i);
    expect(renderSql(conflictCfg.set.updated_at)).toMatch(/NOW\(\)/i);
  });

  it('on no-match: flowsheet UPDATE flips metadata_status + stamps metadata_attempt_at only (no inline URLs)', async () => {
    await applyEnrichment(linkedRow, noMatchResponse);

    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(renderSql(setArgs.metadata_attempt_at)).toMatch(/now\(\)/i);
    expect(setArgs.metadata_status).toBe('enriched_no_match');
    expect(setArgs).not.toHaveProperty('youtube_music_url');
    expect(setArgs).not.toHaveProperty('bandcamp_url');
    expect(setArgs).not.toHaveProperty('soundcloud_url');
  });

  it('on match: returns enriched_match_raced when the flowsheet UPDATE matches 0 rows', async () => {
    // album_metadata UPSERT lands; flowsheet UPDATE races because a
    // concurrent writer (the CDC worker) already moved the row off
    // `fromStatus` in the window between the caller's SELECT and this
    // UPDATE.
    mockDb._chain.returning.mockResolvedValueOnce([]);

    const outcome = await applyEnrichment(linkedRow, matchedResponse);
    expect(outcome).toBe('enriched_match_raced');
    // The album_metadata UPSERT still ran — same data outcome from the
    // album's perspective; only the metric splits.
    expect(mockDb.insert).toHaveBeenCalledWith(album_metadata);
  });

  it('on no-match: returns enriched_no_match_raced when the flowsheet UPDATE matches 0 rows', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([]);

    const outcome = await applyEnrichment(linkedRow, noMatchResponse);
    expect(outcome).toBe('enriched_no_match_raced');
    expect(mockDb.insert).toHaveBeenCalledWith(album_metadata);
  });
});

/**
 * BS#1562 — dead-letter the poison rows so the pending cohort can converge
 * (updated for BS#895's status-flip control flow).
 *
 * A deterministic enrich failure (e.g. a mojibake title whose synthesized
 * Bandcamp URL overflows `flowsheet.bandcamp_url varchar(512)`, SQLSTATE
 * 22001) never flips `metadata_status` on its own — `applyEnrichment` throws
 * before the write lands. `stampDeadLetter` is the status-flip UPDATE the
 * orchestrator calls on a *permanent* enrich failure: it moves the row to
 * `metadata_status = 'failed_no_retry'` (the enum's own terminal value) and
 * stamps the historical `metadata_attempt_at` marker, without persisting the
 * URLs that failed. It is best-effort: it must never re-throw, so a stamp
 * failure can't re-wedge the drain the way the original poison-pill jam did.
 */
describe('stampDeadLetter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb._chain.returning.mockResolvedValue([{ id: baseRow.id }]);
  });

  it('issues an UPDATE that flips metadata_status to failed_no_retry and stamps metadata_attempt_at, with no metadata columns', async () => {
    await stampDeadLetter(baseRow.id);

    expect(mockDb.update).toHaveBeenCalledWith(flowsheet);
    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    // Only the status flip + marker are written — none of the URL/metadata
    // columns that might have overflowed on the failed enrich are persisted.
    expect(Object.keys(setArgs).sort()).toEqual(['metadata_attempt_at', 'metadata_status']);
    expect(setArgs.metadata_status).toBe('failed_no_retry');
    expect(renderSql(setArgs.metadata_attempt_at)).toMatch(/now\(\)/i);
  });

  it('guards the UPDATE by id AND metadata_status = fromStatus (default pending), mirroring applyEnrichment', async () => {
    await stampDeadLetter(baseRow.id);
    expect(mockDb._chain.where).toHaveBeenCalledTimes(1);
    const whereArg = mockDb._chain.where.mock.calls[0]?.[0];
    const rendered = renderSql(whereArg);
    expect(rendered).toMatch(/id/);
    expect(rendered.toLowerCase()).toMatch(/metadata_status/);
    expect(boundValues(whereArg)).toContain('pending');
  });

  it('honors an explicit fromStatus override (W4 self-heal reuse)', async () => {
    await stampDeadLetter(baseRow.id, { fromStatus: 'enriched_no_match' });
    const values = boundValues(mockDb._chain.where.mock.calls[0]?.[0]);
    expect(values).toContain('enriched_no_match');
    expect(values).not.toContain('pending');
  });

  it('never re-throws when the stamp UPDATE itself fails (best-effort)', async () => {
    // If the marker write fails too, the cursor must still advance — swallow
    // the error rather than letting it re-wedge the drain (the exact failure
    // mode BS#1561 fixed for enrich).
    mockDb._chain.where.mockImplementationOnce(() => {
      throw new Error('connection terminated');
    });
    await expect(stampDeadLetter(baseRow.id)).resolves.toBeUndefined();
  });
});

describe('extractArtwork', () => {
  it('returns null when results is empty', () => {
    expect(extractArtwork({ results: [], search_type: 'none' })).toBeNull();
  });

  it('returns null when results[0].artwork is missing', () => {
    expect(
      extractArtwork({
        results: [{ library_item: { id: 1 } }],
        search_type: 'direct',
      })
    ).toBeNull();
  });

  it('returns null when results[0].artwork is explicitly null', () => {
    expect(
      extractArtwork({
        results: [{ library_item: { id: 1 }, artwork: null }],
        search_type: 'direct',
      })
    ).toBeNull();
  });

  it('returns the first result’s artwork object on success-with-match', () => {
    const got = extractArtwork(matchedResponse);
    expect(got?.release_id).toBe(12345);
  });
});
