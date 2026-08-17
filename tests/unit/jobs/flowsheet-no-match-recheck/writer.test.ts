/**
 * Unit tests for jobs/flowsheet-no-match-recheck writer.ts (BS#2176).
 *
 * Two write paths, both fill-null (never clobber a populated field with a
 * null) and both race-guarded on `metadata_status = 'enriched_no_match'`:
 *
 *   - Linked (`candidate.album_id != null`): fill-null COALESCE UPSERT into
 *     `album_metadata` (donor: jobs/flowsheet-linked-reenrichment's
 *     `upsertAlbumMatchFillNull`), then a flowsheet status-only flip.
 *   - Unlinked (`candidate.album_id == null`): a single fill-null COALESCE
 *     UPDATE on flowsheet's own inline metadata columns + the status flip.
 *
 * `markRecheckAttempted` stamps the retry marker alone, under the same race
 * guard, for a no-match / trust-rejected outcome.
 */
import { jest } from '@jest/globals';

import { db, flowsheet, album_metadata } from '@wxyc/database';
import type { DiscogsMatchResult } from '@wxyc/lml-client';
import { markRecheckAttempted, writeMatch } from '../../../../jobs/flowsheet-no-match-recheck/writer';
import { renderSql } from '../../../utils/render-sql';

type MockChain = Record<string, jest.Mock>;
const chain = (db as unknown as { _chain: MockChain })._chain;

/** The manual drizzle-orm mock (`tests/__mocks__/drizzle-orm.ts`) renders
 * `and(eq(a, b), eq(c, d))` as `{ and: [{ eq: [a, b] }, { eq: [c, d] }] }` —
 * a different shape than the `sql`/`raw`/`join`/`queryChunks` chunks
 * `renderSql` understands, so WHERE-clause guards are asserted structurally
 * here instead. */
const whereGuardsOnEnrichedNoMatch = (whereArg: unknown): boolean =>
  JSON.stringify(whereArg).includes('enriched_no_match');

const fullArtwork = (overrides: Partial<DiscogsMatchResult> = {}): DiscogsMatchResult =>
  ({
    release_id: 28327348,
    release_url: 'https://www.discogs.com/release/28327348',
    artwork_url: 'https://img.discogs.com/release/28327348.jpg',
    release_year: 2016,
    spotify_url: 'https://open.spotify.com/album/abc',
    apple_music_url: 'https://music.apple.com/album/abc',
    youtube_music_url: 'https://music.youtube.com/playlist?list=abc',
    bandcamp_url: 'https://vladislavdelay.bandcamp.com/album/entain',
    soundcloud_url: 'https://soundcloud.com/vladislavdelay/entain',
    artist_bio: 'Bio with [a=Sasu Ripatti] markup.',
    wikipedia_url: 'https://en.wikipedia.org/wiki/Vladislav_Delay',
    confidence: 1,
    ...overrides,
  }) as DiscogsMatchResult;

beforeEach(() => {
  chain.returning.mockReset();
  (db.insert as jest.Mock).mockClear();
  chain.values.mockClear();
  chain.onConflictDoUpdate.mockClear();
  chain.set.mockClear();
  chain.update.mockClear();
});

describe('markRecheckAttempted', () => {
  test('stamps only the retry marker for a definitive no-match/trust-rejected outcome', async () => {
    chain.returning.mockResolvedValueOnce([{ id: 99 }]);

    const result = await markRecheckAttempted(99);

    expect(result).toEqual({ written: true });
    const setArg = chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(setArg)).toEqual(['no_match_recheck_attempted_at']);
    expect(renderSql(setArg.no_match_recheck_attempted_at)).toMatch(/now\(\)/i);
  });

  test('returns written:false when the marker UPDATE loses the metadata_status race', async () => {
    chain.returning.mockResolvedValueOnce([]);

    const result = await markRecheckAttempted(99);

    expect(result).toEqual({ written: false });
  });
});

