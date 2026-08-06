/**
 * BS#2000 orchestrator.
 *
 * The behaviors pinned here are the ones that keep the job from destroying the
 * data it exists to protect:
 *
 *   1. Dry-run makes ZERO LML calls — sizing the work is free.
 *   2. One lookup per DISTINCT (artist, album, track), fanned to every row
 *      carrying that triple (BS#1192: Apple URLs are track-aware).
 *   3. A `none` verdict requires THREE consecutive null passes; a URL on pass
 *      2 or 3 short-circuits to `url` and counts as an observed throttle-null.
 *   4. An `indeterminate` triple is SKIPPED and the page CONTINUES — never a
 *      halt-in-place, which would wedge the run (the BS#1011 shape).
 *   5. The SQL net is a superset; the arbiter is what actually decides.
 *   6. The write is a compare-and-set, because this job overwrites a non-null
 *      value while two other writers touch the same column.
 *   7. ANALYZE after the write pass, and `updated_at` omitted on flowsheet.
 *   8. Phase order: flowsheet BEFORE album_metadata.
 */
import { jest } from '@jest/globals';

import { db } from '@wxyc/database';
import {
  VA_NET_REGEX,
  analyzeTable,
  applyFlowsheetBatch,
  invalidateAlbumBatch,
  type AlbumInvalidation,
  resolveAfterId,
  resolveBatchSize,
  resolveDryRun,
  resolveMaxRescueRate,
  runRemediation,
  tripleKey,
  __resetStopForTesting,
  type FlowsheetFix,
} from '../../../../jobs/va-apple-music-url-remediation/orchestrate';

/**
 * Renders a drizzle SQL object for *text* assertions (column names, guards,
 * ordering). It splices bound values inline, so it is deliberately BLIND to how
 * a value is actually PARAMETERIZED — `ANY(${[7, 8]})` and `ANY(${'{7,8}'}::int[])`
 * both render as plausible-looking text here. Anything about the wire shape of a
 * bound parameter must go through `findExecuteQuery` below instead.
 */
type SqlLike = { sql?: string | string[]; values?: unknown[]; raw?: string; join?: unknown[]; sep?: unknown };
const renderSql = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  const obj = value as SqlLike;
  if (typeof obj.raw === 'string') return obj.raw;
  if (Array.isArray(obj.join)) return obj.join.map(renderSql).join(renderSql(obj.sep));
  if (Array.isArray(obj.sql)) {
    const values = obj.values ?? [];
    return obj.sql.map((chunk, i) => chunk + (i < values.length ? renderSql(values[i]) : '')).join('');
  }
  if (typeof obj.sql === 'string') return obj.sql;
  return '';
};

const queueExecute = (...results: unknown[]): void => {
  const mock = db.execute as jest.Mock;
  for (const result of results) mock.mockResolvedValueOnce(result as never);
};

const findExecuteCall = (pattern: RegExp): string =>
  (db.execute as jest.Mock).mock.calls.map((c) => renderSql(c?.[0])).find((s) => pattern.test(s)) ?? '';

/**
 * Every leaf value bound into the first captured statement whose rendered text
 * matches, flattened across nested `sql.join(...)` fragments.
 * `tests/__mocks__/drizzle-orm.ts` stubs the `sql` tag as
 * `{ sql: strings, values }`, so it cannot serialize a statement — but it does
 * preserve each bound value verbatim, which is enough to tell a scalar bind
 * apart from a bare JS array. That distinction is invisible to `renderSql`
 * (which splices values inline), and it is the whole bug.
 */
const collectValues = (node: unknown, out: unknown[]): void => {
  if (node === null || typeof node !== 'object') {
    if (node !== undefined) out.push(node);
    return;
  }
  const obj = node as SqlLike;
  if (Array.isArray(obj.join)) {
    obj.join.forEach((fragment) => collectValues(fragment, out));
    return;
  }
  if (Array.isArray(obj.values)) {
    obj.values.forEach((value) => collectValues(value, out));
    return;
  }
  if (typeof obj.raw === 'string') return;
  out.push(node);
};

