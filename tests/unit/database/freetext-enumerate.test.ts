/**
 * Unit tests for shared/database/src/freetext-enumerate.ts (BS#1767 SQL
 * shape; extracted from jobs/catalog-popularity-freetext-resolve/job.ts by
 * BS#1799 so the tests/integration babel-jest harness — which can't import
 * the job directly — can import and execute this SAME statement instead of
 * hand-duplicating a SQL mirror). Tests the REAL module directly (bypassing
 * the package-level `@wxyc/database` mock, mirroring
 * tests/unit/database/concerts-recompute.test.ts and live-activity.test.ts)
 * so the SQL text asserted below is the module's actual output, not a
 * hand-duplicated stub.
 *
 * `jobs/catalog-popularity-freetext-resolve/job.ts` imports + re-exports
 * `enumerateFreetextPairs` from `@wxyc/database` as a thin pass-through; its
 * own unit suite (tests/unit/jobs/catalog-popularity-freetext-resolve/job.test.ts)
 * no longer tests this function directly.
 *
 * SQL-contract test pins: the DISTINCT ON (artist_name, album_title)
 * selection + its three required predicates, the inner GROUP BY play-count
 * shape, the full non-empty-first / most-played / deterministic-tiebreak
 * ORDER BY sequence (the drift tripwire the integration spec's runtime
 * semantics check depends on), and the SET LOCAL statement_timeout wrapper.
 * Mapping tests pin the `{ artist, album, song }` shape, including the
 * track-less-pair-collapses-to-'' rule.
 */
jest.mock('../../../shared/database/src/client.js', () => jest.requireActual('../../mocks/database.mock'), {
  virtual: true,
});

import { db } from '../../mocks/database.mock';
import { enumerateFreetextPairs } from '../../../shared/database/src/freetext-enumerate';

// drizzle-orm is auto-mocked repo-wide for ts-jest unit tests
// (tests/__mocks__/drizzle-orm.ts, a Jest node_modules manual mock Jest
// substitutes automatically for ANY file requiring `drizzle-orm` — this file
// never calls `jest.unmock('drizzle-orm')`, so it applies here too). That
// mock's `sql` tagged template returns `{ sql: TemplateStringsArray, values }`
// — literal text segments in `sql`, interpolated values (bound params AND
// nested `sql` fragments alike) in `values` — and `sql.raw(s)` returns
// `{ raw: s }`. `renderSql`/`collectParams` below mirror
// tests/unit/jobs/flowsheet-metadata-backfill/worklist.test.ts's
// `renderDeep`/`collectParams` for the identical mock shape: a nested `sql``
// fragment (e.g. the BS#1822 floor predicate, itself interpolated via
// `${floorPredicate}`) recurses via the `Array.isArray(obj.sql)` branch; a
// bound param (e.g. `${minPlays}`) renders as `''` in `renderSql` (asserted
// separately via `collectParams`) since it's neither `{raw}` nor `{sql,values}`.
type SqlLike = { sql?: readonly string[]; values?: unknown[]; raw?: string };

const renderSql = (value: unknown): string => {
  if (value == null || typeof value === 'string') return '';
  const obj = value as SqlLike;
  if (typeof obj.raw === 'string') return obj.raw;
  if (Array.isArray(obj.sql)) {
    const values = obj.values ?? [];
    return obj.sql.map((chunk, i) => chunk + (i < values.length ? renderSql(values[i]) : '')).join('');
  }
  return '';
};

const findExecuteCallMatching = (pattern: RegExp): unknown[] | undefined =>
  (db.execute as jest.Mock).mock.calls.find((call) => pattern.test(renderSql(call[0])));

/** Collect bound (non-fragment, non-raw) parameter VALUES depth-first — the
 * counterpart to `renderSql` above, which deliberately renders a bound param
 * as `''`. Used to assert the BS#1822 floor's exact bound value, since
 * `renderSql` can't show it inline. */
