/**
 * The re-ask's cohort SQL, as statements (BS#3142, tracker BS#3137).
 *
 * The unit tier mocks `drizzle-orm`, so a statement is the mock's
 * `{ sql, values }` pair: these pin its text (rendered with `renderSql`) and
 * which values travel as bound parameters. Behaviour against a real planner
 * is `tests/integration/album-metadata-reask.spec.js`.
 *
 * @see WXYC/Backend-Service#3142
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { db } from '@wxyc/database';
import { renderSql } from '../../../utils/render-sql';
import {
  READ_TIMEOUT_DEFAULT,
  countCohort,
  countCohortSql,
  enumerateCohort,
  enumerateCohortSql,
  tallyCounts,
  type CohortInputs,
} from '../../../../jobs/album-metadata-reask/cohort';

type Statement = { sql: readonly string[]; values: readonly unknown[] };

const INPUTS: CohortInputs = {
  pins: [
    { library_id: 101, discogs_release_id: 9001, source: 'alex-l-2026-masters-api' },
    { library_id: 102, discogs_release_id: 9002, source: 'alex-l-2026' },
  ],
  removed: [{ library_id: 103, discogs_release_id: 9003, source: 'alex-l-2026-masters-api' }],
};

/** Every bound value of a statement, through nested fragments. */
const boundValues = (chunk: unknown): unknown[] => {
  if (chunk === null || typeof chunk !== 'object' || !('values' in chunk)) return [];
  return (chunk as Statement).values.flatMap((v) =>
    v !== null && typeof v === 'object' && 'values' in v ? boundValues(v) : [v]
  );
};

const flat = (chunk: unknown): string => renderSql(chunk).replace(/\s+/g, ' ');

const execute = db.execute as unknown as jest.Mock<(...args: unknown[]) => Promise<unknown>>;

describe('the cohort predicate', () => {
  const statement = flat(enumerateCohortSql(INPUTS, { limit: 0, afterAlbumId: 0 }));

  it('joins the pins and the removals through library.legacy_release_id, never library.id', () => {
    expect(statement).toContain('p.legacy_release_id = s.legacy_release_id');
    expect(statement).toContain('r.legacy_release_id = s.legacy_release_id');
    // The only join on library.id is album_metadata's own foreign key.
    expect(statement.match(/l\."id"/g)).toEqual(['l."id"']);
    expect(statement).toContain('l."id" = am."album_id"');
  });

  it('qualifies every column it reads from the base tables with its alias', () => {
    expect(statement).not.toMatch(/(?<![a-z]\.)"(album_id|discogs_url|artwork_url|legacy_release_id|artist_name)"/);
  });

  it('reads only real Discogs URLs, not the synthetic-match sentinel', () => {
    expect(statement).toContain(`nullif(am."discogs_url", '') IS NOT NULL`);
  });

  it('counts an unparseable stored URL as a mismatch, not a match', () => {
    expect(statement).toContain('s.stored_release_id IS DISTINCT FROM p.pin_release_id');
  });

  it('admits a removed pin only for a card with no pin now that still stores exactly the removed release', () => {
    expect(statement).toContain(
      'NOT EXISTS (SELECT 1 FROM pin p WHERE p.legacy_release_id = s.legacy_release_id) AND s.stored_release_id = r.removed_release_id'
    );
  });

  it('takes the artist name in the catalog export order', () => {
    expect(statement).toContain('COALESCE(l."artist_name", a."artist_name") AS artist_name');
  });
});

describe('array binding', () => {
  it.each([
    ['the enumeration', enumerateCohortSql(INPUTS, { limit: 0, afterAlbumId: 0, albumIds: [7, 8] })],
    ['the counts', countCohortSql(INPUTS)],
  ])('%s binds every id list as one intArrayLiteral string cast to int[], never a bare array', (_label, stmt) => {
    const values = boundValues(stmt);

    expect(values.some((v) => Array.isArray(v))).toBe(false);
    expect(values).toEqual(expect.arrayContaining(['{101,102}', '{9001,9002}', '{0,1}', '{103}', '{9003}', '{0}']));
    // Each literal is cast where it is bound.
    expect(flat(stmt)).toContain('unnest({101,102}::int[], {9001,9002}::int[], {0,1}::int[])');
    expect(flat(stmt)).toContain('unnest({103}::int[], {9003}::int[], {0}::int[])');
  });

  it('binds empty inputs as empty arrays, which Postgres accepts', () => {
    const values = boundValues(countCohortSql({ pins: [], removed: [] }));

    expect(values.filter((v) => v === '{}')).toHaveLength(6);
  });
});