const findExecuteValues = (pattern: RegExp): unknown[] => {
  const chunk = (db.execute as jest.Mock).mock.calls.find((c) => pattern.test(renderSql(c?.[0])))?.[0];
  const out: unknown[] = [];
  collectValues(chunk, out);
  return out;
};

const APPLE_URL = 'https://music.apple.com/us/song/im-on-my-way/777';
const NEW_URL = 'https://music.apple.com/us/song/im-on-my-way/999';

const vaRow = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  artist_name: 'Various Artists - Blues',
  album_title: 'Blues Classics 1927-1940',
  track_title: "I'm On My Way",
  apple_music_url: APPLE_URL,
  ...overrides,
});

const withUrl = (url: string | null) => ({ results: [{ artwork: { apple_music_url: url } }] });
const EMPTY = { results: [] };

/** flowsheet: count, page, empty page. album: count, empty page. */
const queueSinglePageRun = (rows: unknown[]) => queueExecute([{ count: rows.length }], rows, [], [{ count: 0 }], []);

const noopAnalyze = jest.fn(async () => {});
const passThroughApply = jest.fn((fixes: FlowsheetFix[]) => Promise.resolve(fixes.length));
const noopInvalidate = jest.fn((targets: AlbumInvalidation[]) => Promise.resolve(targets.length));

const albumTargets: AlbumInvalidation[] = [
  { albumId: 7, oldUrl: APPLE_URL },
  { albumId: 8, oldUrl: APPLE_URL },
];

const baseOpts = (overrides: Record<string, unknown> = {}) => ({
  dryRun: false,
  applyBatchFn: passThroughApply as never,
  invalidateAlbumFn: noopInvalidate as never,
  analyzeFn: noopAnalyze as never,
  checkLiveActivityFn: (async () => {}) as never,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  __resetStopForTesting();
  // Disabled by default (matches the sibling jobs' test convention): the
  // 'cooperative live-DJ pause' describe block below opts individual tests
  // back in by setting this to a nonzero value themselves.
  process.env.LIVE_ACTIVITY_LOOKBACK_SECONDS = '0';
  process.env.LIVE_ACTIVITY_PAUSE_MS = '0';
  process.env.VA_REMEDIATION_SECOND_PASS_DELAY_MS = '0';
  delete process.env.VA_REMEDIATION_FLOWSHEET_AFTER_ID;
  delete process.env.VA_REMEDIATION_ALBUM_AFTER_ID;
});

describe('resolveDryRun', () => {
  it('defaults to dry-run', () => {
    expect(resolveDryRun(['node', 'job.js'])).toBe(true);
  });
  it('--execute switches writes on', () => {
    expect(resolveDryRun(['node', 'job.js', '--execute'])).toBe(false);
  });
  it('throws on contradictory flags', () => {
    expect(() => resolveDryRun(['node', 'job.js', '--execute', '--dry-run'])).toThrow(/contradictory/i);
  });
});

describe('env resolvers', () => {
  it('accepts a zero resume cursor as "start at the beginning"', () => {
    // The BS#1631 donor's envInt requires > 0 and would silently fall back
    // here, which is why the cursor uses requireNonNegativeInt instead.
    expect(resolveAfterId('VA_REMEDIATION_FLOWSHEET_AFTER_ID', '0')).toBe(0);
    expect(resolveAfterId('VA_REMEDIATION_FLOWSHEET_AFTER_ID', '4200')).toBe(4200);
  });

  it('rejects a nonsensical rescue-rate ceiling', () => {
    expect(resolveMaxRescueRate('0.2')).toBeCloseTo(0.2);
    expect(() => resolveMaxRescueRate('0')).toThrow(/fraction/);
    expect(() => resolveMaxRescueRate('1.5')).toThrow(/fraction/);
  });

  it('rejects a zero batch size', () => {
    expect(() => resolveBatchSize('0')).toThrow(/VA_REMEDIATION_BATCH_SIZE/);
  });
});

