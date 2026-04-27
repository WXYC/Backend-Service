/**
 * Unit tests for the LML-linkage observability surface (B-3.2).
 *
 * Two readouts cover the linkage path:
 *   - In-process counters keyed by outcome name
 *     (`linked_high_conf` / `gray_zone_review` / `no_candidate` /
 *      `lml_error` / `lml_timeout`). B-2.1 (forward) and B-2.2 (backfill)
 *     both increment them. Tests assert the counter map is exposed and
 *     mutates only via the documented increment helper.
 *   - SQL-backed gauges: cumulative linkage coverage across the whole
 *     `flowsheet` table, and a "linked-within-N-hours" forward-path health
 *     proxy.
 *
 * The Sentry tag `subsystem='lml-linkage'` rides on every error reported
 * through this module so the operator can filter the issue stream by
 * subsystem instead of by stack trace.
 */
import { jest } from '@jest/globals';
import { db } from '../../mocks/database.mock';

const mockCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({ captureException: mockCaptureException }));

import {
  LINKAGE_METRIC_NAMES,
  classifyLinkageError,
  getCumulativeLinkageCoverage,
  getLinkageCounters,
  getRecentLinkageRate,
  incrementLinkageMetric,
  reportLinkageError,
  resetLinkageCounters,
} from '../../../apps/backend/services/linkage-metrics.service';

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

describe('linkage counters', () => {
  beforeEach(() => {
    resetLinkageCounters();
  });

  it('exposes exactly the five outcome names the issue specifies', () => {
    // The dashboard the operator builds against this surface keys on these
    // names. Adding a sixth or renaming one silently breaks the dashboard.
    expect(new Set(LINKAGE_METRIC_NAMES)).toEqual(
      new Set(['linked_high_conf', 'gray_zone_review', 'no_candidate', 'lml_error', 'lml_timeout'])
    );
  });

  it('initializes every counter to zero', () => {
    const snapshot = getLinkageCounters();
    for (const name of LINKAGE_METRIC_NAMES) {
      expect(snapshot[name]).toBe(0);
    }
  });

  it('increments the named counter independently of the others', () => {
    incrementLinkageMetric('linked_high_conf');
    incrementLinkageMetric('linked_high_conf');
    incrementLinkageMetric('gray_zone_review');

    const snapshot = getLinkageCounters();
    expect(snapshot.linked_high_conf).toBe(2);
    expect(snapshot.gray_zone_review).toBe(1);
    expect(snapshot.no_candidate).toBe(0);
    expect(snapshot.lml_error).toBe(0);
    expect(snapshot.lml_timeout).toBe(0);
  });

  it('returns a copy so callers cannot mutate the live counters', () => {
    incrementLinkageMetric('linked_high_conf');
    const snapshot = getLinkageCounters();
    snapshot.linked_high_conf = 999;
    expect(getLinkageCounters().linked_high_conf).toBe(1);
  });
});

describe('classifyLinkageError', () => {
  // Timeouts are usually transient (LML cold start, network blip) and the
  // backfill retries on the next sweep; non-timeout errors are more often
  // bugs in the linkage path itself. Splitting the counters lets the
  // operator tell those two failure modes apart at a glance.
  it("classifies node-fetch AbortError-style errors as 'lml_timeout'", () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(classifyLinkageError(err)).toBe('lml_timeout');
  });

  it("classifies ETIMEDOUT errors as 'lml_timeout'", () => {
    const err = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    expect(classifyLinkageError(err)).toBe('lml_timeout');
  });

  it("classifies messages mentioning 'timeout' (case-insensitive) as 'lml_timeout'", () => {
    expect(classifyLinkageError(new Error('Request Timeout from LML'))).toBe('lml_timeout');
  });

  it("classifies everything else as 'lml_error'", () => {
    expect(classifyLinkageError(new Error('500 Internal Server Error'))).toBe('lml_error');
    expect(classifyLinkageError('not even an Error object')).toBe('lml_error');
    expect(classifyLinkageError(null)).toBe('lml_error');
  });
});

