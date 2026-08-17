/**
 * Unit tests for jobs/flowsheet-metadata-backfill/worklist.ts (BS#1591,
 * predicate cut over to metadata_status + W4 self-heal added by BS#895).
 *
 * Pins the shape of the run-start work-list build that replaced the
 * id-cursor drain:
 *   1. Two statements: a cheap pending-count (partial-index shaped) first,
 *      then the priority-ordered work-list SELECT. `below_floor_skipped`
 *      is the subtraction `pending_total - worklist_size` — valid because
 *      the eligibility disjunction partitions the pending set exactly.
 *   2. The work-list statement carries the canonical pending predicate
 *      (entry_type='track', artist_name IS NOT NULL, metadata_status =
 *      'pending', grace-window guard, optional recovery-window ceiling),
 *      groups plays on wxyc_schema.normalize_artist_name so the key can't
 *      drift from the SQL/TS twins (migration 0092), unions `artists` with
 *      `artist_search_alias` for the library exemption, and orders (plays
 *      DESC, artist_norm ASC, id ASC) — the artist tiebreak keeps
 *      same-artist rows contiguous for the LookupCache dedup.
 *   3. Floor semantics: playFloor=0 omits the whole eligibility clause
 *      (floor disabled — everything pending is eligible) and forces the
 *      below-floor count to 0; recencyDays=0 omits only the recency arm.
 *   4. The PARTITION_INDEX/PARTITION_COUNT fragment composes into BOTH
 *      statements, so the subtraction stays partition-consistent.
 *   5. BS#895: graceMinutes composes as a hard `add_time <` guard on both
 *      statements; recoveryWindowHours composes as an additional `add_time
 *      >` ceiling when > 0, omitted entirely at 0.
 *   6. BS#895 / epic #1810 W4: `buildRotationSelfHealCandidates` is a
 *      SEPARATE query (own describe block below) — joins `rotation`, scopes
 *      to `metadata_status = 'enriched_no_match'` rotation-linked rows, and
 *      state-change-gates on `metadata_attempt_at` vs.
 *      `discogs_release_id_resolve_attempted_at`.
 *
 * drizzle-orm is mocked in the unit harness (`{sql: strings[], values}`,
 * `sql.raw` → `{raw}`), so nested fragments land in `values`; renderDeep
 * below stitches the full statement text back together for regex asserts.
 */
import { jest } from '@jest/globals';

