/**
 * Unit tests for jobs/concerts-artist-resolver sync.ts (BS#1760).
 *
 * Two units under test:
 *
 *   - `diffConcertPerformers` — pure per-concert diff: compares a
 *     concert's current `supporting_artists_raw` array against its
 *     existing `concert_performers` (role='support') rows and decides
 *     which raw names need inserting, un-tombstoning, or tombstoning.
 *     No DB, no I/O — every case here is exercised via plain objects.
 *   - `runSync` — the dep-injected orchestrator loop (mirrors
 *     orchestrate.ts's `runResolver` shape): loadCandidates → diff →
 *     applyDiff, per-candidate error containment, onError sink safety.
 *
 * Acceptance cases per the BS#1760 issue:
 *   - idempotency: an unchanged concert (array == active existing rows)
 *     produces an empty diff and is never handed to applyDiff.
 *   - array-shrink → soft-tombstone: an active row whose name dropped
 *     out of the array is tombstoned.
 *   - reappearance: a tombstoned row whose name is back in the array is
 *     un-tombstoned.
 *   - brand-new name: inserted.
 *   - mixed diff: insert + tombstone + untombstone in the same pass.
 */
import {
  diffConcertPerformers,
  runSync,
  type ApplySyncDiffFn,
  type LoadSyncCandidatesFn,
  type SyncCandidate,
} from '../../../../jobs/concerts-artist-resolver/sync';

describe('diffConcertPerformers', () => {
  it('a brand-new support name (no existing row) is queued for insert', () => {
    const candidate: SyncCandidate = {
      concert_id: 1,
      supporting_artists_raw: ['Squirrel Flower'],
      existing: [],
    };
    expect(diffConcertPerformers(candidate)).toEqual({
      to_insert: ['Squirrel Flower'],
      to_untombstone: [],
      to_tombstone: [],
    });
  });

  it('steady state: an active existing row whose name is still billed produces an empty diff', () => {
    const candidate: SyncCandidate = {
      concert_id: 2,
      supporting_artists_raw: ['Sluice'],
      existing: [{ raw_name: 'Sluice', removed_at: null }],
    };
    expect(diffConcertPerformers(candidate)).toEqual({
      to_insert: [],
      to_untombstone: [],
      to_tombstone: [],
    });
  });

  it('steady state: a tombstoned existing row whose name is still absent produces an empty diff', () => {
    const candidate: SyncCandidate = {
      concert_id: 3,
      supporting_artists_raw: [],
      existing: [{ raw_name: 'Old Support Act', removed_at: '2026-01-01T00:00:00Z' }],
    };
    expect(diffConcertPerformers(candidate)).toEqual({
      to_insert: [],
      to_untombstone: [],
      to_tombstone: [],
    });
  });

  it('array-shrink: an active row dropped from the array is queued for tombstone', () => {
    const candidate: SyncCandidate = {
      concert_id: 4,
      supporting_artists_raw: [],
      existing: [{ raw_name: 'Dropped Opener', removed_at: null }],
    };
    expect(diffConcertPerformers(candidate)).toEqual({
      to_insert: [],
      to_untombstone: [],
      to_tombstone: ['Dropped Opener'],
    });
  });

  it('reappearance: a tombstoned row whose name is back in the array is queued for un-tombstone', () => {
    const candidate: SyncCandidate = {
      concert_id: 5,
      supporting_artists_raw: ['Returning Opener'],
      existing: [{ raw_name: 'Returning Opener', removed_at: '2026-01-01T00:00:00Z' }],
    };
    expect(diffConcertPerformers(candidate)).toEqual({
      to_insert: [],
      to_untombstone: ['Returning Opener'],
      to_tombstone: [],
    });
  });

  it('mixed pass: insert + tombstone + untombstone computed independently in one call', () => {
    const candidate: SyncCandidate = {
      concert_id: 6,
      supporting_artists_raw: ['New Act', 'Steady Act', 'Returning Act'],
      existing: [
        { raw_name: 'Steady Act', removed_at: null },
        { raw_name: 'Returning Act', removed_at: '2026-01-01T00:00:00Z' },
        { raw_name: 'Dropped Act', removed_at: null },
      ],
    };
    expect(diffConcertPerformers(candidate)).toEqual({
      to_insert: ['New Act'],
      to_untombstone: ['Returning Act'],
      to_tombstone: ['Dropped Act'],
    });
  });

  it('defensively dedupes duplicate names within the raw array before computing to_insert', () => {
    // mergeSupportingArtists (triangle-shows-etl/map.ts) already dedupes
    // the stored array insensitively, but the diff stays defensive rather
    // than trusting that invariant blindly.
    const candidate: SyncCandidate = {
      concert_id: 7,
      supporting_artists_raw: ['Dup Act', 'Dup Act'],
      existing: [],
    };
    expect(diffConcertPerformers(candidate)).toEqual({
      to_insert: ['Dup Act'],
      to_untombstone: [],
      to_tombstone: [],
    });
  });
});

