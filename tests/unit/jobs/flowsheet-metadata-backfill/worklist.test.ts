/**
 * Unit tests for jobs/flowsheet-metadata-backfill/worklist.ts (BS#1591).
 *
 * Pins the shape of the run-start work-list build that replaced the
 * id-cursor drain:
 *   1. Two statements: a cheap pending-count (partial-index shaped) first,
 *      then the priority-ordered work-list SELECT. `below_floor_skipped`
 *      is the subtraction `pending_total - worklist_size` — valid because
 *      the eligibility disjunction partitions the pending set exactly.
 *   2. The work-list statement carries the canonical pending predicate
 *      (entry_type='track', artist_name IS NOT NULL, marker IS NULL, 60s
 *      race guard), groups plays on wxyc_schema.normalize_artist_name so
 *      the key can't drift from the SQL/TS twins (migration 0092), unions
 *      `artists` with `artist_search_alias` for the library exemption, and
 *      orders (plays DESC, artist_norm ASC, id ASC) — the artist tiebreak
 *      keeps same-artist rows contiguous for the LookupCache dedup.
 *   3. Floor semantics: playFloor=0 omits the whole eligibility clause
 *      (floor disabled — everything pending is eligible) and forces the
 *      below-floor count to 0; recencyDays=0 omits only the recency arm.
 *   4. The PARTITION_INDEX/PARTITION_COUNT fragment composes into BOTH
 *      statements, so the subtraction stays partition-consistent.
 *
 * drizzle-orm is mocked in the unit harness (`{sql: strings[], values}`,
 * `sql.raw` → `{raw}`), so nested fragments land in `values`; renderDeep
 * below stitches the full statement text back together for regex asserts.
 */
import { jest } from '@jest/globals';

import { db } from '@wxyc/database';
import { buildWorkList } from '../../../../jobs/flowsheet-metadata-backfill/worklist';
import { resolvePartitionFilter } from '../../../../jobs/flowsheet-metadata-backfill/orchestrate';

/**
 * Recursively render a mocked-drizzle SQL object to its literal SQL text.
 * Template strings render in place; `sql.raw` fragments render their raw
 * string; nested sql`` fragments recurse; bound params (numbers) render as
 * '' — they're asserted separately via collectParams.
 */
const renderDeep = (value: unknown): string => {
  if (value == null) return '';
  if (typeof value === 'string') return '';
  const obj = value as { sql?: string[]; values?: unknown[]; raw?: string };
  if (typeof obj.raw === 'string') return obj.raw;
  if (Array.isArray(obj.sql)) {
    const values = obj.values ?? [];
    return obj.sql.map((chunk, i) => chunk + (i < values.length ? renderDeep(values[i]) : '')).join('');
  }
  return '';
};

/** Collect bound (non-fragment) params depth-first. */
const collectParams = (value: unknown): unknown[] => {
  if (value == null) return [];
  const obj = value as { sql?: string[]; values?: unknown[]; raw?: string };
  if (typeof obj.raw === 'string') return [];
  if (Array.isArray(obj.sql)) return (obj.values ?? []).flatMap(collectParams);
  return [value];
};

const execCall = (index: number): unknown => (db.execute as jest.Mock).mock.calls[index]?.[0];