import { db } from '@wxyc/database';
import {
  buildWorkList,
  buildRotationSelfHealCandidates,
  countStrandedPastRecoveryWindow,
  pendingPredicate,
  SELF_HEAL_MAX_CANDIDATES,
} from '../../../../jobs/flowsheet-metadata-backfill/worklist';
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

    const result = await buildWorkList({
      playFloor: 5,
      recencyDays: 7,
      partitionFilter: null,
      graceMinutes: 15,
      recoveryWindowHours: 6,
    });

    expect((db.execute as jest.Mock).mock.calls.length).toBe(2);
    expect(result.ids).toEqual([30, 10, 20]);
    expect(result.plays).toEqual([12, 12, 3]);
    expect(result.pendingTotal).toBe(5);
    expect(result.belowFloorSkipped).toBe(2);
  });

  it('work-list statement carries the pending predicate, normalized plays JOIN, library UNION arms, all eligibility arms, and the play-desc order', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce(pendingCount(3)).mockResolvedValueOnce(listRows);

    await buildWorkList({
      playFloor: 5,
      recencyDays: 7,
      partitionFilter: null,
      graceMinutes: 15,
      recoveryWindowHours: 6,
    });

    const sql = renderDeep(execCall(1));
    // Canonical pending predicate (BS#895: metadata_status replaces the old
    // metadata_attempt_at marker; grace window replaces the 60s guard).
    expect(sql).toMatch(/"entry_type"\s*=\s*'track'/);
    expect(sql).toMatch(/"artist_name"\s+IS\s+NOT\s+NULL/i);
    expect(sql).toMatch(/"metadata_status"\s*=\s*'pending'/i);
    expect(sql).toMatch(/"add_time"\s*<\s*now\(\)\s*-\s*\(\s*\d*\s*\*\s*interval\s*'1 minute'\s*\)/i);
    // Plays aggregate grouped on the canonical normalization function.
    expect(sql).toMatch(/normalize_artist_name/);
    expect(sql).toMatch(/GROUP BY/i);
    // Library-artist exemption: artists UNION artist_search_alias.
    expect(sql).toMatch(/"artists"/);
    expect(sql).toMatch(/"artist_search_alias"/);
    expect(sql).toMatch(/UNION/i);
    // Eligibility arms: linked, floor, recency, library-by-name.
    expect(sql).toMatch(/"album_id"\s+IS\s+NOT\s+NULL/i);
    expect(sql).toMatch(/EXISTS/i);
    expect(sql).toMatch(/plays\s*>=/i);
    expect(sql).toMatch(/interval\s*'1 day'/i);
    // Arm ORDER is load-bearing (PG evaluates OR arms left-to-right with
    // short-circuit): the free plays/recency comparisons must precede the
    // correlated EXISTS subplan so most rows never pay the probe.
    expect(sql.search(/plays\s*>=/i)).toBeLessThan(sql.search(/EXISTS/i));
    // The probe keys on the join-bound p.artist_norm — re-computing
    // normalize_artist_name inside the EXISTS would double-evaluate the
    // regexp per probed row (no cross-clause CSE in PG).
    expect(sql).toMatch(/la\.artist_norm\s*=\s*p\.artist_norm/i);
    // Priority order with the same-artist contiguity tiebreak.
    expect(sql).toMatch(/ORDER BY\s+p\.plays\s+DESC\s*,\s*p\.artist_norm\s+ASC\s*,\s*f\."id"\s+ASC/i);
    // Floor + recency are bound params.
    const params = collectParams(execCall(1));
    expect(params).toContain(5);
    expect(params).toContain(7);
  });

  it('pending-count statement carries the same pending predicate, no ordering', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce(pendingCount(3)).mockResolvedValueOnce(listRows);

    await buildWorkList({
      playFloor: 5,
      recencyDays: 7,
      partitionFilter: null,
      graceMinutes: 15,
      recoveryWindowHours: 6,
    });

    const sql = renderDeep(execCall(0));
    expect(sql).toMatch(/COUNT\(\*\)/i);
    expect(sql).toMatch(/"entry_type"\s*=\s*'track'/);
    expect(sql).toMatch(/"artist_name"\s+IS\s+NOT\s+NULL/i);
    expect(sql).toMatch(/"metadata_status"\s*=\s*'pending'/i);
    expect(sql).toMatch(/"add_time"\s*<\s*now\(\)\s*-\s*\(\s*\d*\s*\*\s*interval\s*'1 minute'\s*\)/i);
    expect(sql).not.toMatch(/ORDER BY/i);
    // The count must NOT carry the eligibility clause — it counts the whole
    // pending cohort so the subtraction yields the below-floor residual.
    expect(sql).not.toMatch(/"album_id"\s+IS\s+NOT\s+NULL/i);
  });

  it('early-exits without the work-list statement when the pending count is 0', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce(pendingCount(0));

    const result = await buildWorkList({
      playFloor: 5,
      recencyDays: 7,
      partitionFilter: null,
      graceMinutes: 15,
      recoveryWindowHours: 6,
    });

    expect((db.execute as jest.Mock).mock.calls.length).toBe(1);
    expect(result.ids).toEqual([]);
    expect(result.plays).toEqual([]);
    expect(result.pendingTotal).toBe(0);
    expect(result.belowFloorSkipped).toBe(0);
  });

  it('playFloor=0 disables the floor: eligibility clause omitted, below-floor forced to 0', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce(pendingCount(3)).mockResolvedValueOnce(listRows);

    const result = await buildWorkList({
      playFloor: 0,
      recencyDays: 7,
      partitionFilter: null,
      graceMinutes: 15,
      recoveryWindowHours: 6,
    });

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

    await buildWorkList({
      playFloor: 5,
      recencyDays: 0,
      partitionFilter: null,
      graceMinutes: 15,
      recoveryWindowHours: 6,
    });

    const sql = renderDeep(execCall(1));
    expect(sql).toMatch(/"album_id"\s+IS\s+NOT\s+NULL/i);
    expect(sql).toMatch(/EXISTS/i);
    expect(sql).toMatch(/plays\s*>=/i);
    expect(sql).not.toMatch(/interval\s*'1 day'/i);
  });

  it('composes the partition fragment into BOTH statements (subtraction stays partition-consistent)', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce(pendingCount(3)).mockResolvedValueOnce(listRows);
    const partition = resolvePartitionFilter('1', '4');

    await buildWorkList({
      playFloor: 5,
      recencyDays: 7,
      partitionFilter: partition.sqlFragment,
      graceMinutes: 15,
      recoveryWindowHours: 6,
    });

    expect(renderDeep(execCall(0))).toMatch(/%/);
    expect(renderDeep(execCall(1))).toMatch(/%/);
  });

  it('clamps a negative subtraction (mid-build race skew) to 0', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce(pendingCount(1)).mockResolvedValueOnce(listRows);

    const result = await buildWorkList({
      playFloor: 5,
      recencyDays: 7,
      partitionFilter: null,
      graceMinutes: 15,
      recoveryWindowHours: 6,
    });

    expect(result.belowFloorSkipped).toBe(0);
  });

  it('coerces string-typed driver values (id, plays, pending_total) to numbers', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([{ pending_total: '4' }])
      .mockResolvedValueOnce([{ id: '30', plays: '12' }]);

    const result = await buildWorkList({
      playFloor: 5,
      recencyDays: 7,
      partitionFilter: null,
      graceMinutes: 15,
      recoveryWindowHours: 6,
    });

    expect(result.ids).toEqual([30]);
    expect(result.plays).toEqual([12]);
    expect(result.pendingTotal).toBe(4);
    expect(result.belowFloorSkipped).toBe(3);
  });

  // Loud-unwrap contract (review follow-up): a driver/ORM result-shape
  // change must crash the run, never coerce to a green zero-work no-op.
  // The `{rows: [...]}` wrapper (node-postgres shape) is the one known
  // alternate contract and is accepted; anything else throws.
  it('accepts the {rows: [...]} driver result wrapper on both statements', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce({ rows: pendingCount(5) })
      .mockResolvedValueOnce({ rows: listRows });

    const result = await buildWorkList({
      playFloor: 5,
      recencyDays: 7,
      partitionFilter: null,
      graceMinutes: 15,
      recoveryWindowHours: 6,
    });

    expect(result.pendingTotal).toBe(5);
    expect(result.ids).toEqual([30, 10, 20]);
    expect(result.belowFloorSkipped).toBe(2);
  });

  it('throws loudly on an unrecognized db.execute result shape instead of early-exiting as a zero-work run', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce({ rowCount: 1 });

    await expect(
      buildWorkList({ playFloor: 5, recencyDays: 7, partitionFilter: null, graceMinutes: 15, recoveryWindowHours: 6 })
    ).rejects.toThrow(/unrecognized db\.execute\(\) result shape/);
  });

  it('throws loudly when the pending count returns no row or a non-numeric total', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);
    await expect(
      buildWorkList({ playFloor: 5, recencyDays: 7, partitionFilter: null, graceMinutes: 15, recoveryWindowHours: 6 })
    ).rejects.toThrow(/pending count returned 0 rows/);

    (db.execute as jest.Mock).mockReset();
    (db.execute as jest.Mock).mockResolvedValueOnce([{ pending_total: 'not-a-number' }]);
    await expect(
      buildWorkList({ playFloor: 5, recencyDays: 7, partitionFilter: null, graceMinutes: 15, recoveryWindowHours: 6 })
    ).rejects.toThrow(/non-numeric/);
  });

  it('composes graceMinutes as a bound param on both statements (BS#895 consumer grace window)', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce(pendingCount(3)).mockResolvedValueOnce(listRows);

    await buildWorkList({
      playFloor: 5,
      recencyDays: 7,
      partitionFilter: null,
      graceMinutes: 42,
      recoveryWindowHours: 0,
    });

    expect(collectParams(execCall(0))).toContain(42);
    expect(collectParams(execCall(1))).toContain(42);
  });

  it('composes the recoveryWindowHours ceiling as an extra AND clause with a bound param when > 0 (BS#895)', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce(pendingCount(3)).mockResolvedValueOnce(listRows);

    await buildWorkList({
      playFloor: 5,
      recencyDays: 7,
      partitionFilter: null,
      graceMinutes: 15,
      recoveryWindowHours: 9,
    });

    const countSql = renderDeep(execCall(0));
    const listSql = renderDeep(execCall(1));
    expect(countSql).toMatch(/"add_time"\s*>\s*now\(\)\s*-\s*\(\s*\d*\s*\*\s*interval\s*'1 hour'\s*\)/i);
    expect(listSql).toMatch(/"add_time"\s*>\s*now\(\)\s*-\s*\(\s*\d*\s*\*\s*interval\s*'1 hour'\s*\)/i);
    expect(collectParams(execCall(0))).toContain(9);
    expect(collectParams(execCall(1))).toContain(9);
  });

  it('omits the recoveryWindowHours ceiling entirely when 0 (historical catch-up shape — never the live hourly cron)', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce(pendingCount(3)).mockResolvedValueOnce(listRows);

    await buildWorkList({
      playFloor: 5,
      recencyDays: 7,
      partitionFilter: null,
      graceMinutes: 15,
      recoveryWindowHours: 0,
    });

    expect(renderDeep(execCall(0))).not.toMatch(/interval\s*'1 hour'/i);
    expect(renderDeep(execCall(1))).not.toMatch(/interval\s*'1 hour'/i);
  });

  // BS#2176 acceptance criterion: "add a test pinning the C6 sweep's
  // candidate predicate against an exact-match allowlist (the
  // legacy-linkage-resolve precedent)". `jobs/flowsheet-no-match-recheck`
  // introduces a disjoint retry marker (`no_match_recheck_attempted_at`) for
  // a disjoint cohort (`metadata_status = 'enriched_no_match'`) precisely so
  // it never has to touch this predicate — this pins that boundary. Full
  // literal text, whitespace-normalized, asserted equal to a fixed constant
  // (not a denylist regex): any added conjunct, regardless of spelling,
  // changes the normalized text and fails the assertion.
  const PENDING_PREDICATE_SQL =
    'f."entry_type" = \'track\' AND f."artist_name" IS NOT NULL AND f."metadata_status" = \'pending\' ' +
    'AND f."add_time" < now() - ( * interval \'1 minute\') AND f."add_time" > now() - ( * interval \'1 hour\')';

  it('BS#2176: pendingPredicate text matches the allowlisted predicate exactly — no added clause survives', () => {
    const text = renderDeep(pendingPredicate(null, 15, 6))
      .replace(/\s+/g, ' ')
      .trim();
    expect(text).toBe(PENDING_PREDICATE_SQL);
  });

  it('BS#2176: pendingPredicate never references the disjoint no-match-recheck retry marker', () => {
    const text = renderDeep(pendingPredicate(null, 15, 6));
    expect(text).not.toMatch(/no_match_recheck_attempted_at/i);
  });
});