describe('runSync', () => {
  const makeLoad = (rows: SyncCandidate[]): LoadSyncCandidatesFn => jest.fn().mockResolvedValue(rows);

  it('idempotent re-run: no candidates need diffing → applyDiff is never called', async () => {
    const loadCandidates = makeLoad([
      { concert_id: 1, supporting_artists_raw: ['Sluice'], existing: [{ raw_name: 'Sluice', removed_at: null }] },
    ]);
    const applyDiff = jest.fn<ReturnType<ApplySyncDiffFn>, Parameters<ApplySyncDiffFn>>();

    const { totals } = await runSync({ loadCandidates, applyDiff });

    expect(applyDiff).not.toHaveBeenCalled();
    expect(totals).toMatchObject({
      concerts_scanned: 1,
      concerts_changed: 0,
      inserted: 0,
      untombstoned: 0,
      tombstoned: 0,
      error: 0,
    });
  });

  it('a concert with a non-empty diff calls applyDiff with the concert id and the computed diff', async () => {
    const loadCandidates = makeLoad([{ concert_id: 42, supporting_artists_raw: ['New Act'], existing: [] }]);
    const applyDiff = jest.fn<ReturnType<ApplySyncDiffFn>, Parameters<ApplySyncDiffFn>>().mockResolvedValue({
      inserted: 1,
      untombstoned: 0,
      tombstoned: 0,
    });

    const { totals } = await runSync({ loadCandidates, applyDiff });

    expect(applyDiff).toHaveBeenCalledWith(42, { to_insert: ['New Act'], to_untombstone: [], to_tombstone: [] });
    expect(totals).toMatchObject({
      concerts_scanned: 1,
      concerts_changed: 1,
      inserted: 1,
      untombstoned: 0,
      tombstoned: 0,
    });
  });

  it('accumulates inserted/untombstoned/tombstoned totals across multiple changed concerts', async () => {
    const loadCandidates = makeLoad([
      { concert_id: 1, supporting_artists_raw: ['A'], existing: [] },
      { concert_id: 2, supporting_artists_raw: [], existing: [{ raw_name: 'B', removed_at: null }] },
      {
        concert_id: 3,
        supporting_artists_raw: ['C'],
        existing: [{ raw_name: 'C', removed_at: '2026-01-01T00:00:00Z' }],
      },
    ]);
    const applyDiff = jest
      .fn<ReturnType<ApplySyncDiffFn>, Parameters<ApplySyncDiffFn>>()
      .mockResolvedValueOnce({ inserted: 1, untombstoned: 0, tombstoned: 0 })
      .mockResolvedValueOnce({ inserted: 0, untombstoned: 0, tombstoned: 1 })
      .mockResolvedValueOnce({ inserted: 0, untombstoned: 1, tombstoned: 0 });

    const { totals } = await runSync({ loadCandidates, applyDiff });

    expect(applyDiff).toHaveBeenCalledTimes(3);
    expect(totals).toMatchObject({
      concerts_scanned: 3,
      concerts_changed: 3,
      inserted: 1,
      untombstoned: 1,
      tombstoned: 1,
      error: 0,
    });
  });

  it('applyDiff throws → error counter increments, loop continues to the next candidate', async () => {
    const loadCandidates = makeLoad([
      { concert_id: 1, supporting_artists_raw: ['Throws'], existing: [] },
      { concert_id: 2, supporting_artists_raw: ['Fine'], existing: [] },
    ]);
    const applyDiff = jest
      .fn<ReturnType<ApplySyncDiffFn>, Parameters<ApplySyncDiffFn>>()
      .mockRejectedValueOnce(new Error('PG: deadlock detected'))
      .mockResolvedValueOnce({ inserted: 1, untombstoned: 0, tombstoned: 0 });

    const { totals } = await runSync({ loadCandidates, applyDiff });

    expect(applyDiff).toHaveBeenCalledTimes(2);
    expect(totals).toMatchObject({ concerts_scanned: 2, concerts_changed: 1, inserted: 1, error: 1 });
  });

  it('applyDiff throws → onError invoked with the failing candidate and the underlying error', async () => {
    const boom = new Error('PG: deadlock detected');
    const candidate: SyncCandidate = { concert_id: 9, supporting_artists_raw: ['Throws'], existing: [] };
    const loadCandidates = makeLoad([candidate]);
    const applyDiff = jest.fn<ReturnType<ApplySyncDiffFn>, Parameters<ApplySyncDiffFn>>().mockRejectedValue(boom);
    const onError = jest.fn();

    const { totals } = await runSync({ loadCandidates, applyDiff, onError });

    expect(onError).toHaveBeenCalledWith(candidate, boom);
    expect(totals.error).toBe(1);
  });

  it('a synchronous onError throw does not abort the loop', async () => {
    const loadCandidates = makeLoad([
      { concert_id: 1, supporting_artists_raw: ['Throws'], existing: [] },
      { concert_id: 2, supporting_artists_raw: ['Fine'], existing: [] },
    ]);
    const applyDiff = jest
      .fn<ReturnType<ApplySyncDiffFn>, Parameters<ApplySyncDiffFn>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ inserted: 1, untombstoned: 0, tombstoned: 0 });
    const onError = jest.fn(() => {
      throw new Error('sink also broke');
    });

    const { totals } = await runSync({ loadCandidates, applyDiff, onError });

    expect(applyDiff).toHaveBeenCalledTimes(2);
    expect(totals).toMatchObject({ concerts_changed: 1, inserted: 1, error: 1 });
  });

  it('empty candidate set: applyDiff never called, totals are all zero', async () => {
    const loadCandidates = makeLoad([]);
    const applyDiff = jest.fn<ReturnType<ApplySyncDiffFn>, Parameters<ApplySyncDiffFn>>();

    const { totals } = await runSync({ loadCandidates, applyDiff });

    expect(applyDiff).not.toHaveBeenCalled();
    expect(totals).toMatchObject({
      concerts_scanned: 0,
      concerts_changed: 0,
      inserted: 0,
      untombstoned: 0,
      tombstoned: 0,
      error: 0,
    });
  });
});
