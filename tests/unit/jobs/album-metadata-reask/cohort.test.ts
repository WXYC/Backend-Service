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
  countCohort,
  countCohortSql,
  enumerateCohort,
  enumerateCohortSql,
  tallyCounts,
  type CohortInputs,
  type CountRow,
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

  it('parses only a release id that fits int, whole, so an oversized id reads as unparseable rather than aborting', () => {
    expect(statement).toContain(
      `substring(am."discogs_url" FROM '/release/([1-9][0-9]{0,8})(?![0-9])')::int AS stored_release_id`
    );
  });

  it('counts an unparseable stored URL as a mismatch, not a match', () => {
    expect(statement).toContain('s.stored_release_id IS DISTINCT FROM p.pin_release_id');
  });

  it('admits a removed pin only for a card with no pin now that still stores exactly the removed release', () => {
    expect(statement).toContain(
      'AS r(legacy_release_id, removed_release_id, pin_source) WHERE NOT EXISTS (SELECT 1 FROM pin p WHERE p.legacy_release_id = r.legacy_release_id)'
    );
    expect(statement).toContain('WHERE s.stored_release_id = r.removed_release_id');
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
    expect(values).toEqual(
      expect.arrayContaining([
        '{101,102}',
        '{9001,9002}',
        '{"alex-l-2026-masters-api","alex-l-2026"}',
        '{103}',
        '{9003}',
        '{"alex-l-2026-masters-api"}',
      ])
    );
    // Each literal is cast where it is bound.
    expect(flat(stmt)).toContain(
      'unnest({101,102}::int[], {9001,9002}::int[], {"alex-l-2026-masters-api","alex-l-2026"}::text[])'
    );
    expect(flat(stmt)).toContain('unnest({103}::int[], {9003}::int[], {"alex-l-2026-masters-api"}::text[])');
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
    { limit: 0, after: 0, ids: [], range: 'AND am."album_id" > 0 )', limitText: null },
    { limit: 25, after: 0, ids: [], range: 'AND am."album_id" > 0 )', limitText: 'LIMIT 25' },
    { limit: 2400, after: 53799, ids: [], range: 'AND am."album_id" > 53799 )', limitText: 'LIMIT 2400' },
    // A list with cursor 0 is a retry: the list is the whole run.
    { limit: 0, after: 0, ids: [40, 90], range: 'AND am."album_id" = ANY({40,90}::int[]) )', limitText: null },
    // A list with a cursor carries the previous run's unsettled albums on top of everything above it.
    {
      limit: 2400,
      after: 500,
      ids: [40, 90],
      range: 'AND (am."album_id" > 500 OR am."album_id" = ANY({40,90}::int[])) )',
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

  it.each([
    ['pins', { pins: [...INPUTS.pins, { ...INPUTS.pins[0], discogs_release_id: 1 }], removed: INPUTS.removed }],
    ['removed', { pins: INPUTS.pins, removed: [...INPUTS.removed, INPUTS.removed[0]] }],
  ])('refuses a card named twice in %s, which would enumerate its album twice', (_label, inputs) => {
    expect(() => enumerateCohortSql(inputs, { limit: 0, afterAlbumId: 0 })).toThrow(/library_id 10[13] appears twice/);
    expect(() => countCohortSql(inputs)).toThrow(/appears twice/);
  });

  it('refuses a pin id that is not an integer instead of binding it', () => {
    const bad = { pins: [{ library_id: 1.5, discogs_release_id: 1, source: 'x' }], removed: [] };

    expect(() => enumerateCohortSql(bad, { limit: 0, afterAlbumId: 0 })).toThrow(/intArrayLiteral/);
  });
});

describe('countCohortSql', () => {
  const statement = flat(countCohortSql(INPUTS));

  it('counts the whole cohort by reason and pin source, with the exclusions as filtered counts', () => {
    expect(statement).toContain('GROUP BY c.reason, c.pin_source');
    expect(statement).toContain('count(*) FILTER (WHERE c.artist_name IS NULL)::int AS no_artist_name');
    expect(statement).toContain(
      'count(*) FILTER (WHERE c.artist_name IS NOT NULL AND c.discogs_unavailable)::int AS discogs_unavailable'
    );
  });

  it('counts the whole cohort, with no cursor', () => {
    expect(statement).not.toContain('am."album_id" >');
  });

  it('counts removed cards whose row stores some other release, which stay out of the cohort', () => {
    expect(statement).toContain(`'removed_stores_other' AS reason`);
    expect(statement).toContain('s.stored_release_id IS DISTINCT FROM r.removed_release_id');
  });
});

const MASTERS_API = 'alex-l-2026-masters-api';

/** One count row; the exclusion columns default to 0. */
const countRow = (
  reason: CountRow['reason'],
  pin_source: string,
  n: number,
  no_artist_name = 0,
  discogs_unavailable = 0,
  cover_mirrors = 0
): CountRow => ({ reason, pin_source, n, no_artist_name, discogs_unavailable, cover_mirrors });

describe('tallyCounts', () => {
  it('names each source and keeps the exclusions out of the cohort totals', () => {
    const counts = tallyCounts([
      countRow('pin_mismatch', MASTERS_API, 10, 1, 2, 3),
      countRow('pin_mismatch', 'alex-l-2026', 4, 0, 0, 1),
      countRow('pin_removed', MASTERS_API, 5, 0, 1),
      countRow('removed_stores_other', MASTERS_API, 6),
    ]);

    expect(counts).toEqual({
      total: 19,
      eligible: 15,
      by_reason_and_source: [
        { reason: 'pin_mismatch', source: MASTERS_API, n: 10 },
        { reason: 'pin_mismatch', source: 'alex-l-2026', n: 4 },
        { reason: 'pin_removed', source: MASTERS_API, n: 5 },
      ],
      excluded: { no_artist_name: 1, discogs_unavailable: 3, removed_stores_other: 6 },
      catalog_cover_mirrors: 4,
    });
  });

  it('is all zeros for an empty cohort', () => {
    expect(tallyCounts([])).toEqual({
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
    const doga = {
      album_id: 11,
      discogs_url: 'https://www.discogs.com/release/1234',
      artwork_url: null,
      library_artwork_url: 'https://i.discogs.com/doga.jpg',
      artist_name: 'Juana Molina',
      album_title: 'DOGA',
      reason: 'pin_mismatch',
      pin_release_id: 9002,
      pin_source: 'alex-l-2026',
    };
    const ooyla = {
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
      pin_source: MASTERS_API,
    };
    // A URL that did not parse comes back null and must stay null, not 0.
    const dotsAndLoops = {
      ...doga,
      album_id: 13,
      legacy_release_id: 101,
      discogs_url: 'https://www.discogs.com/master/77',
      stored_release_id: null,
      artist_name: 'Stereolab',
      album_title: 'Dots and Loops',
    };
    execute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...doga, legacy_release_id: '102', stored_release_id: '1234' }, ooyla, dotsAndLoops]);

    const rows = await enumerateCohort(INPUTS, { limit: 0, afterAlbumId: 0, timeoutMs: 1234 });

    expect(renderSql(execute.mock.calls[0][0])).toBe(`SET LOCAL statement_timeout = '1234ms'`);
    expect(rows).toEqual([{ ...doga, legacy_release_id: 102, stored_release_id: 1234 }, ooyla, dotsAndLoops]);
  });

  it('refuses a zero timeout, which would disable statement_timeout instead of setting one', async () => {
    await expect(enumerateCohort(INPUTS, { limit: 0, afterAlbumId: 0, timeoutMs: 0 })).rejects.toThrow(
      /timeoutMs must be a positive integer/
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('counts with the default five-minute read timeout', async () => {
    execute.mockResolvedValueOnce([]).mockResolvedValueOnce([countRow('pin_mismatch', 'alex-l-2026', 2, 0, 0, 1)]);

    const counts = await countCohort(INPUTS);

    expect(renderSql(execute.mock.calls[0][0])).toBe(`SET LOCAL statement_timeout = '300000ms'`);
    expect(counts.by_reason_and_source).toEqual([{ reason: 'pin_mismatch', source: 'alex-l-2026', n: 2 }]);
  });
});
