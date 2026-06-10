/**
 * Unit tests for jobs/concerts-artist-resolver query.ts (BS#1383).
 *
 * `resolveArtistId` runs two SQL JOINs (strict-then-alias). The alias arm
 * is the load-bearing site for BS#1383: a `discogs_member` row in
 * `artist_search_alias` is a relational signal ("X was a member of Y"),
 * not a synonym signal. Folding it into the FK-write path produced the
 * Geordie Greep → black midi mislabel surfaced by the BS#1368 frequency
 * audit (Greep is touring solo, not in WXYC's library; only black midi's
 * records are). The fix filters `source <> 'discogs_member'` from the
 * alias subquery so the resolver returns `unmatched` for `discogs_member`-
 * only hits — the FK stays NULL and the row is never mislabeled.
 *
 * Negative-form filter (`<>`) is forward-compatible against a future
 * fifth source: any new relational signal LML adds (collaborator,
 * featured-on, side-project) is also excluded by default until we
 * explicitly opt it in. The catalog-search sites take the opposite
 * tack — they DO want `discogs_member` matches surfaced as a "related
 * artist" UX hint — but those sites have a wire-shape seam for `source`
 * and the resolver does not.
 */
import { jest } from '@jest/globals';

import { db } from '../../../mocks/database.mock';
import { resolveArtistId } from '../../../../jobs/concerts-artist-resolver/query';

type SqlLike = {
  sql?: string | string[];
  queryChunks?: Array<string | { value?: string | string[] }>;
};
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

const executeMock = db.execute;

describe('resolveArtistId — discogs_member filter (BS#1383)', () => {
  beforeEach(() => {
    executeMock.mockReset();
  });

  it("excludes 'discogs_member' rows from the alias arm at SQL time", async () => {
    // Both arms return [] — we're inspecting the SQL contract, not the
    // result handling. The behaviour assertion (filtered-out → unmatched)
    // lives in the next test.
    executeMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await resolveArtistId('Geordie Greep');

    expect(executeMock).toHaveBeenCalledTimes(2);
    const aliasSql = renderSql(executeMock.mock.calls[1][0]);
    // Negative form is forward-compatible against a future fifth source.
    expect(aliasSql).toMatch(/"?source"?\s*<>\s*'discogs_member'/i);
  });

  it("returns { kind: 'unmatched' } when the only matching alias row is a 'discogs_member' (filtered out by the SQL)", async () => {
    // The SQL filter is what removes the row; the mock simulates the
    // filtered result set — empty, because the only candidate variant
    // was a discogs_member row.
    executeMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const result = await resolveArtistId('Geordie Greep');

    expect(result).toEqual({ kind: 'unmatched' });
  });

  it("still returns { kind: 'alias' } for non-member alias sources (discogs_name_variation, discogs_alias, wxyc_library_alt)", async () => {
    // The filter is scoped to `discogs_member` only. A
    // `discogs_name_variation` / `discogs_alias` / `wxyc_library_alt`
    // hit still resolves an FK — that's the substrate's whole point.
    executeMock.mockResolvedValueOnce([]).mockResolvedValueOnce([{ artist_id: 42 }]);

    const result = await resolveArtistId('Thee Oh Sees');

    expect(result).toEqual({ kind: 'alias', artist_id: 42 });
  });

  it('strict-wins is unchanged: a strict singleton skips the alias arm entirely', async () => {
    // Only one db.execute call should fire — the strict one. The alias
    // arm (and therefore the filter) is irrelevant when strict resolves.
    executeMock.mockResolvedValueOnce([{ artist_id: 7 }]);

    const result = await resolveArtistId('Pavement');

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ kind: 'strict', artist_id: 7 });
  });
});