describe('writeMatch — unlinked (album_id null)', () => {
  test('fill-null COALESCEs the 6 non-streaming inline flowsheet columns and flips metadata_status, guarded on enriched_no_match', async () => {
    chain.returning.mockResolvedValueOnce([{ id: 5308981 }]);

    const result = await writeMatch(
      { id: 5308981, artist_name: 'Vladislav Delay', album_title: 'Entain', track_title: 'Kohde', album_id: null },
      fullArtwork()
    );

    expect(result).toEqual({ written: true });
    expect(db.update as jest.Mock).toHaveBeenCalledWith(flowsheet);
    const setArg = chain.set.mock.calls[0]?.[0] as Record<string, unknown>;

    // Plain fill-null COALESCE: no BS#2179 review HIGH 1 upgrade concern —
    // `enrich.ts`'s unlinked no-match arm never pre-populates these.
    for (const col of [
      'artwork_url',
      'discogs_url',
      'release_year',
      'apple_music_url',
      'artist_bio',
      'artist_wikipedia_url',
    ]) {
      const rendered = renderSql(setArg[col]);
      expect(rendered).toMatch(/COALESCE/i);
    }
    // The 4 streaming-search columns (BS#2179 review HIGH 1): NOT plain
    // COALESCE — see the dedicated describe block below. Pinned here only as
    // a negative check so a regression back to plain COALESCE fails loudly.
    for (const col of ['spotify_url', 'youtube_music_url', 'bandcamp_url', 'soundcloud_url']) {
      const rendered = renderSql(setArg[col]);
      expect(rendered).not.toMatch(/COALESCE/i);
      expect(rendered).toMatch(/CASE WHEN/i);
    }
    expect(setArg.metadata_status).toBe('enriched_match');
    expect(renderSql(setArg.no_match_recheck_attempted_at)).toMatch(/now\(\)/i);

    expect(whereGuardsOnEnrichedNoMatch(chain.where.mock.calls[0]?.[0])).toBe(true);
  });

  test('strips Discogs bio markup and drops spacer.gif artwork to null', async () => {
    chain.returning.mockResolvedValueOnce([{ id: 1 }]);

    await writeMatch(
      { id: 1, artist_name: 'X', album_title: 'Y', track_title: 'Z', album_id: null },
      fullArtwork({
        artwork_url: 'https://img.discogs.com/spacer.gif',
        artist_bio: 'Bio with [a=Sasu Ripatti] markup.',
      })
    );

    const setArg = chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    // COALESCE(existing_column, <computed value>) — the computed value is
    // the SQL fragment's second interpolated param.
    const artworkSql = setArg.artwork_url as { values?: unknown[] } | undefined;
    expect(artworkSql?.values?.[artworkSql.values.length - 1]).toBeNull();
    const bioSql = setArg.artist_bio as { values?: unknown[] } | undefined;
    expect(bioSql?.values?.[bioSql.values.length - 1]).toBe('Bio with Sasu Ripatti markup.');
  });

  test('returns written:false when the race guard loses (metadata_status already changed)', async () => {
    chain.returning.mockResolvedValueOnce([]);

    const result = await writeMatch(
      { id: 1, artist_name: 'X', album_title: 'Y', track_title: 'Z', album_id: null },
      fullArtwork()
    );

    expect(result).toEqual({ written: false });
  });
});

describe('writeMatch — unlinked search-URL upgrade (BS#2179 review HIGH 1)', () => {
  /**
   * `apps/enrichment-worker/enrich.ts`'s unlinked `enriched_no_match` write
   * (the arm that puts a row in THIS job's candidate set to begin with)
   * unconditionally fills these four columns with a synthesized search URL
   * before this job ever sees the row — so a plain `COALESCE(column,
   * incoming)` here is a guaranteed no-op: `column` is never NULL. The fix
   * is a CASE that also overwrites when the STORED value is itself one of
   * these exact placeholder prefixes (never a genuinely verified link, which
   * never starts with them), so a real Discogs-sourced URL can land.
   */
  const searchUrlCases: Array<{ column: string; prefix: string }> = [
    { column: 'spotify_url', prefix: 'https://open.spotify.com/search/' },
    { column: 'youtube_music_url', prefix: 'https://music.youtube.com/search?q=' },
    { column: 'bandcamp_url', prefix: 'https://bandcamp.com/search?q=' },
    { column: 'soundcloud_url', prefix: 'https://soundcloud.com/search?q=' },
  ];

  test.each(searchUrlCases)(
    '$column: CASE upgrades a stored search-shaped placeholder to the incoming Discogs value, never plain COALESCE',
    async ({ column, prefix }) => {
      chain.returning.mockResolvedValueOnce([{ id: 1 }]);

      await writeMatch({ id: 1, artist_name: 'X', album_title: 'Y', track_title: 'Z', album_id: null }, fullArtwork());

      const setArg = chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
      const rendered = renderSql(setArg[column]);

      expect(rendered).toMatch(/CASE WHEN/i);
      expect(rendered).toMatch(/IS NOT NULL/i);
      // The LIKE guard is the never-downgrade property: it only ever matches
      // the exact synthesized-placeholder prefix, never a verified link.
      expect(rendered).toContain(`LIKE`);
      expect(rendered).toContain(`${prefix}%`);
      // Column referenced for both the NULL/placeholder test and the ELSE
      // fallback — same column the mock renders as its own name.
      expect(rendered.match(new RegExp(column, 'g'))?.length).toBeGreaterThanOrEqual(2);
    }
  );

  test('leaves a stored value untouched when the incoming artwork value is null (never downgrades to null)', async () => {
    chain.returning.mockResolvedValueOnce([{ id: 1 }]);

    await writeMatch(
      { id: 1, artist_name: 'X', album_title: 'Y', track_title: 'Z', album_id: null },
      fullArtwork({ spotify_url: undefined })
    );

    const setArg = chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    const rendered = renderSql(setArg.spotify_url);
    // incoming IS NOT NULL guards the THEN branch — a null incoming always
    // falls through to ELSE <column>, exactly like COALESCE(column, null).
    expect(rendered).toMatch(/CASE WHEN/i);
    expect(rendered).toMatch(/ELSE\s+spotify_url\s+END/i);
  });
});

