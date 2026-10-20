/**
 * Unit tests for jobs/library-identity-consumer/job.ts's `shouldAnalyzeCompilationTracks`.
 * `main()` itself isn't unit-tested (mirrors the rest of the jobs/* fleet: the
 * `NODE_ENV !== 'test'` guard exists purely so this module can be imported safely).
 */
import { shouldAnalyzeCompilationTracks } from '../../../../jobs/library-identity-consumer/job';

describe('shouldAnalyzeCompilationTracks (BS#1991)', () => {
  // The bulk-update playbook pairs a bulk write with ANALYZE on the touched
  // table, once per run (not per page) — but only when something was
  // actually written: a dry-run makes no writes, and a no-op re-drain's
  // IS DISTINCT FROM guard can leave every drain at 0, where ANALYZE would
  // be wasted work on an unchanged table.
  it('is false on a dry run regardless of write counts', () => {
    expect(shouldAnalyzeCompilationTracks(true, 84, 12)).toBe(false);
  });

  it('is false when no drain wrote any compilation-track rows', () => {
    expect(shouldAnalyzeCompilationTracks(false, 0, 0)).toBe(false);
  });

  it('is true when any drain wrote at least one row', () => {
    expect(shouldAnalyzeCompilationTracks(false, 0, 1)).toBe(true);
    expect(shouldAnalyzeCompilationTracks(false, 84)).toBe(true);
  });
});