describe('tripleKey', () => {
  it('keys on all three axes because Apple URLs are track-aware (BS#1192)', () => {
    const a = tripleKey('Various Artists', 'Blues', 'Track One');
    expect(tripleKey('various artists', 'blues', 'track one')).toBe(a);
    expect(tripleKey('Various Artists', 'Blues', 'Track Two')).not.toBe(a);
  });
});

describe('candidate net', () => {
  it('folds the artist in SQL and uses the widened V/A regex', async () => {
    queueSinglePageRun([]);
    await runRemediation(baseOpts({ dryRun: true }));
    const countSql = findExecuteCall(/COUNT/);
    // The fold must happen in SQL: lower('Vàrious Artists') matches none of
    // the alternatives, so a lower()-based net would drop diacritic rows
    // before the arbiter ever saw them.
    expect(countSql).toMatch(/fold_artist_name/);
    expect(countSql).toContain('apple_music_url" IS NOT NULL');
    // Widened from the donor's `v\.a\.`, which is not a superset of
    // is_compilation_artist (misses the dotless `v.a` family).
    expect(VA_NET_REGEX).toContain('v[./]');
  });
});

describe('dry-run', () => {
  it('makes ZERO LML calls and zero writes', async () => {
    const lookup = jest.fn();
    queueSinglePageRun([vaRow(1), vaRow(2, { track_title: 'Another' })]);

    const result = await runRemediation(baseOpts({ dryRun: true, lookup: lookup }));

    expect(lookup).not.toHaveBeenCalled();
    expect(passThroughApply).not.toHaveBeenCalled();
    expect(noopAnalyze).not.toHaveBeenCalled();
    expect(result.flowsheet.distinctTriples).toBe(2);
    expect(result.flowsheet.arbitrated).toBe(2);
  });
});

describe('triple dedupe', () => {
  it('fans one lookup out to every row carrying that triple', async () => {
    const lookup = jest.fn(() => Promise.resolve(withUrl(NEW_URL)));
    queueSinglePageRun([vaRow(1), vaRow(2), vaRow(3)]);

    const result = await runRemediation(baseOpts({ lookup: lookup }));

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(result.flowsheet.distinctTriples).toBe(1);
    expect(passThroughApply.mock.calls[0][0]).toHaveLength(3);
  });
});

describe('multi-pass confirmation before NULL', () => {
  it('requires three consecutive nulls to write a NULL', async () => {
    const lookup = jest.fn(() => Promise.resolve(withUrl(null)));
    queueSinglePageRun([vaRow(1)]);

    const result = await runRemediation(baseOpts({ lookup: lookup }));

    expect(lookup).toHaveBeenCalledTimes(3);
    expect(result.flowsheet.written_null).toBe(1);
    expect(passThroughApply.mock.calls[0][0][0]).toMatchObject({ id: 1, url: null, oldUrl: APPLE_URL });
  });

  it('a URL on a later pass rescues the row and counts as a throttle-null', async () => {
    // This is the LML#904 failure the job must survive: the first probe timed
    // out on LML's own throttle, not because there is no match.
    const lookup = jest
      .fn()
      .mockResolvedValueOnce(withUrl(null) as never)
      .mockResolvedValueOnce(withUrl(NEW_URL) as never);
    queueSinglePageRun([vaRow(1)]);

    const result = await runRemediation(baseOpts({ lookup: lookup }));

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(result.flowsheet.written_url).toBe(1);
    expect(result.flowsheet.rescued).toBe(1);
    expect(result.flowsheet.first_pass_nulls).toBe(1);
    expect(passThroughApply.mock.calls[0][0][0]).toMatchObject({ url: NEW_URL });
  });

  it('does not spend confirmation passes on an indeterminate response', async () => {
    const lookup = jest.fn(() => Promise.resolve(EMPTY));
    queueSinglePageRun([vaRow(1)]);

    await runRemediation(baseOpts({ lookup: lookup }));

    expect(lookup).toHaveBeenCalledTimes(1);
  });
});

