/**
 * Unit tests for flowsheet-metadata-backfill enrich.ts.
 *
 * Pins the row-level UPDATE shape against three #639 contract guarantees:
 *   1. On LML success-with-match, all 10 metadata columns are written and
 *      `metadata_attempt_at = sql\`now()\`` is in the same .set() block.
 *   2. On LML success-no-match, the three search-URL columns are written
 *      and `metadata_attempt_at` is still stamped — no-match is still an
 *      attempt the recurring sweep should not retry.
 *   3. The .set() block calls `eq(flowsheet.id, row.id)` AND
 *      `isNull(flowsheet.metadata_attempt_at)` so a runtime stamp landing
 *      between the orchestrator's SELECT and this UPDATE wins.
 *
 * spacer.gif filter and Discogs bio cleanup are covered directly in
 * tests/unit/shared/metadata/; exercised here transitively via
 * applyEnrichment's match-path assertions.
 */
import { jest } from '@jest/globals';

import { album_metadata, db, flowsheet } from '@wxyc/database';
import { applyEnrichment, extractArtwork, type EnrichRow } from '../../../../jobs/flowsheet-metadata-backfill/enrich';
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

  it('writes 10 metadata columns and stamps metadata_attempt_at on LML success-with-match', async () => {
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
    });
    expect(setArgs.bandcamp_url).toContain('bandcamp.com/search');
    expect(setArgs.soundcloud_url).toContain('soundcloud.com/search');
    // Bio is cleaned of Discogs markup tags
    expect(setArgs.artist_bio).toBe('Rob Brown and Sean Booth are Autechre.');
    expect(setArgs.artist_wikipedia_url).toBe('https://en.wikipedia.org/wiki/Autechre');
    // The stamp is the canonical sql`now()` chunk, not a JS Date
    expect(renderSql(setArgs.metadata_attempt_at)).toMatch(/now\(\)/i);
  });

  it('writes synthesized search URLs (4) and stamps on LML success-no-match (empty results)', async () => {
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

  it('idempotency guard: WHERE narrows by id AND metadata_attempt_at IS NULL', async () => {
    // The WHERE makes the UPDATE a no-op against rows the runtime path
    // already stamped. Verify .where() was called once with a single
    // drizzle expression whose rendered SQL references both columns.
    await applyEnrichment(baseRow, matchedResponse);
    expect(mockDb._chain.where).toHaveBeenCalledTimes(1);
    const whereArg = mockDb._chain.where.mock.calls[0]?.[0];
    const rendered = renderSql(whereArg);
    expect(rendered).toMatch(/id/);
    expect(rendered.toLowerCase()).toMatch(/metadata_attempt_at/);
  });

  it('returns enriched_match_raced when 0 rows update (runtime path stamped first)', async () => {
    // Race scenario: between the orchestrator's SELECT and this UPDATE,
    // the runtime path landed its own stamp on the same row, so
    // `metadata_attempt_at IS NULL` no longer matches and Postgres
    // updates 0 rows. The data outcome is identical (both writers
    // produce the same payload) — only the metric splits.
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
 * `album_metadata` keyed by album_id, and the flowsheet UPDATE only stamps
 * `metadata_attempt_at`. The race detector stays on the flowsheet UPDATE
 * (marker IS NULL guard), and the album_metadata UPSERT carries a
 * `updated_at < NOW()` setWhere so a delayed backfill cycle can't clobber
 * a fresher runtime/worker enrichment. Mirrors the D3 worker pattern in
 * `apps/enrichment-worker/enrich.ts` (BS#899).
 *
 * Critical contract difference from the worker: the backfill stamps
 * `metadata_attempt_at` and guards on `metadata_attempt_at IS NULL`. The
 * worker uses `metadata_status='enriching'`. The backfill operates on rows
 * the consumer never claimed, so the marker is the right invariant.
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

  it('on match: flowsheet UPDATE stamps only metadata_attempt_at (no inline metadata columns)', async () => {
    await applyEnrichment(linkedRow, matchedResponse);

    expect(mockDb.update).toHaveBeenCalledWith(flowsheet);
    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(renderSql(setArgs.metadata_attempt_at)).toMatch(/now\(\)/i);
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

  it('on match: flowsheet WHERE still uses the marker-IS-NULL race detector (one where call, non-empty predicate)', async () => {
    // Linked path uses typed `and(eq(flowsheet.id, row.id), isNull(flowsheet.metadata_attempt_at))`
    // builders. Column refs are compile-time checked against the schema; the
    // race-detector behavior is covered by the _raced tests below.
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
    expect(conflictCfg.set.spotify_url).toContain('open.spotify.com/search');
    expect(conflictCfg.set.youtube_music_url).toContain('music.youtube.com/search');
    expect(conflictCfg.setWhere).toBeDefined();
    expect(renderSql(conflictCfg.setWhere)).toMatch(/<\s*NOW\(\)/i);
  });

  it('on no-match: flowsheet UPDATE stamps only metadata_attempt_at (no inline URLs)', async () => {
    await applyEnrichment(linkedRow, noMatchResponse);

    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(renderSql(setArgs.metadata_attempt_at)).toMatch(/now\(\)/i);
    expect(setArgs).not.toHaveProperty('youtube_music_url');
    expect(setArgs).not.toHaveProperty('bandcamp_url');
    expect(setArgs).not.toHaveProperty('soundcloud_url');
  });

  it('on match: returns enriched_match_raced when the flowsheet UPDATE matches 0 rows', async () => {
    // album_metadata UPSERT lands; flowsheet UPDATE races because the
    // marker was already stamped by another writer (runtime/worker path) in
    // the window between the orchestrator's SELECT and this UPDATE.
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
