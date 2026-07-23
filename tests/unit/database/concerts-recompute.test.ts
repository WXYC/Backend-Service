/**
 * Unit tests for shared/database/src/concerts-recompute.ts (BS#1760;
 * extracted from jobs/concerts-artist-resolver/recompute.ts by BS#1763 so
 * jobs/concerts-artist-lml-resolver's LML supportTarget can call the same
 * windowed recompute). Tests the REAL module directly (bypassing the
 * package-level `@wxyc/database` mock, mirroring
 * tests/unit/database/live-activity.test.ts and concerts-sql.test.ts) so
 * the SQL text asserted below is the module's actual output, not a
 * hand-duplicated stub.
 *
 * Both `jobs/concerts-artist-resolver/recompute.ts` (thin re-export shim)
 * and `jobs/concerts-artist-lml-resolver/job.ts` call this same function —
 * a support resolved by either job's resolve arm flips `has_resolved_
 * support` on whichever one of them runs the recompute step next.
 *
 * Step 4 of concerts-artist-resolver's four-step run: a single set-based
 * UPDATE recomputes `concerts.has_resolved_support` from truth over the
 * active window (`removed_at IS NULL AND starts_on >= todayEastern`). Per
 * the locked decision in the BS#1760 issue, this is NOT an in-line boolean
 * flip at resolve time — a windowed recompute-from-truth is the only shape
 * that handles the down-transition (tombstone the only resolved support →
 * must go false) without decrement bookkeeping.
 *
 * SQL-contract test pins: the EXISTS subquery's dual-lane resolved
 * predicate (artist_id OR discogs_artist_id), the role='support' +
 * removed_at IS NULL junction-side guard, the active-window WHERE, and
 * the `IS DISTINCT FROM` no-op guard (never touch a row whose flag
 * already matches truth, so `last_modified` stays an honest signal).
 * Outcome-counting test pins updated_true/updated_false bucketing off
 * the RETURNING rows.
 */
jest.mock('../../../shared/database/src/client.js', () => jest.requireActual('../../mocks/database.mock'), {
  virtual: true,
});

import { db } from '../../mocks/database.mock';
import { recomputeHasResolvedSupport } from '../../../shared/database/src/concerts-recompute';

type SqlLike = {
  sql?: string | string[];
  values?: unknown[];
  queryChunks?: Array<unknown>;
  value?: string | string[];
  raw?: string;
};

const PARAM_PLACEHOLDER = '<?>';

/** Best-effort drizzle-SQL renderer; see query.test.ts for the full contract. */
const renderSql = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return PARAM_PLACEHOLDER;
  }
  const obj = value as SqlLike;
  if (Array.isArray(obj.sql) && Array.isArray(obj.values)) {
    const fragments = obj.sql;
    const values = obj.values;
    const parts: string[] = [];
    fragments.forEach((fragment, i) => {
      parts.push(fragment);
      if (i < values.length) {
        parts.push(renderSql(values[i]));
      }
    });
    return parts.join('');
  }
  if (Array.isArray(obj.sql)) return obj.sql.join('');
  if (typeof obj.sql === 'string') return obj.sql;
  if (obj.queryChunks) {
    return obj.queryChunks.map((chunk) => renderSql(chunk)).join('');
  }
  if (typeof obj.raw === 'string') return obj.raw;
  if (Array.isArray(obj.value)) return obj.value.join('');
  if (typeof obj.value === 'string') return PARAM_PLACEHOLDER;
  return '';
};

beforeEach(() => {
  db.execute.mockReset();
});

describe('recomputeHasResolvedSupport — SQL contract', () => {
  test('windows on the active (non-tombstoned, upcoming) concert set', async () => {
    db.execute.mockResolvedValueOnce([]);

    await recomputeHasResolvedSupport();

    const text = renderSql(db.execute.mock.calls[0][0]);
    expect(text).toContain('"removed_at" IS NULL');
    expect(text).toContain(`"starts_on" >= (now() AT TIME ZONE 'America/New_York')::date`);
  });

  test('the EXISTS subquery uses the dual-lane resolved predicate (artist_id OR discogs_artist_id)', async () => {
    db.execute.mockResolvedValueOnce([]);

    await recomputeHasResolvedSupport();

    const text = renderSql(db.execute.mock.calls[0][0]);
    expect(text).toContain(`"role" = 'support'`);
    expect(text).toContain('"removed_at" IS NULL');
    expect(text).toContain('"artist_id" IS NOT NULL');
    expect(text).toContain('"discogs_artist_id" IS NOT NULL');
  });

  test('guards the UPDATE with IS DISTINCT FROM so an unchanged flag is never rewritten', async () => {
    db.execute.mockResolvedValueOnce([]);

    await recomputeHasResolvedSupport();

    const text = renderSql(db.execute.mock.calls[0][0]);
    expect(text).toContain('IS DISTINCT FROM');
    expect(text).toContain('"has_resolved_support"');
  });
});

describe('recomputeHasResolvedSupport — outcome counting', () => {
  test('buckets RETURNING rows into updated_true / updated_false', async () => {
    db.execute.mockResolvedValueOnce([{ resolved: true }, { resolved: false }, { resolved: true }]);

    const outcome = await recomputeHasResolvedSupport();

    expect(outcome).toEqual({ updated: 3, updated_true: 2, updated_false: 1 });
  });

  test('zero changed rows (steady state) → all-zero outcome, not an error', async () => {
    db.execute.mockResolvedValueOnce([]);

    const outcome = await recomputeHasResolvedSupport();

    expect(outcome).toEqual({ updated: 0, updated_true: 0, updated_false: 0 });
  });

  test('an unrecognized db.execute result shape fails LOUD, not as a zero-work run', async () => {
    db.execute.mockResolvedValueOnce({ weird: true });
    await expect(recomputeHasResolvedSupport()).rejects.toThrow(/unrecognized db\.execute\(\) result shape/);
  });
});