describe('indeterminate handling (anti-wedge)', () => {
  it('skips the triple, continues the page, and fails the run at the END', async () => {
    // Halting in place with the cursor at page start would re-select the same
    // page forever — the BS#1011 wedge. A genuinely unfindable compilation
    // returns empty results on every attempt, so this is the expected case.
    const lookup = jest.fn((artist: unknown) =>
      Promise.resolve((artist as string).includes('Latin') ? EMPTY : withUrl(NEW_URL))
    );
    queueSinglePageRun([vaRow(1, { artist_name: 'Various Artists - Latin' }), vaRow(2)]);

    const result = await runRemediation(baseOpts({ lookup: lookup }));

    expect(result.flowsheet.indeterminate).toBe(1);
    // The healthy row on the same page was still processed and written.
    expect(result.flowsheet.written_url).toBe(1);
    expect(result.flowsheet.last_id).toBe(2);
    // ...and the run reports failure so the AC isn't falsely claimed.
    expect(result.failed).toBe(true);
  });

  it('does not fail a dry-run for indeterminates', async () => {
    queueSinglePageRun([vaRow(1)]);
    const result = await runRemediation(baseOpts({ dryRun: true, lookup: jest.fn() }));
    expect(result.failed).toBe(false);
  });
});

describe('the arbiter, not the net, decides', () => {
  it('never writes a row the SQL net caught but the arbiter rejects', async () => {
    const lookup = jest.fn(() => Promise.resolve(withUrl(NEW_URL)));
    // `Various Production` matches the coarse regex and is NOT a V/A credit.
    queueSinglePageRun([vaRow(1, { artist_name: 'Various Production' }), vaRow(2)]);

    const result = await runRemediation(baseOpts({ lookup: lookup }));

    expect(result.flowsheet.scanned).toBe(2);
    expect(result.flowsheet.arbitrated).toBe(1);
    const written = passThroughApply.mock.calls[0][0];
    expect(written.map((f) => f.id)).toEqual([2]);
  });
});

describe('phase order', () => {
  it('runs flowsheet before album_metadata', async () => {
    // Nulling album_metadata unmasks flowsheet's value via the read-path
    // coalesce, so the fall-through target must already be clean.
    queueExecute([{ count: 1 }], [vaRow(1)], [], [{ count: 1 }], [{ album_id: 7, artist_name: 'Various Artists' }], []);
    const order: string[] = [];
    const apply = jest.fn((f: FlowsheetFix[]) => {
      order.push('flowsheet');
      return Promise.resolve(f.length);
    });
    const invalidate = jest.fn((targets: AlbumInvalidation[]) => {
      order.push('album');
      return Promise.resolve(targets.length);
    });

    await runRemediation(
      baseOpts({
        lookup: () => Promise.resolve(withUrl(NEW_URL)),
        applyBatchFn: apply,
        invalidateAlbumFn: invalidate,
      })
    );

    expect(order).toEqual(['flowsheet', 'album']);
  });

  it('skips the album phase when flowsheet failed', async () => {
    // Exactly 2: the count query, then page 1. `apply` below rejects on
    // page 1's write, which breaks the flowsheet loop before it ever fetches
    // a second page — a 3rd queued value here would go unconsumed and leak
    // into whatever test runs next (`jest.clearAllMocks()` clears call
    // history but not queued `mockResolvedValueOnce` values).
    queueExecute([{ count: 1 }], [vaRow(1)]);
    const apply = jest.fn(() => Promise.reject(new Error('boom')));
    const invalidate = jest.fn(() => Promise.resolve(0));

    const result = await runRemediation(
      baseOpts({
        lookup: () => Promise.resolve(withUrl(NEW_URL)),
        applyBatchFn: apply,
        invalidateAlbumFn: invalidate,
      })
    );

    expect(invalidate).not.toHaveBeenCalled();
    expect(result.failed).toBe(true);
  });
});