const collectParams = (value: unknown): unknown[] => {
  if (value == null || typeof value === 'string') return [];
  const obj = value as SqlLike;
  if (typeof obj.raw === 'string') return [];
  if (Array.isArray(obj.sql)) return (obj.values ?? []).flatMap(collectParams);
  return [value];
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('enumerateFreetextPairs', () => {
  it('selects DISTINCT ON (artist_name, album_title) with the three required predicates', async () => {
    (db.execute as jest.Mock).mockResolvedValue([
      { artist_name: 'J Dilla', album_title: 'Donuts', track_title: 'Waves' },
    ]);

    await enumerateFreetextPairs();

    const call = findExecuteCallMatching(/SELECT\s+DISTINCT\s+ON/i);
    expect(call).toBeDefined();
    const text = renderSql(call?.[0]);
    expect(text).toMatch(/DISTINCT\s+ON\s*\(\s*"?artist_name"?\s*,\s*"?album_title"?\s*\)/i);
    expect(text).toMatch(/FROM\s+"?wxyc_schema"?\."?flowsheet"?/i);
    expect(text).toMatch(/"?entry_type"?\s*=\s*'track'/i);
    expect(text).toMatch(/"?album_id"?\s+IS\s+NULL/i);
    expect(text).toMatch(/"?artist_name"?\s+IS\s+NOT\s+NULL/i);
    expect(text).toMatch(/"?album_title"?\s+IS\s+NOT\s+NULL/i);
    // Representative track_title is returned but NEVER filtered — a track-less
    // pair must still fall back to album-only, not be dropped from the scan.
    expect(text).toMatch(/"?track_title"?/i);
    expect(text).not.toMatch(/"?track_title"?\s+IS\s+NOT\s+NULL/i);
  });

  it('groups by (artist, album, track) and orders by non-empty-first, then most-played, then deterministic', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await enumerateFreetextPairs();
    const call = findExecuteCallMatching(/SELECT\s+DISTINCT\s+ON/i);
    const text = renderSql(call?.[0]);
    // Inner GROUP BY counts plays per distinct track so the modal one can win.
    expect(text).toMatch(/GROUP\s+BY\s+"?artist_name"?\s*,\s*"?album_title"?\s*,\s*"?track_title"?/i);
    expect(text).toMatch(/count\s*\(\s*\*\s*\)\s+AS\s+play_count/i);
    // Pin the FULL ORDER BY sequence IN ORDER — this is the drift tripwire on
    // the real query (the integration spec validates this same shape's runtime
    // semantics against real PG). A flipped ASC/DESC, a dropped btrim
    // non-empty-first term, or a reordered tiebreak all fail HERE, on the real
    // function's emitted SQL. Whitespace is collapsed first so the assertion is
    // a single flat pattern (avoids a nest of `\s*` quantifiers):
    //   artist_name, album_title,
    //   (btrim(coalesce(track_title,'')) = '') ASC,   -- non-empty first
    //   play_count DESC,                              -- most-played wins
    //   track_title ASC                               -- deterministic tiebreak
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toContain('ORDER BY "artist_name", "album_title",');
    expect(flat).toContain(`(btrim(coalesce("track_title", '')) = '') ASC, play_count DESC, "track_title" ASC`);
  });

  it('wraps the SELECT in a transaction + SET LOCAL statement_timeout', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await enumerateFreetextPairs(99_000);
    expect((db.transaction as jest.Mock).mock.calls.length).toBe(1);
    const setLocalCall = findExecuteCallMatching(/SET\s+LOCAL\s+statement_timeout/i);
    expect(renderSql(setLocalCall?.[0])).toMatch(/99000ms/);
  });

  it('maps rows to { artist, album, song } using the representative track_title', async () => {
    (db.execute as jest.Mock).mockResolvedValue([
      { artist_name: 'Kendrick Lamar', album_title: 'DAMN.', track_title: 'HUMBLE.' },
    ]);
    const out = await enumerateFreetextPairs();
    expect(out).toEqual([{ artist: 'Kendrick Lamar', album: 'DAMN.', song: 'HUMBLE.' }]);
  });

  it('maps a null/missing track_title to an empty song (track-less pairs still fall back to album-only)', async () => {
    (db.execute as jest.Mock).mockResolvedValue([{ artist_name: 'J Dilla', album_title: 'Donuts', track_title: null }]);
    const out = await enumerateFreetextPairs();
    expect(out).toEqual([{ artist: 'J Dilla', album: 'Donuts', song: '' }]);
  });

  it('trims a whitespace-only track_title to an empty song at the enumerate boundary', async () => {
    // The "usable track?" rule lives HERE (the single trim boundary): a
    // whitespace-only representative maps to song='' so buildBulkItems can use
    // a plain truthiness check downstream.
    (db.execute as jest.Mock).mockResolvedValue([
      { artist_name: 'J Dilla', album_title: 'Donuts', track_title: '   ' },
    ]);
    const out = await enumerateFreetextPairs();
    expect(out).toEqual([{ artist: 'J Dilla', album: 'Donuts', song: '' }]);
  });

  it('trims surrounding whitespace off a usable track_title', async () => {
    (db.execute as jest.Mock).mockResolvedValue([
      { artist_name: 'J Dilla', album_title: 'Donuts', track_title: '  Waves  ' },
    ]);
    const out = await enumerateFreetextPairs();
    expect(out).toEqual([{ artist: 'J Dilla', album: 'Donuts', song: 'Waves' }]);
  });
});