describe('enumerateCohortSql: drainable subset, cursor and carried list', () => {
  it('drops rows with no artist name and albums marked not on Discogs, and orders by album_id', () => {
    const statement = flat(enumerateCohortSql(INPUTS, { limit: 0, afterAlbumId: 0 }));

    expect(statement).toContain('c.artist_name IS NOT NULL AND c.discogs_unavailable = false');
    expect(statement).toMatch(/ORDER BY c\.album_id$/);
  });

  it.each([
    { limit: 0, after: 0, ids: [], range: 'AND c.album_id > 0 ORDER', limitText: null },
    { limit: 25, after: 0, ids: [], range: 'AND c.album_id > 0 ORDER', limitText: 'LIMIT 25' },
    { limit: 2400, after: 53799, ids: [], range: 'AND c.album_id > 53799 ORDER', limitText: 'LIMIT 2400' },
    // A list with cursor 0 is a retry: the list is the whole run.
    { limit: 0, after: 0, ids: [40, 90], range: 'AND c.album_id = ANY({40,90}::int[]) ORDER', limitText: null },
    // A list with a cursor carries the previous run's unsettled albums on top of everything above it.
    {
      limit: 2400,
      after: 500,
      ids: [40, 90],
      range: 'AND (c.album_id > 500 OR c.album_id = ANY({40,90}::int[])) ORDER',
      limitText: 'LIMIT 2400',
    },
  ])('limit=$limit after=$after ids=$ids', ({ limit, after, ids, range, limitText }) => {
    const stmt = enumerateCohortSql(INPUTS, { limit, afterAlbumId: after, albumIds: ids });
    const statement = flat(stmt);

    expect(statement).toContain(range);
    expect(statement.includes('LIMIT')).toBe(limitText !== null);
    if (limitText) expect(statement).toContain(limitText);
    // The cursor and the cap are bound values, not text spliced into the statement.
    if (range.includes('>')) expect(boundValues(stmt)).toContain(after);
    if (limitText) expect(boundValues(stmt)).toContain(limit);
  });

  it.each([
    ['a fractional limit', 2.5, 0, []],
    ['a negative limit', -1, 0, []],
    ['a fractional cursor', 0, 1.5, []],
    ['a negative cursor', 0, -3, []],
    ['a non-finite cursor', 0, Number.NaN, []],
    ['a fractional id in the list', 0, 0, [10, 1.5]],
    ['a negative id in the list', 0, 0, [-10]],
  ])('refuses %s', (_label, limit, after, albumIds) => {
    expect(() => enumerateCohortSql(INPUTS, { limit, afterAlbumId: after, albumIds })).toThrow(/non-negative integer/);
  });

  it('refuses a pin id that is not an integer instead of binding it', () => {
    const bad = { pins: [{ library_id: 1.5, discogs_release_id: 1, source: 'x' }], removed: [] };

    expect(() => enumerateCohortSql(bad, { limit: 0, afterAlbumId: 0 })).toThrow(/intArrayLiteral/);
  });
});

describe('countCohortSql', () => {
  const statement = flat(countCohortSql(INPUTS));

  it('counts the whole cohort by reason and pin source, with the exclusions as filtered counts', () => {
    expect(statement).toContain('GROUP BY c.reason, c.source_idx');
    expect(statement).toContain('count(*) FILTER (WHERE c.artist_name IS NULL)::int AS no_artist_name');
    expect(statement).toContain(
      'count(*) FILTER (WHERE c.artist_name IS NOT NULL AND c.discogs_unavailable)::int AS discogs_unavailable'
    );
  });

  it('counts removed cards whose row stores some other release, which stay out of the cohort', () => {
    expect(statement).toContain(`'removed_stores_other' AS reason`);
    expect(statement).toContain('s.stored_release_id IS DISTINCT FROM r.removed_release_id');
  });
});