describe('writeMatch — linked (album_id present)', () => {
  test('fill-null UPSERTs album_metadata then flips only metadata_status on flowsheet (no inline metadata columns)', async () => {
    chain.returning.mockResolvedValueOnce([{ id: 7 }]); // the flowsheet status-flip UPDATE

    const result = await writeMatch(
      { id: 7, artist_name: 'Vladislav Delay', album_title: 'Entain', track_title: 'Kohde', album_id: 42 },
      fullArtwork()
    );

    expect(result).toEqual({ written: true });

    // album_metadata UPSERT.
    expect(db.insert as jest.Mock).toHaveBeenCalledWith(album_metadata);
    const valuesArg = chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(valuesArg).toMatchObject({
      album_id: 42,
      artwork_url: 'https://img.discogs.com/release/28327348.jpg',
      discogs_url: 'https://www.discogs.com/release/28327348',
      release_year: 2016,
    });
    const conflictArg = chain.onConflictDoUpdate.mock.calls[0]?.[0] as {
      target: unknown;
      set: Record<string, unknown>;
      setWhere: unknown;
    };
    expect(conflictArg.target).toBe(album_metadata.album_id);
    for (const col of [
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
    ]) {
      const rendered = renderSql(conflictArg.set[col]);
      expect(rendered).toMatch(/COALESCE/i);
      expect(rendered).toMatch(new RegExp(`excluded\\."${col}"`, 'i'));
    }
    expect(renderSql(conflictArg.set.updated_at)).toMatch(/NOW\(\)/i);
    expect(renderSql(conflictArg.set.updated_at)).not.toMatch(/COALESCE/i);
    expect(renderSql(conflictArg.setWhere)).toMatch(/<\s*NOW\(\)/i);

    // flowsheet status-only flip: no inline metadata columns.
    expect(db.update as jest.Mock).toHaveBeenCalledWith(flowsheet);
    const flowsheetSet = chain.set.mock.calls[chain.set.mock.calls.length - 1]?.[0] as Record<string, unknown>;
    expect(flowsheetSet.metadata_status).toBe('enriched_match');
    expect(Object.keys(flowsheetSet)).toEqual(['metadata_status', 'no_match_recheck_attempted_at']);
    expect(whereGuardsOnEnrichedNoMatch(chain.where.mock.calls[chain.where.mock.calls.length - 1]?.[0])).toBe(true);
  });

  test('returns written:false when the flowsheet flip loses the race, even though album_metadata upserted', async () => {
    chain.returning.mockResolvedValueOnce([]); // flowsheet UPDATE affected 0 rows

    const result = await writeMatch(
      { id: 7, artist_name: 'Vladislav Delay', album_title: 'Entain', track_title: 'Kohde', album_id: 42 },
      fullArtwork()
    );

    expect(result).toEqual({ written: false });
    expect(db.insert as jest.Mock).toHaveBeenCalledWith(album_metadata);
  });
});