describe('reportLinkageError', () => {
  beforeEach(() => {
    mockCaptureException.mockReset();
  });

  it("forwards the error to Sentry with tag subsystem='lml-linkage'", () => {
    const err = new Error('LML 502');
    reportLinkageError(err);

    expect(mockCaptureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ tags: expect.objectContaining({ subsystem: 'lml-linkage' }) })
    );
  });

  it('attaches caller-supplied context as Sentry extras', () => {
    // The operator opens the Sentry issue and needs the flowsheet id +
    // artist/album text to triage. Without extras they only see the stack.
    const err = new Error('LML failure');
    reportLinkageError(err, { flowsheetId: 7, artistName: 'Stereolab', albumTitle: 'Dots and Loops' });

    expect(mockCaptureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        tags: expect.objectContaining({ subsystem: 'lml-linkage' }),
        extra: expect.objectContaining({
          flowsheetId: 7,
          artistName: 'Stereolab',
          albumTitle: 'Dots and Loops',
        }),
      })
    );
  });

  it('passes additional caller tags alongside the subsystem tag', () => {
    // Forward path vs. backfill is a useful axis to slice the error stream
    // by. Callers pass `path: 'forward' | 'backfill'` as a tag.
    reportLinkageError(new Error('boom'), undefined, { path: 'forward' });

    const call = mockCaptureException.mock.calls[0];
    const opts = call[1] as { tags: Record<string, string> };
    expect(opts.tags.subsystem).toBe('lml-linkage');
    expect(opts.tags.path).toBe('forward');
  });
});

describe('getCumulativeLinkageCoverage', () => {
  beforeEach(() => {
    (db.execute as jest.Mock).mockReset();
  });

  it("issues count(*) FILTER (WHERE album_id IS NOT NULL) over flowsheet entry_type='track'", async () => {
    // The exact ratio we want surfaced on the dashboard. FILTER beats the
    // alternative (two queries or a subquery) because PG runs it in a
    // single pass over the table.
    (db.execute as jest.Mock).mockResolvedValueOnce([{ linked: 100, total: 250 }]);

    const result = await getCumulativeLinkageCoverage();

    expect(result).toEqual({ linked: 100, total: 250, ratio: 0.4 });
    const sqlText = renderSql((db.execute as jest.Mock).mock.calls[0][0]);
    expect(sqlText).toMatch(/count\(\*\)\s+FILTER\s*\(\s*WHERE\s+"?album_id"?\s+IS\s+NOT\s+NULL\s*\)/i);
    expect(sqlText).toMatch(/FROM[\s\S]*flowsheet/i);
    expect(sqlText).toMatch(/entry_type"?\s*=\s*'track'/i);
  });

  it('handles an empty table without dividing by zero', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([{ linked: 0, total: 0 }]);

    const result = await getCumulativeLinkageCoverage();

    expect(result).toEqual({ linked: 0, total: 0, ratio: 0 });
  });

  it('coerces postgres BIGINT string counts to numbers', async () => {
    // postgres-js returns BIGINTs as strings to avoid precision loss. The
    // 1.95M-row flowsheet count would surface as a string and JSON.stringify
    // would happily ship "1956737" to the dashboard if we forgot to coerce.
    (db.execute as jest.Mock).mockResolvedValueOnce([{ linked: '775453', total: '1956737' }]);

    const result = await getCumulativeLinkageCoverage();

    expect(typeof result.linked).toBe('number');
    expect(typeof result.total).toBe('number');
    expect(result.linked).toBe(775453);
    expect(result.total).toBe(1956737);
    expect(result.ratio).toBeCloseTo(775453 / 1956737, 6);
  });
});

describe('getRecentLinkageRate', () => {
  beforeEach(() => {
    (db.execute as jest.Mock).mockReset();
  });

  it('parameterizes the lookback window in hours', async () => {
    // The forward-path health proxy: of rows inserted in the last N hours,
    // how many were linked? B-2.1's worker should land linkage within
    // minutes; a falling ratio means the worker is falling behind.
    (db.execute as jest.Mock).mockResolvedValueOnce([{ inserted: 50, linked: 47 }]);

    const result = await getRecentLinkageRate(24);

    expect(result).toEqual({ inserted: 50, linked: 47, ratio: 47 / 50 });
    const call = (db.execute as jest.Mock).mock.calls[0][0];
    const sqlText = renderSql(call);
    expect(sqlText).toMatch(/add_time/i);
    expect(sqlText).toMatch(/now\(\)\s*-/i);
    expect(JSON.stringify(call)).toContain('24');
  });

  it("scopes the rate to entry_type='track' (messages and breaks shouldn't move the gauge)", async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([{ inserted: 0, linked: 0 }]);

    await getRecentLinkageRate(24);

    const sqlText = renderSql((db.execute as jest.Mock).mock.calls[0][0]);
    expect(sqlText).toMatch(/entry_type"?\s*=\s*'track'/i);
  });

  it('returns ratio=0 when nothing has been inserted in the window', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([{ inserted: 0, linked: 0 }]);

    const result = await getRecentLinkageRate(1);

    expect(result.ratio).toBe(0);
  });
});