describe('buildWorkList (BS#1591 play-priority work-list)', () => {
  beforeEach(() => {
    (db.execute as jest.Mock).mockReset();
  });

  const pendingCount = (n: number) => [{ pending_total: n }];
  const listRows = [
    { id: 30, plays: 12 },
    { id: 10, plays: 12 },
    { id: 20, plays: 3 },
  ];

  it('runs pending-count then work-list and returns ids/plays in server order with the subtraction-based below-floor count', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce(pendingCount(5)).mockResolvedValueOnce(listRows);

    const result = await buildWorkList({ playFloor: 5, recencyDays: 7, partitionFilter: null });

    expect((db.execute as jest.Mock).mock.calls.length).toBe(2);
    expect(result.ids).toEqual([30, 10, 20]);
    expect(result.plays).toEqual([12, 12, 3]);
    expect(result.pendingTotal).toBe(5);
    expect(result.belowFloorSkipped).toBe(2);
  });

  it('work-list statement carries the pending predicate, normalized plays JOIN, library UNION arms, all eligibility arms, and the play-desc order', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce(pendingCount(3)).mockResolvedValueOnce(listRows);

    await buildWorkList({ playFloor: 5, recencyDays: 7, partitionFilter: null });

    const sql = renderDeep(execCall(1));
    // Canonical pending predicate (same four clauses the id-cursor drain used).
    expect(sql).toMatch(/"entry_type"\s*=\s*'track'/);
    expect(sql).toMatch(/"artist_name"\s+IS\s+NOT\s+NULL/i);
    expect(sql).toMatch(/"metadata_attempt_at"\s+IS\s+NULL/i);
    expect(sql).toMatch(/"add_time"\s*<\s*now\(\)\s*-\s*interval\s*'60 seconds'/i);
    // Plays aggregate grouped on the canonical normalization function.
    expect(sql).toMatch(/normalize_artist_name/);
    expect(sql).toMatch(/GROUP BY/i);
    // Library-artist exemption: artists UNION artist_search_alias.
    expect(sql).toMatch(/"artists"/);
    expect(sql).toMatch(/"artist_search_alias"/);
    expect(sql).toMatch(/UNION/i);
    // Eligibility arms: linked, library-by-name, floor, recency.
    expect(sql).toMatch(/"album_id"\s+IS\s+NOT\s+NULL/i);
    expect(sql).toMatch(/EXISTS/i);
    expect(sql).toMatch(/plays\s*>=/i);
    expect(sql).toMatch(/interval\s*'1 day'/i);
    // Priority order with the same-artist contiguity tiebreak.
    expect(sql).toMatch(/ORDER BY\s+p\.plays\s+DESC\s*,\s*p\.artist_norm\s+ASC\s*,\s*f\."id"\s+ASC/i);
    // Floor + recency are bound params.
    const params = collectParams(execCall(1));
    expect(params).toContain(5);
    expect(params).toContain(7);
  });

  it('pending-count statement carries the same pending predicate, no ordering', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce(pendingCount(3)).mockResolvedValueOnce(listRows);

    await buildWorkList({ playFloor: 5, recencyDays: 7, partitionFilter: null });

    const sql = renderDeep(execCall(0));
    expect(sql).toMatch(/COUNT\(\*\)/i);
    expect(sql).toMatch(/"entry_type"\s*=\s*'track'/);
    expect(sql).toMatch(/"artist_name"\s+IS\s+NOT\s+NULL/i);
    expect(sql).toMatch(/"metadata_attempt_at"\s+IS\s+NULL/i);
    expect(sql).toMatch(/"add_time"\s*<\s*now\(\)\s*-\s*interval\s*'60 seconds'/i);
    expect(sql).not.toMatch(/ORDER BY/i);
    // The count must NOT carry the eligibility clause — it counts the whole
    // pending cohort so the subtraction yields the below-floor residual.
    expect(sql).not.toMatch(/"album_id"\s+IS\s+NOT\s+NULL/i);
  });

  it('early-exits without the work-list statement when the pending count is 0', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce(pendingCount(0));

    const result = await buildWorkList({ playFloor: 5, recencyDays: 7, partitionFilter: null });

    expect((db.execute as jest.Mock).mock.calls.length).toBe(1);
    expect(result.ids).toEqual([]);
    expect(result.plays).toEqual([]);
    expect(result.pendingTotal).toBe(0);
    expect(result.belowFloorSkipped).toBe(0);
  });

  it('playFloor=0 disables the floor: eligibility clause omitted, below-floor forced to 0', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce(pendingCount(3)).mockResolvedValueOnce(listRows);

    const result = await buildWorkList({ playFloor: 0, recencyDays: 7, partitionFilter: null });

    const sql = renderDeep(execCall(1));
    expect(sql).not.toMatch(/"album_id"\s+IS\s+NOT\s+NULL/i);
    expect(sql).not.toMatch(/EXISTS/i);
    expect(sql).not.toMatch(/plays\s*>=/i);
    expect(sql).not.toMatch(/interval\s*'1 day'/i);
    // Ordering still applies — the floor and the priority order are
    // independent features.
    expect(sql).toMatch(/ORDER BY\s+p\.plays\s+DESC/i);
    expect(result.belowFloorSkipped).toBe(0);
  });

  it('recencyDays=0 omits only the recency arm; the rest of the disjunction stays', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce(pendingCount(3)).mockResolvedValueOnce(listRows);

    await buildWorkList({ playFloor: 5, recencyDays: 0, partitionFilter: null });

    const sql = renderDeep(execCall(1));
    expect(sql).toMatch(/"album_id"\s+IS\s+NOT\s+NULL/i);
    expect(sql).toMatch(/EXISTS/i);
    expect(sql).toMatch(/plays\s*>=/i);
    expect(sql).not.toMatch(/interval\s*'1 day'/i);
  });

  it('composes the partition fragment into BOTH statements (subtraction stays partition-consistent)', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce(pendingCount(3)).mockResolvedValueOnce(listRows);
    const partition = resolvePartitionFilter('1', '4');

    await buildWorkList({ playFloor: 5, recencyDays: 7, partitionFilter: partition.sqlFragment });

    expect(renderDeep(execCall(0))).toMatch(/%/);
    expect(renderDeep(execCall(1))).toMatch(/%/);
  });

  it('clamps a negative subtraction (mid-build race skew) to 0', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce(pendingCount(1)).mockResolvedValueOnce(listRows);

    const result = await buildWorkList({ playFloor: 5, recencyDays: 7, partitionFilter: null });

    expect(result.belowFloorSkipped).toBe(0);
  });

  it('coerces string-typed driver values (id, plays, pending_total) to numbers', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([{ pending_total: '4' }])
      .mockResolvedValueOnce([{ id: '30', plays: '12' }]);

    const result = await buildWorkList({ playFloor: 5, recencyDays: 7, partitionFilter: null });

    expect(result.ids).toEqual([30]);
    expect(result.plays).toEqual([12]);
    expect(result.pendingTotal).toBe(4);
    expect(result.belowFloorSkipped).toBe(3);
  });
});
