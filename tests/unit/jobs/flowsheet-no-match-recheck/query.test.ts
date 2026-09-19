/**
 * Unit tests for jobs/flowsheet-no-match-recheck query.ts (BS#2176, BS#2218).
 *
 * Pins the recurring sweep's candidate predicate: terminal `enriched_no_match`
 * track rows with a real artist name remain the idempotent candidate set, but
 * a row already recheck-attempted inside the TTL is suppressed until the
 * marker exits the window. Bounded by a per-run LIMIT (the "bounded drip, not
 * a full-cohort sweep" constraint).
 *
 * BS#2218 changed the ordering: never-attempted rows still lead (`NULLS
 * FIRST`) and previously-attempted rows still sort oldest-attempted-first,
 * but the `id` tiebreak flipped from `ASC` to `DESC` (newest-first) — see
 * `query.ts`'s module docstring for why oldest-first stranded 2026 playcuts
 * 132,460 rows deep. BS#2218 also added an OFFSET cursor (`countCandidates` +
 * a `cursorOffset` param on `loadCandidates`) so a persistently-transient
 * head can't occupy every future run's window — see
 * `jobs/flowsheet-no-match-recheck/watermark.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';

import { jest } from '@jest/globals';

import { db } from '@wxyc/database';
import {
  countCandidates,
  loadCandidates,
  CRON_SCHEDULE,
  HEAD_CURSOR_WINDOW_DAYS,
  HEAD_CURSOR_WINDOW_DEFAULT,
  HEAD_SLICE_COVERAGE_MARGIN,
  HEAD_SLICE_DEFAULT,
  MEASURED_INFLOW_ROWS_PER_DAY,
  RUNS_PER_DAY,
  runsPerDayFromCronSchedule,
} from '../../../../jobs/flowsheet-no-match-recheck/query';
import { renderSql } from '../../../utils/render-sql';

describe('loadCandidates', () => {
  beforeEach(() => {
    (db.execute as jest.Mock).mockReset();
  });

  test('selects terminal no-match track rows and keeps metadata_status as the idempotency gate', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([
      {
        id: 5308981,
        artist_name: 'Vladislav Delay',
        album_title: 'Entain',
        track_title: 'Kohde',
        album_id: null,
        discogs_unavailable: false,
      },
    ]);

    const rows = await loadCandidates(14, 200);

    expect(rows).toEqual([
      {
        id: 5308981,
        artist_name: 'Vladislav Delay',
        album_title: 'Entain',
        track_title: 'Kohde',
        album_id: null,
        discogs_unavailable: false,
      },
    ]);
    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]);
    expect(text).toMatch(/FROM\s+"?wxyc_schema"?\."?flowsheet"?/i);
    expect(text).toMatch(/"metadata_status"\s*=\s*'enriched_no_match'/i);
    expect(text).toMatch(/"entry_type"\s*=\s*'track'/i);
    expect(text).toMatch(/"artist_name"\s+IS\s+NOT\s+NULL/i);
  });

  test('suppresses recheck-attempted rows inside the TTL and permits them after the TTL', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await loadCandidates(14, 200);

    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    expect(text).toContain('"no_match_recheck_attempted_at" IS NULL');
    expect(text).toContain('"no_match_recheck_attempted_at" <= now() - (interval');
    expect(text).toContain("interval '1 day'");
  });

  test('orders never-attempted rows first (NULLS FIRST), then previously-attempted rows oldest-first, and bounds with LIMIT', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await loadCandidates(14, 200);

    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    expect(text).toMatch(/ORDER BY\s+f\."no_match_recheck_attempted_at"\s+ASC\s+NULLS\s+FIRST\s*,/i);
    expect(text).toMatch(/LIMIT/i);
  });

  test('BS#2218: the id tiebreak is newest-first (DESC) — a 2026 playcut sorts ahead of a 2004 one', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await loadCandidates(14, 200);

    // `id` is monotonically assigned at insert time, so a 2026 playcut (a
    // large id, e.g. ~5,309,000 per the BS#2218 measurement) sorts strictly
    // before a 2004 playcut (a small id, e.g. ~200) — the opposite of the
    // pre-fix `id ASC` tiebreak that put 22 years of history ahead of
    // anything a listener can currently see.
    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    expect(text).toMatch(/ORDER BY f\."no_match_recheck_attempted_at" ASC NULLS FIRST, f\."id" DESC/i);
  });

  test('BS#2218: no CASE expressions in the ORDER BY — a per-tier tiebreak would foreclose the index remedy', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await loadCandidates(14, 200);

    // A B-tree can never supply an `ORDER BY <CASE expression>` order, so
    // splitting the tiebreak per tier would rule out the companion
    // `(no_match_recheck_attempted_at NULLS FIRST, id DESC)` index that
    // query.ts's INDEXING NOTE holds in reserve. The tie a per-tier
    // tiebreak would protect (two rows stamped at the identical timestamp)
    // does not occur: each stamp is its own single-row UPDATE.
    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    expect(text).not.toMatch(/ORDER BY[^;]*CASE/i);
  });

  test('BS#2218: accepts a cursorOffset and appends it as OFFSET', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await loadCandidates(14, 200, 400);

    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    expect(text).toMatch(/OFFSET 400/i);
  });

  test('BS#2218: cursorOffset defaults to 0 (no behavior change for a caller that omits it)', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await loadCandidates(14, 200);

    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    expect(text).toMatch(/OFFSET 0/i);
  });

  test('does not key off metadata_attempt_at — the C6 sweep writer-discriminator marker stays untouched', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await loadCandidates(14, 200);

    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]);
    expect(text).not.toMatch(/metadata_attempt_at/i);
  });

  test('LEFT JOINs library on album_id and pre-reads discogs_unavailable, defaulting unlinked rows to false', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await loadCandidates(14, 200);

    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]);
    expect(text).toMatch(/LEFT\s+JOIN\s+"?wxyc_schema"?\."?library"?/i);
    expect(text).toMatch(/ON\s+f\."?album_id"?\s*=\s*l\."?id"?/i);
    expect(text).toMatch(/COALESCE\s*\(\s*l\."?discogs_unavailable"?\s*,\s*false\s*\)\s+AS\s+"?discogs_unavailable"?/i);
  });
});

describe('countCandidates', () => {
  beforeEach(() => {
    (db.execute as jest.Mock).mockReset();
  });

  test('BS#2218: counts the same predicate loadCandidates uses, with no LIMIT/OFFSET/ORDER BY', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([{ count: 137340 }]);

    const count = await countCandidates(14);

    expect(count).toBe(137340);
    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    expect(text).toMatch(/COUNT\(\*\)/i);
    expect(text).toMatch(/FROM\s+"?wxyc_schema"?\."?flowsheet"?/i);
    expect(text).toMatch(/"metadata_status"\s*=\s*'enriched_no_match'/i);
    expect(text).toMatch(/"entry_type"\s*=\s*'track'/i);
    expect(text).toMatch(/"artist_name"\s+IS\s+NOT\s+NULL/i);
    expect(text).toContain('"no_match_recheck_attempted_at" IS NULL');
    expect(text).not.toMatch(/ORDER BY/i);
    expect(text).not.toMatch(/LIMIT/i);
    expect(text).not.toMatch(/OFFSET/i);
  });

  test('BS#2218: returns 0 when the predicate matches nothing', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([{ count: 0 }]);

    const count = await countCandidates(14);

    expect(count).toBe(0);
  });
});

describe('RUNS_PER_DAY (BS#2222)', () => {
  const jobPackageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../../../jobs/flowsheet-no-match-recheck/package.json'), 'utf-8')
  ) as Record<string, string>;

  test('CRON_SCHEDULE is the cadence the deploy actually installs, read from package.json', () => {
    // The guard has to point THIS way round. Pinning `RUNS_PER_DAY` to the
    // literal 4 fails when someone corrects the constant and passes when
    // someone changes the real cadence (BS#2186 resizing it to hourly, say)
    // and leaves the constant stale -- which is the silent 12x head-slice
    // over-spend the "derived, not hardcoded" criterion exists to prevent.
    // `scripts/resolve-cron-schedule.sh` reads this same field at deploy time.
    expect(CRON_SCHEDULE).toBe(jobPackageJson['cron-schedule']);
  });

  test('is derived from CRON_SCHEDULE, not hand-copied', () => {
    expect(RUNS_PER_DAY).toBe(runsPerDayFromCronSchedule(jobPackageJson['cron-schedule']));
    expect(RUNS_PER_DAY).toBe(4); // `47 */6 * * *` -> one minute x four hours
  });

  test('runsPerDayFromCronSchedule handles every field shape this fleet uses', () => {
    expect(runsPerDayFromCronSchedule('47 */6 * * *')).toBe(4); // this job
    expect(runsPerDayFromCronSchedule('10 * * * *')).toBe(24); // flowsheet-metadata-backfill (hourly)
    expect(runsPerDayFromCronSchedule('15 4 * * *')).toBe(1); // artist-search-alias-consumer (daily)
    expect(runsPerDayFromCronSchedule('*/30 * * * *')).toBe(48); // legacy-linkage-resolve
    expect(runsPerDayFromCronSchedule('0 0-11 * * *')).toBe(12); // a range
    expect(runsPerDayFromCronSchedule('0,30 2,14 * * *')).toBe(4); // comma lists
  });

  test('refuses a schedule whose runs-per-day is undefined or unparseable, rather than guessing', () => {
    // A weekly cron (rotation-release-id-pollution-check's `0 7 * * 1`) has no
    // runs-per-day, so deriving a head slice from it would be nonsense.
    expect(() => runsPerDayFromCronSchedule('0 7 * * 1')).toThrow(/does not run every day/);
    expect(() => runsPerDayFromCronSchedule('10 7 * * 0')).toThrow(/does not run every day/);
    expect(() => runsPerDayFromCronSchedule('47 */6 * *')).toThrow(/expected 5 fields/);
    expect(() => runsPerDayFromCronSchedule('47 banana * * *')).toThrow(/Unsupported cron field/);
    expect(() => runsPerDayFromCronSchedule('47 */0 * * *')).toThrow(/Unsupported cron field/);
    expect(() => runsPerDayFromCronSchedule('47 24 * * *')).toThrow(/Unsupported cron field/);
  });
});

describe('HEAD_SLICE_DEFAULT (BS#2222)', () => {
  test('is derived arithmetic, not a bare constant: ceil(inflow * margin / runsPerDay)', () => {
    expect(HEAD_SLICE_DEFAULT).toBe(
      Math.ceil((MEASURED_INFLOW_ROWS_PER_DAY * HEAD_SLICE_COVERAGE_MARGIN) / RUNS_PER_DAY)
    );
  });

  test('matches the README table: 40/day inflow, 2x margin, 4 runs/day -> 20', () => {
    expect(MEASURED_INFLOW_ROWS_PER_DAY).toBe(40);
    expect(HEAD_SLICE_COVERAGE_MARGIN).toBe(2);
    expect(RUNS_PER_DAY).toBe(4);
    expect(HEAD_SLICE_DEFAULT).toBe(20);
  });

  test('clears the measured inflow with the stated margin: headSlice * runsPerDay >= inflow * margin', () => {
    expect(HEAD_SLICE_DEFAULT * RUNS_PER_DAY).toBeGreaterThanOrEqual(
      MEASURED_INFLOW_ROWS_PER_DAY * HEAD_SLICE_COVERAGE_MARGIN
    );
  });

  test('is independent of BATCH_SIZE — head coverage is an inflow requirement, not a batch fraction', () => {
    // The docstring used to claim a BATCH_SIZE resize recomputed this. It does
    // not, and cannot: none of the three inputs is a function of BATCH_SIZE.
    // What a BATCH_SIZE resize invalidates is the README's wrap-period table
    // and the head's share of each run, both prose.
    expect(HEAD_SLICE_DEFAULT).toBe(
      Math.ceil((MEASURED_INFLOW_ROWS_PER_DAY * HEAD_SLICE_COVERAGE_MARGIN) / RUNS_PER_DAY)
    );
  });
});

describe('HEAD_CURSOR_WINDOW_DEFAULT (BS#2222)', () => {
  test('is derived from the same inflow measurement, over the window it was measured on', () => {
    expect(HEAD_CURSOR_WINDOW_DEFAULT).toBe(MEASURED_INFLOW_ROWS_PER_DAY * HEAD_CURSOR_WINDOW_DAYS);
    expect(HEAD_CURSOR_WINDOW_DEFAULT).toBe(200);
  });

  test('rotates fully in fewer runs than the window holds days of inflow', () => {
    // The head must come back around to a row while that row is still inside
    // the window, or the rotation would hand rows off to the tail's ~6-month
    // wrap -- the deferral this whole change removes.
    const rotationRuns = HEAD_CURSOR_WINDOW_DEFAULT / HEAD_SLICE_DEFAULT;
    expect(rotationRuns / RUNS_PER_DAY).toBeLessThan(HEAD_CURSOR_WINDOW_DAYS);
  });
});