describe('buildRotationSelfHealCandidates (BS#895 / epic #1810 W4)', () => {
  beforeEach(() => {
    (db.execute as jest.Mock).mockReset();
  });

  it('queries flowsheet joined to rotation, scoped to enriched_no_match + rotation_id/discogs_release_id NOT NULL, the state-change gate, id-order, and the defensive LIMIT', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([{ id: 10 }, { id: 20 }]);

    const ids = await buildRotationSelfHealCandidates();

    expect(ids).toEqual([10, 20]);
    const sql = renderDeep(execCall(0));
    expect(sql).toMatch(/JOIN\s+"wxyc_schema"\."rotation"\s+r\s+ON\s+r\."id"\s*=\s*f\."rotation_id"/i);
    expect(sql).toMatch(/f\."metadata_status"\s*=\s*'enriched_no_match'/i);
    expect(sql).toMatch(/f\."rotation_id"\s+IS\s+NOT\s+NULL/i);
    expect(sql).toMatch(/r\."discogs_release_id"\s+IS\s+NOT\s+NULL/i);
    // State-change gate: never-attempted-by-this-job OR resolved-after-last-attempt.
    expect(sql).toMatch(/f\."metadata_attempt_at"\s+IS\s+NULL/i);
    expect(sql).toMatch(/r\."discogs_release_id_resolve_attempted_at"\s*>\s*f\."metadata_attempt_at"/i);
    expect(sql).toMatch(/ORDER BY\s+f\."id"\s+ASC/i);
    expect(sql).toMatch(/LIMIT/i);
    expect(collectParams(execCall(0))).toContain(SELF_HEAL_MAX_CANDIDATES);
  });

  it('returns an empty array when there are no candidates', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    expect(await buildRotationSelfHealCandidates()).toEqual([]);
  });

  it('coerces string-typed driver ids to numbers', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([{ id: '15' }, { id: '25' }]);

    expect(await buildRotationSelfHealCandidates()).toEqual([15, 25]);
  });

  it('accepts the {rows: [...]} driver result wrapper', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce({ rows: [{ id: 7 }] });

    expect(await buildRotationSelfHealCandidates()).toEqual([7]);
  });

  it('throws loudly on an unrecognized db.execute result shape instead of silently returning zero candidates', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce({ rowCount: 1 });

    await expect(buildRotationSelfHealCandidates()).rejects.toThrow(/unrecognized db\.execute\(\) result shape/);
  });
});