describe('tallyCounts', () => {
  const sources = ['alex-l-2026-masters-api', 'alex-l-2026'];

  it('names each source and keeps the exclusions out of the cohort totals', () => {
    const counts = tallyCounts(
      [
        { reason: 'pin_mismatch', source_idx: 0, n: 10, no_artist_name: 1, discogs_unavailable: 2, cover_mirrors: 3 },
        { reason: 'pin_mismatch', source_idx: 1, n: 4, no_artist_name: 0, discogs_unavailable: 0, cover_mirrors: 1 },
        { reason: 'pin_removed', source_idx: 0, n: 5, no_artist_name: 0, discogs_unavailable: 1, cover_mirrors: 0 },
        {
          reason: 'removed_stores_other',
          source_idx: 0,
          n: 6,
          no_artist_name: 0,
          discogs_unavailable: 0,
          cover_mirrors: 0,
        },
      ],
      sources
    );

    expect(counts).toEqual({
      total: 19,
      eligible: 15,
      by_reason_and_source: [
        { reason: 'pin_mismatch', source: 'alex-l-2026-masters-api', n: 10 },
        { reason: 'pin_mismatch', source: 'alex-l-2026', n: 4 },
        { reason: 'pin_removed', source: 'alex-l-2026-masters-api', n: 5 },
      ],
      excluded: { no_artist_name: 1, discogs_unavailable: 3, removed_stores_other: 6 },
      catalog_cover_mirrors: 4,
    });
  });

  it('is all zeros for an empty cohort', () => {
    expect(tallyCounts([], sources)).toEqual({
      total: 0,
      eligible: 0,
      by_reason_and_source: [],
      excluded: { no_artist_name: 0, discogs_unavailable: 0, removed_stores_other: 0 },
      catalog_cover_mirrors: 0,
    });
  });
});

describe('the reads', () => {
  beforeEach(() => {
    execute.mockReset();
  });

  it('enumerates under SET LOCAL statement_timeout and maps each row to a typed candidate', async () => {
    execute.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        album_id: 11,
        legacy_release_id: '102',
        discogs_url: 'https://www.discogs.com/release/1234',
        artwork_url: null,
        library_artwork_url: 'https://i.discogs.com/doga.jpg',
        stored_release_id: '1234',
        artist_name: 'Juana Molina',
        album_title: 'DOGA',
        reason: 'pin_mismatch',
        pin_release_id: 9002,
        source_idx: 1,
      },
      {
        album_id: 12,
        legacy_release_id: 103,
        discogs_url: 'https://www.discogs.com/release/9003',
        artwork_url: 'https://i.discogs.com/ooyla.jpg',
        library_artwork_url: null,
        stored_release_id: 9003,
        artist_name: 'Jessica Pratt',
        album_title: 'On Your Own Love Again',
        reason: 'pin_removed',
        pin_release_id: null,
        source_idx: 0,
      },
    ]);

    const rows = await enumerateCohort(INPUTS, { limit: 0, afterAlbumId: 0, timeoutMs: 1234 });

    expect(renderSql(execute.mock.calls[0][0])).toBe(`SET LOCAL statement_timeout = '1234ms'`);
    expect(rows).toEqual([
      {
        album_id: 11,
        legacy_release_id: 102,
        discogs_url: 'https://www.discogs.com/release/1234',
        artwork_url: null,
        library_artwork_url: 'https://i.discogs.com/doga.jpg',
        stored_release_id: 1234,
        artist_name: 'Juana Molina',
        album_title: 'DOGA',
        reason: 'pin_mismatch',
        pin_release_id: 9002,
        pin_source: 'alex-l-2026',
      },
      {
        album_id: 12,
        legacy_release_id: 103,
        discogs_url: 'https://www.discogs.com/release/9003',
        artwork_url: 'https://i.discogs.com/ooyla.jpg',
        library_artwork_url: null,
        stored_release_id: 9003,
        artist_name: 'Jessica Pratt',
        album_title: 'On Your Own Love Again',
        reason: 'pin_removed',
        pin_release_id: null,
        pin_source: 'alex-l-2026-masters-api',
      },
    ]);
  });

  it('keeps an unparseable stored release as null, not 0', async () => {
    execute.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        album_id: 13,
        legacy_release_id: 101,
        discogs_url: 'https://www.discogs.com/master/77',
        artwork_url: null,
        library_artwork_url: null,
        stored_release_id: null,
        artist_name: 'Stereolab',
        album_title: 'Dots and Loops',
        reason: 'pin_mismatch',
        pin_release_id: 9001,
        source_idx: 0,
      },
    ]);

    const [row] = await enumerateCohort(INPUTS, { limit: 0, afterAlbumId: 0 });

    expect(row.stored_release_id).toBeNull();
  });

  it('counts with the default five-minute read timeout', async () => {
    execute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { reason: 'pin_mismatch', source_idx: 1, n: 2, no_artist_name: 0, discogs_unavailable: 0, cover_mirrors: 1 },
      ]);

    const counts = await countCohort(INPUTS);

    expect(READ_TIMEOUT_DEFAULT).toBe(5 * 60 * 1000);
    expect(renderSql(execute.mock.calls[0][0])).toBe(`SET LOCAL statement_timeout = '300000ms'`);
    expect(counts.by_reason_and_source).toEqual([{ reason: 'pin_mismatch', source: 'alex-l-2026', n: 2 }]);
  });
});
