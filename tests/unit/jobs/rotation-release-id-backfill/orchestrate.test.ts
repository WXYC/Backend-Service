/**
 * Unit tests for jobs/rotation-release-id-backfill orchestrate.ts (BS#1029).
 *
 * Behaviors covered:
 *   1. (tracer bullet) one resolvable row → write called with the resolved id;
 *      `resolved` counter bumps, scanned == 1.
 *   2. LML returns null → unresolved counter; no write.
 *   3. LML throws → lml_error counter; no write; row stays NULL for next pass.
 *   4. Writer returns written:false → raced counter, not resolved.
 *   5. dryRun=true → resolved_dry counter; no write.
 */
import { jest } from '@jest/globals';

import {
  runBackfill,
  type Candidate,
  type LoadCandidatesFn,
  type LookupFn,
  type WriteFn,
} from '../../../../jobs/rotation-release-id-backfill/orchestrate';

const makeLoadCandidates = (rows: Candidate[]): LoadCandidatesFn => jest.fn<LoadCandidatesFn>().mockResolvedValue(rows);

describe('runBackfill', () => {
  test('one resolvable row produces one resolved UPDATE and bumps the counter', async () => {
    const loadCandidates = makeLoadCandidates([
      { id: 42, artist_name: 'Jessica Pratt', album_title: 'On Your Own Love Again' },
    ]);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(999001);
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    const result = await runBackfill({ loadCandidates, lookup, write });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(42, 999001);
    expect(result.totals.scanned).toBe(1);
    expect(result.totals.resolved).toBe(1);
    expect(result.totals.unresolved).toBe(0);
    expect(result.totals.lml_error).toBe(0);
    expect(result.totals.raced).toBe(0);
  });

  test('LML returns null (no Discogs match) → unresolved counter, no write', async () => {
    const loadCandidates = makeLoadCandidates([
      { id: 99, artist_name: 'Chuquimamani-Condori', album_title: 'Untitled Acetate' },
    ]);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(null);
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    const result = await runBackfill({ loadCandidates, lookup, write });

    expect(write).not.toHaveBeenCalled();
    expect(result.totals.scanned).toBe(1);
    expect(result.totals.unresolved).toBe(1);
    expect(result.totals.resolved).toBe(0);
  });

  test('LML throws → lml_error counter; no write; row stays NULL for next pass', async () => {
    const loadCandidates = makeLoadCandidates([{ id: 7, artist_name: 'Juana Molina', album_title: 'DOGA' }]);
    const lookup = jest.fn<LookupFn>().mockRejectedValue(new Error('LML socket timeout'));
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    const result = await runBackfill({ loadCandidates, lookup, write });

    expect(write).not.toHaveBeenCalled();
    expect(result.totals.scanned).toBe(1);
    expect(result.totals.lml_error).toBe(1);
    expect(result.totals.resolved).toBe(0);
    expect(result.totals.unresolved).toBe(0);
  });

  test('write returns written:false → raced counter, not resolved', async () => {
    // The writer's WHERE clause guards on `discogs_release_id IS NULL`.
    // If a tubafrenzy paste landed between SELECT and UPDATE, the UPDATE
    // affects 0 rows. The orchestrator distinguishes that from "resolved
    // and persisted" so the dashboard surfaces races separately.
    const loadCandidates = makeLoadCandidates([
      { id: 11, artist_name: 'Duke Ellington & John Coltrane', album_title: 'Duke Ellington & John Coltrane' },
    ]);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(555);
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: false });

    const result = await runBackfill({ loadCandidates, lookup, write });

    expect(write).toHaveBeenCalledTimes(1);
    expect(result.totals.scanned).toBe(1);
    expect(result.totals.raced).toBe(1);
    expect(result.totals.resolved).toBe(0);
  });

  test('LML returns 0 (sentinel) → sentinel_rejected counter, no write (BS#1429)', async () => {
    // The CHECK at rotation_discogs_release_id_not_sentinel rejects `0`
    // and negative ids. Without this pre-empt the writer's UPDATE would
    // raise 23514, the throw would escape the for-loop, and the entire
    // batch's remaining candidates would be abandoned.
    const loadCandidates = makeLoadCandidates([
      { id: 7, artist_name: 'Juana Molina', album_title: 'DOGA' },
      { id: 8, artist_name: 'Jessica Pratt', album_title: 'On Your Own Love Again' },
    ]);
    const lookup = jest.fn<LookupFn>().mockResolvedValueOnce(0).mockResolvedValueOnce(999001);
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    const result = await runBackfill({ loadCandidates, lookup, write });

    // Sentinel candidate is skipped, second candidate proceeds to write.
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(8, 999001);
    expect(result.totals.scanned).toBe(2);
    expect(result.totals.sentinel_rejected).toBe(1);
    expect(result.totals.resolved).toBe(1);
  });

  test('LML returns a negative id → sentinel_rejected counter, no write (BS#1429)', async () => {
    const loadCandidates = makeLoadCandidates([{ id: 7, artist_name: 'Juana Molina', album_title: 'DOGA' }]);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(-1);
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    const result = await runBackfill({ loadCandidates, lookup, write });

    expect(write).not.toHaveBeenCalled();
    expect(result.totals.sentinel_rejected).toBe(1);
    expect(result.totals.resolved).toBe(0);
  });

  test('dryRun=true skips writes and bumps resolved_dry instead of resolved', async () => {
    const loadCandidates = makeLoadCandidates([
      { id: 42, artist_name: 'Jessica Pratt', album_title: 'On Your Own Love Again' },
    ]);
    const lookup = jest.fn<LookupFn>().mockResolvedValue(999001);
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    const result = await runBackfill({ loadCandidates, lookup, write, dryRun: true });

    expect(write).not.toHaveBeenCalled();
    expect(result.totals.scanned).toBe(1);
    expect(result.totals.resolved_dry).toBe(1);
    expect(result.totals.resolved).toBe(0);
  });
});