describe('countStrandedPastRecoveryWindow (BS#895 review finding #4)', () => {
  beforeEach(() => {
    (db.execute as jest.Mock).mockReset();
  });

  it('returns 0 without querying when recoveryWindowHours <= 0 (the ceiling is disabled — "stranded past the ceiling" is not meaningful)', async () => {
    expect(await countStrandedPastRecoveryWindow(0)).toBe(0);
    expect(await countStrandedPastRecoveryWindow(-1)).toBe(0);
    expect((db.execute as jest.Mock).mock.calls.length).toBe(0);
  });

  it('runs a single COUNT query scoped to metadata_status=pending, entry_type=track, artist_name NOT NULL, and add_time past the ceiling, with the hours as a bound param', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([{ stranded_total: 12 }]);

    const result = await countStrandedPastRecoveryWindow(6);

    expect(result).toBe(12);
    expect((db.execute as jest.Mock).mock.calls.length).toBe(1);
    const sql = renderDeep(execCall(0));
    expect(sql).toMatch(/COUNT\(\*\)/i);
    expect(sql).toMatch(/"entry_type"\s*=\s*'track'/);
    expect(sql).toMatch(/"artist_name"\s+IS\s+NOT\s+NULL/i);
    expect(sql).toMatch(/"metadata_status"\s*=\s*'pending'/i);
    expect(sql).toMatch(/"add_time"\s*<=\s*now\(\)\s*-\s*\(\s*\d*\s*\*\s*interval\s*'1 hour'\s*\)/i);
    expect(collectParams(execCall(0))).toContain(6);
  });

  it('coerces a string-typed driver total to a number', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([{ stranded_total: '9' }]);

    expect(await countStrandedPastRecoveryWindow(6)).toBe(9);
  });

  it('accepts the {rows: [...]} driver result wrapper', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce({ rows: [{ stranded_total: 3 }] });

    expect(await countStrandedPastRecoveryWindow(6)).toBe(3);
  });

  it('throws loudly on an unrecognized db.execute result shape instead of silently reporting 0', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce({ rowCount: 1 });

    await expect(countStrandedPastRecoveryWindow(6)).rejects.toThrow(/unrecognized db\.execute\(\) result shape/);
  });

  it('throws loudly when the count returns no row or a non-numeric total', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);
    await expect(countStrandedPastRecoveryWindow(6)).rejects.toThrow(/returned 0 rows/);

    (db.execute as jest.Mock).mockReset();
    (db.execute as jest.Mock).mockResolvedValueOnce([{ stranded_total: 'not-a-number' }]);
    await expect(countStrandedPastRecoveryWindow(6)).rejects.toThrow(/non-numeric/);
  });
});
