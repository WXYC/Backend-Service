/**
 * Unit tests for jobs/artist-search-alias-consumer/alt-name-source.ts.
 *
 * The alt-name source is the second composer leg of the orchestrator — a
 * local Backend SELECT against `library.alternate_artist_name` aggregated
 * per `artist_id`. Tags the resulting variants as `wxyc_library_alt`.
 *
 * Returns a Map<artist_id, string[]> so the orchestrator can `.get(id)` in
 * O(1) inside the fan-out loop.
 */
import { db } from '@wxyc/database';
import { fetchAlternateArtistNames } from '../../../../jobs/artist-search-alias-consumer/alt-name-source';

describe('fetchAlternateArtistNames', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('short-circuits with no PG round-trip when artist_ids is empty', async () => {
    const result = await fetchAlternateArtistNames([]);
    expect(result.size).toBe(0);
    expect((db.execute as jest.Mock).mock.calls.length).toBe(0);
  });

  it('returns a Map keyed by artist_id with aggregated alt names', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([
      { artist_id: 42, alts: ['Juana M.'] },
      { artist_id: 7, alts: ['Tim Gane', 'L Sadier'] },
    ]);

    const result = await fetchAlternateArtistNames([42, 7, 9999]);

    expect(result.get(42)).toEqual(['Juana M.']);
    expect(result.get(7)).toEqual(['Tim Gane', 'L Sadier']);
    expect(result.has(9999)).toBe(false);
  });

  it('issues SQL that filters to the supplied artist_ids and skips NULL alts', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);
    await fetchAlternateArtistNames([1, 2, 3]);

    expect((db.execute as jest.Mock).mock.calls.length).toBe(1);
    const serialized = JSON.stringify((db.execute as jest.Mock).mock.calls[0][0]);
    expect(serialized).toMatch(/library/);
    expect(serialized).toMatch(/alternate_artist_name/);
    expect(serialized).toMatch(/artist_id/);
    // The integer bindings land as positional params.
    expect(serialized).toMatch(/IS NOT NULL/);
  });

  it('unwraps a `.rows`-shaped driver response', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce({
      rows: [{ artist_id: 7, alts: ['Tim Gane'] }],
    });

    const result = await fetchAlternateArtistNames([7]);
    expect(result.get(7)).toEqual(['Tim Gane']);
  });

  it('binds the artist_ids as a single PG-array-literal text param (anti-regression for BS#1068/#1071 array splat)', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);
    await fetchAlternateArtistNames([1, 2, 3, 42, 1234567]);

    // The drizzle-orm `sql\`...\`` template stores positional binds in
    // `queryChunks` as objects with a `value` array. The fix passes a single
    // PG-array-literal string (`'{1,2,3,42,1234567}'`) — never the raw JS
    // array. Inspect the serialised payload and confirm:
    //   1. the literal '{1,2,3,42,1234567}' appears as a bind value
    //   2. no raw integer array is passed as a single bind
    const call = (db.execute as jest.Mock).mock.calls[0][0];
    const serialized = JSON.stringify(call);
    expect(serialized).toContain('{1,2,3,42,1234567}');
    // Regression guard: the raw JS array `[1,2,3,42,1234567]` must NOT be
    // serialised into the SQL. (postgres-js would splat it into N positional
    // placeholders.)
    expect(serialized).not.toContain('[1,2,3,42,1234567]');
  });
});
