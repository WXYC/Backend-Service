/**
 * Unit tests for the fire-and-forget metadata enrichment helper.
 *
 * Verifies that fireAndForgetMetadataForRow:
 *   - calls fetchMetadata with the input fields
 *   - on success, updates the flowsheet row with the 10-column metadata payload
 *   - on fetch failure, captures the error to Sentry under subsystem='metadata'
 *     and does not throw
 *   - returns synchronously (callers must not be blocked by enrichment)
 */
import { jest } from '@jest/globals';

const mockFetchMetadata = jest.fn<() => Promise<unknown>>();
jest.mock('../../../apps/backend/services/metadata/metadata.service', () => ({
  fetchMetadata: mockFetchMetadata,
}));

const mockCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({ captureException: mockCaptureException }));

import { db } from '@wxyc/database';
import { fireAndForgetMetadataForRow } from '../../../apps/backend/services/metadata/enrichment.service';

/**
 * Render a drizzle `sql` template object to a string for substring assertions.
 * Mirrors the helper in tests/unit/jobs/flowsheet-etl/job.djName.test.ts —
 * drizzle's SQL serializes to `{ sql: string[], values: unknown[] }` with the
 * literal fragments split across the array, or to a `queryChunks` shape under
 * other code paths.
 */
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
  _chain: { set: jest.Mock; where: jest.Mock };
};