describe('applyFlowsheetBatch SQL', () => {
  it('is a compare-and-set that omits updated_at', async () => {
    (db.transaction as jest.Mock).mockImplementation((cb: (tx: unknown) => unknown) =>
      Promise.resolve(cb({ execute: db.execute }))
    );
    queueExecute({ count: 1 }, { count: 1 });

    await applyFlowsheetBatch([{ id: 1, url: NEW_URL, oldUrl: APPLE_URL }], 1000);

    const updateSql = findExecuteCall(/UPDATE/);
    // The compare-and-set: two other writers touch this column, and unlike the
    // fill-only siblings this job overwrites a NON-NULL value.
    expect(updateSql).toMatch(/IS NOT DISTINCT FROM v\."old_url"/);
    // migration 0084's bump_flowsheet_updated_at trigger owns the stamp.
    expect(updateSql).not.toMatch(/updated_at/);
    expect(updateSql).toMatch(/apple_music_url" = v\."url"/);
    expect(updateSql).not.toMatch(/spotify_url/);
  });
});

describe('invalidateAlbumBatch SQL', () => {
  it('sets status unresolved and resets the re-ask counter', async () => {
    (db.transaction as jest.Mock).mockImplementation((cb: (tx: unknown) => unknown) =>
      Promise.resolve(cb({ execute: db.execute }))
    );
    queueExecute({ count: 1 }, { count: 1 });

    await invalidateAlbumBatch(albumTargets, 1000);

    const updateSql = findExecuteCall(/UPDATE/);
    // Handing the row to the BS#1915 hourly re-ask sweep rather than
    // re-verifying it here — album_metadata is album-keyed while the URL is a
    // track deep-link, so there is no honest triple to re-query with.
    expect(updateSql).toMatch(/apple_music_status" = 'unresolved'/);
    expect(updateSql).toMatch(/streaming_reask_attempts" = 0/);
    expect(updateSql).toMatch(/apple_music_url" = NULL/);
  });

  it('is a compare-and-set on the observed url', async () => {
    // The album arm overwrites a NON-NULL value while the enrichment worker and
    // the BS#1915 sweep touch the same column, so a bare `IS NOT NULL` is not
    // enough: it would null a url the worker had just re-verified through the
    // post-#1139 guarded matcher. Mirrors applyFlowsheetBatch's guard.
    (db.transaction as jest.Mock).mockImplementation((cb: (tx: unknown) => unknown) =>
      Promise.resolve(cb({ execute: db.execute }))
    );
    queueExecute({ count: 1 }, { count: 1 });

    await invalidateAlbumBatch(albumTargets, 1000);

    const updateSql = findExecuteCall(/UPDATE/);
    expect(updateSql).toMatch(/IS NOT DISTINCT FROM v\."old_url"/);
    expect(updateSql).toMatch(/t\."album_id" = v\."album_id"/);
    // The old predicate would silently re-admit the race this guard closes.
    expect(updateSql).not.toMatch(/apple_music_url" IS NOT NULL/);
  });

  it('stamps updated_at, which no trigger does for album_metadata', async () => {
    // Migration 0084's bump_flowsheet_updated_at is flowsheet-ONLY (the mirror
    // image of applyFlowsheetBatch's `not.toMatch(/updated_at/)` assertion).
    // Drop this SET and the row's freshness signal — which the BS#1915 re-ask
    // sweep and the CDC consumers read — freezes at its pre-remediation value.
    (db.transaction as jest.Mock).mockImplementation((cb: (tx: unknown) => unknown) =>
      Promise.resolve(cb({ execute: db.execute }))
    );
    queueExecute({ count: 1 }, { count: 1 });

    await invalidateAlbumBatch(albumTargets, 1000);

    expect(findExecuteCall(/UPDATE/)).toMatch(/"updated_at" = NOW\(\)/);
  });

  it('never binds a bare JS array', async () => {
    // The shipped defect was `ANY(${albumIds})` with a bare `number[]`: drizzle
    // expands a JS array inside a `sql` template into a comma-separated
    // PARAMETER LIST, so Postgres received `ANY(($1, $2, … $202))` — a row
    // constructor, which `ANY` rejects at parse time (42809) — and every page
    // of the album_metadata phase failed. The VALUES join binds each id and url
    // as its own parameter, so no array is bound at all; this pins that.
    //
    // Only as strong as the mock allows: `tests/__mocks__/drizzle-orm.ts` stubs
    // the `sql` tag, so nothing here parses SQL. The statement is executed for
    // real — by requiring the compiled function — in
    // `tests/integration/va-apple-music-url-remediation-invalidate.spec.js`.
    (db.transaction as jest.Mock).mockImplementation((cb: (tx: unknown) => unknown) =>
      Promise.resolve(cb({ execute: db.execute }))
    );
    queueExecute({ count: 1 }, { count: 1 });

    await invalidateAlbumBatch(albumTargets, 1000);

    const bound = findExecuteValues(/UPDATE/);
    expect(bound.length).toBeGreaterThan(0);
    expect(bound.some((v) => Array.isArray(v))).toBe(false);
  });
});

describe('cooperative live-DJ pause (BS#2009)', () => {
  beforeEach(() => {
    // Nonzero by default within this block: LIVE_ACTIVITY_PAUSE_MS=0 is its
    // OWN disable gate now (see the 'does not spin' test below), so a test
    // in here that wants the probe to actually fire needs a real value —
    // the outer beforeEach's '0' would otherwise short-circuit every test
    // before checkLive is ever called. Tests that care about the exact
    // pause duration override this locally.
    process.env.LIVE_ACTIVITY_PAUSE_MS = '10';
  });
  afterEach(() => {
    delete process.env.LIVE_ACTIVITY_LOOKBACK_SECONDS;
  });

  it('sleeps while the probe reports activity and proceeds once it reports quiet', async () => {
    process.env.LIVE_ACTIVITY_LOOKBACK_SECONDS = '60';
    // Nonzero on purpose (the outer beforeEach's default is '0', which would
    // make stopAwareSleep(0) a no-op and let this test pass without any real
    // sleep ever happening). A real wait is asserted below via elapsed time.
    process.env.LIVE_ACTIVITY_PAUSE_MS = '120';
    const checkLive = jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    queueSinglePageRun([vaRow(1)]);

    const startedAt = Date.now();
    const result = await runRemediation(
      baseOpts({
        lookup: () => Promise.resolve(withUrl(NEW_URL)),
        checkLiveActivityFn: checkLive,
      })
    );
    const elapsedMs = Date.now() - startedAt;

    // The probe reported activity on its first call for the page, which
    // must trigger a REAL sleep of (at least) LIVE_ACTIVITY_PAUSE_MS before
    // the next probe — not a discarded read. A call-count assertion alone
    // cannot distinguish "looped and slept" from "read the answer once and
    // moved on regardless" (BS#2009 defect 1's exact shape), so this is the
    // one assertion in the suite a mutation that deletes the sleep/loop
    // (keeping only `await safeProbe()`) cannot pass without also being
    // slower than a genuine no-op — verified by mutation below.
    expect(elapsedMs).toBeGreaterThanOrEqual(100);
    // Exact count, verified by running the fixture rather than inferred:
    // 3 waitForQuietPeriod() calls total (one per while-loop page iteration
    // — 2 flowsheet [the data page + the terminal empty page] + 1 album
    // [its terminal empty page], per the "once per page" test below), plus
    // ONE extra checkLive invocation from the sleep-then-recheck inside the
    // FIRST of those three calls (true, then false) = 4. Strictly more than
    // the loop-free per-page baseline of 3 pinned by the next test.
    expect(checkLive).toHaveBeenCalledTimes(4);
    expect(checkLive).toHaveBeenCalledWith(60);
    expect(result.flowsheet.written_url).toBe(1);
  });

  it('probes once per page, not once per row', async () => {
    process.env.LIVE_ACTIVITY_LOOKBACK_SECONDS = '60';
    const checkLive = jest.fn(() => Promise.resolve(false));
    // Three arbitrated rows on a SINGLE page. A per-row probe (the old
    // defect) would call checkLive at least 3 times for flowsheet alone; a
    // per-page probe calls it once per while-loop iteration regardless of
    // how many rows the page holds — 2 for flowsheet (the data page plus
    // the terminal empty page) + 1 for album_metadata (its terminal empty
    // page) = 3, identical to the single-row case pinned in the test above.
    queueSinglePageRun([vaRow(1), vaRow(2, { track_title: 'Another' }), vaRow(3, { track_title: 'A Third' })]);

    await runRemediation(
      baseOpts({
        lookup: () => Promise.resolve(withUrl(NEW_URL)),
        checkLiveActivityFn: checkLive,
      })
    );

    expect(checkLive).toHaveBeenCalledTimes(3);
  });

  it('a throwing probe does not abort the run: it is treated as no-activity and the summary still carries both last_id cursors', async () => {
    process.env.LIVE_ACTIVITY_LOOKBACK_SECONDS = '60';
    const checkLive = jest.fn(() => Promise.reject(new Error('transient RDS blip')));
    queueExecute([{ count: 1 }], [vaRow(1)], [], [{ count: 1 }], [{ album_id: 7, artist_name: 'Various Artists' }], []);

    const result = await runRemediation(
      baseOpts({
        lookup: () => Promise.resolve(withUrl(NEW_URL)),
        checkLiveActivityFn: checkLive,
      })
    );

    // The run must not reject even though every probe call threw.
    expect(result.flowsheet.last_id).toBe(1);
    expect(result.album_metadata.last_id).toBe(7);
    expect(result.flowsheet.written_url).toBe(1);
    expect(result.album_metadata.invalidated).toBe(1);
    expect(result.failed).toBe(false);
  });

  it('skips the probe entirely when the lookback is 0 (pause disabled)', async () => {
    process.env.LIVE_ACTIVITY_LOOKBACK_SECONDS = '0';
    const checkLive = jest.fn(() => Promise.resolve(true));
    queueSinglePageRun([vaRow(1)]);

    await runRemediation(
      baseOpts({
        lookup: () => Promise.resolve(withUrl(NEW_URL)),
        checkLiveActivityFn: checkLive,
      })
    );

    expect(checkLive).not.toHaveBeenCalled();
  });

  it('does not spin when the pause is disabled via pauseMs<=0, even while the probe reports activity', async () => {
    process.env.LIVE_ACTIVITY_LOOKBACK_SECONDS = '60';
    process.env.LIVE_ACTIVITY_PAUSE_MS = '0';
    // stopAwareSleep(0) returns without awaiting a real timer, so a probe
    // that never reports quiet would otherwise degenerate into an
    // unthrottled `while (active) { probe() }` hot loop against RDS for the
    // run's entire duration. Bounded (not literally always-true) so that IF
    // this regresses, the mock terminates the loop after a bounded number
    // of calls instead of hanging the test run indefinitely — the
    // assertion below is what actually catches the regression.
    let calls = 0;
    const checkLive = jest.fn(() => {
      calls += 1;
      return Promise.resolve(calls <= 50);
    });
    queueSinglePageRun([vaRow(1)]);

    await runRemediation(
      baseOpts({
        lookup: () => Promise.resolve(withUrl(NEW_URL)),
        checkLiveActivityFn: checkLive,
      })
    );

    // pauseMs<=0 disables the pause the same way lookbackSeconds<=0 does:
    // the probe is never called at all, regardless of what it would report.
    expect(checkLive).not.toHaveBeenCalled();
  });
});

describe('ANALYZE pairing', () => {
  it('runs ANALYZE after the flowsheet write pass', async () => {
    // No CI check covers this for a TS job — check-bulk-update-analyze.mjs
    // scans .sql files only — so the bulk-update-playbook rule is pinned here.
    queueSinglePageRun([vaRow(1)]);
    await runRemediation(baseOpts({ lookup: () => Promise.resolve(withUrl(NEW_URL)) }));
    expect(noopAnalyze).toHaveBeenCalledWith('flowsheet', expect.any(Number));
  });

  it('emits ANALYZE in a raised-timeout transaction', async () => {
    (db.transaction as jest.Mock).mockImplementation((cb: (tx: unknown) => unknown) =>
      Promise.resolve(cb({ execute: db.execute }))
    );
    queueExecute({}, {});
    await analyzeTable('flowsheet', 300_000);
    expect(findExecuteCall(/statement_timeout/)).toContain('300000');
    expect(findExecuteCall(/ANALYZE/)).toMatch(/ANALYZE/);
  });
});
