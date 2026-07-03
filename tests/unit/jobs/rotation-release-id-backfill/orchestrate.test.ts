/**
 * Unit tests for jobs/rotation-release-id-backfill orchestrate.ts (BS#1029).
 *
 * Behaviors covered:
 *   1. (tracer bullet) one resolvable row → write called with the resolved id;
 *      `resolved` counter bumps, scanned == 1.
 *   2. LML finds no match → unresolved counter; no write.
 *   3. LML throws → lml_error counter; no write; row stays NULL for next pass.
 *   4. Writer returns written:false → raced counter, not resolved.
 *   5. dryRun=true → resolved_dry counter; no write.
 *   6. Trust gate (BS#1516): a non-direct LML answer → trust_rejected
 *      counter; no write; the row stays NULL rather than persisting a
 *      wrong-album release id.
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
    const lookup = jest.fn<LookupFn>().mockResolvedValue({ kind: 'resolved', releaseId: 999001 });
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

  test('LML finds no Discogs match → unresolved counter, no write', async () => {
    const loadCandidates = makeLoadCandidates([
      { id: 99, artist_name: 'Chuquimamani-Condori', album_title: 'Untitled Acetate' },
    ]);
    const lookup = jest.fn<LookupFn>().mockResolvedValue({ kind: 'no_match' });
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
    const lookup = jest.fn<LookupFn>().mockResolvedValue({ kind: 'resolved', releaseId: 555 });
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
    const lookup = jest
      .fn<LookupFn>()
      .mockResolvedValueOnce({ kind: 'resolved', releaseId: 0 })
      .mockResolvedValueOnce({ kind: 'resolved', releaseId: 999001 });
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
    const lookup = jest.fn<LookupFn>().mockResolvedValue({ kind: 'resolved', releaseId: -1 });
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
    const lookup = jest.fn<LookupFn>().mockResolvedValue({ kind: 'resolved', releaseId: 999001 });
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    const result = await runBackfill({ loadCandidates, lookup, write, dryRun: true });

    expect(write).not.toHaveBeenCalled();
    expect(result.totals.scanned).toBe(1);
    expect(result.totals.resolved_dry).toBe(1);
    expect(result.totals.resolved).toBe(0);
  });

  test('trust-rejected lookup → trust_rejected counter, no write; batch continues (BS#1516)', async () => {
    // A wrong-album persist is permanent: tier 1 serves it forever and the
    // runtime BS#1351 gate never re-checks stored ids. The row must stay
    // NULL so the (trust-gated) tier-3 path or a later re-run can resolve it.
    const loadCandidates = makeLoadCandidates([
      { id: 21529, artist_name: 'Noura Mint Seymali', album_title: 'Yenbett' },
      { id: 8, artist_name: 'Jessica Pratt', album_title: 'On Your Own Love Again' },
    ]);
    const lookup = jest
      .fn<LookupFn>()
      .mockResolvedValueOnce({ kind: 'trust_rejected', searchType: 'alternative' })
      .mockResolvedValueOnce({ kind: 'resolved', releaseId: 999001 });
    const write = jest.fn<WriteFn>().mockResolvedValue({ written: true });

    const result = await runBackfill({ loadCandidates, lookup, write });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(8, 999001);
    expect(result.totals.scanned).toBe(2);
    expect(result.totals.trust_rejected).toBe(1);
    expect(result.totals.resolved).toBe(1);
    expect(result.totals.unresolved).toBe(0);
  });

  test('counter invariant holds across a mixed batch (scanned == sum of outcome counters)', async () => {
    const loadCandidates = makeLoadCandidates([
      { id: 1, artist_name: 'Jessica Pratt', album_title: 'On Your Own Love Again' },
      { id: 2, artist_name: 'Noura Mint Seymali', album_title: 'Yenbett' },
      { id: 3, artist_name: 'Chuquimamani-Condori', album_title: 'Untitled Acetate' },
      { id: 4, artist_name: 'Juana Molina', album_title: 'DOGA' },
      { id: 5, artist_name: 'Stereolab', album_title: 'Dots and Loops' },
      { id: 6, artist_name: 'Cat Power', album_title: 'Moon Pix' },
    ]);
    const lookup = jest
      .fn<LookupFn>()
      .mockResolvedValueOnce({ kind: 'resolved', releaseId: 111 }) // resolved
      .mockResolvedValueOnce({ kind: 'trust_rejected', searchType: 'alternative' }) // trust_rejected
      .mockResolvedValueOnce({ kind: 'no_match' }) // unresolved
      .mockResolvedValueOnce({ kind: 'resolved', releaseId: 0 }) // sentinel_rejected
      .mockRejectedValueOnce(new Error('LML socket timeout')) // lml_error
      .mockResolvedValueOnce({ kind: 'resolved', releaseId: 222 }); // raced
    const write = jest.fn<WriteFn>().mockResolvedValueOnce({ written: true }).mockResolvedValueOnce({ written: false });

    const { totals } = await runBackfill({ loadCandidates, lookup, write });

    expect(totals).toEqual({
      scanned: 6,
      resolved: 1,
      resolved_dry: 0,
      unresolved: 1,
      lml_error: 1,
      raced: 1,
      sentinel_rejected: 1,
      trust_rejected: 1,
    });
    expect(totals.scanned).toBe(
      totals.resolved +
        totals.resolved_dry +
        totals.unresolved +
        totals.lml_error +
        totals.raced +
        totals.sentinel_rejected +
        totals.trust_rejected
    );
  });
});