describe('fireAndForgetMetadataForRow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns void synchronously even when fetchMetadata is pending', () => {
    mockFetchMetadata.mockReturnValue(new Promise(() => undefined));

    const result = fireAndForgetMetadataForRow({
      flowsheetId: 1,
      artistName: 'Autechre',
      albumTitle: 'Confield',
      trackTitle: 'VI Scose Poise',
    });

    expect(result).toBeUndefined();
    expect(mockFetchMetadata).toHaveBeenCalledWith({
      albumId: undefined,
      artistId: undefined,
      artistName: 'Autechre',
      albumTitle: 'Confield',
      trackTitle: 'VI Scose Poise',
    });
  });

  it('writes all 10 metadata columns when fetchMetadata returns full enrichment', async () => {
    mockFetchMetadata.mockResolvedValue({
      album: {
        artworkUrl: 'https://i.discogs.com/art.jpg',
        discogsUrl: 'https://www.discogs.com/release/12345',
        releaseYear: 2001,
        spotifyUrl: 'https://open.spotify.com/album/abc',
        appleMusicUrl: 'https://music.apple.com/album/xyz',
        youtubeMusicUrl: 'https://music.youtube.com/album/aaa',
        bandcampUrl: 'https://bandcamp.com/album/bbb',
        soundcloudUrl: 'https://soundcloud.com/album/ccc',
      },
      artist: {
        bio: 'Rob Brown and Sean Booth are Autechre.',
        wikipediaUrl: 'https://en.wikipedia.org/wiki/Autechre',
      },
    });

    fireAndForgetMetadataForRow({
      flowsheetId: 42,
      artistName: 'Autechre',
      albumTitle: 'Confield',
    });

    // Drain the promise queue so the .then() callback runs.
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockDb.update).toHaveBeenCalled();
    expect(mockDb._chain.set).toHaveBeenCalledWith(
      expect.objectContaining({
        artwork_url: 'https://i.discogs.com/art.jpg',
        discogs_url: 'https://www.discogs.com/release/12345',
        release_year: 2001,
        spotify_url: 'https://open.spotify.com/album/abc',
        apple_music_url: 'https://music.apple.com/album/xyz',
        youtube_music_url: 'https://music.youtube.com/album/aaa',
        bandcamp_url: 'https://bandcamp.com/album/bbb',
        soundcloud_url: 'https://soundcloud.com/album/ccc',
        artist_bio: 'Rob Brown and Sean Booth are Autechre.',
        artist_wikipedia_url: 'https://en.wikipedia.org/wiki/Autechre',
      })
    );
  });

  it('stamps metadata_attempt_at = sql`NOW()` on LML success-with-match', async () => {
    mockFetchMetadata.mockResolvedValue({
      album: { artworkUrl: 'https://i.discogs.com/art.jpg' },
    });

    fireAndForgetMetadataForRow({
      flowsheetId: 42,
      artistName: 'Autechre',
      albumTitle: 'Confield',
    });

    await new Promise((resolve) => setImmediate(resolve));

    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArgs).toBeDefined();
    // Pin the value to a drizzle SQL chunk that calls Postgres's NOW().
    // A bare `new Date()` here would silently switch to *application*-host
    // time, masking clock skew across containers — the regression this
    // assertion guards against. Substring match (rather than equality)
    // tolerates whitespace / case variants without admitting `current_date`,
    // `clock_timestamp`, or a JS Date.
    expect(renderSql(setArgs.metadata_attempt_at)).toMatch(/NOW\(\)/i);
  });

  it('stamps metadata_attempt_at = sql`NOW()` on LML success-no-match (search URLs only)', async () => {
    // No match: album payload contains only synthesized search URLs, no
    // artwork. The stamp must still fire — the row was attempted.
    mockFetchMetadata.mockResolvedValue({
      album: {
        youtubeMusicUrl: 'https://music.youtube.com/search?q=x',
        bandcampUrl: 'https://bandcamp.com/search?q=x',
        soundcloudUrl: 'https://soundcloud.com/search?q=x',
      },
    });

    fireAndForgetMetadataForRow({
      flowsheetId: 43,
      artistName: 'Autechre',
      albumTitle: 'Confield',
    });

    await new Promise((resolve) => setImmediate(resolve));

    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArgs).toBeDefined();
    expect(renderSql(setArgs.metadata_attempt_at)).toMatch(/NOW\(\)/i);
  });

  it('does NOT stamp metadata_attempt_at when fetchMetadata throws', async () => {
    mockFetchMetadata.mockRejectedValue(new Error('LML responded with 502'));

    fireAndForgetMetadataForRow({
      flowsheetId: 44,
      artistName: 'King Crimson',
      albumTitle: 'Discipline',
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockDb._chain.set).not.toHaveBeenCalled();
  });

  it('skips the DB update when fetchMetadata returns null', async () => {
    mockFetchMetadata.mockResolvedValue(null);

    fireAndForgetMetadataForRow({
      flowsheetId: 99,
      artistName: 'Anonymous Artist',
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('accepts null albumTitle/trackTitle from truncate() and forwards as undefined to fetchMetadata', () => {
    mockFetchMetadata.mockReturnValue(new Promise(() => undefined));

    fireAndForgetMetadataForRow({
      flowsheetId: 5,
      artistName: 'Lone Anonymous',
      albumTitle: null,
      trackTitle: null,
    });

    expect(mockFetchMetadata).toHaveBeenCalledWith({
      albumId: undefined,
      artistId: undefined,
      artistName: 'Lone Anonymous',
      albumTitle: undefined,
      trackTitle: undefined,
    });
  });

  it('reports fetchMetadata errors to Sentry with subsystem=metadata and does not throw', async () => {
    const error = new Error('LML responded with 502');
    mockFetchMetadata.mockRejectedValue(error);

    expect(() =>
      fireAndForgetMetadataForRow({
        flowsheetId: 7,
        artistName: 'King Crimson',
        albumTitle: 'Discipline',
      })
    ).not.toThrow();

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      tags: { subsystem: 'metadata' },
      extra: {
        flowsheetId: 7,
        artistName: 'King Crimson',
        albumTitle: 'Discipline',
      },
    });
  });

  it('UPDATE narrows on metadata_attempt_at IS NULL so a backfill ↔ runtime race cannot double-stamp', async () => {
    // The drift-repair backfill (`jobs/flowsheet-metadata-backfill/enrich.ts`
    // line 173) narrows its UPDATE by `WHERE id = $row.id AND
    // metadata_attempt_at IS NULL`. The runtime path here must do the same
    // so that a backfill UPDATE that landed first cannot be clobbered by
    // a runtime UPDATE that races after it (or vice versa). At row-lock
    // granularity in PG, the second writer's UPDATE then resolves to a
    // 0-row effect — the stamp stays intact.
    mockFetchMetadata.mockResolvedValue({
      album: { artworkUrl: 'https://i.discogs.com/art.jpg' },
    });

    fireAndForgetMetadataForRow({
      flowsheetId: 42,
      artistName: 'Autechre',
      albumTitle: 'Confield',
    });

    await new Promise((resolve) => setImmediate(resolve));

    const whereCalls = mockDb._chain.where.mock.calls;
    expect(whereCalls.length).toBeGreaterThan(0);
    const lastWhereArg = whereCalls[whereCalls.length - 1][0];
    expect(renderSql(lastWhereArg)).toMatch(/metadata_attempt_at.*IS\s+NULL/i);
  });

  it('does not write linkage columns (album_id / linkage_source / linkage_confidence / linked_at)', async () => {
    // `apps/backend/services/flowsheet-linkage.service.ts::setFlowsheetLinkage`
    // owns these four columns. If a metadata UPDATE and a linkage UPDATE
    // race on the same flowsheet row, they must touch disjoint columns so
    // neither clobbers the other. This locks in the column boundary so a
    // future refactor cannot quietly add e.g. `album_id` to the metadata
    // set() block.
    mockFetchMetadata.mockResolvedValue({
      album: {
        artworkUrl: 'https://i.discogs.com/art.jpg',
        discogsUrl: 'https://www.discogs.com/release/12345',
      },
      artist: { wikipediaUrl: 'https://en.wikipedia.org/wiki/Autechre' },
    });

    fireAndForgetMetadataForRow({
      flowsheetId: 42,
      artistName: 'Autechre',
      albumTitle: 'Confield',
    });

    await new Promise((resolve) => setImmediate(resolve));

    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArgs).toBeDefined();
    expect(setArgs).not.toHaveProperty('album_id');
    expect(setArgs).not.toHaveProperty('linkage_source');
    expect(setArgs).not.toHaveProperty('linkage_confidence');
    expect(setArgs).not.toHaveProperty('linked_at');
  });
});