describe('enumerateFreetextPairs — play floor + play-descending drain (BS#1822)', () => {
  it('always computes a PAIR-level total_plays (SUM of per-track play_count, partitioned by the pair), independent of whether a floor is applied', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await enumerateFreetextPairs();
    const call = findExecuteCallMatching(/SELECT\s+DISTINCT\s+ON/i);
    const flat = renderSql(call?.[0]).replace(/\s+/g, ' ');
    // Summed across a pair's tracks — NOT the per-track play_count itself —
    // gating a (artist, album) pair, never a single track.
    expect(flat).toContain('SUM("play_count") OVER (PARTITION BY "artist_name", "album_title") AS "total_plays"');
  });

  it('omits the floor predicate entirely when minPlays is omitted (default) or 0 — unset/0 disables the floor', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);

    await enumerateFreetextPairs(); // bare call — no floor arg
    const bareCall = findExecuteCallMatching(/SELECT\s+DISTINCT\s+ON/i);
    expect(renderSql(bareCall?.[0])).not.toMatch(/WHERE\s+"total_plays"/i);
    expect(collectParams(bareCall?.[0])).toEqual([]);

    jest.clearAllMocks();
    (db.execute as jest.Mock).mockResolvedValue([]);
    await enumerateFreetextPairs(300_000, 0); // explicit 0 — same as disabled
    const zeroCall = findExecuteCallMatching(/SELECT\s+DISTINCT\s+ON/i);
    expect(renderSql(zeroCall?.[0])).not.toMatch(/WHERE\s+"total_plays"/i);
    expect(collectParams(zeroCall?.[0])).toEqual([]);
  });

  it('gates the eligible set behind WHERE total_plays >= minPlays when a positive floor is passed, bound to the exact value', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await enumerateFreetextPairs(300_000, 3);
    const call = findExecuteCallMatching(/SELECT\s+DISTINCT\s+ON/i);
    const text = renderSql(call?.[0]);
    expect(text).toMatch(/WHERE\s+"total_plays"\s*>=/i);
    expect(collectParams(call?.[0])).toEqual([3]);
  });

  it('re-evaluates the floor fresh on every call from live play counts — no persisted exclusion side-table (no permanent exclusion)', async () => {
    // The floor predicate reads ONLY the SAME "wxyc_schema"."flowsheet" table
    // the rest of the enumerate scan reads — there is no second table (e.g. an
    // "excluded_pairs" bookkeeping table) that would make an exclusion
    // permanent. A pair's exclusion is a pure function of the CURRENT play
    // count, recomputed identically every call.
    (db.execute as jest.Mock).mockResolvedValue([]);
    await enumerateFreetextPairs(300_000, 2);
    const call = findExecuteCallMatching(/SELECT\s+DISTINCT\s+ON/i);
    const text = renderSql(call?.[0]);
    expect(text.match(/FROM\s+"wxyc_schema"\."flowsheet"/gi) ?? []).toHaveLength(1);

    // Calling again with a DIFFERENT floor re-binds the NEW value — proving
    // the threshold is a per-call parameter re-applied against live data, not
    // a value baked into some stored exclusion state from the prior call.
    jest.clearAllMocks();
    (db.execute as jest.Mock).mockResolvedValue([]);
    await enumerateFreetextPairs(300_000, 5);
    const call2 = findExecuteCallMatching(/SELECT\s+DISTINCT\s+ON/i);
    expect(collectParams(call2?.[0])).toEqual([5]);
  });

  it('wraps the DISTINCT ON pick in an outer query that re-orders pairs by total_plays DESC, leaving the inner representative-track ORDER BY untouched', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await enumerateFreetextPairs();
    const call = findExecuteCallMatching(/SELECT\s+DISTINCT\s+ON/i);
    const flat = renderSql(call?.[0]).replace(/\s+/g, ' ');

    // The inner (representative-track pick) ORDER BY is UNCHANGED from the
    // pre-BS#1822 shape — non-empty-first, most-played, deterministic
    // tiebreak — exactly as pinned by the "groups by ... orders by
    // non-empty-first" test above.
    const innerOrderBy = `ORDER BY "artist_name", "album_title", (btrim(coalesce("track_title", '')) = '') ASC, play_count DESC, "track_title" ASC`;
    expect(flat).toContain(innerOrderBy);

    // The outer re-order for the play-descending drain appears AFTER (wraps)
    // the inner DISTINCT ON's own ORDER BY — proving it's a separate outer
    // query, not bolted onto the DISTINCT ON's required leading ORDER BY
    // (which must match its distinct columns and can't itself start with
    // total_plays).
    const outerOrderBy = 'ORDER BY "total_plays" DESC, "artist_name" ASC, "album_title" ASC';
    expect(flat).toContain(outerOrderBy);
    expect(flat.indexOf(outerOrderBy)).toBeGreaterThan(flat.indexOf(innerOrderBy));
  });
});
